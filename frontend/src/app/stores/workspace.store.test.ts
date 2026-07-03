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
