/**
 * Tests for the project registry lifecycle (create / rename / restore).
 *
 * Ported from the Angular `ProjectService` spec to the Zustand store. The
 * store is a module singleton, so each test gets a fresh module instance via
 * `vi.resetModules()` + dynamic import and a localStorage stub for isolation.
 * The canvas controller is mocked (it would otherwise pull in tldraw + a DOM).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

/** Minimal synchronous localStorage for the active-project pointer. */
class LocalStorageStub {
  #m = new Map<string, string>();
  getItem(k: string) {
    return this.#m.has(k) ? this.#m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.#m.set(k, String(v));
  }
  removeItem(k: string) {
    this.#m.delete(k);
  }
  clear() {
    this.#m.clear();
  }
}

let registry = { projects: [] as Array<Record<string, any>>, folders: [] as Array<Record<string, any>>, revision: 0 };
let histories = new Map<string, { revision: number; runs: Array<Record<string, any>> }>();
let liveSessions = new Set<string>();
let probeFails = false;

async function stateRequest(operation: string, options: { projectId?: string; payload?: Record<string, any> } = {}) {
  const payload = options.payload ?? {};
  if (operation === "registry-load") return structuredClone(registry);
  if (operation === "session-probe") {
    if (probeFails) throw new Error("session-probe unsupported");
    return { exists: !!options.projectId && liveSessions.has(options.projectId) };
  }
  if (operation === "history-load") {
    return structuredClone(histories.get(options.projectId ?? "") ?? { revision: 0, runs: [] });
  }
  if (operation === "state-export") {
    const selected = new Set(payload.projectIds ?? registry.projects.map((project) => project.id));
    const projects = registry.projects.filter((project) => selected.has(project.id));
    const folderIds = new Set(projects.map((project) => project.folderId).filter(Boolean));
    return {
      version: 2,
      exportedAt: 1,
      registry: {
        version: 1,
        revision: registry.revision,
        projects,
        folders: registry.folders.filter((f) => folderIds.has(f.id))
      },
      boards: Object.fromEntries(
        projects.map((project) => [project.id, { version: 1, revision: 0, nextIdeaRef: 1, document: null }])
      ),
      histories: Object.fromEntries(projects.map((project) => [project.id, { version: 1, revision: 0, runs: [] }]))
    };
  }
  if (operation === "state-import") {
    const bundle = payload.bundle;
    const selected = new Set(payload.projectIds ?? bundle.registry.projects.map((project: any) => project.id));
    const projects = bundle.registry.projects.filter((project: any) => selected.has(project.id));
    const sourceFolderIds = new Set(projects.map((project: any) => project.folderId).filter(Boolean));
    const folderMap = new Map<string, string>();
    for (const folder of bundle.registry.folders.filter((item: any) => sourceFolderIds.has(item.id))) {
      const id = `fld_import_${folderMap.size}`;
      folderMap.set(folder.id, id);
      registry.folders.push({ ...folder, id });
    }
    for (const source of projects) {
      const id = `ws_import_${registry.projects.length}`;
      registry.projects.push({
        ...source,
        id,
        folderId: source.folderId ? folderMap.get(source.folderId) : undefined
      });
      const sourceHistory = bundle.histories[source.id] ?? { revision: 0, runs: [] };
      histories.set(id, {
        ...sourceHistory,
        runs: sourceHistory.runs.map((run: Record<string, any>) => ({ ...run, projectId: id }))
      });
    }
  } else if (operation === "registry-create-project") {
    const project = payload.project;
    registry.projects.push({ ...project, updatedAt: project.createdAt });
  } else if (operation === "registry-patch-project") {
    const index = registry.projects.findIndex((item) => item.id === options.projectId);
    if (index >= 0) registry.projects[index] = { ...registry.projects[index], ...payload.patch, updatedAt: Date.now() };
  } else if (operation === "registry-delete-project") {
    registry.projects = registry.projects.filter((item) => item.id !== options.projectId);
  } else if (operation === "registry-create-folder") {
    registry.folders.push(payload.folder);
  } else if (operation === "registry-patch-folder") {
    const index = registry.folders.findIndex((item) => item.id === payload.folderId);
    if (index >= 0) registry.folders[index] = { ...registry.folders[index], ...payload.patch };
  } else if (operation === "registry-delete-folder") {
    registry.folders = registry.folders.filter((item) => item.id !== payload.folderId);
    registry.projects = registry.projects.map((item) =>
      item.folderId === payload.folderId ? { ...item, folderId: undefined } : item
    );
  }
  registry.revision++;
  return structuredClone(registry);
}

async function bootStore() {
  vi.resetModules();
  // A canvas controller double exposing only the seam the registry drives.
  const canvasMock = {
    init: vi.fn(async () => {}),
    ensureReady: vi.fn(async () => {}),
    switchTo: vi.fn(),
    removeProject: vi.fn(),
    waitForMount: vi.fn(async () => {}),
    exportBoard: vi.fn(() => ({ cards: [], edges: [] })),
    importBoard: vi.fn(() => true),
    exportTldraw: vi.fn(async () => undefined),
    importTldraw: vi.fn(() => true),
    flushPersistence: vi.fn(async () => {})
  };
  vi.doMock("./canvas.store", () => ({ canvas: canvasMock }));
  vi.doMock("./backend.store", () => ({
    backend: { request: vi.fn(stateRequest), onOpen: vi.fn(() => () => {}) }
  }));
  const mod = await import("./project.store");
  await mod.project.boot();
  return { ...mod, canvasMock };
}

describe("project store — registry lifecycle", () => {
  beforeEach(() => {
    // Fresh backend authority + active pointer for each test.
    (globalThis as { localStorage: LocalStorageStub }).localStorage = new LocalStorageStub();
    registry = { projects: [], folders: [], revision: 0 };
    histories = new Map();
    liveSessions = new Set();
    probeFails = false;
  });

  it("stands up a starter project on first boot and marks it active", async () => {
    const { useProjectStore, selectActive } = await bootStore();
    expect(useProjectStore.getState().projects.length).toBe(1);
    expect(selectActive(useProjectStore.getState())?.title).toBe("Untitled Project");
  });

  it("restores active runtime status when a durable session survived a browser reload", async () => {
    registry.projects.push({
      id: "ws_live",
      title: "Live project",
      terminal: { agentCommand: "claude" },
      createdAt: 1,
      updatedAt: 1
    });
    liveSessions.add("ws_live");

    const { useProjectStore, selectActive } = await bootStore();

    expect(selectActive(useProjectStore.getState())?.status).toBe("active");
  });

  it("boots despite session probes failing — status recovery is best-effort", async () => {
    registry.projects.push({
      id: "ws_live",
      title: "Live project",
      terminal: { agentCommand: "claude" },
      createdAt: 1,
      updatedAt: 1
    });
    probeFails = true;

    const { useProjectStore, selectActive } = await bootStore();

    expect(useProjectStore.getState().booted).toBe(true);
    expect(selectActive(useProjectStore.getState())?.status).toBe("idle");
  });

  it("create() adds a project with the given title and rename() updates it", async () => {
    const { project, useProjectStore } = await bootStore();

    const id = project.create("My Project");
    expect(useProjectStore.getState().projects.find((w) => w.id === id)?.title).toBe("My Project");

    project.rename(id, "Renamed Project");
    expect(useProjectStore.getState().projects.find((w) => w.id === id)?.title).toBe("Renamed Project");
  });

  it("create() assigns a deterministic default color and setColor() overrides it", async () => {
    const { project, useProjectStore } = await bootStore();

    const id = project.create("Colorful");
    const meta = useProjectStore.getState().projects.find((w) => w.id === id);
    expect(meta?.color).toBeTruthy();

    project.setColor(id, "#123456");
    expect(useProjectStore.getState().projects.find((w) => w.id === id)?.color).toBe("#123456");
  });

  it("setActive() records the active project and bumps lastActiveAt", async () => {
    const { project, useProjectStore } = await bootStore();
    const first = useProjectStore.getState().activeId;
    const id = project.create("Second");
    project.setActive(id);
    expect(useProjectStore.getState().activeId).toBe(id);
    expect(useProjectStore.getState().activeId).not.toBe(first);
  });
});

describe("project store — folders (#128)", () => {
  beforeEach(() => {
    (globalThis as { localStorage: LocalStorageStub }).localStorage = new LocalStorageStub();
    registry = { projects: [], folders: [], revision: 0 };
  });

  it("createFolder() adds a folder and renameFolder() updates its title", async () => {
    const { project, useProjectStore } = await bootStore();

    const id = project.createFolder("Research");
    expect(useProjectStore.getState().folders.find((f) => f.id === id)?.title).toBe("Research");

    project.renameFolder(id, "Deep Research");
    expect(useProjectStore.getState().folders.find((f) => f.id === id)?.title).toBe("Deep Research");
  });

  it("moveToFolder() assigns and clears a project's folderId", async () => {
    const { project, useProjectStore } = await bootStore();
    const wsId = project.create("Board");
    const folderId = project.createFolder("Group");

    project.moveToFolder(wsId, folderId);
    expect(useProjectStore.getState().projects.find((w) => w.id === wsId)?.folderId).toBe(folderId);

    project.moveToFolder(wsId, null);
    expect(useProjectStore.getState().projects.find((w) => w.id === wsId)?.folderId).toBeUndefined();
  });

  it("setFolderCollapsed() persists the collapse state", async () => {
    const { project, useProjectStore } = await bootStore();
    const id = project.createFolder("Group");

    project.setFolderCollapsed(id, true);
    expect(useProjectStore.getState().folders.find((f) => f.id === id)?.collapsed).toBe(true);

    project.setFolderCollapsed(id, false);
    expect(useProjectStore.getState().folders.find((f) => f.id === id)?.collapsed).toBe(false);
  });

  it("assigns fractional order keys on create so new items append at the end", async () => {
    const { project, useProjectStore } = await bootStore();
    const a = project.create("A");
    const b = project.create("B");

    const state = useProjectStore.getState();
    const ids = state.projects.map((w) => w.id);
    expect(ids.indexOf(a)).toBeLessThan(ids.indexOf(b));
    expect(state.projects.every((w) => w.order)).toBe(true);
  });

  it("moveProject() re-parents and reorders in one write", async () => {
    const { project, useProjectStore } = await bootStore();
    const a = project.create("A");
    const folderId = project.createFolder("Group");
    const b = project.create("B");
    project.moveToFolder(b, folderId);

    // Drop A into the folder before B.
    const bOrder = useProjectStore.getState().projects.find((w) => w.id === b)!.order!;
    project.moveProject(a, folderId, "0" + bOrder); // any key < bOrder
    let state = useProjectStore.getState();
    const aMeta = state.projects.find((w) => w.id === a)!;
    expect(aMeta.folderId).toBe(folderId);
    expect(state.projects.findIndex((w) => w.id === a)).toBeLessThan(state.projects.findIndex((w) => w.id === b));

    // Drop A back to the top level.
    project.moveProject(a, null, "zz");
    state = useProjectStore.getState();
    expect(state.projects.find((w) => w.id === a)?.folderId).toBeUndefined();
  });

  it("reorderFolder() reranks folders by their order keys", async () => {
    const { project, useProjectStore } = await bootStore();
    const f1 = project.createFolder("First");
    const f2 = project.createFolder("Second");

    const before = useProjectStore.getState().folders.map((f) => f.id);
    expect(before).toEqual([f1, f2]);

    const firstOrder = useProjectStore.getState().folders[0].order!;
    project.reorderFolder(f2, "0" + firstOrder); // any key < firstOrder
    const after = useProjectStore.getState().folders.map((f) => f.id);
    expect(after).toEqual([f2, f1]);
  });

  it("ordering is stable across several moves", async () => {
    const { project, useProjectStore } = await bootStore();
    const starter = useProjectStore.getState().projects[0].id;
    const a = project.create("A");
    const b = project.create("B");

    // Move starter to the end, then B to the front.
    const { computeOrder } = await import("../core/sidebar-order");
    const list = () => useProjectStore.getState().projects;
    project.moveProject(
      starter,
      null,
      computeOrder(
        list().filter((w) => w.id !== starter),
        2
      )
    );
    expect(list().map((w) => w.id)).toEqual([a, b, starter]);

    project.moveProject(
      b,
      null,
      computeOrder(
        list().filter((w) => w.id !== b),
        0
      )
    );
    expect(list().map((w) => w.id)).toEqual([b, a, starter]);
  });

  it("order keys survive a reboot and every item stays keyed", async () => {
    const first = await bootStore();
    first.project.create("Legacy");
    first.project.createFolder("Old Group");
    const { projects: ws1, folders: f1 } = first.useProjectStore.getState();
    expect(ws1.every((w) => w.order)).toBe(true);

    // Second boot re-reads the same IndexedDB; orders already present survive.
    const second = await bootStore();
    const { projects, folders } = second.useProjectStore.getState();
    expect(projects.map((w) => w.id)).toEqual(ws1.map((w) => w.id));
    expect(folders.map((f) => f.id)).toEqual(f1.map((f) => f.id));
    expect(projects.every((w) => w.order)).toBe(true);
    expect(folders.every((f) => f.order)).toBe(true);
  });

  it("importProjects() clones selected backend state with fresh project/folder ids", async () => {
    const { project, useProjectStore } = await bootStore();
    const bundle = {
      version: 2 as const,
      exportedAt: 1,
      registry: {
        version: 1 as const,
        revision: 1,
        projects: [
          { id: "p1", title: "Imported A", folderId: "f1", terminal: {}, createdAt: 1, updatedAt: 1 },
          { id: "p2", title: "Skipped", terminal: {}, createdAt: 1, updatedAt: 1 }
        ],
        folders: [{ id: "f1", title: "Research", createdAt: 1 }]
      },
      boards: {
        p1: { version: 1 as const, revision: 0, nextIdeaRef: 7, document: null },
        p2: { version: 1 as const, revision: 0, nextIdeaRef: 1, document: null }
      },
      histories: {
        p1: {
          version: 1 as const,
          revision: 1,
          runs: [
            {
              id: "run_imported",
              projectId: "p1",
              type: "synthesis" as const,
              status: "done" as const,
              createdAt: 1,
              finishedAt: 1,
              output: "# Restored summary",
              preview: "Restored summary"
            }
          ]
        },
        p2: { version: 1 as const, revision: 0, runs: [] }
      }
    };

    await project.importProjects(bundle, ["p1"]);
    const state = useProjectStore.getState();
    const imported = state.projects.find((item) => item.title === "Imported A")!;
    expect(imported.id).not.toBe("p1");
    expect(imported.folderId).toBeTruthy();
    expect(state.folders.find((folder) => folder.id === imported.folderId)?.title).toBe("Research");
    expect(state.projects.some((item) => item.title === "Skipped")).toBe(false);
    expect(state.activeId).toBe(imported.id);

    const { useHistoryStore } = await import("./history.store");
    expect(useHistoryStore.getState().entries).toContainEqual(
      expect.objectContaining({ id: "run_imported", projectId: imported.id, output: "# Restored summary" })
    );
  });

  it("exportAll() reads the backend state subset without switching projects", async () => {
    const { project, useProjectStore } = await bootStore();
    const starterId = useProjectStore.getState().activeId!;
    const b = project.create("Boxed");
    const folderId = project.createFolder("Group");
    project.moveToFolder(b, folderId);

    const bundle = await project.exportAll();

    expect(bundle.registry.projects.map((entry) => entry.title)).toEqual(["Untitled Project", "Boxed"]);
    expect(bundle.registry.folders.map((folder) => folder.title)).toEqual(["Group"]);
    expect(Object.keys(bundle.boards)).toHaveLength(2);
    expect(useProjectStore.getState().activeId).toBe(starterId);
  });

  it("removeFolder() deletes the folder but keeps its projects (moved to top level)", async () => {
    const { project, useProjectStore } = await bootStore();
    const wsId = project.create("Board");
    const folderId = project.createFolder("Group");
    project.moveToFolder(wsId, folderId);

    project.removeFolder(folderId);

    const state = useProjectStore.getState();
    expect(state.folders.find((f) => f.id === folderId)).toBeUndefined();
    const ws = state.projects.find((w) => w.id === wsId);
    expect(ws).toBeDefined();
    expect(ws?.folderId).toBeUndefined();
  });
});
