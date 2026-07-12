/**
 * Tests for agent.discussText — the bidirectional canvas seam (#13).
 *
 * When a session is attached, the supplied card text is framed and TYPED into
 * the live PTY as an editable prompt (no trailing '\r', so not auto-submitted)
 * and the terminal is focused. When nothing is attached, or the text is empty,
 * nothing is sent. Ported from the Angular spec; collaborator stores are mocked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ServerMessage } from "@ai-storm/shared";

interface Harness {
  agent: typeof import("./agent.store").agent;
  useAgentStore: typeof import("./agent.store").useAgentStore;
  sendInput: ReturnType<typeof vi.fn>;
  submitPrompt: ReturnType<typeof vi.fn>;
  pastePrompt: ReturnType<typeof vi.fn>;
  focusTerminal: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  applyIssueLinks: ReturnType<typeof vi.fn>;
  /** Push a backend message to the store's project subscription. */
  receive: (msg: ServerMessage) => void;
}

async function makeStore(opts: { attached: boolean }): Promise<Harness> {
  vi.resetModules();
  const sendInput = vi.fn();
  const submitPrompt = vi.fn();
  const pastePrompt = vi.fn();
  const focusTerminal = vi.fn();
  const send = vi.fn();
  const handlers: Array<(msg: ServerMessage) => void> = [];
  vi.doMock("./ingestion.store", () => ({
    ingestion: { isAttached: (_id: string) => opts.attached, sendInput, submitPrompt, pastePrompt, focusTerminal }
  }));
  // backend.store reads `location` at import time; canvas pulls in tldraw — mock
  // both so the agent store imports cleanly in the Node test env.
  vi.doMock("./backend.store", () => ({
    backend: {
      connect: vi.fn(),
      send,
      request: vi.fn(async () => {
        throw new Error("offline test backend");
      }),
      onOpen: vi.fn(() => () => {}),
      subscribe: (_id: string, h: (msg: ServerMessage) => void) => {
        handlers.push(h);
        return () => {};
      }
    }
  }));
  const applyIssueLinks = vi.fn();
  vi.doMock("./canvas.store", () => ({
    canvas: {
      serializeForHandoff: () => "★ [feature] Dark mode — the one card",
      serializeForTriage: () => "@a1 [feature] Dark mode\n@a2 [feature] Light mode",
      applyIssueLinks
    }
  }));

  const { agent, useAgentStore } = await import("./agent.store");
  return {
    agent,
    useAgentStore,
    sendInput,
    submitPrompt,
    pastePrompt,
    focusTerminal,
    send,
    applyIssueLinks,
    receive: (msg) => handlers.forEach((h) => h(msg))
  };
}

describe("agent.discussText (#13)", () => {
  let h: Harness;

  describe("attached with non-empty text", () => {
    beforeEach(async () => {
      h = await makeStore({ attached: true });
    });

    it("returns true", () => {
      expect(h.agent.discussText("ws1", "Cache CRDT ops offline")).toBe(true);
    });

    it("types the framed prompt into the PTY with NO trailing carriage return", () => {
      h.agent.discussText("ws1", "Cache CRDT ops offline");
      expect(h.sendInput).toHaveBeenCalledTimes(1);
      const [id, data] = h.sendInput.mock.calls[0];
      expect(id).toBe("ws1");
      expect(data).toContain("Cache CRDT ops offline");
      expect(data.endsWith("\r")).toBe(false);
      expect(data.endsWith("\n")).toBe(false);
      expect(data.endsWith(" ")).toBe(true);
    });

    it("focuses the terminal after typing the prompt", () => {
      h.agent.discussText("ws1", "Cache CRDT ops offline");
      expect(h.focusTerminal).toHaveBeenCalledWith("ws1");
    });
  });

  describe("not attached", () => {
    beforeEach(async () => {
      h = await makeStore({ attached: false });
    });

    it("returns false and sends nothing", () => {
      expect(h.agent.discussText("ws1", "some notes")).toBe(false);
      expect(h.sendInput).not.toHaveBeenCalled();
      expect(h.focusTerminal).not.toHaveBeenCalled();
    });
  });

  describe("attached but empty text", () => {
    beforeEach(async () => {
      h = await makeStore({ attached: true });
    });

    it("returns false and sends nothing", () => {
      expect(h.agent.discussText("ws1", "   \n  ")).toBe(false);
      expect(h.sendInput).not.toHaveBeenCalled();
      expect(h.focusTerminal).not.toHaveBeenCalled();
    });
  });
});

describe("agent.referenceIdeas (#194)", () => {
  const cards = [
    { ref: "a1", kind: "feature", title: "Offline sync", body: "Cache ops" },
    { ref: "a2", kind: "risk", title: "Conflict resolution", body: "" }
  ];

  let h: Harness;

  describe("attached with selected cards", () => {
    beforeEach(async () => {
      h = await makeStore({ attached: true });
    });

    it("types the @ref block into the PTY unsubmitted (no trailing carriage return)", () => {
      expect(h.agent.referenceIdeas("ws1", cards)).toBe(true);
      expect(h.sendInput).toHaveBeenCalledTimes(1);
      const [id, data] = h.sendInput.mock.calls[0];
      expect(id).toBe("ws1");
      expect(data).toContain("@a1 [feature] Offline sync");
      expect(data).toContain("@a2 [risk] Conflict resolution");
      expect(data.endsWith("\r")).toBe(false);
      expect(data.endsWith("\n")).toBe(false);
      expect(data.endsWith(" ")).toBe(true);
    });

    it("carries no preset verb prompt — the user owns the follow-up", () => {
      h.agent.referenceIdeas("ws1", cards);
      const [, data] = h.sendInput.mock.calls[0];
      expect(data).not.toMatch(/Let's discuss|Expand on|stress-test|into ONE stronger/);
    });

    it("focuses the terminal after typing the block", () => {
      h.agent.referenceIdeas("ws1", cards);
      expect(h.focusTerminal).toHaveBeenCalledWith("ws1");
    });

    it("returns false and sends nothing for an empty selection", () => {
      expect(h.agent.referenceIdeas("ws1", [])).toBe(false);
      expect(h.sendInput).not.toHaveBeenCalled();
    });
  });

  describe("not attached", () => {
    it("returns false and sends nothing", async () => {
      h = await makeStore({ attached: false });
      expect(h.agent.referenceIdeas("ws1", cards)).toBe(false);
      expect(h.sendInput).not.toHaveBeenCalled();
      expect(h.focusTerminal).not.toHaveBeenCalled();
    });
  });
});

describe("agent.generateSpec run metadata + capabilities (#120)", () => {
  const config = { agentCommand: "claude", agentArgs: [], cwd: "/repo" } as never;

  let h: Harness;
  beforeEach(async () => {
    h = await makeStore({ attached: true });
  });

  it("sends the format and an empty capability list by default", () => {
    expect(h.agent.generateSpec("ws1", config, "plan")).toBe(true);
    expect(h.send).toHaveBeenCalledTimes(1);
    const msg = h.send.mock.calls[0][0];
    expect(msg.type).toBe("agent");
    expect(msg.format).toBe("plan");
    expect(msg.capabilities).toEqual([]);
  });

  it("requests the create-issues capability when the issues create-toggle is on", () => {
    h.agent.generateSpec("ws1", config, "issues", { createIssues: true });
    const msg = h.send.mock.calls[0][0];
    expect(msg.format).toBe("issues");
    expect(msg.capabilities).toEqual(["create-issues"]);
  });

  it("adopts the backend-echoed format on spawned (survives a stateless client)", () => {
    h.agent.generateSpec("ws1", config, "prd");
    // Simulate a client whose local stamp is gone: spawned carries the format.
    h.useAgentStore.setState({ runs: {} });
    h.receive({
      type: "agent-status",
      projectId: "ws1",
      status: "spawned",
      pid: 1,
      format: "issues"
    });
    expect(h.useAgentStore.getState().runs["ws1"]?.format).toBe("issues");
  });

  it("records spec run history: running at dispatch, done with the artifact on exit (#104)", async () => {
    const { useHistoryStore } = await import("./history.store");
    h.agent.generateSpec("ws1", config, "prd");

    let entries = useHistoryStore.getState().entries;
    expect(entries.length).toBe(1);
    expect(entries[0]).toMatchObject({ projectId: "ws1", type: "spec", status: "running", format: "prd" });

    h.receive({ type: "agent-status", projectId: "ws1", status: "spawned", pid: 1, format: "prd" });
    h.receive({ type: "agent-status", projectId: "ws1", status: "stdout", data: "# PRD\n\nDark mode." });
    h.receive({ type: "agent-status", projectId: "ws1", status: "exit", code: 0 });

    entries = useHistoryStore.getState().entries;
    expect(entries[0].status).toBe("done");
    expect(entries[0].output).toBe("# PRD\n\nDark mode.");
    expect(entries[0].exitCode).toBe(0);
  });

  it("records a run that exits without output as 'empty' (#104)", async () => {
    const { useHistoryStore } = await import("./history.store");
    h.agent.generateSpec("ws1", config, "prd");
    h.receive({ type: "agent-status", projectId: "ws1", status: "spawned", pid: 1, format: "prd" });
    h.receive({ type: "agent-status", projectId: "ws1", status: "exit", code: 0 });
    expect(useHistoryStore.getState().entries[0].status).toBe("empty");
  });

  it("records a failed run as 'error' with the stderr tail (#104)", async () => {
    const { useHistoryStore } = await import("./history.store");
    h.agent.generateSpec("ws1", config, "prd");
    h.receive({ type: "agent-status", projectId: "ws1", status: "spawned", pid: 1, format: "prd" });
    h.receive({ type: "agent-status", projectId: "ws1", status: "error", data: "spawn failed" });
    const entry = useHistoryStore.getState().entries[0];
    expect(entry.status).toBe("error");
    expect(entry.output).toContain("spawn failed");
  });

  it("triage pastes the complete multiline board editable (user submits) and records its card count (#60/#104)", async () => {
    const { useHistoryStore } = await import("./history.store");
    expect(h.agent.triage("ws1")).toBe(true);

    expect(h.pastePrompt).toHaveBeenCalledTimes(1);
    const prompt = h.pastePrompt.mock.calls[0][1] as string;
    expect(h.pastePrompt).toHaveBeenCalledWith("ws1", prompt);
    expect(prompt).toContain("@a1 [feature] Dark mode");
    expect(prompt).toContain("@a2 [feature] Light mode");
    // Neither raw keystrokes (embedded LF would submit partial prompts) nor an
    // auto-submitting path — the user owns the final Enter.
    expect(h.sendInput).not.toHaveBeenCalled();
    expect(h.submitPrompt).not.toHaveBeenCalled();

    const entry = useHistoryStore.getState().entries[0];
    expect(entry).toMatchObject({ projectId: "ws1", type: "triage", status: "running", cardCount: 2, scoredCount: 0 });
  });

  it("applies agent-artifacts to the run and keeps them through exit", () => {
    h.agent.generateSpec("ws1", config, "issues", { createIssues: true });
    h.receive({
      type: "agent-status",
      projectId: "ws1",
      status: "spawned",
      pid: 1,
      format: "issues"
    });
    const artifacts = [
      {
        kind: "github-issue" as const,
        title: "Add dark mode",
        url: "https://github.com/acme/app/issues/12"
      }
    ];
    h.receive({ type: "agent-artifacts", projectId: "ws1", artifacts });
    h.receive({ type: "agent-status", projectId: "ws1", status: "exit", code: 0 });
    const run = h.useAgentStore.getState().runs["ws1"];
    expect(run?.status).toBe("exit");
    expect(run?.artifacts).toEqual(artifacts);
  });

  it("stamps agent-artifacts back onto the source cards (#125)", () => {
    h.agent.generateSpec("ws1", config, "issues", { createIssues: true });
    const artifacts = [
      {
        kind: "github-issue" as const,
        title: "Add dark mode",
        url: "https://github.com/acme/app/issues/12",
        refs: ["a1"]
      }
    ];
    h.receive({ type: "agent-artifacts", projectId: "ws1", artifacts });
    expect(h.applyIssueLinks).toHaveBeenCalledWith("ws1", artifacts);
  });
});
