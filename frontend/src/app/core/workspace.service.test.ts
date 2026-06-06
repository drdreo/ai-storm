/**
 * Tests for the workspace-name ↔ BlockSuite document-title sync.
 *
 * Both directions are wired across WorkspaceService and CanvasService:
 *  - forward: create()/rename() push the workspace title onto the doc via
 *    CanvasService.setDocTitle;
 *  - reverse: a title typed into the page editor fires the callback registered
 *    with CanvasService.onDocTitleChanged, which renames the workspace.
 *
 * CanvasService is mocked (it would otherwise pull in BlockSuite + a DOM), and
 * the registry's IndexedDB persistence runs against fake-indexeddb so boot()
 * can rehydrate in the plain Node test env. A fresh IDBFactory + localStorage
 * stub per test keeps runs isolated.
 */

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Injector, runInInjectionContext } from "@angular/core";

// Replace the module that would otherwise import BlockSuite custom elements.
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

/** A CanvasService double that records title pushes and exposes the reverse sink. */
function makeCanvas() {
  let titleSink: ((id: string, title: string) => void) | null = null;
  return {
    init: vi.fn(async () => {}),
    ensureReady: vi.fn(async () => {}),
    ensureDoc: vi.fn(),
    setDocTitle: vi.fn(),
    switchTo: vi.fn(),
    removeWorkspace: vi.fn(),
    onDocTitleChanged: vi.fn((cb: (id: string, title: string) => void) => {
      titleSink = cb;
    }),
    /** Simulate the user typing a title into the BlockSuite page editor. */
    editTitleInEditor: (id: string, title: string) => titleSink?.(id, title),
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

describe("WorkspaceService — title ↔ document-title sync", () => {
  beforeEach(() => {
    // Fresh IDB + active-pointer store so each boot starts from a clean slate.
    (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    (globalThis as { localStorage: LocalStorageStub }).localStorage = new LocalStorageStub();
  });

  it("syncs the title onto the doc when a workspace is created or renamed", async () => {
    const { svc, canvas } = await bootService();
    canvas.setDocTitle.mockClear(); // ignore the boot/first-run stamping

    const id = svc.create("My Project");
    expect(canvas.setDocTitle).toHaveBeenCalledWith(id, "My Project");

    svc.rename(id, "Renamed Project");
    expect(canvas.setDocTitle).toHaveBeenLastCalledWith(id, "Renamed Project");
    expect(svc.workspaces().find((w) => w.id === id)?.title).toBe("Renamed Project");
  });

  it("renames the workspace when its document title is edited in the editor", async () => {
    const { svc, canvas } = await bootService();
    const id = svc.create("Initial");

    canvas.editTitleInEditor(id, "Edited In Editor");
    expect(svc.workspaces().find((w) => w.id === id)?.title).toBe("Edited In Editor");

    // Reverse sink ignores blank/whitespace and unchanged titles (loop guard) —
    // it must NOT push back to the doc and risk an editor↔sidebar cycle.
    canvas.setDocTitle.mockClear();
    canvas.editTitleInEditor(id, "   ");
    canvas.editTitleInEditor(id, "Edited In Editor");
    expect(svc.workspaces().find((w) => w.id === id)?.title).toBe("Edited In Editor");
    expect(canvas.setDocTitle).not.toHaveBeenCalled();
  });
});
