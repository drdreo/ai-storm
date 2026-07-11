/**
 * Unit tests for the MCP capture endpoint, registry routing, and tmux token
 * durability (mcp-idea-capture design §9 cases 1–6). The endpoint is pure
 * JSON-RPC over Hono, so everything runs against `app.request()` with injected
 * registries — no real server, harness, or tmux needed; the durability cases
 * reuse the fake-tmux seam from the extraction tests.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { Hono } from "hono";
import type { Completion, Idea, Reference, Score } from "@ai-storm/shared";
import type { BoardDocument, RegistryDocument, StateStore } from "../state/store.ts";
import { mcpRoutes } from "./endpoint.ts";
import { McpSessionRegistry } from "./registry.ts";
import { IdeaScanner, IdeaSink, ScoreSink, scanIdeas } from "../session/extraction/index.ts";
import { TmuxSessionBackend } from "../session/tmux-backend.ts";
import { fakeTmux } from "../session/test-support/fake-tmux.ts";
import { log } from "../log.ts";

// ── Harness plumbing ──

const BASE = "http://127.0.0.1:8787";

function setup() {
  const registry = new McpSessionRegistry();
  registry.configure(BASE);
  let registryDocument: RegistryDocument = { version: 1, revision: 0, projects: [], folders: [] };
  const boards = new Map<string, BoardDocument>();
  const stateStore = {
    readRegistry: vi.fn(async () => registryDocument),
    readBoard: vi.fn(async (projectId: string) => {
      const board = boards.get(projectId);
      if (!board) throw new Error("missing board");
      return board;
    })
  } as unknown as StateStore;
  const app = new Hono().route("/mcp", mcpRoutes(registry, stateStore));
  return {
    registry,
    app,
    boards,
    setRegistry(document: RegistryDocument) {
      registryDocument = document;
    }
  };
}

/** Register + attach a project, collecting everything its callbacks emit. */
function wire(registry: McpSessionRegistry, projectId: string) {
  const target = registry.registerSession(projectId)!;
  const ideaSink = new IdeaSink();
  const scoreSink = new ScoreSink();
  const ideas: Idea[] = [];
  const scores: Score[] = [];
  const completions: Completion[] = [];
  const references: Reference[] = [];
  registry.attachSession(projectId, {
    ideaSink,
    scoreSink,
    onIdea: (i) => ideas.push(i),
    onScore: (s) => scores.push(s),
    onCompletion: (c) => completions.push(c),
    onReference: (r) => references.push(r)
  });
  return { ...target, ideaSink, scoreSink, ideas, scores, completions, references };
}

function storedBoard(...records: Record<string, unknown>[]): BoardDocument {
  return {
    version: 1,
    revision: 3,
    nextIdeaRef: 4,
    document: { store: Object.fromEntries(records.map((record) => [record.id, record])) }
  };
}

function storedProject(id: string, title: string, folderId?: string) {
  return {
    id,
    title,
    folderId,
    terminal: { cwd: `C:/secret/${id}`, args: ["--secret"] },
    createdAt: 100,
    updatedAt: 200
  };
}
let rpcId = 0;

async function rpc(app: Hono, ws: string, token: string, method: string, params?: unknown) {
  const res = await app.request(`/mcp/${ws}/${token}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params })
  });
  return res;
}

async function callTool(app: Hono, ws: string, token: string, name: string, args: unknown) {
  const res = await rpc(app, ws, token, "tools/call", { name, arguments: args });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    result?: { content: { type: string; text: string }[]; isError?: boolean };
    error?: { code: number; message: string };
  };
  return body;
}

/** Tool-result text (asserting the call did not fail at the JSON-RPC level). */
function textOf(body: Awaited<ReturnType<typeof callTool>>): string {
  expect(body.error).toBeUndefined();
  return body.result!.content[0].text;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ── MCP protocol surface (sessionless Streamable HTTP minimum) ──

describe("MCP endpoint — protocol surface", () => {
  it("initialize negotiates the protocol version and declares the tools capability", async () => {
    const { registry, app } = setup();
    const { token } = wire(registry, "ws1");

    const res = await rpc(app, "ws1", token, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "claude-code", version: "x" }
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // A revision we speak verbatim is echoed back.
    expect(body.result.protocolVersion).toBe("2025-06-18");
    expect(body.result.capabilities).toEqual({ tools: {} });
    expect(body.result.serverInfo.name).toBe("ai-storm");
  });

  it("counter-offers 2025-03-26 for an unknown protocol version", async () => {
    const { registry, app } = setup();
    const { token } = wire(registry, "ws1");
    const res = await rpc(app, "ws1", token, "initialize", { protocolVersion: "1999-01-01" });
    expect((await res.json()).result.protocolVersion).toBe("2025-03-26");
  });

  it("accepts and ignores notifications (202, no body)", async () => {
    const { registry, app } = setup();
    const { token } = wire(registry, "ws1");
    const res = await app.request(`/mcp/ws1/${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })
    });
    expect(res.status).toBe(202);
  });

  it("lists the capture + completion tools with their schemas", async () => {
    const { registry, app } = setup();
    const { token } = wire(registry, "ws1");
    const res = await rpc(app, "ws1", token, "tools/list");
    const { tools } = (await res.json()).result;
    expect(tools.map((t: { name: string }) => t.name)).toEqual([
      "capture_idea",
      "capture_score",
      "mark_idea_done",
      "link_idea",
      "get_board_ideas",
      "get_projects"
    ]);
    expect(tools[0].inputSchema.required).toEqual(["title"]);
    expect(tools[1].inputSchema.required).toEqual(["ref", "impact", "effort"]);
    // `done` is optional (defaults to marking done); only the target ref is required.
    expect(tools[2].inputSchema.required).toEqual(["ref"]);
    // link_idea needs a target ref and a url; label is optional.
    expect(tools[3].inputSchema.required).toEqual(["ref", "url"]);
    expect(tools[4].inputSchema.required).toEqual(["projectId"]);
    expect(tools[5].inputSchema.properties).toEqual({});
  });

  it("answers ping and rejects unknown methods / tools / batches / GET", async () => {
    const { registry, app } = setup();
    const { token } = wire(registry, "ws1");

    expect((await (await rpc(app, "ws1", token, "ping")).json()).result).toEqual({});
    expect((await (await rpc(app, "ws1", token, "resources/list")).json()).error.code).toBe(-32601);

    const unknownTool = await callTool(app, "ws1", token, "delete_everything", {});
    expect(unknownTool.error?.code).toBe(-32602);

    const batch = await app.request(`/mcp/ws1/${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }])
    });
    expect(batch.status).toBe(400);

    const get = await app.request(`/mcp/ws1/${token}`, { method: "GET" });
    expect(get.status).toBe(405); // no server-initiated SSE stream in sessionless mode
  });
});

// ── §9 case 1 — schema validation ──

describe("capture_idea — schema validation (§9.1)", () => {
  it("captures a minimal idea with a minted i<n> id and the documented result text", async () => {
    const { registry, app } = setup();
    const w = wire(registry, "ws1");
    const body = await callTool(app, "ws1", w.token, "capture_idea", { title: "Edge cache" });
    expect(textOf(body)).toBe('Captured as @i1. Link follow-up ideas to it with links:[{to:"i1"}].');
    expect(body.result!.isError).toBeUndefined();
    expect(w.ideas).toEqual([{ title: "Edge cache", body: "", id: "i1" }]);
  });

  it("captures a maximal idea (kind, multi-line body, 8 links, both relations)", async () => {
    const { registry, app } = setup();
    const w = wire(registry, "ws1");
    const links = Array.from({ length: 8 }, (_, i) => ({
      to: `a${i + 1}`,
      relation: i === 0 ? ("supersedes" as const) : undefined
    }));
    const body = await callTool(app, "ws1", w.token, "capture_idea", {
      title: "Unified store",
      body: "line one\nline two",
      kind: "feature",
      links
    });
    expect(textOf(body)).toContain("Captured as @i1");
    expect(w.ideas).toHaveLength(1);
    expect(w.ideas[0].kind).toBe("feature");
    expect(w.ideas[0].body).toBe("line one\nline two");
    expect(w.ideas[0].links).toHaveLength(8);
    // The relation default is applied explicitly (parity with scanIdeas).
    expect(w.ideas[0].links![0]).toEqual({ to: "a1", relation: "supersedes" });
    expect(w.ideas[0].links![1]).toEqual({ to: "a2", relation: "about" });
  });

  it.each([
    ["missing title", {}],
    ["empty title", { title: "" }],
    ["whitespace title", { title: "   " }],
    ["overlong title", { title: "x".repeat(121) }],
    ["non-string body", { title: "T", body: 7 }],
    ["overlong body", { title: "T", body: "x".repeat(2001) }],
    ["uppercase kind", { title: "T", kind: "Risk" }],
    ["kind starting with digit", { title: "T", kind: "1risk" }],
    ["links not an array", { title: "T", links: "a1" }],
    [">8 links", { title: "T", links: Array.from({ length: 9 }, (_, i) => ({ to: `a${i}` })) }],
    ["link missing to", { title: "T", links: [{ relation: "about" }] }],
    ["link ref with bad charset", { title: "T", links: [{ to: "a1; rm -rf" }] }],
    ["bad relation", { title: "T", links: [{ to: "a1", relation: "blocks" }] }]
  ])("rejects %s as a tool error and emits nothing", async (_label, args) => {
    const { registry, app } = setup();
    const w = wire(registry, "ws1");
    const body = await callTool(app, "ws1", w.token, "capture_idea", args);
    expect(body.result!.isError).toBe(true);
    expect(body.result!.content[0].text.length).toBeGreaterThan(0); // readable retry hint
    expect(w.ideas).toEqual([]);
  });
});

describe("capture_score — schema validation (§9.1)", () => {
  it("captures a full and a confidence-less score", async () => {
    const { registry, app } = setup();
    const w = wire(registry, "ws1");
    expect(
      textOf(
        await callTool(app, "ws1", w.token, "capture_score", {
          ref: "a1",
          impact: 4,
          effort: 2,
          confidence: 3
        })
      )
    ).toBe("Scored @a1.");
    expect(textOf(await callTool(app, "ws1", w.token, "capture_score", { ref: "a2", impact: 5, effort: 1 }))).toBe(
      "Scored @a2."
    );
    expect(w.scores).toEqual([
      { ref: "a1", impact: 4, effort: 2, confidence: 3 },
      { ref: "a2", impact: 5, effort: 1 }
    ]);
  });

  it.each([
    ["missing ref", { impact: 4, effort: 2 }],
    ["bad ref charset", { ref: "@a1", impact: 4, effort: 2 }],
    ["impact below range", { ref: "a1", impact: 0, effort: 2 }],
    ["effort above range", { ref: "a1", impact: 4, effort: 6 }],
    ["non-integer impact", { ref: "a1", impact: 3.5, effort: 2 }],
    ["string effort", { ref: "a1", impact: 3, effort: "2" }],
    ["confidence out of range", { ref: "a1", impact: 3, effort: 2, confidence: 9 }]
  ])("rejects %s as a tool error and emits nothing", async (_label, args) => {
    const { registry, app } = setup();
    const w = wire(registry, "ws1");
    const body = await callTool(app, "ws1", w.token, "capture_score", args);
    expect(body.result!.isError).toBe(true);
    expect(w.scores).toEqual([]);
  });
});

describe("mark_idea_done — completion state (#167)", () => {
  it("marks a card done (default), emits the completion, and reports it", async () => {
    const { registry, app } = setup();
    const w = wire(registry, "ws1");
    expect(textOf(await callTool(app, "ws1", w.token, "mark_idea_done", { ref: "a1" }))).toBe("Marked @a1 done.");
    expect(w.completions).toEqual([{ ref: "a1", done: true }]);
  });

  it("reopens a card when done:false, with distinct result text", async () => {
    const { registry, app } = setup();
    const w = wire(registry, "ws1");
    expect(textOf(await callTool(app, "ws1", w.token, "mark_idea_done", { ref: "a2", done: false }))).toBe(
      "Reopened @a2."
    );
    expect(w.completions).toEqual([{ ref: "a2", done: false }]);
  });

  it("always flows through (no dedupe) — re-marking the same ref emits again", async () => {
    const { registry, app } = setup();
    const w = wire(registry, "ws1");
    await callTool(app, "ws1", w.token, "mark_idea_done", { ref: "a1" });
    await callTool(app, "ws1", w.token, "mark_idea_done", { ref: "a1" });
    expect(w.completions).toEqual([
      { ref: "a1", done: true },
      { ref: "a1", done: true }
    ]);
  });

  it.each([
    ["missing ref", {}],
    ["bad ref charset", { ref: "@a1" }],
    ["non-boolean done", { ref: "a1", done: "yes" }]
  ])("rejects %s as a tool error and emits nothing", async (_label, args) => {
    const { registry, app } = setup();
    const w = wire(registry, "ws1");
    const body = await callTool(app, "ws1", w.token, "mark_idea_done", args);
    expect(body.result!.isError).toBe(true);
    expect(body.result!.content[0].text.length).toBeGreaterThan(0);
    expect(w.completions).toEqual([]);
  });

  it("returns a tool error (not delivered) when the session is detached", async () => {
    const { registry, app } = setup();
    const target = registry.registerSession("ws1")!;
    // Registered but never attached → attachment is null.
    const body = await callTool(app, "ws1", target.token, "mark_idea_done", { ref: "a1" });
    expect(body.result!.isError).toBe(true);
    expect(body.result!.content[0].text).toContain("not attached");
  });
});

describe("link_idea — external-link reference (#227)", () => {
  it("attaches a link with a label, emits the reference, and reports it", async () => {
    const { registry, app } = setup();
    const w = wire(registry, "ws1");
    const body = await callTool(app, "ws1", w.token, "link_idea", {
      ref: "a1",
      url: "https://figma.com/file/abc",
      label: "Figma spec"
    });
    expect(textOf(body)).toBe("Linked https://figma.com/file/abc to @a1.");
    expect(w.references).toEqual([{ ref: "a1", url: "https://figma.com/file/abc", label: "Figma spec" }]);
  });

  it("omits label when not provided (or blank)", async () => {
    const { registry, app } = setup();
    const w = wire(registry, "ws1");
    await callTool(app, "ws1", w.token, "link_idea", { ref: "a1", url: "https://docs.google.com/x" });
    await callTool(app, "ws1", w.token, "link_idea", { ref: "a2", url: "https://example.com", label: "   " });
    expect(w.references).toEqual([
      { ref: "a1", url: "https://docs.google.com/x" },
      { ref: "a2", url: "https://example.com" }
    ]);
  });

  it("trims the url and always flows through (no dedupe on the wire)", async () => {
    const { registry, app } = setup();
    const w = wire(registry, "ws1");
    await callTool(app, "ws1", w.token, "link_idea", { ref: "a1", url: "  https://example.com/x  " });
    await callTool(app, "ws1", w.token, "link_idea", { ref: "a1", url: "https://example.com/x" });
    expect(w.references).toEqual([
      { ref: "a1", url: "https://example.com/x" },
      { ref: "a1", url: "https://example.com/x" }
    ]);
  });

  it.each([
    ["missing ref", { url: "https://example.com" }],
    ["bad ref charset", { ref: "@a1", url: "https://example.com" }],
    ["missing url", { ref: "a1" }],
    ["empty url", { ref: "a1", url: "   " }],
    ["non-http scheme", { ref: "a1", url: "javascript:alert(1)" }],
    ["not a url", { ref: "a1", url: "not a url" }],
    ["non-string label", { ref: "a1", url: "https://example.com", label: 5 }]
  ])("rejects %s as a tool error and emits nothing", async (_label, args) => {
    const { registry, app } = setup();
    const w = wire(registry, "ws1");
    const body = await callTool(app, "ws1", w.token, "link_idea", args);
    expect(body.result!.isError).toBe(true);
    expect(body.result!.content[0].text.length).toBeGreaterThan(0);
    expect(w.references).toEqual([]);
  });
});

describe("durable MCP read tools (#234)", () => {
  const page = (id: string, name: string, index: string) => ({ id, typeName: "page", name, index });
  const card = (id: string, parentId: string, ref: string, title: string) => ({
    id,
    typeName: "shape",
    type: "idea-card",
    parentId,
    x: 10,
    y: 20,
    props: { kind: "feature", color: "blue", title, body: "Body", origin: "ai", superseded: false },
    meta: {
      ref,
      editedByUser: true,
      issue: { provider: "github", key: "drdreo/ai-storm#234", url: "https://github.com/drdreo/ai-storm/issues/234" },
      links: [{ url: "https://example.com/spec", label: "Spec" }]
    }
  });

  it("reads every page directly from the store without a browser attachment", async () => {
    const { registry, app, boards, setRegistry } = setup();
    const target = registry.registerSession("route")!;
    setRegistry({ version: 1, revision: 4, projects: [storedProject("project-a", "Alpha")], folders: [] });
    boards.set(
      "project-a",
      storedBoard(
        page("page:1", "First", "a"),
        page("page:2", "Empty", "b"),
        card("shape:1", "page:1", "i1", "Stored idea")
      )
    );

    const body = await callTool(app, "route", target.token, "get_board_ideas", { projectId: "project-a" });
    const payload = JSON.parse(textOf(body));

    expect(payload).toMatchObject({ version: 1, revision: 3 });
    expect(payload.pages.map((item: { id: string; name: string }) => [item.id, item.name])).toEqual([
      ["page:1", "First"],
      ["page:2", "Empty"]
    ]);
    expect(payload.pages[1]).toMatchObject({ cards: [], edges: [] });
    expect(payload.pages[0].cards[0]).toMatchObject({
      id: "shape:1",
      ref: "i1",
      color: "blue",
      editedByUser: true,
      issue: { key: "drdreo/ai-storm#234" },
      links: [{ url: "https://example.com/spec", label: "Spec" }]
    });
  });

  it("keeps every registry project discoverable when one board is unreadable", async () => {
    const { registry, app, boards, setRegistry } = setup();
    const target = registry.registerSession("route")!;
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    setRegistry({
      version: 1,
      revision: 2,
      projects: [storedProject("healthy", "Healthy"), storedProject("broken", "Broken")],
      folders: []
    });
    boards.set("healthy", storedBoard(page("page:healthy", "Ideas", "a")));

    const body = await callTool(app, "route", target.token, "get_projects", {});
    const payload = JSON.parse(textOf(body));

    expect(payload.projects).toEqual([
      expect.objectContaining({ id: "healthy", pages: ["Ideas"], ideaCount: 0 }),
      expect.objectContaining({ id: "broken", status: "error", pages: [], ideaCount: 0 })
    ]);
    expect(warn).toHaveBeenCalledWith(
      "mcp.read_failed",
      expect.objectContaining({ tool: "get_projects", project: "broken", message: "missing board" })
    );
  });

  it("logs board read failures while returning a path-free tool error", async () => {
    const { registry, app, setRegistry } = setup();
    const target = registry.registerSession("route")!;
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    setRegistry({ version: 1, revision: 1, projects: [storedProject("broken", "Broken")], folders: [] });

    const body = await callTool(app, "route", target.token, "get_board_ideas", { projectId: "broken" });

    expect(body.result!.isError).toBe(true);
    expect(textOf(body)).toBe("Unable to read the requested project board.");
    expect(warn).toHaveBeenCalledWith(
      "mcp.read_failed",
      expect.objectContaining({ tool: "get_board_ideas", project: "broken", message: "missing board" })
    );
  });

  it("returns Project not found for unknown/deleted ids without leaking filesystem paths", async () => {
    const { registry, app, setRegistry } = setup();
    const target = registry.registerSession("route")!;
    setRegistry({ version: 1, revision: 1, projects: [], folders: [] });

    const body = await callTool(app, "route", target.token, "get_board_ideas", { projectId: "deleted" });
    expect(body.result!.isError).toBe(true);
    expect(textOf(body)).toBe("Project not found");
  });

  it("lists discovery metadata only and derives runtime status", async () => {
    vi.useFakeTimers();
    const { registry, app, boards, setRegistry } = setup();
    const auth = registry.registerSession("route")!;
    registry.registerSession("active");
    registry.registerSession("streaming");
    registry.setRuntimeState("streaming", "responding");
    registry.registerSession("broken");
    registry.setRuntimeState("broken", "error");
    setRegistry({
      version: 1,
      revision: 7,
      projects: [
        storedProject("idle", "Idle", "folder:1"),
        storedProject("active", "Active"),
        storedProject("streaming", "Streaming"),
        storedProject("broken", "Broken")
      ],
      folders: [{ id: "folder:1", title: "Archive", createdAt: 1 }]
    });
    for (const id of ["idle", "active", "streaming", "broken"]) {
      boards.set(id, storedBoard(page(`page:${id}`, `${id} page`, "a")));
    }

    const body = await callTool(app, "route", auth.token, "get_projects", {});
    const payload = JSON.parse(textOf(body));
    expect(payload).toMatchObject({ version: 1, revision: 7 });
    expect(payload.projects.map((project: { status: string }) => project.status)).toEqual([
      "idle",
      "active",
      "streaming",
      "error"
    ]);
    expect(payload.projects[0]).toMatchObject({
      id: "idle",
      title: "Idle",
      folder: "Archive",
      createdAt: 100,
      updatedAt: 200,
      pages: ["idle page"],
      ideaCount: 0
    });
    expect(JSON.stringify(payload)).not.toMatch(/terminal|cwd|--secret/);
    expect(JSON.stringify(payload)).not.toContain("C:/secret");

    vi.advanceTimersByTime(751);
    expect(registry.runtimeStatus("streaming")).toBe("active");
  });
});

// ── §9 case 2 — marker parity: tool calls ≡ scanIdeas on the §3.1 mapping table ──

describe("capture_idea — marker parity (§9.2)", () => {
  /** Scan a marker fixture the way the scanner would (final, no hold-back). */
  const ideasOf = (...lines: string[]) => scanIdeas(lines, true);

  it.each([
    ["plain idea", { title: "Edge cache", body: "serve from CDN" }, ["  «IDEA» Edge cache :: serve from CDN"]],
    [
      "typed idea",
      { title: "Token rotation", body: "may break sessions", kind: "risk" },
      ["  «IDEA:risk» Token rotation :: may break sessions"]
    ],
    [
      "linked idea (about default)",
      {
        title: "Token leak",
        body: "refresh races the reattach",
        kind: "risk",
        links: [{ to: "a1" }]
      },
      ["  «IDEA:risk@a1» Token leak :: refresh races the reattach"]
    ],
    [
      "supersede (PD-012)",
      {
        title: "Stronger plan",
        body: "addresses the objection",
        links: [{ to: "a1", relation: "supersedes" }]
      },
      ["  «IDEA@a1!» Stronger plan :: addresses the objection"]
    ],
    [
      "combine chain (#62)",
      {
        title: "Unified store",
        body: "one CRDT-backed canvas",
        kind: "feature",
        links: [
          { to: "a1", relation: "supersedes" },
          { to: "a2", relation: "supersedes" }
        ]
      },
      ["  «IDEA:feature@a1!@a2!» Unified store :: one CRDT-backed canvas"]
    ],
    [
      "multi-line body (fenced form)",
      {
        title: "Adopt event sourcing",
        body: "Persist every op as a log.\nEnables time-travel scrub.",
        kind: "decision"
      },
      [
        "  ```idea kind=decision",
        "  title: Adopt event sourcing",
        "  body: Persist every op as a log.",
        "  Enables time-travel scrub.",
        "  ```"
      ]
    ]
  ])("tool call ≡ marker scan for a %s", async (_label, toolArgs, markerLines) => {
    const { registry, app } = setup();
    const w = wire(registry, "ws1");
    await callTool(app, "ws1", w.token, "capture_idea", toolArgs);
    expect(w.ideas).toHaveLength(1);
    // The tool path stamps the minted ref into Idea.id (§3.3) — the one
    // deliberate difference from the marker path; strip it before comparing.
    const { id, ...toolIdea } = w.ideas[0];
    expect(id).toBe("i1");
    expect([toolIdea]).toEqual(ideasOf(...markerLines));
  });
});

// ── §9 case 3 — shared dedupe across the tool and scanner producers ──

describe("shared dedupe (§9.3)", () => {
  it("a tool capture suppresses the identical marker scan that follows", async () => {
    const { registry, app } = setup();
    const w = wire(registry, "ws1");
    const scanner = new IdeaScanner({ sink: w.ideaSink });

    await callTool(app, "ws1", w.token, "capture_idea", {
      title: "Edge cache",
      body: "serve from CDN"
    });
    expect(w.ideas).toHaveLength(1);
    // The agent redundantly echoes the marker line; the shared sink absorbs it.
    expect(scanner.scan("  «IDEA» Edge cache :: re-worded body\n❯")).toEqual([]);
  });

  it("a marker-scanned idea makes the identical tool call a no-op (one emission)", async () => {
    const { registry, app } = setup();
    const w = wire(registry, "ws1");
    const scanner = new IdeaScanner({ sink: w.ideaSink });

    expect(scanner.scan("  «IDEA» Edge cache :: serve from CDN\n❯")).toHaveLength(1);
    const body = await callTool(app, "ws1", w.token, "capture_idea", {
      title: "Edge cache",
      body: "serve from CDN"
    });
    expect(textOf(body)).toContain("Already captured");
    expect(w.ideas).toEqual([]); // the tool path emitted nothing on top
  });

  it("score dedupe is shared too, and a re-triage still passes", async () => {
    const { registry, app } = setup();
    const w = wire(registry, "ws1");

    await callTool(app, "ws1", w.token, "capture_score", { ref: "a1", impact: 4, effort: 2 });
    await callTool(app, "ws1", w.token, "capture_score", { ref: "a1", impact: 4, effort: 2 });
    expect(w.scores).toHaveLength(1); // identical tuple delivered once
    await callTool(app, "ws1", w.token, "capture_score", { ref: "a1", impact: 5, effort: 1 });
    expect(w.scores).toHaveLength(2); // re-triage (new tuple) flows through
  });
});

// ── §9 case 4 — ref round-trip ──

describe("ref round-trip (§9.4)", () => {
  it("the returned ref is usable in follow-up links and scores", async () => {
    const { registry, app } = setup();
    const w = wire(registry, "ws1");

    textOf(await callTool(app, "ws1", w.token, "capture_idea", { title: "Seed idea" }));
    expect(w.ideas[0].id).toBe("i1");

    // Link a follow-up to the just-returned ref…
    await callTool(app, "ws1", w.token, "capture_idea", {
      title: "Follow-up",
      links: [{ to: "i1" }]
    });
    expect(w.ideas[1]).toEqual({
      title: "Follow-up",
      body: "",
      id: "i2",
      links: [{ to: "i1", relation: "about" }]
    });

    // …and score it.
    expect(textOf(await callTool(app, "ws1", w.token, "capture_score", { ref: "i1", impact: 4, effort: 2 }))).toBe(
      "Scored @i1."
    );
    expect(w.scores).toEqual([{ ref: "i1", impact: 4, effort: 2 }]);
  });

  it("refs are session-scoped: a second project starts at i1 again", async () => {
    const { registry, app } = setup();
    const w1 = wire(registry, "ws1");
    const w2 = wire(registry, "ws2");
    await callTool(app, "ws1", w1.token, "capture_idea", { title: "First in ws1" });
    await callTool(app, "ws2", w2.token, "capture_idea", { title: "First in ws2" });
    expect(w1.ideas[0].id).toBe("i1");
    expect(w2.ideas[0].id).toBe("i1");
  });
});

// ── §9 case 5 — routing & auth ──

describe("routing & auth (§9.5)", () => {
  it("rejects a wrong token with a bare 404 and emits nothing", async () => {
    const { registry, app } = setup();
    const w = wire(registry, "ws1");
    const res = await rpc(app, "ws1", "not-the-token", "tools/call", {
      name: "capture_idea",
      arguments: { title: "Sneaky" }
    });
    expect(res.status).toBe(404);
    expect(w.ideas).toEqual([]);
    // Unknown project is indistinguishable from a wrong token.
    expect((await rpc(app, "nope", w.token, "initialize")).status).toBe(404);
  });

  it("routes two concurrent projects to their own callbacks", async () => {
    const { registry, app } = setup();
    const w1 = wire(registry, "ws1");
    const w2 = wire(registry, "ws2");
    await callTool(app, "ws1", w1.token, "capture_idea", { title: "For ws1" });
    await callTool(app, "ws2", w2.token, "capture_idea", { title: "For ws2" });
    expect(w1.ideas.map((i) => i.title)).toEqual(["For ws1"]);
    expect(w2.ideas.map((i) => i.title)).toEqual(["For ws2"]);
  });

  it("a detached session keeps its token but tool calls fail readably", async () => {
    const { registry, app } = setup();
    const w = wire(registry, "ws1");
    registry.detachSession("ws1");
    // Protocol methods still answer (the harness may re-initialize while the
    // browser is away)…
    expect((await rpc(app, "ws1", w.token, "initialize")).status).toBe(200);
    // …but a capture has nowhere to go: tool error, nothing emitted.
    const body = await callTool(app, "ws1", w.token, "capture_idea", { title: "Lost?" });
    expect(body.result!.isError).toBe(true);
    expect(body.result!.content[0].text).toContain("not attached");
    expect(w.ideas).toEqual([]);
  });

  it("a killed session 404s", async () => {
    const { registry, app } = setup();
    const w = wire(registry, "ws1");
    registry.removeSession("ws1");
    expect((await rpc(app, "ws1", w.token, "initialize")).status).toBe(404);
  });

  it("registerSession declines (markers-only) until a base URL is configured", () => {
    const registry = new McpSessionRegistry();
    expect(registry.registerSession("ws1")).toBeUndefined();
    registry.configure(BASE);
    const target = registry.registerSession("ws1");
    expect(target?.url).toBe(`${BASE}/mcp/ws1/${target?.token}`);
    // Idempotent: a reused session keeps its token.
    expect(registry.registerSession("ws1")?.token).toBe(target?.token);
  });
});

// ── §9 case 6 — tmux token durability (fake-tmux seam) ──

const noop = () => {};

describe("TmuxSessionBackend — MCP token durability (§9.6)", () => {
  it("create() bakes the MCP URL into the launch args and stamps @ai_storm_mcp_token", async () => {
    const fake = fakeTmux();
    const registry = new McpSessionRegistry();
    registry.configure(BASE);
    const backend = new TmuxSessionBackend({ tmux: fake.tmux, sleep: async () => {}, registry });
    await backend.create({ projectId: "ws1", command: "claude", prime: "p" });

    const token = fake.sessions.get("ai-storm-ws1")?.options["@ai_storm_mcp_token"];
    expect(token).toMatch(/^[0-9a-f]{32}$/); // 128-bit randomUUID-derived secret
    const launch = fake.sessions.get("ai-storm-ws1")?.launch ?? "";
    expect(launch).toContain("--mcp-config");
    expect(launch).toContain(`${BASE}/mcp/ws1/${token}`);
    expect(launch).toContain("--allowedTools");
  });

  it("a markers-only harness (bash) gets no token and no MCP args", async () => {
    const fake = fakeTmux();
    const registry = new McpSessionRegistry();
    registry.configure(BASE);
    const backend = new TmuxSessionBackend({ tmux: fake.tmux, sleep: async () => {}, registry });
    await backend.create({ projectId: "ws1", command: "bash" });
    expect(fake.sessions.get("ai-storm-ws1")?.options["@ai_storm_mcp_token"]).toBeUndefined();
    expect(fake.sessions.get("ai-storm-ws1")?.launch).not.toContain("--mcp-config");
    expect(registry.isRegistered("ws1")).toBe(false);
  });

  it("reconcile() restores routing so the URL baked at launch still works after a restart", async () => {
    const fake = fakeTmux();
    const registry1 = new McpSessionRegistry();
    registry1.configure(BASE);
    const b1 = new TmuxSessionBackend({
      tmux: fake.tmux,
      sleep: async () => {},
      registry: registry1
    });
    await b1.create({ projectId: "ws1", command: "claude", prime: "p" });
    const token = fake.sessions.get("ai-storm-ws1")!.options["@ai_storm_mcp_token"];

    // "Restart": fresh registry + backend over the same surviving tmux state.
    const registry2 = new McpSessionRegistry();
    registry2.configure(BASE);
    const b2 = new TmuxSessionBackend({
      tmux: fake.tmux,
      sleep: async () => {},
      registry: registry2
    });
    expect(await b2.reconcile()).toEqual(["ws1"]);

    // The old token routes again; after attach, a tool call lands on the canvas.
    const app = new Hono().route("/mcp", mcpRoutes(registry2, {} as StateStore));
    const ideas: Idea[] = [];
    await b2.attach("ws1", noop, (i) => ideas.push(i), noop, noop, noop);
    const body = await callTool(app, "ws1", token, "capture_idea", {
      title: "Survived the restart"
    });
    expect(textOf(body)).toContain("Captured as @i1");
    expect(ideas.map((i) => i.title)).toEqual(["Survived the restart"]);

    // kill() forgets the routing → 404.
    await b2.kill("ws1");
    expect((await rpc(app, "ws1", token, "initialize")).status).toBe(404);
  });

  it("logs idea.fallback_scan (warn) when the scanner fires on an MCP-wired session", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(log, "warn");
    const fake = fakeTmux();
    const registry = new McpSessionRegistry();
    registry.configure(BASE);
    const backend = new TmuxSessionBackend({ tmux: fake.tmux, sleep: async () => {}, registry });
    await backend.create({ projectId: "ws1", command: "claude", prime: "p" });

    const ideas: Idea[] = [];
    await backend.attach("ws1", noop, (i) => ideas.push(i), noop, noop, noop);
    // The primed agent lapses back to a marker line after the attach-time seed.
    fake.setPane("  «IDEA» Lapsed marker :: the agent ignored the tool\n❯");
    // Two poll ticks: the scanner's two-frame confirmation (scanner-hardening)
    // holds a fresh marker as a candidate on the first tick and emits it on the
    // second, once it has re-rendered identically.
    await vi.advanceTimersByTimeAsync(450); // tick 1 — candidate
    expect(ideas).toEqual([]);
    await vi.advanceTimersByTimeAsync(400); // tick 2 — confirmed

    expect(ideas.map((i) => i.title)).toEqual(["Lapsed marker"]);
    expect(warn.mock.calls.some(([event]) => event === "idea.fallback_scan")).toBe(true);
    backend.detach("ws1");
  });
});
