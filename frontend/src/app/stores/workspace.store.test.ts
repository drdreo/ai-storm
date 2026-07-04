/**
 * Tests for the workspace registry lifecycle (create / rename / restore).
 *
 * Ported from the Angular `WorkspaceService` spec to the Zustand store. The
 * store is a module singleton (Y.Doc created at import time), so each test gets
 * a fresh module instance via `vi.resetModules()` + dynamic import, paired with
 * a fresh IDBFactory + localStorage stub for isolation. The canvas controller is
 * mocked (it would otherwise pull in tldraw + a DOM).
 */

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, it, expect, vi, beforeEach } from "vitest";

/** Minimal synchronous localStorage for the active-workspace pointer. */
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

async function bootStore() {
  vi.resetModules();
  // A canvas controller double exposing only the seam the registry drives.
  vi.doMock("./canvas.store", () => ({
    canvas: {
      init: vi.fn(async () => {}),
      ensureReady: vi.fn(async () => {}),
      switchTo: vi.fn(),
      removeWorkspace: vi.fn()
    }
  }));
  const mod = await import("./workspace.store");
  await mod.workspace.boot();
  return mod;
}

describe("workspace store — registry lifecycle", () => {
  beforeEach(() => {
    // Fresh IDB + active-pointer store so each boot starts from a clean slate.
    (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    (globalThis as { localStorage: LocalStorageStub }).localStorage = new LocalStorageStub();
  });

  it("stands up a starter workspace on first boot and marks it active", async () => {
    const { useWorkspaceStore, selectActive } = await bootStore();
    expect(useWorkspaceStore.getState().workspaces.length).toBe(1);
    expect(selectActive(useWorkspaceStore.getState())?.title).toBe("Untitled Project");
  });

  it("create() adds a workspace with the given title and rename() updates it", async () => {
    const { workspace, useWorkspaceStore } = await bootStore();

    const id = workspace.create("My Project");
    expect(useWorkspaceStore.getState().workspaces.find((w) => w.id === id)?.title).toBe("My Project");

    workspace.rename(id, "Renamed Project");
    expect(useWorkspaceStore.getState().workspaces.find((w) => w.id === id)?.title).toBe("Renamed Project");
  });

  it("create() assigns a deterministic default color and setColor() overrides it", async () => {
    const { workspace, useWorkspaceStore } = await bootStore();

    const id = workspace.create("Colorful");
    const meta = useWorkspaceStore.getState().workspaces.find((w) => w.id === id);
    expect(meta?.color).toBeTruthy();

    workspace.setColor(id, "#123456");
    expect(useWorkspaceStore.getState().workspaces.find((w) => w.id === id)?.color).toBe("#123456");
  });

  it("setActive() records the active workspace and bumps lastActiveAt", async () => {
    const { workspace, useWorkspaceStore } = await bootStore();
    const first = useWorkspaceStore.getState().activeId;
    const id = workspace.create("Second");
    workspace.setActive(id);
    expect(useWorkspaceStore.getState().activeId).toBe(id);
    expect(useWorkspaceStore.getState().activeId).not.toBe(first);
  });
});

describe("workspace store — folders (#128)", () => {
  beforeEach(() => {
    (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    (globalThis as { localStorage: LocalStorageStub }).localStorage = new LocalStorageStub();
  });

  it("createFolder() adds a folder and renameFolder() updates its title", async () => {
    const { workspace, useWorkspaceStore } = await bootStore();

    const id = workspace.createFolder("Research");
    expect(useWorkspaceStore.getState().folders.find((f) => f.id === id)?.title).toBe("Research");

    workspace.renameFolder(id, "Deep Research");
    expect(useWorkspaceStore.getState().folders.find((f) => f.id === id)?.title).toBe("Deep Research");
  });

  it("moveToFolder() assigns and clears a workspace's folderId", async () => {
    const { workspace, useWorkspaceStore } = await bootStore();
    const wsId = workspace.create("Board");
    const folderId = workspace.createFolder("Group");

    workspace.moveToFolder(wsId, folderId);
    expect(useWorkspaceStore.getState().workspaces.find((w) => w.id === wsId)?.folderId).toBe(folderId);

    workspace.moveToFolder(wsId, null);
    expect(useWorkspaceStore.getState().workspaces.find((w) => w.id === wsId)?.folderId).toBeUndefined();
  });

  it("setFolderCollapsed() persists the collapse state", async () => {
    const { workspace, useWorkspaceStore } = await bootStore();
    const id = workspace.createFolder("Group");

    workspace.setFolderCollapsed(id, true);
    expect(useWorkspaceStore.getState().folders.find((f) => f.id === id)?.collapsed).toBe(true);

    workspace.setFolderCollapsed(id, false);
    expect(useWorkspaceStore.getState().folders.find((f) => f.id === id)?.collapsed).toBe(false);
  });

  it("assigns fractional order keys on create so new items append at the end", async () => {
    const { workspace, useWorkspaceStore } = await bootStore();
    const a = workspace.create("A");
    const b = workspace.create("B");

    const state = useWorkspaceStore.getState();
    const ids = state.workspaces.map((w) => w.id);
    expect(ids.indexOf(a)).toBeLessThan(ids.indexOf(b));
    expect(state.workspaces.every((w) => w.order)).toBe(true);
  });

  it("moveWorkspace() re-parents and reorders in one write", async () => {
    const { workspace, useWorkspaceStore } = await bootStore();
    const a = workspace.create("A");
    const folderId = workspace.createFolder("Group");
    const b = workspace.create("B");
    workspace.moveToFolder(b, folderId);

    // Drop A into the folder before B.
    const bOrder = useWorkspaceStore.getState().workspaces.find((w) => w.id === b)!.order!;
    workspace.moveWorkspace(a, folderId, "0" + bOrder); // any key < bOrder
    let state = useWorkspaceStore.getState();
    const aMeta = state.workspaces.find((w) => w.id === a)!;
    expect(aMeta.folderId).toBe(folderId);
    expect(state.workspaces.findIndex((w) => w.id === a)).toBeLessThan(state.workspaces.findIndex((w) => w.id === b));

    // Drop A back to the top level.
    workspace.moveWorkspace(a, null, "zz");
    state = useWorkspaceStore.getState();
    expect(state.workspaces.find((w) => w.id === a)?.folderId).toBeUndefined();
  });

  it("reorderFolder() reranks folders by their order keys", async () => {
    const { workspace, useWorkspaceStore } = await bootStore();
    const f1 = workspace.createFolder("First");
    const f2 = workspace.createFolder("Second");

    const before = useWorkspaceStore.getState().folders.map((f) => f.id);
    expect(before).toEqual([f1, f2]);

    const firstOrder = useWorkspaceStore.getState().folders[0].order!;
    workspace.reorderFolder(f2, "0" + firstOrder); // any key < firstOrder
    const after = useWorkspaceStore.getState().folders.map((f) => f.id);
    expect(after).toEqual([f2, f1]);
  });

  it("ordering is stable across several moves", async () => {
    const { workspace, useWorkspaceStore } = await bootStore();
    const starter = useWorkspaceStore.getState().workspaces[0].id;
    const a = workspace.create("A");
    const b = workspace.create("B");

    // Move starter to the end, then B to the front.
    const { computeOrder } = await import("../core/sidebar-order");
    const list = () => useWorkspaceStore.getState().workspaces;
    workspace.moveWorkspace(
      starter,
      null,
      computeOrder(
        list().filter((w) => w.id !== starter),
        2
      )
    );
    expect(list().map((w) => w.id)).toEqual([a, b, starter]);

    workspace.moveWorkspace(
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
    first.workspace.create("Legacy");
    first.workspace.createFolder("Old Group");
    const { workspaces: ws1, folders: f1 } = first.useWorkspaceStore.getState();
    expect(ws1.every((w) => w.order)).toBe(true);

    // Second boot re-reads the same IndexedDB; orders already present survive.
    const second = await bootStore();
    const { workspaces, folders } = second.useWorkspaceStore.getState();
    expect(workspaces.map((w) => w.id)).toEqual(ws1.map((w) => w.id));
    expect(folders.map((f) => f.id)).toEqual(f1.map((f) => f.id));
    expect(workspaces.every((w) => w.order)).toBe(true);
    expect(folders.every((f) => f.order)).toBe(true);
  });

  it("removeFolder() deletes the folder but keeps its workspaces (moved to top level)", async () => {
    const { workspace, useWorkspaceStore } = await bootStore();
    const wsId = workspace.create("Board");
    const folderId = workspace.createFolder("Group");
    workspace.moveToFolder(wsId, folderId);

    workspace.removeFolder(folderId);

    const state = useWorkspaceStore.getState();
    expect(state.folders.find((f) => f.id === folderId)).toBeUndefined();
    const ws = state.workspaces.find((w) => w.id === wsId);
    expect(ws).toBeDefined();
    expect(ws?.folderId).toBeUndefined();
  });
});
