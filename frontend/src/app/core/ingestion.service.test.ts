/**
 * Tests for the ingestion split (extraction-contract §8.1):
 *  - `data` → the registered terminal sink (the xterm.js conversation surface),
 *             buffered until a terminal mounts, then flushed.
 *  - `idea` → CanvasService.applyIdeas via the render scheduler (one discrete
 *             card per idea; ideas in one frame batched into a single CRDT
 *             mutation).
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
  const applyIdeas = vi.fn();
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
      { provide: CanvasService, useValue: { applyIdeas } },
      { provide: BackendService, useValue: backend },
      { provide: WorkspaceService, useValue: workspace },
    ],
  });
  const svc = runInInjectionContext(injector, () => new IngestionService());
  svc.attach("ws1", { agentCommand: "claude" } as never);
  const emitIdea = (idea: { title: string; body: string; kind?: string }) =>
    listener?.({ type: "idea", workspaceId: "ws1", idea });
  const emitData = (data: string) => listener?.({ type: "data", workspaceId: "ws1", data });
  return { svc, applyIdeas, emitIdea, emitData };
}

describe("IngestionService — data/idea split", () => {
  let h: ReturnType<typeof makeService>;
  beforeEach(() => {
    h = makeService();
  });

  it("routes an idea to the canvas (applyIdeas) and never to the terminal", async () => {
    const write = vi.fn();
    h.svc.registerTerminal("ws1", { write, clear: vi.fn() });

    const idea = { title: "Offline-first canvas", body: "cache CRDT ops" };
    h.emitIdea(idea);
    await nextFrame();

    expect(h.applyIdeas).toHaveBeenCalledTimes(1);
    expect(h.applyIdeas).toHaveBeenCalledWith("ws1", [idea]);
    expect(write).not.toHaveBeenCalled();
  });

  it("creates a card once for a re-emitted idea (resize re-render guard, #38)", async () => {
    const idea = { title: "Edge cache", body: "serve from the CDN", kind: "feature" };
    h.emitIdea(idea);
    // A pane resize re-wraps the rendered idea, so the backend re-emits it with
    // slightly different whitespace — the same idea, not a new card.
    h.emitIdea({ ...idea, body: "serve  from   the\tCDN" });
    h.emitIdea(idea);
    await nextFrame();

    expect(h.applyIdeas).toHaveBeenCalledTimes(1);
    expect(h.applyIdeas).toHaveBeenCalledWith("ws1", [idea]);
  });

  it("treats a genuinely different idea as a new card", async () => {
    h.emitIdea({ title: "A", body: "one" });
    h.emitIdea({ title: "B", body: "two" });
    await nextFrame();
    expect(h.applyIdeas).toHaveBeenCalledTimes(1); // one batched frame…
    expect(h.applyIdeas).toHaveBeenCalledWith("ws1", [
      { title: "A", body: "one" },
      { title: "B", body: "two" },
    ]);
  });

  it("forwards raw data to a registered terminal sink and not to the canvas", () => {
    const write = vi.fn();
    h.svc.registerTerminal("ws1", { write, clear: vi.fn() });

    h.emitData("aGVsbG8=");
    expect(write).toHaveBeenCalledWith("aGVsbG8=");
    expect(h.applyIdeas).not.toHaveBeenCalled();
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
