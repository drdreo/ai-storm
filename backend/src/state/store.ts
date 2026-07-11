import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename, rm, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveStateDir } from "@ai-storm/state";
import type { PortableStateBundle } from "@ai-storm/shared";

export const STATE_FORMAT_VERSION = 1 as const;

export interface TerminalConfiguration {
  shell?: string;
  args?: string[];
  cwd?: string;
  agentCommand?: string;
  agentArgs?: string[];
  mode?: string;
  background?: string;
}

export interface StoredProject {
  id: string;
  title: string;
  color?: string;
  folderId?: string;
  order?: string;
  terminal: TerminalConfiguration;
  createdAt: number;
  /** Changed only by registry metadata mutations, never board/session activity. */
  updatedAt: number;
}

export interface StoredFolder {
  id: string;
  title: string;
  createdAt: number;
  order?: string;
}

export interface RegistryDocument {
  version: typeof STATE_FORMAT_VERSION;
  revision: number;
  projects: StoredProject[];
  folders: StoredFolder[];
}

export interface BoardDocument {
  version: typeof STATE_FORMAT_VERSION;
  revision: number;
  nextIdeaRef: number;
  /** Complete tldraw document snapshot. Null means a project has not mounted an editor yet. */
  document: unknown | null;
}

export interface HistoryDocument {
  version: typeof STATE_FORMAT_VERSION;
  revision: number;
  runs: Record<string, unknown>[];
}

export type BoardWriteResult =
  | { ok: true; board: BoardDocument }
  | { ok: false; conflict: { revision: number; document: unknown | null } };

export class StateFileError extends Error {
  readonly path: string;

  constructor(message: string, path: string, options?: ErrorOptions) {
    super(`${message}: ${path}`, options);
    this.path = path;
    this.name = "StateFileError";
  }
}

const emptyRegistry = (): RegistryDocument => ({
  version: STATE_FORMAT_VERSION,
  revision: 0,
  projects: [],
  folders: []
});
const emptyBoard = (): BoardDocument => ({
  version: STATE_FORMAT_VERSION,
  revision: 0,
  nextIdeaRef: 1,
  document: null
});
const emptyHistory = (): HistoryDocument => ({ version: STATE_FORMAT_VERSION, revision: 0, runs: [] });

function assertProjectId(projectId: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(projectId)) throw new Error(`Invalid project id: ${projectId}`);
}

async function ensureDirectory(path: string): Promise<void> {
  const created = await mkdir(path, { recursive: true, mode: 0o700 });
  // Enforce owner-only access on directories this store creates, but preserve
  // permissions on an existing explicit state root (and its existing parents).
  if (created !== undefined && process.platform !== "win32") await chmod(path, 0o700);
}

async function syncParent(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(dirname(path), constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    // Directory fsync is unsupported on Windows and on some network filesystems.
    const code = (error as NodeJS.ErrnoException).code;
    if (!code || !["EINVAL", "ENOTSUP", "EPERM", "EISDIR", "EBADF"].includes(code)) throw error;
  } finally {
    await handle?.close();
  }
}

/** Durable same-directory replace: write+fsync, rename, then directory fsync. */
export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await ensureDirectory(dirname(path));
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    // The temporary file was created as 0600 and rename preserves that mode.
    // Do not add fallible work between the atomic commit and its acknowledgement.
    await rename(temporary, path);
    await syncParent(path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readJson<T>(path: string, validEnvelope: (value: Record<string, unknown>) => boolean): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new StateFileError("Unable to read state file", path, { cause: error });
  }
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("root must be an object");
    if (value.version !== STATE_FORMAT_VERSION) throw new Error(`unsupported format version ${String(value.version)}`);
    // Validate only the store-owned envelope. The tldraw document and operation
    // payloads inside it remain deliberately opaque/trusted.
    if (!validEnvelope(value)) throw new Error("invalid state document envelope");
    return value as T;
  } catch (error) {
    throw new StateFileError("Malformed or unsupported state file", path, { cause: error });
  }
}

const validRevision = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const readRegistryFile = (path: string) =>
  readJson<RegistryDocument>(
    path,
    (value) => validRevision(value.revision) && Array.isArray(value.projects) && Array.isArray(value.folders)
  );
const readBoardFile = (path: string) =>
  readJson<BoardDocument>(
    path,
    (value) =>
      validRevision(value.revision) &&
      Number.isSafeInteger(value.nextIdeaRef) &&
      (value.nextIdeaRef as number) >= 1 &&
      Object.hasOwn(value, "document")
  );
const readHistoryFile = (path: string) =>
  readJson<HistoryDocument>(path, (value) => validRevision(value.revision) && Array.isArray(value.runs));

export interface StateStoreOptions {
  root?: string;
  now?: () => number;
  writeJson?: typeof atomicWriteJson;
}

/** Canonical backend-owned filesystem store. All mutation critical sections are per-file. */
export class StateStore {
  readonly root: string;
  readonly registryPath: string;
  readonly projectsPath: string;
  /** Reserved launcher paths; lifecycle and contents are managed by the CLI daemon. */
  readonly logsPath: string;
  readonly daemonPath: string;

  readonly #now: () => number;
  readonly #writeJson: typeof atomicWriteJson;
  readonly #queues = new Map<string, Promise<void>>();

  constructor(options: StateStoreOptions = {}) {
    this.root = options.root ?? resolveStateDir();
    this.registryPath = join(this.root, "registry.json");
    this.projectsPath = join(this.root, "projects");
    this.logsPath = join(this.root, "logs");
    this.daemonPath = join(this.root, "daemon.json");
    this.#now = options.now ?? Date.now;
    this.#writeJson = options.writeJson ?? atomicWriteJson;
  }

  boardPath(projectId: string): string {
    assertProjectId(projectId);
    return join(this.projectsPath, projectId, "board.json");
  }

  historyPath(projectId: string): string {
    assertProjectId(projectId);
    return join(this.projectsPath, projectId, "history.json");
  }

  async #serialized<T>(path: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(path) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const settled = result.then(
      () => undefined,
      () => undefined
    );
    this.#queues.set(path, settled);
    void settled.then(() => {
      if (this.#queues.get(path) === settled) this.#queues.delete(path);
    });
    return result;
  }

  /** Initialize only the root and an empty registry. Existing malformed state is never replaced. */
  async initialize(): Promise<RegistryDocument> {
    await ensureDirectory(this.root);
    return this.#serialized(this.registryPath, async () => {
      try {
        return await readRegistryFile(this.registryPath);
      } catch (error) {
        if (
          !(error instanceof StateFileError) ||
          (error.cause as NodeJS.ErrnoException | undefined)?.code !== "ENOENT"
        ) {
          throw error;
        }
        const registry = emptyRegistry();
        await this.#writeJson(this.registryPath, registry);
        return registry;
      }
    });
  }

  readRegistry(): Promise<RegistryDocument> {
    return this.#serialized(this.registryPath, () => readRegistryFile(this.registryPath));
  }

  readBoard(projectId: string): Promise<BoardDocument> {
    const path = this.boardPath(projectId);
    return this.#serialized(path, () => readBoardFile(path));
  }

  readHistory(projectId: string): Promise<HistoryDocument> {
    const path = this.historyPath(projectId);
    return this.#serialized(path, () => readHistoryFile(path));
  }

  async createProject(
    input: Omit<StoredProject, "createdAt" | "updatedAt"> & Partial<Pick<StoredProject, "createdAt">>
  ): Promise<StoredProject> {
    assertProjectId(input.id);
    return this.#serialized(this.registryPath, async () => {
      const registry = await readRegistryFile(this.registryPath);
      if (registry.projects.some((project) => project.id === input.id))
        throw new Error(`Project already exists: ${input.id}`);
      if (input.folderId && !registry.folders.some((folder) => folder.id === input.folderId)) {
        throw new Error(`Folder does not exist: ${input.folderId}`);
      }
      const createdAt = input.createdAt ?? this.#now();
      const project: StoredProject = { ...input, createdAt, updatedAt: createdAt };
      // Children first: a crash can leave a harmless orphan, never a registry entry without files.
      await this.#writeJson(this.boardPath(input.id), emptyBoard());
      await this.#writeJson(this.historyPath(input.id), emptyHistory());
      await this.#writeJson(this.registryPath, {
        ...registry,
        revision: registry.revision + 1,
        projects: [...registry.projects, project]
      });
      return project;
    });
  }

  async updateProject(
    projectId: string,
    patch: Partial<Pick<StoredProject, "title" | "color" | "folderId" | "order" | "terminal">>
  ): Promise<StoredProject> {
    assertProjectId(projectId);
    return this.#serialized(this.registryPath, async () => {
      const registry = await readRegistryFile(this.registryPath);
      const index = registry.projects.findIndex((project) => project.id === projectId);
      if (index < 0) throw new Error(`Project does not exist: ${projectId}`);
      if (patch.folderId && !registry.folders.some((folder) => folder.id === patch.folderId)) {
        throw new Error(`Folder does not exist: ${patch.folderId}`);
      }
      const project = { ...registry.projects[index], ...patch, updatedAt: this.#now() };
      const projects = [...registry.projects];
      projects[index] = project;
      await this.#writeJson(this.registryPath, { ...registry, revision: registry.revision + 1, projects });
      return project;
    });
  }

  async deleteProject(projectId: string): Promise<boolean> {
    assertProjectId(projectId);
    return this.#serialized(this.registryPath, async () => {
      const registry = await readRegistryFile(this.registryPath);
      if (!registry.projects.some((project) => project.id === projectId)) return false;
      await this.#writeJson(this.registryPath, {
        ...registry,
        revision: registry.revision + 1,
        projects: registry.projects.filter((project) => project.id !== projectId)
      });
      // Registry first: a crash may leave an orphan directory, which is safe.
      // Board writes use a separate per-file queue, so one that already passed
      // its read can race this rm and recreate that orphan. This is intentional:
      // the registry remains authoritative and the format explicitly tolerates
      // orphan project directories.
      await rm(join(this.projectsPath, projectId), { recursive: true, force: true });
      return true;
    });
  }

  async createFolder(folder: StoredFolder): Promise<void> {
    await this.#serialized(this.registryPath, async () => {
      const registry = await readRegistryFile(this.registryPath);
      if (registry.folders.some((item) => item.id === folder.id))
        throw new Error(`Folder already exists: ${folder.id}`);
      await this.#writeJson(this.registryPath, {
        ...registry,
        revision: registry.revision + 1,
        folders: [...registry.folders, folder]
      });
    });
  }

  async updateFolder(folderId: string, patch: Partial<Pick<StoredFolder, "title" | "order">>): Promise<void> {
    await this.#serialized(this.registryPath, async () => {
      const registry = await readRegistryFile(this.registryPath);
      const index = registry.folders.findIndex((folder) => folder.id === folderId);
      if (index < 0) throw new Error(`Folder does not exist: ${folderId}`);
      const folders = [...registry.folders];
      folders[index] = { ...folders[index], ...patch };
      await this.#writeJson(this.registryPath, { ...registry, revision: registry.revision + 1, folders });
    });
  }

  async deleteFolder(folderId: string): Promise<boolean> {
    return this.#serialized(this.registryPath, async () => {
      const registry = await readRegistryFile(this.registryPath);
      if (!registry.folders.some((folder) => folder.id === folderId)) return false;
      const now = this.#now();
      const projects = registry.projects.map((project) =>
        project.folderId === folderId ? { ...project, folderId: undefined, updatedAt: now } : project
      );
      await this.#writeJson(this.registryPath, {
        ...registry,
        revision: registry.revision + 1,
        projects,
        folders: registry.folders.filter((folder) => folder.id !== folderId)
      });
      return true;
    });
  }

  async writeBoard(projectId: string, expectedRevision: number, document: unknown): Promise<BoardWriteResult> {
    const path = this.boardPath(projectId);
    return this.#serialized(path, async () => {
      const board = await readBoardFile(path);
      if (board.revision !== expectedRevision) {
        return { ok: false, conflict: { revision: board.revision, document: board.document } };
      }
      const next = { ...board, revision: board.revision + 1, document };
      await this.#writeJson(path, next);
      return { ok: true, board: next };
    });
  }

  /** Export the directly-copyable durable subset; logs and daemon state are excluded. */
  async exportState(projectIds?: readonly string[]): Promise<PortableStateBundle> {
    const registry = await this.readRegistry();
    const selected = projectIds ? new Set(projectIds) : new Set(registry.projects.map((project) => project.id));
    const projects = registry.projects.filter((project) => selected.has(project.id));
    if (projects.length === 0) throw new Error("State export contains no projects");
    if (projects.length !== selected.size) throw new Error("State export references an unknown project");
    const folderIds = new Set(projects.flatMap((project) => (project.folderId ? [project.folderId] : [])));
    const folders = registry.folders.filter((folder) => folderIds.has(folder.id));
    const pairs = await Promise.all(
      projects.map(
        async (project) => [project.id, await this.readBoard(project.id), await this.readHistory(project.id)] as const
      )
    );
    return {
      version: 2,
      exportedAt: this.#now(),
      registry: { ...registry, projects, folders },
      boards: Object.fromEntries(pairs.map(([id, board]) => [id, board])),
      histories: Object.fromEntries(pairs.map(([id, , history]) => [id, history]))
    };
  }

  /** Import selected projects. Existing state is never overwritten: IDs are cloned. */
  async importState(bundle: PortableStateBundle, projectIds?: readonly string[]): Promise<RegistryDocument> {
    if (bundle.version !== 2 || bundle.registry?.version !== STATE_FORMAT_VERSION)
      throw new Error("Unsupported state export version");
    return this.#serialized(this.registryPath, async () => {
      const registry = await readRegistryFile(this.registryPath);
      const selected = new Set(projectIds ?? bundle.registry.projects.map((project) => project.id));
      const sourceProjects = bundle.registry.projects.filter((project) => selected.has(project.id));
      if (sourceProjects.length === 0) throw new Error("State import contains no selected projects");
      if (sourceProjects.length !== selected.size) throw new Error("State import references an unknown project");
      for (const project of sourceProjects) {
        assertProjectId(project.id);
        if (typeof project.title !== "string" || !project.terminal || typeof project.terminal !== "object")
          throw new Error(`State import contains invalid project metadata: ${project.id}`);
        const board = bundle.boards[project.id];
        const history = bundle.histories[project.id];
        if (
          !board ||
          board.version !== STATE_FORMAT_VERSION ||
          !validRevision(board.revision) ||
          !Number.isSafeInteger(board.nextIdeaRef) ||
          board.nextIdeaRef < 1 ||
          !Object.hasOwn(board, "document") ||
          !history ||
          history.version !== STATE_FORMAT_VERSION ||
          !validRevision(history.revision) ||
          !Array.isArray(history.runs)
        )
          throw new Error(`State import is missing or has invalid project documents: ${project.id}`);
      }

      const preserveIds = registry.projects.length === 0 && registry.folders.length === 0;
      const sourceFolderIds = new Set(
        sourceProjects.flatMap((project) => (project.folderId ? [project.folderId] : []))
      );
      const sourceFolders = bundle.registry.folders.filter((folder) => sourceFolderIds.has(folder.id));
      if (sourceFolders.length !== sourceFolderIds.size) throw new Error("State import is missing a selected folder");
      for (const folder of sourceFolders) {
        assertProjectId(folder.id);
        if (typeof folder.title !== "string") throw new Error(`State import contains an invalid folder: ${folder.id}`);
      }
      const folderIds = new Map(
        sourceFolders.map((folder) => [folder.id, preserveIds ? folder.id : `fld_${randomUUID()}`])
      );
      const projectIdsBySource = new Map(
        sourceProjects.map((project) => [project.id, preserveIds ? project.id : `ws_${randomUUID()}`])
      );
      const folders = sourceFolders.map((folder) => ({ ...folder, id: folderIds.get(folder.id)! }));
      const projects = sourceProjects.map((project) => ({
        ...project,
        id: projectIdsBySource.get(project.id)!,
        folderId: project.folderId ? folderIds.get(project.folderId) : undefined,
        ...(preserveIds ? {} : { createdAt: this.#now(), updatedAt: this.#now() })
      }));

      // Children first, matching createProject's crash-safe ordering.
      for (const source of sourceProjects) {
        const id = projectIdsBySource.get(source.id)!;
        await this.#writeJson(this.boardPath(id), bundle.boards[source.id]);
        const history = bundle.histories[source.id];
        await this.#writeJson(this.historyPath(id), {
          ...history,
          runs: history.runs.map((run) => ({ ...run, projectId: id }))
        });
      }
      const next = {
        ...registry,
        revision: registry.revision + 1,
        projects: [...registry.projects, ...projects],
        folders: [...registry.folders, ...folders]
      };
      await this.#writeJson(this.registryPath, next);
      return next;
    });
  }

  async reserveIdeaRefs(projectId: string, count: number): Promise<string[]> {
    if (!Number.isSafeInteger(count) || count < 1)
      throw new Error("Idea ref reservation count must be a positive integer");
    const path = this.boardPath(projectId);
    return this.#serialized(path, async () => {
      const board = await readBoardFile(path);
      const refs = Array.from({ length: count }, (_, index) => `i${board.nextIdeaRef + index}`);
      // Ref allocation changes allocator metadata, not the document snapshot.
      // Keep the document revision stable so a client holding this revision can
      // reserve refs, create cards, and save without manufacturing a conflict.
      await this.#writeJson(path, { ...board, nextIdeaRef: board.nextIdeaRef + count });
      return refs;
    });
  }

  async appendHistoryEntry(projectId: string, entry: Record<string, unknown>): Promise<HistoryDocument> {
    // History files are per-project, so retaining the newest 50 here enforces
    // the cap for every client (including interrupted/reconnecting browsers).
    return this.#mutateHistory(projectId, (entries) =>
      [...entries.filter((existing) => existing.id !== entry.id), entry].slice(-50)
    );
  }

  async updateHistoryEntry(
    projectId: string,
    entryId: string,
    patch: Record<string, unknown>
  ): Promise<HistoryDocument> {
    return this.#mutateHistory(projectId, (runs) => {
      const index = runs.findIndex((run) => run.id === entryId);
      if (index < 0) throw new Error(`History entry does not exist: ${entryId}`);
      const next = [...runs];
      next[index] = { ...next[index], ...patch, id: entryId };
      return next;
    });
  }

  async deleteHistoryEntry(projectId: string, entryId: string): Promise<HistoryDocument> {
    return this.#mutateHistory(projectId, (runs) => runs.filter((run) => run.id !== entryId));
  }

  async clearHistory(projectId: string): Promise<HistoryDocument> {
    return this.#mutateHistory(projectId, () => []);
  }

  async #mutateHistory(
    projectId: string,
    mutate: (runs: Record<string, unknown>[]) => Record<string, unknown>[]
  ): Promise<HistoryDocument> {
    const path = this.historyPath(projectId);
    return this.#serialized(path, async () => {
      const history = await readHistoryFile(path);
      const next = { ...history, revision: history.revision + 1, runs: mutate(history.runs) };
      await this.#writeJson(path, next);
      return next;
    });
  }
}
