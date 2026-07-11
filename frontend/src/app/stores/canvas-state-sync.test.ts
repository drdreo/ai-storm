import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSnapshot } from "tldraw";

vi.mock("tldraw", async (importOriginal) => {
  const actual = await importOriginal<typeof import("tldraw")>();
  return {
    ...actual,
    getSnapshot: (store: { getStoreSnapshot(): unknown }) => ({ document: store.getStoreSnapshot(), session: {} }),
    loadSnapshot: vi.fn()
  };
});

const harness = vi.hoisted(() => {
  const openHandlers = new Set<() => void>();
  return {
    openHandlers,
    connection: { state: "open" as "open" | "closed" },
    request: vi.fn(),
    send: vi.fn()
  };
});

vi.mock("../core/canvas-island", () => ({
  applyIdeas: vi.fn(),
  applyScore: vi.fn(),
  applyCompletion: vi.fn(),
  applyIssueLinks: vi.fn(),
  applyReference: vi.fn(),
  collectBoard: vi.fn(() => ({ cards: [], edges: [] })),
  exportBoard: vi.fn(),
  exportTldrawPages: vi.fn(),
  importBoard: vi.fn(),
  importTldrawPages: vi.fn(),
  selectedText: vi.fn(() => ""),
  serializeBoardIdeasSnapshot: vi.fn(() => ({
    version: 1,
    pageId: "page:page",
    updatedAt: 0,
    cards: [],
    edges: [],
    selection: { refs: [], ids: [] }
  })),
  serializeEditor: vi.fn(() => ""),
  serializeForHandoff: vi.fn(() => ""),
  serializeForTriage: vi.fn(() => "")
}));

vi.mock("./backend.store", () => ({
  backend: {
    request: harness.request,
    send: harness.send,
    onOpen(handler: () => void) {
      harness.openHandlers.add(handler);
      return () => harness.openHandlers.delete(handler);
    }
  },
  useBackendStore: { getState: () => harness.connection }
}));

class StorageStub {
  values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

describe("backend board synchronization", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    harness.request.mockReset();
    harness.send.mockReset();
    harness.openHandlers.clear();
    harness.connection.state = "open";
    (globalThis as { localStorage: StorageStub }).localStorage = new StorageStub();
  });

  it("loads before mount, acknowledges a debounced document save, and drops a stale queued snapshot on reconnect", async () => {
    let revision = 0;
    let serverDocument: unknown = null;
    let disconnected = false;
    harness.request.mockImplementation(async (operation: string, options: { payload?: Record<string, unknown> }) => {
      if (operation === "board-load") return { revision, document: serverDocument };
      if (operation === "reserve-idea-refs")
        return { refs: Array.from({ length: Number(options.payload?.count) }, (_, i) => `i${i + 1}`) };
      if (operation === "board-save") {
        if (disconnected) throw new Error("Backend connection lost");
        revision++;
        serverDocument = options.payload?.document;
        return { ok: true, board: { revision } };
      }
      throw new Error(`Unexpected ${operation}`);
    });

    const { canvas, useCanvasStore } = await import("./canvas.store");
    await canvas.init();
    await canvas.ensureReady("p1");
    canvas.switchTo("p1");
    const store = useCanvasStore.getState().activeStore!;
    expect(useCanvasStore.getState().loadState).toBe("ready");

    const editor = {
      store,
      getCurrentPageId: () => "page:page",
      getCurrentPageShapes: () => [],
      getSelectedShapeIds: () => []
    };
    canvas.bridge.onEditorMount(editor as never);
    canvas.bridge.onBoardChanged?.();
    await vi.advanceTimersByTimeAsync(500);
    expect(harness.request).toHaveBeenCalledWith(
      "board-save",
      expect.objectContaining({
        projectId: "p1",
        payload: expect.objectContaining({ expectedRevision: 0, document: getSnapshot(store).document })
      })
    );
    expect(useCanvasStore.getState().unsaved).toBe(false);

    disconnected = true;
    harness.connection.state = "closed";
    canvas.bridge.onBoardChanged?.();
    await vi.advanceTimersByTimeAsync(500);
    expect(useCanvasStore.getState().unsaved).toBe(true);

    revision = 2;
    serverDocument = getSnapshot(store).document;
    disconnected = false;
    harness.connection.state = "open";
    await Promise.all([...harness.openHandlers].map((handler) => handler()));
    await vi.runAllTimersAsync();
    expect(useCanvasStore.getState().unsaved).toBe(false);
  });
});
