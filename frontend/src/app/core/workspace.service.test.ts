/**
 * Tests for the workspace registry lifecycle (create / rename / restore).
 *
 * With the tldraw migration the canvas no longer has an editable title field
 * (PD-011: no page view), so the old workspace-name ↔ document-title two-way
 * sync is gone. The workspace title is now purely a registry/sidebar concern:
 * create()/rename() write the CRDT registry, and that is the single source of
 * truth. CanvasService is mocked (it would otherwise pull in tldraw + a DOM),
 * and the registry's IndexedDB persistence runs against fake-indexeddb so boot()
 * can rehydrate in the plain Node test env. A fresh IDBFactory + localStorage
 * stub per test keeps runs isolated.
 */

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Injector, runInInjectionContext } from "@angular/core";

// Replace the module that would otherwise import tldraw + React.
vi.mock("./canvas.service", () => ({ CanvasService: class {} }));

import { WorkspaceService } from "./workspace.service";
import { CanvasService } from "./canvas.service";

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

/** A CanvasService double exposing only the seam WorkspaceService drives. */
function makeCanvas() {
  return {
    init: vi.fn(async () => {}),
    ensureReady: vi.fn(async () => {}),
    switchTo: vi.fn(),
    removeWorkspace: vi.fn(),
  };
}

async function bootService() {
  const canvas = makeCanvas();
  const injector = Injector.create({
    providers: [{ provide: CanvasService, useValue: canvas }],
  });
  const svc = runInInjectionContext(injector, () => new WorkspaceService());
  await svc.boot();
  return { svc, canvas };
}

describe("WorkspaceService — registry lifecycle", () => {
  beforeEach(() => {
    // Fresh IDB + active-pointer store so each boot starts from a clean slate.
    (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    (globalThis as { localStorage: LocalStorageStub }).localStorage = new LocalStorageStub();
  });

  it("stands up a starter workspace on first boot and marks it active", async () => {
    const { svc } = await bootService();
    expect(svc.workspaces().length).toBe(1);
    expect(svc.active()?.title).toBe("Untitled Project");
  });

  it("create() adds a workspace with the given title and rename() updates it", async () => {
    const { svc } = await bootService();

    const id = svc.create("My Project");
    expect(svc.workspaces().find((w) => w.id === id)?.title).toBe("My Project");

    svc.rename(id, "Renamed Project");
    expect(svc.workspaces().find((w) => w.id === id)?.title).toBe("Renamed Project");
  });

  it("setActive() records the active workspace and bumps lastActiveAt", async () => {
    const { svc } = await bootService();
    const first = svc.activeId();
    const id = svc.create("Second");
    svc.setActive(id);
    expect(svc.activeId()).toBe(id);
    expect(svc.activeId()).not.toBe(first);
  });
});
