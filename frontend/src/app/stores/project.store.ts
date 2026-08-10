import { create } from "zustand";
import { backend } from "./backend.store";
import type { Folder, PortableStateBundle, ProjectMeta, ProjectStatus } from "@ai-storm/shared";
import { canvas } from "./canvas.store";
import { history } from "./history.store";
import { defaultTerminalConfig, defaultProjectColor } from "../core/models";
import { compareByOrder, orderAfterAll } from "../core/sidebar-order";
import { withSpan } from "../../lib/log";

const ACTIVE_KEY = "ai-storm.activeProject";

/**
 * Multi-project registry & lifecycle (PRD §3.4, §3.5).
 *
 * Durable metadata is loaded and mutated through the backend state protocol.
 * Zustand holds the optimistic UI projection; only the active-project pointer
 * and folder-collapse preferences remain browser-local.
 */

interface ProjectState {
  projects: ProjectMeta[];
  folders: Folder[];
  activeId: string | null;
  booted: boolean;
}

export const useProjectStore = create<ProjectState>(() => ({
  projects: [],
  folders: [],
  activeId: null,
  booted: false
}));

/** Derived selector: the active project meta (or null). */
export function selectActive(s: ProjectState): ProjectMeta | null {
  return s.activeId ? (s.projects.find((w) => w.id === s.activeId) ?? null) : null;
}

interface RegistryWire {
  projects: Array<{
    id: string;
    title: string;
    color?: string;
    folderId?: string;
    order?: string;
    terminal: ProjectMeta["terminal"];
    createdAt: number;
    updatedAt: number;
  }>;
  folders: Array<{ id: string; title: string; createdAt: number; order?: string }>;
}

const folderCollapsed = new Map<string, boolean>();
const collapsedKey = (id: string) => `ai-storm:ui:folder:${id}:collapsed`;

function applyRegistry(registry: RegistryWire): void {
  const statuses = new Map(useProjectStore.getState().projects.map((item) => [item.id, item.status]));
  const projects: ProjectMeta[] = registry.projects
    .map((item) => ({
      ...item,
      status: statuses.get(item.id) ?? "idle",
      // Compatibility field only: backend `updatedAt` tracks registry edits,
      // not actual UI activity. Active-project restoration uses localStorage.
      lastActiveAt: item.updatedAt
    }))
    .sort(compareByOrder);
  const folders: Folder[] = registry.folders
    .map((item) => ({
      ...item,
      collapsed: folderCollapsed.get(item.id) ?? localStorage.getItem(collapsedKey(item.id)) === "1"
    }))
    .sort(compareByOrder);
  useProjectStore.setState({ projects, folders });
}
function getMeta(id: string): ProjectMeta | undefined {
  return useProjectStore.getState().projects.find((item) => item.id === id);
}
function getFolder(id: string): Folder | undefined {
  return useProjectStore.getState().folders.find((item) => item.id === id);
}
function optimisticProject(meta: ProjectMeta): void {
  const projects = useProjectStore.getState().projects.filter((item) => item.id !== meta.id);
  useProjectStore.setState({ projects: [...projects, meta].sort(compareByOrder) });
}
function optimisticFolder(folder: Folder): void {
  const folders = useProjectStore.getState().folders.filter((item) => item.id !== folder.id);
  useProjectStore.setState({ folders: [...folders, folder].sort(compareByOrder) });
}
async function reloadRegistry(): Promise<void> {
  applyRegistry(await backend.request<RegistryWire>("registry-load"));
}

/** Recover non-durable runtime status after a browser reload. The registry does
 * not persist "active" because only the session backend can authoritatively say
 * whether a PTY/tmux session still exists. Strictly best-effort: restoring a
 * status badge must never block boot, so a failed probe counts as "no session". */
async function probeLiveSessions(): Promise<void> {
  const projects = useProjectStore.getState().projects;
  const probes = await Promise.all(
    projects.map(async ({ id }) => {
      try {
        const result = await backend.request<{ exists: boolean }>("session-probe", { projectId: id });
        return [id, result.exists] as const;
      } catch {
        return [id, false] as const;
      }
    })
  );
  const live = new Set(probes.filter(([, exists]) => exists).map(([id]) => id));
  if (live.size === 0) return;
  useProjectStore.setState((state) => ({
    projects: state.projects.map((item) => (live.has(item.id) ? { ...item, status: "active" as const } : item))
  }));
}
function durableProject(meta: ProjectMeta): Record<string, unknown> {
  return {
    title: meta.title,
    color: meta.color,
    folderId: meta.folderId,
    order: meta.order,
    terminal: { ...meta.terminal }
  };
}
function patchProject(meta: ProjectMeta): void {
  optimisticProject(meta);
  void backend
    .request<RegistryWire>("registry-patch-project", {
      projectId: meta.id,
      payload: { patch: durableProject(meta) }
    })
    .then(applyRegistry)
    .catch(() => {
      void reloadRegistry().catch(() => undefined);
    });
}
function patchFolder(folder: Folder): void {
  optimisticFolder(folder);
  void backend
    .request<RegistryWire>("registry-patch-folder", {
      payload: { folderId: folder.id, patch: { title: folder.title, order: folder.order } }
    })
    .then(applyRegistry)
    .catch(() => {
      void reloadRegistry().catch(() => undefined);
    });
}

// Registry mutations intentionally do not queue offline. On reconnect, replace
// optimistic ghosts with the authoritative registry so the UI cannot imply
// durability that never happened.
backend.onOpen(() => {
  if (useProjectStore.getState().booted) void reloadRegistry().catch(() => undefined);
});

export const project = {
  /** Boot only from the backend authority. No IndexedDB fallback is attempted. */
  async boot(): Promise<void> {
    if (useProjectStore.getState().booted) return;
    await withSpan("project.boot", {}, async () => {
      await canvas.init();
      await reloadRegistry();
      await probeLiveSessions();
      let projects = useProjectStore.getState().projects;
      if (projects.length === 0) {
        const id = `ws_${crypto.randomUUID()}`;
        const now = Date.now();
        const meta: ProjectMeta = {
          id,
          title: "Untitled Project",
          status: "idle",
          createdAt: now,
          lastActiveAt: now,
          terminal: defaultTerminalConfig(),
          color: defaultProjectColor(id),
          order: orderAfterAll([])
        };
        applyRegistry(
          await backend.request<RegistryWire>("registry-create-project", {
            payload: { project: { id, ...durableProject(meta), createdAt: now } }
          })
        );
        projects = useProjectStore.getState().projects;
      }
      const stored = localStorage.getItem(ACTIVE_KEY);
      const active = stored && projects.some((item) => item.id === stored) ? stored : projects[0]?.id;
      if (active) {
        project.setActive(active);
        await canvas.ensureReady(active);
      }
      useProjectStore.setState({ booted: true });
    });
  },

  create(title: string): string {
    const id = `ws_${crypto.randomUUID()}`;
    const now = Date.now();
    const ungrouped = useProjectStore.getState().projects.filter((w) => !w.folderId);
    const meta: ProjectMeta = {
      id,
      title,
      status: "idle",
      createdAt: now,
      lastActiveAt: now,
      terminal: defaultTerminalConfig(),
      color: defaultProjectColor(id),
      order: orderAfterAll(ungrouped)
    };
    optimisticProject(meta);
    void backend
      .request<RegistryWire>("registry-create-project", {
        payload: { project: { id, ...durableProject(meta), createdAt: now } }
      })
      .then(applyRegistry)
      .catch(() => {
        void reloadRegistry().catch(() => undefined);
      });
    return id;
  },

  rename(id: string, title: string): void {
    const meta = getMeta(id);
    if (meta) patchProject({ ...meta, title });
  },

  setStatus(id: string, status: ProjectStatus): void {
    const meta = getMeta(id);
    if (meta && meta.status !== status) optimisticProject({ ...meta, status });
  },

  setColor(id: string, color: string): void {
    const meta = getMeta(id);
    if (meta && meta.color !== color) patchProject({ ...meta, color });
  },

  // ---- Folders (#128) ------------------------------------------------------

  /** Create an (initially empty) sidebar folder, returning its id. */
  createFolder(title: string): string {
    const id = `fld_${crypto.randomUUID()}`;
    const folders = useProjectStore.getState().folders;
    const folder = { id, title, createdAt: Date.now(), order: orderAfterAll(folders) };
    optimisticFolder(folder);
    void backend
      .request<RegistryWire>("registry-create-folder", { payload: { folder } })
      .then(applyRegistry)
      .catch(() => {
        void reloadRegistry().catch(() => undefined);
      });
    return id;
  },

  renameFolder(id: string, title: string): void {
    const folder = getFolder(id);
    if (folder) patchFolder({ ...folder, title });
  },

  setFolderCollapsed(id: string, collapsed: boolean): void {
    const folder = getFolder(id);
    if (folder && !!folder.collapsed !== collapsed) {
      folderCollapsed.set(id, collapsed);
      localStorage.setItem(collapsedKey(id), collapsed ? "1" : "0");
      optimisticFolder({ ...folder, collapsed });
    }
  },

  /**
   * Delete a folder. Folders are pure containers, so its projects are never
   * deleted — they fall back to the sidebar's top level (folderId cleared).
   */
  removeFolder(id: string): void {
    const state = useProjectStore.getState();
    folderCollapsed.delete(id);
    localStorage.removeItem(collapsedKey(id));
    useProjectStore.setState({
      projects: state.projects.map((meta) => (meta.folderId === id ? { ...meta, folderId: undefined } : meta)),
      folders: state.folders.filter((folder) => folder.id !== id)
    });
    void backend
      .request<RegistryWire>("registry-delete-folder", { payload: { folderId: id } })
      .then(applyRegistry)
      .catch(() => {
        void reloadRegistry().catch(() => undefined);
      });
  },

  /**
   * Move a project into a folder, or to the top level when `folderId` is
   * null, appending it after its new siblings (the "Move to folder" menu path).
   */
  moveToFolder(projectId: string, folderId: string | null): void {
    const meta = getMeta(projectId);
    if (!meta) return;
    const next = folderId ?? undefined;
    if (meta.folderId === next) return;
    const siblings = useProjectStore
      .getState()
      .projects.filter((w) => (w.folderId ?? undefined) === next && w.id !== projectId);
    patchProject({ ...meta, folderId: next, order: orderAfterAll(siblings) });
  },

  /**
   * Drop a project at an explicit position (#128 DnD): re-parents to
   * `folderId` (null → top level) and sets the fractional sort key in a single
   * write, so a cross-container drag is one granular backend update.
   */
  moveProject(projectId: string, folderId: string | null, order: string): void {
    const meta = getMeta(projectId);
    if (!meta) return;
    patchProject({ ...meta, folderId: folderId ?? undefined, order });
  },

  /** Drop a folder at an explicit position among folders (#128 DnD). */
  reorderFolder(folderId: string, order: string): void {
    const folder = getFolder(folderId);
    if (folder) patchFolder({ ...folder, order });
  },

  patchTerminal(id: string, patch: Partial<ProjectMeta["terminal"]>): void {
    const meta = getMeta(id);
    if (meta) patchProject({ ...meta, terminal: { ...meta.terminal, ...patch } });
  },

  setActive(id: string): void {
    if (useProjectStore.getState().activeId === id) return;
    useProjectStore.setState({ activeId: id });
    localStorage.setItem(ACTIVE_KEY, id);
    const meta = getMeta(id);
    if (meta) optimisticProject({ ...meta, lastActiveAt: Date.now() });
  },

  async remove(id: string): Promise<void> {
    const wasActive = useProjectStore.getState().activeId === id;
    let target = useProjectStore.getState().projects.find((w) => w.id !== id) ?? null;
    if (wasActive && !target) {
      // Deleting the last project — stand up a replacement to switch onto.
      const fresh = project.create("Untitled Project");
      target = getMeta(fresh) ?? null;
    }

    // When deleting the ACTIVE project, switch the canvas onto the target
    // project's store before dropping the deleted one's persisted store.
    if (wasActive && target) {
      await canvas.ensureReady(target.id);
      project.setActive(target.id);
      canvas.switchTo(target.id);
    }

    useProjectStore.setState((state) => ({ projects: state.projects.filter((item) => item.id !== id) }));
    history.removeProject(id, false);
    await backend.request<RegistryWire>("registry-delete-project", { projectId: id }).then(applyRegistry);
    canvas.removeProject(id);
  },

  /** Export one project directly from the backend-owned durable state. */
  async exportBundle(id: string): Promise<PortableStateBundle | null> {
    if (!getMeta(id)) return null;
    await canvas.flushPersistence();
    return backend.request<PortableStateBundle>("state-export", { payload: { projectIds: [id] } });
  },

  /** Export registry, every board, and every history; logs/daemon state stay local. */
  async exportAll(): Promise<PortableStateBundle> {
    await canvas.flushPersistence();
    return backend.request<PortableStateBundle>("state-export");
  },

  /**
   * Open the project holding an idea and frame that card (#124) — the landing
   * action for a full-text search result. Switches onto the target project if
   * needed (same path as clicking its sidebar row), waits for its editor to
   * mount, then selects + pans/zooms to the card. Returns false if the shape no
   * longer exists (e.g. the card was deleted since the index was gathered).
   */
  async revealIdea(projectId: string, shapeId: string): Promise<boolean> {
    if (!getMeta(projectId)) return false;
    if (useProjectStore.getState().activeId !== projectId) {
      project.setActive(projectId);
      canvas.switchTo(projectId);
    }
    await canvas.waitForMount(projectId);
    return canvas.focusIdea(projectId, shapeId);
  },

  /** Clone selected projects/folders through the backend; existing state is never overwritten. */
  async importProjects(bundle: PortableStateBundle, projectIds?: readonly string[]): Promise<void> {
    await canvas.flushPersistence();
    const existingIds = new Set(useProjectStore.getState().projects.map((item) => item.id));
    const registry = await backend.request<RegistryWire>("state-import", {
      payload: { bundle, ...(projectIds ? { projectIds: [...projectIds] } : {}) }
    });
    applyRegistry(registry);
    const imported = registry.projects.filter((item) => !existingIds.has(item.id));
    // `state-import` writes each cloned history document on the backend, but
    // history.boot() has already run for the pre-import registry. Hydrate the
    // new ids now so History reflects the restored backup immediately.
    await history.loadProjects(imported.map((item) => item.id));
    const target = imported.at(-1) ?? registry.projects.at(-1);
    if (target) {
      project.setActive(target.id);
      canvas.switchTo(target.id);
      await canvas.ensureReady(target.id);
    }
  }
};
