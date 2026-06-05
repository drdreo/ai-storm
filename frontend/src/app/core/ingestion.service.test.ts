/**
 * Tests for the ingestion split (extraction-contract §8.1):
 *  - `data` → the registered terminal sink (the xterm.js conversation surface),
 *             buffered until a terminal mounts, then flushed.
 *  - `idea` → CanvasService.applyBlocks via the render scheduler (one batched
 *             CRDT mutation per frame).
 *
 * The heavy/IO collaborators (BlockSuite canvas, the WebSocket backend) are
 * mocked so the service runs in the plain Node test env; the service is built
 * inside a minimal injector via `runInInjectionContext` (no DOM / TestBed).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Injector, runInInjectionContext } from "@angular/core";

// Replace modules that would otherwise pull in BlockSuite / a real socket.
vi.mock("./canvas.service", () => ({ CanvasService: class {} }));
vi.mock("./backend.service", () => ({ BackendService: class {} }));
vi.mock("./workspace.service", () => ({ WorkspaceService: class {} }));

import { IngestionService } from "./ingestion.service";
import { CanvasService } from "./canvas.service";
import { BackendService } from "./backend.service";
import { WorkspaceService } from "./workspace.service";

type Listener = (msg: unknown) => void;

/** The render scheduler flushes on a ~16ms setTimeout frame in Node. */
const nextFrame = () => new Promise((r) => setTimeout(r, 25));

function makeService() {
  const applyBlocks = vi.fn();
  let listener: Listener | null = null;
  const backend = {
    subscribe: (_id: string, cb: Listener) => {
      listener = cb;
      return () => {};
    },
    onOpen: (_cb: () => void) => () => {},
    connect: () => {},
    send: () => {},
  };
  const workspace = { setStatus: vi.fn() };
  const injector = Injector.create({
    providers: [
      { provide: CanvasService, useValue: { applyBlocks } },
      { provide: BackendService, useValue: backend },
      { provide: WorkspaceService, useValue: workspace },
    ],
  });
  const svc = runInInjectionContext(injector, () => new IngestionService());
  svc.attach("ws1", { agentCommand: "claude" } as never);
  const emitIdea = (idea: { title: string; body: string; kind?: string }) =>
    listener?.({ type: "idea", workspaceId: "ws1", idea });
  const emitData = (data: string) => listener?.({ type: "data", workspaceId: "ws1", data });
  return { svc, applyBlocks, emitIdea, emitData };
}

describe("IngestionService — data/idea split", () => {
  let h: ReturnType<typeof makeService>;
  beforeEach(() => {
    h = makeService();
  });

  it("routes an idea to the canvas (applyBlocks) and never to the terminal", async () => {
    const write = vi.fn();
    h.svc.registerTerminal("ws1", { write, clear: vi.fn() });

    h.emitIdea({ title: "Offline-first canvas", body: "cache CRDT ops" });
    await nextFrame();

    expect(h.applyBlocks).toHaveBeenCalledTimes(1);
    expect(h.applyBlocks).toHaveBeenCalledWith("ws1", [
      { type: "heading", level: 3, text: "Offline-first canvas" },
      { type: "paragraph", text: "cache CRDT ops" },
    ]);
    expect(write).not.toHaveBeenCalled();
  });

  it("forwards raw data to a registered terminal sink and not to the canvas", () => {
    const write = vi.fn();
    h.svc.registerTerminal("ws1", { write, clear: vi.fn() });

    h.emitData("aGVsbG8=");
    expect(write).toHaveBeenCalledWith("aGVsbG8=");
    expect(h.applyBlocks).not.toHaveBeenCalled();
  });

  it("buffers data that arrives before the terminal mounts, then flushes on register", () => {
    h.emitData("Zmlyc3Q="); // "first"
    h.emitData("c2Vjb25k"); // "second"

    const write = vi.fn();
    h.svc.registerTerminal("ws1", { write, clear: vi.fn() });

    expect(write.mock.calls.map((c) => c[0])).toEqual(["Zmlyc3Q=", "c2Vjb25k"]);
  });

  it("clearTerminal delegates to the registered sink", () => {
    const clear = vi.fn();
    h.svc.registerTerminal("ws1", { write: vi.fn(), clear });
    h.svc.clearTerminal("ws1");
    expect(clear).toHaveBeenCalledTimes(1);
  });
});
