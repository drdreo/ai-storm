import { create } from "zustand";
import * as Y from "yjs";
import { IndexeddbPersistence } from "y-indexeddb";
import type { Folder, ProjectMeta, ProjectStatus } from "@ai-storm/shared";
import { canvas } from "./canvas.store";
import { defaultTerminalConfig, defaultProjectColor } from "../core/models";
import { compareByOrder, orderAfterAll } from "../core/sidebar-order";
import { buildExportBundle, type ProjectExportBundle } from "../core/project-portable";
import { withSpan } from "../../lib/log";

const REGISTRY_ROOM = "ai-storm-registry";
const ACTIVE_KEY = "ai-storm.activeProject";

/**
 * Multi-project registry & lifecycle (PRD §3.4, §3.5).
 *
 * Project metadata is stored in a dedicated CRDT Y.Doc persisted to its own
 * IndexedDB store, so every change (title, status) is written immediately and
 * survives crashes. The canvas content for each project is owned by the
 * {@link canvas} controller (a tldraw store per project). On boot we
 * rehydrate both layers and restore the most recently active project exactly
 * as it was left.
 *
 * This is a 1:1 port of the Angular `ProjectService`: signals → Zustand state,
 * the Y.Doc/persistence are imperative module singletons.
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

// ---- Imperative CRDT singletons (outside React) ----------------------------

const registryDoc = new Y.Doc();
let registryPersistence: IndexeddbPersistence;
let map: Y.Map<ProjectMeta>;
let folderMap: Y.Map<Folder>;

function syncFromMap(): void {
  const list: ProjectMeta[] = [];
  map.forEach((meta) => list.push(meta));
  list.sort(compareByOrder);
  const folders: Folder[] = [];
  folderMap.forEach((f) => folders.push(f));
  folders.sort(compareByOrder);
  useProjectStore.setState({ projects: list, folders });
}

/**
 * Self-heal registries persisted before explicit ordering existed (#128 DnD):
 * if any item lacks an `order` key, re-key the whole collection in its current
 * sorted order so every later insertion can assume keyed neighbors. Runs once
 * at boot; after that all writes carry keys.
 */
function backfillOrders(): void {
  const { projects, folders } = useProjectStore.getState();
  registryDoc.transact(() => {
    if (!projects.every((w) => w.order)) {
      const keyed: ProjectMeta[] = [];
      for (const ws of projects) {
        const next = { ...ws, order: orderAfterAll(keyed) };
        write(next);
        keyed.push(next);
      }
    }
    if (!folders.every((f) => f.order)) {
      const keyed: Folder[] = [];
      for (const f of folders) {
        const next = { ...f, order: orderAfterAll(keyed) };
        writeFolder(next);
        keyed.push(next);
      }
    }
  });
}

function write(meta: ProjectMeta): void {
  // Structured-clone a plain object into the CRDT map (writes immediately).
  map.set(meta.id, { ...meta, terminal: { ...meta.terminal } });
}

function writeFolder(folder: Folder): void {
  folderMap.set(folder.id, { ...folder });
}

export const project = {
  /** Boot sequence (PRD §3.5): rehydrate CRDT stores, restore last project. */
  async boot(): Promise<void> {
    if (useProjectStore.getState().booted) return;
    await withSpan("project.boot", {}, async () => {
      await canvas.init();

      map = registryDoc.getMap<ProjectMeta>("projects");
      folderMap = registryDoc.getMap<Folder>("folders");
      registryPersistence = new IndexeddbPersistence(REGISTRY_ROOM, registryDoc);
      await new Promise<void>((resolve) => {
        registryPersistence.once("synced", () => resolve());
      });

      // Keep state in sync with the CRDT registry (immediate writes §3.5).
      map.observe(() => syncFromMap());
      folderMap.observe(() => syncFromMap());
      syncFromMap();
      backfillOrders();

      const projects = useProjectStore.getState().projects;
      if (projects.length === 0) {
        // First run — stand up a starter project.
        const id = project.create("Untitled Project");
        project.setActive(id);
      } else {
        // Restore the most recently active project.
        const stored = localStorage.getItem(ACTIVE_KEY);
        const exists = stored && projects.some((w) => w.id === stored);
        const fallback = [...projects].sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
        project.setActive(exists ? stored! : fallback.id);
      }

      // Let the canvas settle before rendering the panes (PRD §3.5 boot). tldraw
      // loads the active project's store on mount, so this is a cheap no-op kept
      // for parity / future async restore.
      const active = useProjectStore.getState().activeId;
      if (active) await canvas.ensureReady(active);

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
    write(meta);
    return id;
  },

  rename(id: string, title: string): void {
    const meta = map.get(id);
    if (!meta) return;
    write({ ...meta, title });
  },

  setStatus(id: string, status: ProjectStatus): void {
    const meta = map.get(id);
    if (meta && meta.status !== status) write({ ...meta, status });
  },

  setColor(id: string, color: string): void {
    const meta = map.get(id);
    if (meta && meta.color !== color) write({ ...meta, color });
  },

  // ---- Folders (#128) ------------------------------------------------------

  /** Create an (initially empty) sidebar folder, returning its id. */
  createFolder(title: string): string {
    const id = `fld_${crypto.randomUUID()}`;
    const folders = useProjectStore.getState().folders;
    writeFolder({ id, title, createdAt: Date.now(), order: orderAfterAll(folders) });
    return id;
  },

  renameFolder(id: string, title: string): void {
    const folder = folderMap.get(id);
    if (folder) writeFolder({ ...folder, title });
  },

  setFolderCollapsed(id: string, collapsed: boolean): void {
    const folder = folderMap.get(id);
    if (folder && !!folder.collapsed !== collapsed) writeFolder({ ...folder, collapsed });
  },

  /**
   * Delete a folder. Folders are pure containers, so its projects are never
   * deleted — they fall back to the sidebar's top level (folderId cleared).
   */
  removeFolder(id: string): void {
    registryDoc.transact(() => {
      map.forEach((meta) => {
        if (meta.folderId === id) write({ ...meta, folderId: undefined });
      });
      folderMap.delete(id);
    });
  },

  /**
   * Move a project into a folder, or to the top level when `folderId` is
   * null, appending it after its new siblings (the "Move to folder" menu path).
   */
  moveToFolder(projectId: string, folderId: string | null): void {
    const meta = map.get(projectId);
    if (!meta) return;
    const next = folderId ?? undefined;
    if (meta.folderId === next) return;
    const siblings = useProjectStore
      .getState()
      .projects.filter((w) => (w.folderId ?? undefined) === next && w.id !== projectId);
    write({ ...meta, folderId: next, order: orderAfterAll(siblings) });
  },

  /**
   * Drop a project at an explicit position (#128 DnD): re-parents to
   * `folderId` (null → top level) and sets the fractional sort key in a single
   * write, so a cross-container drag is one CRDT update.
   */
  moveProject(projectId: string, folderId: string | null, order: string): void {
    const meta = map.get(projectId);
    if (!meta) return;
    write({ ...meta, folderId: folderId ?? undefined, order });
  },

  /** Drop a folder at an explicit position among folders (#128 DnD). */
  reorderFolder(folderId: string, order: string): void {
    const folder = folderMap.get(folderId);
    if (folder) writeFolder({ ...folder, order });
  },

  patchTerminal(id: string, patch: Partial<ProjectMeta["terminal"]>): void {
    const meta = map.get(id);
    if (meta) write({ ...meta, terminal: { ...meta.terminal, ...patch } });
  },

  setActive(id: string): void {
    if (useProjectStore.getState().activeId === id) return;
    useProjectStore.setState({ activeId: id });
    localStorage.setItem(ACTIVE_KEY, id);
    const meta = map.get(id);
    if (meta) write({ ...meta, lastActiveAt: Date.now() });
  },

  async remove(id: string): Promise<void> {
    const wasActive = useProjectStore.getState().activeId === id;
    let target = useProjectStore.getState().projects.find((w) => w.id !== id) ?? null;
    if (wasActive && !target) {
      // Deleting the last project — stand up a replacement to switch onto.
      const fresh = project.create("Untitled Project");
      target = map.get(fresh) ?? null;
    }

    // When deleting the ACTIVE project, switch the canvas onto the target
    // project's store before dropping the deleted one's persisted store.
    if (wasActive && target) {
      await canvas.ensureReady(target.id);
      project.setActive(target.id);
      canvas.switchTo(target.id);
    }

    map.delete(id);
    canvas.removeProject(id);
  },

  /**
   * Export a project to a portable bundle (#105). Reading the board requires a
   * live editor, so a non-active project is switched onto first (an export
   * click opens/activates that project, same as clicking its sidebar row).
   */
  async exportBundle(id: string): Promise<ProjectExportBundle | null> {
    const meta = map.get(id);
    if (!meta) return null;
    if (useProjectStore.getState().activeId !== id) {
      project.setActive(id);
      canvas.switchTo(id);
    }
    await canvas.waitForMount(id);
    const board = canvas.exportBoard(id);
    if (!board) return null;
    return buildExportBundle(meta, board);
  },

  /**
   * Open the project holding an idea and frame that card (#124) — the landing
   * action for a full-text search result. Switches onto the target project if
   * needed (same path as clicking its sidebar row), waits for its editor to
   * mount, then selects + pans/zooms to the card. Returns false if the shape no
   * longer exists (e.g. the card was deleted since the index was gathered).
   */
  async revealIdea(projectId: string, shapeId: string): Promise<boolean> {
    if (!map.get(projectId)) return false;
    if (useProjectStore.getState().activeId !== projectId) {
      project.setActive(projectId);
      canvas.switchTo(projectId);
    }
    await canvas.waitForMount(projectId);
    return canvas.focusIdea(projectId, shapeId);
  },

  /**
   * Import a bundle as a brand-new project (#105) — never overwrites an
   * existing one. Standing up + activating the project mirrors `create` +
   * `setActive`; the imported board is rendered once its (fresh, empty) editor
   * mounts.
   */
  async importBundle(bundle: ProjectExportBundle): Promise<string> {
    const id = project.create(bundle.project.title);
    const meta = map.get(id)!;
    write({
      ...meta,
      color: bundle.project.color ?? meta.color,
      terminal: { ...meta.terminal, ...bundle.project.terminal }
    });
    project.setActive(id);
    canvas.switchTo(id);
    await canvas.waitForMount(id);
    canvas.importBoard(id, bundle.board);
    return id;
  }
};
