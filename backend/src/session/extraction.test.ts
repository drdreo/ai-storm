/**
 * Unit tests for the response extractor (design §4.3 + extraction-contract §9)
 * against recorded `capture-pane` fixtures: idle → echo → response → idle
 * cycles, spinners, multiline output, scrollback, the claude chrome-strip
 * profile, the `«IDEA»` / fenced contract, the heuristic floor, and idempotent
 * priming. This is where the real risk lives, so it is tested in isolation from
 * tmux/node-pty (design §8 step 4).
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ResponseExtractor,
  getProfile,
  DEFAULT_PROFILE,
  CLAUDE_PROFILE,
} from "./extraction.ts";
import { TmuxSessionBackend } from "./tmux-backend.ts";

/** Build a capture string from screen lines (as `capture-pane -p` would emit). */
const cap = (...lines: string[]): string => lines.join("\n");

/** Read a recorded claude `capture-pane` fixture (extraction-contract §9). */
const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/claude/${name}`, import.meta.url)), "utf-8");

const PYTHON = getProfile("python");

describe("ResponseExtractor — idle/echo/response/idle cycle (§4.4 spike)", () => {
  it("emits the response, skipping the echoed input and the prompt chrome", () => {
    const ex = new ResponseExtractor(PYTHON);

    // Capture 1: idle, just the banner + prompt.
    expect(ex.ingest(cap('Python 3.14.2 on linux', 'Type "help" for more.', ">>>")))
      .toEqual({ chat: [], ideas: [], complete: false });

    // User sends `print("hello")`.
    ex.beginResponse('print("hello")');
    expect(ex.responding).toBe(true);

    // Capture 2: echo + first response line, prompt has NOT returned yet.
    // The last line is held back (it may still be growing).
    expect(
      ex.ingest(cap('Python 3.14.2 on linux', 'Type "help" for more.', '>>> print("hello")', "hello")),
    ).toEqual({ chat: [], ideas: [], complete: false });

    // Capture 3: idle prompt reappears ⇒ complete; "hello" is now emitted.
    expect(
      ex.ingest(
        cap('Python 3.14.2 on linux', 'Type "help" for more.', '>>> print("hello")', "hello", ">>>"),
      ),
    ).toEqual({ chat: ["hello"], ideas: [], complete: true });

    expect(ex.responding).toBe(false);
  });

  it("never emits the echoed user input as a response line", () => {
    const ex = new ResponseExtractor(PYTHON);
    ex.ingest(cap(">>>"));
    ex.beginResponse("1 + 1");
    const out = ex.ingest(cap(">>> 1 + 1", "2", ">>>"));
    expect(out).toEqual({ chat: ["2"], ideas: [], complete: true });
    expect(out.chat).not.toContain("1 + 1");
  });
});

describe("ResponseExtractor — multiline + incremental emission", () => {
  it("emits a multi-line response in stable increments, last line on complete", () => {
    const ex = new ResponseExtractor(PYTHON);
    ex.ingest(cap(">>>"));
    ex.beginResponse("go()");

    // Only line one present so far — held back as the growing tail.
    expect(ex.ingest(cap(">>> go()", "line one"))).toEqual({ chat: [], ideas: [], complete: false });
    // line two arrives — line one is now stable and emitted.
    expect(ex.ingest(cap(">>> go()", "line one", "line two"))).toEqual({
      chat: ["line one"],
      ideas: [],
      complete: false,
    });
    // Prompt returns — flush the remainder and mark complete.
    expect(ex.ingest(cap(">>> go()", "line one", "line two", ">>>"))).toEqual({
      chat: ["line two"],
      ideas: [],
      complete: true,
    });
  });

  it("handles a whole multi-line block that completes in one capture", () => {
    const ex = new ResponseExtractor(PYTHON);
    ex.ingest(cap(">>>"));
    ex.beginResponse("dump()");
    expect(ex.ingest(cap(">>> dump()", "alpha", "beta", "gamma", ">>>"))).toEqual({
      chat: ["alpha", "beta", "gamma"],
      ideas: [],
      complete: true,
    });
  });
});

describe("ResponseExtractor — chrome filtering", () => {
  it("drops braille spinner / 'thinking' status lines but keeps real content", () => {
    const ex = new ResponseExtractor(PYTHON);
    ex.ingest(cap(">>>"));
    ex.beginResponse("work()");
    const out = ex.ingest(cap(">>> work()", "⠋ thinking…", "result ready", ">>>"));
    expect(out).toEqual({ chat: ["result ready"], ideas: [], complete: true });
  });

  it("preserves markdown bullets and dividers (not mistaken for chrome)", () => {
    const ex = new ResponseExtractor(PYTHON);
    ex.ingest(cap(">>>"));
    ex.beginResponse("md()");
    const out = ex.ingest(cap(">>> md()", "- bullet one", "- bullet two", "---", ">>>"));
    expect(out).toEqual({ chat: ["- bullet one", "- bullet two", "---"], ideas: [], complete: true });
  });
});

describe("ResponseExtractor — idle-timeout completion (no prompt marker)", () => {
  it("finalize() flushes the held-back tail and completes", () => {
    const ex = new ResponseExtractor(getProfile("bash"));
    ex.ingest(cap("user@host:~$"));
    ex.beginResponse("echo hi");
    // bash's PS1 is not anchored, so the prompt return is not detected; the
    // last line stays held back until the idle timeout fires.
    expect(ex.ingest(cap("user@host:~$ echo hi", "hi"))).toEqual({ chat: [], ideas: [], complete: false });
    // Poller observes the pane went quiet → finalize.
    expect(ex.finalize()).toEqual({ chat: ["hi"], ideas: [], complete: true });
    expect(ex.responding).toBe(false);
  });

  it("finalize() is a no-op when not responding", () => {
    const ex = new ResponseExtractor(PYTHON);
    expect(ex.finalize()).toEqual({ chat: [], ideas: [], complete: false });
  });
});

describe("ResponseExtractor — scrollback / multiple cycles", () => {
  it("anchors on the MOST RECENT echo when prior cycles remain in scrollback", () => {
    const ex = new ResponseExtractor(PYTHON);
    // First cycle already in the captured scrollback.
    ex.ingest(cap(">>> first()", "first-out", ">>>"));
    // Second prompt sent — its echo and output appear below the first cycle.
    ex.beginResponse("second()");
    const out = ex.ingest(
      cap(">>> first()", "first-out", ">>> second()", "second-out", ">>>"),
    );
    expect(out).toEqual({ chat: ["second-out"], ideas: [], complete: true });
    expect(out.chat).not.toContain("first-out");
  });

  it("does not emit anything while idle between responses", () => {
    const ex = new ResponseExtractor(PYTHON);
    expect(ex.ingest(cap("banner", ">>>"))).toEqual({ chat: [], ideas: [], complete: false });
    expect(ex.ingest(cap("banner", ">>>"))).toEqual({ chat: [], ideas: [], complete: false });
  });
});

describe("ResponseExtractor — multiline input echo", () => {
  it("skips all echoed lines of a multi-line prompt", () => {
    const ex = new ResponseExtractor(PYTHON);
    ex.ingest(cap(">>>"));
    ex.beginResponse("for i in range(2):\n    print(i)");
    // python echoes the block across a primary + continuation prompt.
    const out = ex.ingest(
      cap(">>> for i in range(2):", "...     print(i)", "0", "1", ">>>"),
    );
    expect(out).toEqual({ chat: ["0", "1"], ideas: [], complete: true });
  });
});

describe("getProfile", () => {
  it("returns the default profile for an unknown name and warns", () => {
    const warnings: string[] = [];
    const profile = getProfile("nonsense-harness", (m) => warnings.push(m));
    expect(profile).toBe(DEFAULT_PROFILE);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/nonsense-harness/);
  });

  it("returns the default profile (no warning) when no name is given", () => {
    const warnings: string[] = [];
    expect(getProfile(undefined, (m) => warnings.push(m))).toBe(DEFAULT_PROFILE);
    expect(warnings.length).toBe(0);
  });

  it("resolves the claude profile by name", () => {
    expect(getProfile("claude")).toBe(CLAUDE_PROFILE);
  });
});

// ── extraction-contract §9 — the claude profile + idea contract matrix ──
// Captures below mirror a real claude 2.1.165 pane: a "❯" input prompt between
// horizontal rules, the assistant turn bulleted with "● ", word-wrapped ideas
// separated by blank lines, and a randomised "✻ <Verb> for <n>s" done-line.

/**
 * Drive the claude extractor over a full recorded capture. claude anchors on
 * the "● " assistant marker (not the echoed input), and completion is via the
 * poller's idle-timeout, so we merge ingest() + finalize() like the real poller
 * and drop blank chat lines (the frontend filters blank paragraphs too).
 */
function claudeRun(capture: string, opts: { onHeuristic?: (n: number) => void; onDebug?: (e: string, d: Record<string, string | number>) => void } = {}) {
  const ex = new ResponseExtractor(CLAUDE_PROFILE, opts);
  ex.beginResponse("");
  const a = ex.ingest(capture);
  const b = ex.finalize();
  return {
    chat: [...a.chat, ...b.chat].filter((l) => l.trim() !== ""),
    ideas: [...a.ideas, ...b.ideas],
  };
}

describe("claude profile — §9.1 chrome strip (verified against real claude 2.1.x)", () => {
  it("each chrome / prompt rule matches its sample line; real content does not", () => {
    const chrome = (line: string) => CLAUDE_PROFILE.chrome.some((re) => re.test(line));
    expect(chrome("Opus 4.8 (1M context) | main | ~/p | ctx:29.0k/1000k (3%) | 5h:33%")).toBe(true);
    expect(chrome("  Opus 4.8 (1M context) |  feat/x | ~/very/long/path/worktrees/a…")).toBe(true); // truncated
    expect(chrome("* Catapulting…")).toBe(true);
    expect(chrome("✽ Forging… (5s · ↓ 227 tokens)")).toBe(true);
    expect(chrome("✻ Worked for 3s")).toBe(true);
    expect(chrome("✻ Brewed for 4s")).toBe(true); // randomised verb
    expect(chrome("✻ Baked for 3s")).toBe(true);
    expect(chrome("⏵⏵ auto mode on (shift+tab to cycle) · PR #10 · ← for agents")).toBe(true);
    expect(chrome("⎿  Tip: Run claude --continue or claude --resume to resume a conversation")).toBe(true);
    expect(chrome("❯ go deeper on the latency budget")).toBe(true); // echoed input / suggestion / idle prompt
    expect(chrome("────────────────────────")).toBe(true);
    // Real chat / markdown / a context-window mention are NOT chrome.
    expect(chrome("Let me know which, or just tell me the task.")).toBe(false);
    expect(chrome("- a real bullet point")).toBe(false);
    expect(chrome("We could exploit the (1M context) window for whole-repo recall.")).toBe(false);
  });

  it("extracts only the conversational reply from a full claude capture", () => {
    const out = claudeRun(fixture("chrome-and-chat.txt"));
    expect(out.chat).toEqual(["Let me know which, or just tell me the task."]);
    expect(out.ideas).toEqual([]);
  });
});

describe("claude profile — §9.2 marked output", () => {
  it("extracts «IDEA» / «IDEA:kind» / bare ideas; markers never leak into chat", () => {
    const out = claudeRun(fixture("marked-ideas.txt"));
    expect(out.ideas).toEqual([
      {
        title: "Contextual Edge Ad Selection",
        body: "Pick ads at the CDN edge based on page content + request signals, cutting round-trips and latency to sub-50ms.",
      },
      { title: "Token rotation", body: "may break long-lived sessions", kind: "risk" },
      { title: "Offline-first canvas", body: "" },
    ]);
    expect(out.chat).toEqual([
      "Here are a few directions worth capturing.",
      "Happy to expand on any of these — which should we explore first?",
    ]);
    expect(out.chat.join("\n")).not.toContain("«IDEA»");
  });

  it("accepts the ASCII <<IDEA>> alias", () => {
    const out = claudeRun(cap("❯ go", "────", "● <<IDEA:feature>> Edgeless cards :: one note per idea", "✻ Worked for 1s", "❯"));
    expect(out.ideas).toEqual([{ title: "Edgeless cards", body: "one note per idea", kind: "feature" }]);
  });
});

describe("claude profile — §9.3 marker collision", () => {
  it("treats a mid-sentence «IDEA» mention as chat, not an idea", () => {
    const out = claudeRun(cap("❯ go", "────", "● We reserve the «IDEA» marker for genuine ideas only.", "✻ Worked for 1s", "❯"));
    expect(out.ideas).toEqual([]);
    expect(out.chat).toEqual(["We reserve the «IDEA» marker for genuine ideas only."]);
  });
});

describe("claude profile — §9.4 multiline / fenced idea", () => {
  it("parses an indented ```idea block into one Idea with the full multi-line body", () => {
    const out = claudeRun(fixture("fenced-idea.txt"));
    expect(out.ideas).toEqual([
      {
        title: "Adopt event-sourced canvas history",
        body:
          "Persist every CRDT op as an append-only log.\n" +
          "Enables time-travel scrub and per-idea provenance.\n" +
          "Cost: storage growth; mitigate with periodic snapshots.",
        kind: "decision",
      },
    ]);
    expect(out.chat).toEqual([
      "Sure — here is a richer one that needs a few lines.",
      "That one has real trade-offs worth discussing.",
    ]);
    expect(out.chat.join("\n")).not.toContain("```");
  });
});

describe("claude profile — §9.5 word-wrapped idea body", () => {
  it("rejoins a body claude wrapped across rows (word-boundary, blank-separated)", () => {
    const out = claudeRun(cap(
      "❯ go", "────",
      "● Sure.",
      "",
      "  «IDEA» Offline-first canvas :: cache CRDT ops in IndexedDB and replay",
      "  them on reconnect for full resilience.",
      "",
      "  Thoughts?",
      "✻ Worked for 1s", "❯",
    ));
    expect(out.ideas).toEqual([
      { title: "Offline-first canvas", body: "cache CRDT ops in IndexedDB and replay them on reconnect for full resilience." },
    ]);
    expect(out.chat).toEqual(["Sure.", "Thoughts?"]);
  });
});

describe("claude profile — §9.6 heuristic floor", () => {
  it("promotes a markerless bullet list to ideas AND logs the fallback", () => {
    const onHeuristic = vi.fn();
    const out = claudeRun(fixture("heuristic-bullets.txt"), { onHeuristic });
    expect(out.ideas).toEqual([
      { title: "Offline-first canvas", body: "", kind: "heuristic" },
      { title: "Token rotation safety", body: "", kind: "heuristic" },
      { title: "Event-sourced history", body: "", kind: "heuristic" },
    ]);
    expect(out.chat).toEqual(["Here are a few:", "Let me know which to expand."]);
    expect(onHeuristic).toHaveBeenCalledTimes(1);
    expect(onHeuristic).toHaveBeenCalledWith(3);
  });

  it("does NOT run the fallback when explicit markers are present", () => {
    const onHeuristic = vi.fn();
    claudeRun(fixture("marked-ideas.txt"), { onHeuristic });
    expect(onHeuristic).not.toHaveBeenCalled();
  });

  it("does not fire for the default profile (chat-only)", () => {
    const onHeuristic = vi.fn();
    const ex = new ResponseExtractor(DEFAULT_PROFILE, { onHeuristic });
    ex.beginResponse("go");
    const out = ex.ingest(cap("> go", "- one", "- two", "- three", ">"));
    expect(out.ideas).toEqual([]);
    expect(onHeuristic).not.toHaveBeenCalled();
  });
});

describe("claude profile — §9.7 streaming partial idea", () => {
  it("emits a still-growing idea exactly once, only after it terminates", () => {
    const ex = new ResponseExtractor(CLAUDE_PROFILE);
    ex.beginResponse("");

    // Capture N: the «IDEA» line is the last (still-growing) line — held back.
    const n1 = ex.ingest(cap("❯ go", "────", "● Thinking out loud.", "", "  «IDEA» Half a titl"));
    expect(n1.ideas).toEqual([]);

    // Capture N+1: the idea is terminated by the returned "❯" prompt.
    const n2 = ex.ingest(cap("❯ go", "────", "● Thinking out loud.", "", "  «IDEA» Half a title :: with a body", "❯"));
    const ideas = [...n2.ideas, ...ex.finalize().ideas];
    expect(ideas).toEqual([{ title: "Half a title", body: "with a body" }]);
  });
});

describe("claude profile — contract diagnostics (onDebug)", () => {
  it("reports a per-response summary split by source on completion", () => {
    const onDebug = vi.fn();
    claudeRun(cap("❯ go", "────", "● Some chat.", "", "  «IDEA» Edge cache :: serve from CDN", "✻ Worked for 1s", "❯"), { onDebug });
    const call = onDebug.mock.calls.find((c) => c[0] === "extract.contract");
    expect(call).toBeTruthy();
    expect(call![1]).toMatchObject({ profile: "claude", ideas: 1, contractIdeas: 1, heuristicIdeas: 0, nearMisses: 0 });
  });

  it("flags a near-miss when the agent mangles the marker (no guillemets / wrong wrapper)", () => {
    const onDebug = vi.fn();
    claudeRun(cap("❯ go", "────", "● Ideas:", "", "  Idea: cache at the edge", "  [IDEA] rotate tokens on attach", "✻ Worked for 1s", "❯"), { onDebug });
    const data = onDebug.mock.calls.filter((c) => c[0] === "extract.contract").at(-1)![1];
    expect(data.ideas).toBe(0);
    expect(data.nearMisses).toBe(2);
    expect(String(data.nearMissSample)).toContain("Idea: cache at the edge");
  });

  it("does not flag ordinary prose that merely contains the word idea", () => {
    const onDebug = vi.fn();
    claudeRun(cap("❯ go", "────", "● Ideally we cache aggressively.", "  That idea is mid-sentence.", "✻ Worked for 1s", "❯"), { onDebug });
    const data = onDebug.mock.calls.filter((c) => c[0] === "extract.contract").at(-1)![1];
    expect(data.nearMisses).toBe(0);
  });
});

describe("priming suppression — §9.9 (extractor level)", () => {
  it("never forwards output while not responding (the READY ack is swallowed)", () => {
    const ex = new ResponseExtractor(CLAUDE_PROFILE);
    // No beginResponse: models the priming window before the first user input,
    // during which the extractor is idle and emits nothing.
    expect(ex.ingest(cap("────", "❯", "● READY", "❯"))).toEqual({ chat: [], ideas: [], complete: false });
  });
});

// ── extraction-contract §9.8 — idempotent priming (mock tmux) ──

/** A minimal in-memory tmux fake: tracks session existence + the primed flag. */
function fakeTmux() {
  const calls: string[][] = [];
  const sessions = new Map<string, { primed: boolean }>();
  const argAfter = (args: string[], flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const tmux = async (...args: string[]): Promise<string> => {
    calls.push(args);
    const cmd = args[0];
    const name = argAfter(args, "-t");
    switch (cmd) {
      case "has-session":
        if (!sessions.has(name!)) throw new Error("no such session");
        return "";
      case "new-session":
        sessions.set(argAfter(args, "-s")!, { primed: false });
        return "";
      case "set-option":
        if (args.includes("@ai_storm_primed")) sessions.get(name!)!.primed = true;
        return "";
      case "show-options": {
        const s = sessions.get(name!);
        if (s?.primed) return "1";
        throw new Error("option unset"); // tmux errors on an unset user option
      }
      case "capture-pane":
        // Always shows the ready input box and the priming READY ack so the
        // readiness + ack probes resolve on the first poll.
        return "❯\n● READY\n";
      case "kill-session":
        sessions.delete(name!);
        return "";
      default:
        return "";
    }
  };
  const count = (cmd: string) => calls.filter((a) => a[0] === cmd).length;
  return { tmux, sessions, calls, count };
}

const PRIME = "You are in a brainstorming workspace.\nAcknowledge with the single word READY and nothing else.";

describe("TmuxSessionBackend — §9.8 idempotent priming", () => {
  it("primes a fresh session and stamps the durable @ai_storm_primed flag", async () => {
    const fake = fakeTmux();
    const backend = new TmuxSessionBackend({ tmux: fake.tmux, sleep: async () => {} });
    await backend.create({ workspaceId: "ws1", command: "claude", prime: PRIME });

    // The instruction was sent (heavy/multiline → paste buffer) and stamped.
    expect(fake.count("load-buffer")).toBe(1);
    expect(fake.calls.some((a) => a[0] === "set-option" && a.includes("@ai_storm_primed"))).toBe(true);
    expect(fake.sessions.get("ai-storm-ws1")?.primed).toBe(true);
  });

  it("does NOT re-prime when the durable flag is already set (reattach/restart)", async () => {
    const fake = fakeTmux();
    const backend = new TmuxSessionBackend({ tmux: fake.tmux, sleep: async () => {} });
    await backend.create({ workspaceId: "ws1", command: "claude", prime: PRIME });
    const sendsAfterFirst = fake.count("load-buffer");

    // Second create = a reattach: session exists, flag present → skip priming.
    await backend.create({ workspaceId: "ws1", command: "claude", prime: PRIME });
    expect(fake.count("load-buffer")).toBe(sendsAfterFirst); // no new prime sent
  });

  it("re-primes a session that exists WITHOUT the flag (mid-prime crash)", async () => {
    const fake = fakeTmux();
    // Simulate a session created by a backend that died before stamping.
    fake.sessions.set("ai-storm-ws2", { primed: false });
    const backend = new TmuxSessionBackend({ tmux: fake.tmux, sleep: async () => {} });

    await backend.create({ workspaceId: "ws2", command: "claude", prime: PRIME });
    expect(fake.count("load-buffer")).toBe(1); // (re)primed
    expect(fake.sessions.get("ai-storm-ws2")?.primed).toBe(true);
  });

  it("never primes a non-contract harness (no prime text)", async () => {
    const fake = fakeTmux();
    const backend = new TmuxSessionBackend({ tmux: fake.tmux, sleep: async () => {} });
    await backend.create({ workspaceId: "ws3", command: "bash" }); // no prime
    expect(fake.count("load-buffer")).toBe(0);
    expect(fake.calls.some((a) => a[0] === "set-option" && a.includes("@ai_storm_primed"))).toBe(false);
  });
});
