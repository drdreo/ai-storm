/**
 * Tests for the ingestion split (extraction-contract §8.1, §9):
 *  - `chat`  → the control hub scrollback signal (never the canvas)
 *  - `ideas` → CanvasService.applyBlocks via the render scheduler
 *  - the markdown parser is NOT applied to the live stream (chat is verbatim).
 *
 * The heavy/IO collaborators (BlockSuite canvas, the WebSocket backend) are
 * mocked so the service runs in the plain Node test env; the service is built
 * inside a minimal injector via `runInInjectionContext` (no DOM / TestBed).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Injector, runInInjectionContext } from "@angular/core";
import type { ResponseMessage } from "@ai-storm/shared";

// Replace modules that would otherwise pull in BlockSuite / a real socket.
vi.mock("./canvas.service", () => ({ CanvasService: class {} }));
vi.mock("./backend.service", () => ({ BackendService: class {} }));
vi.mock("./workspace.service", () => ({ WorkspaceService: class {} }));

import { IngestionService } from "./ingestion.service";
import { CanvasService } from "./canvas.service";
import { BackendService } from "./backend.service";
import { WorkspaceService } from "./workspace.service";

type Listener = (msg: unknown) => void;

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
  const emit = (msg: Omit<ResponseMessage, "type">) => listener?.({ type: "response", ...msg });
  return { svc, applyBlocks, emit };
}

describe("IngestionService — chat/ideas split", () => {
  let h: ReturnType<typeof makeService>;
  beforeEach(() => {
    h = makeService();
  });

  it("appends chat to the hub signal and never to the canvas", () => {
    h.emit({ workspaceId: "ws1", chat: ["Let me know which to explore."], ideas: [], complete: true });
    expect(h.svc.terminalLines("ws1")()).toEqual(["Let me know which to explore."]);
    expect(h.applyBlocks).not.toHaveBeenCalled();
  });

  it("sends ideas to the canvas (applyBlocks) and not to the hub", () => {
    h.emit({
      workspaceId: "ws1",
      chat: [],
      ideas: [{ title: "Offline-first canvas", body: "cache CRDT ops" }],
      complete: true,
    });
    expect(h.applyBlocks).toHaveBeenCalledTimes(1);
    expect(h.applyBlocks).toHaveBeenCalledWith("ws1", [
      { type: "heading", level: 3, text: "Offline-first canvas" },
      { type: "paragraph", text: "cache CRDT ops" },
    ]);
    expect(h.svc.terminalLines("ws1")()).toEqual([]);
  });

  it("does NOT run the markdown parser over the chat stream (chat stays verbatim)", () => {
    // A chat line that LOOKS like a markdown heading must remain plain text in
    // the hub and must never be turned into a canvas block.
    h.emit({ workspaceId: "ws1", chat: ["# Not a canvas heading", "- not a bullet"], ideas: [], complete: true });
    expect(h.svc.terminalLines("ws1")()).toEqual(["# Not a canvas heading", "- not a bullet"]);
    expect(h.applyBlocks).not.toHaveBeenCalled();
  });
});
