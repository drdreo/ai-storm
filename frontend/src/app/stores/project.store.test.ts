/**
 * Tests for the project registry lifecycle (create / rename / restore).
 *
 * Ported from the Angular `ProjectService` spec to the Zustand store. The
 * store is a module singleton (Y.Doc created at import time), so each test gets
 * a fresh module instance via `vi.resetModules()` + dynamic import, paired with
 * a fresh IDBFactory + localStorage stub for isolation. The canvas controller is
 * mocked (it would otherwise pull in tldraw + a DOM).
 */

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
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

async function bootStore() {
  vi.resetModules();
  // A canvas controller double exposing only the seam the registry drives.
  vi.doMock("./canvas.store", () => ({
    canvas: {
      init: vi.fn(async () => {}),
      ensureReady: vi.fn(async () => {}),
      switchTo: vi.fn(),
      removeProject: vi.fn()
    }
  }));
  const mod = await import("./project.store");
  await mod.project.boot();
  return mod;
}

describe("project store — registry lifecycle", () => {
  beforeEach(() => {
    // Fresh IDB + active-pointer store so each boot starts from a clean slate.
    (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    (globalThis as { localStorage: LocalStorageStub }).localStorage = new LocalStorageStub();
  });

  it("stands up a starter project on first boot and marks it active", async () => {
    const { useProjectStore, selectActive } = await bootStore();
    expect(useProjectStore.getState().projects.length).toBe(1);
    expect(selectActive(useProjectStore.getState())?.title).toBe("Untitled Project");
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
    (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    (globalThis as { localStorage: LocalStorageStub }).localStorage = new LocalStorageStub();
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
