/**
 * Unit tests for the idea scanner (extraction-contract §3, §9) against recorded
 * `capture-pane` fixtures and synthetic captures. The conversation surface is a
 * real terminal now, so there is no chat/chrome extraction to test — only the
 * robust `«IDEA»` / fenced contract, session-scoped dedupe, near-miss
 * diagnostics, and idempotent priming. This is where the real risk lives, so it
 * is tested in isolation from tmux/node-pty (design §8 step 4).
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  IdeaScanner,
  scanIdeas,
  getProfile,
  commandProfileName,
  DEFAULT_PROFILE,
  CLAUDE_PROFILE,
} from "./extraction.ts";
import { TmuxSessionBackend } from "./tmux-backend.ts";

/** Build a capture string from screen lines (as `capture-pane -p` would emit). */
const cap = (...lines: string[]): string => lines.join("\n");

/** Read a recorded claude `capture-pane` fixture (extraction-contract §9). */
const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/claude/${name}`, import.meta.url)), "utf-8");

/** Scan a whole capture in one shot (final), discarding the held-back tail. */
const ideasOf = (capture: string) => scanIdeas(capture.replace(/\r\n/g, "\n").split("\n"), true);

describe("profiles", () => {
  it("returns the default profile (no warning) when no name is given", () => {
    const warnings: string[] = [];
    expect(getProfile(undefined, (m) => warnings.push(m))).toBe(DEFAULT_PROFILE);
    expect(warnings.length).toBe(0);
  });

  it("resolves the claude profile by name (it alone supports the idea contract)", () => {
    expect(getProfile("claude")).toBe(CLAUDE_PROFILE);
    expect(CLAUDE_PROFILE.supportsIdeaContract).toBe(true);
    expect(DEFAULT_PROFILE.supportsIdeaContract).toBe(false);
  });

  it("defaults the claude profile to a fast model (haiku via --model)", () => {
    expect(CLAUDE_PROFILE.modelFlag).toBe("--model");
    expect(CLAUDE_PROFILE.defaultModel).toBe("haiku");
    // A bare/non-AI harness selects no model.
    expect(DEFAULT_PROFILE.modelFlag).toBeUndefined();
    expect(DEFAULT_PROFILE.defaultModel).toBeUndefined();
  });

  it("warns and falls back to default for an unknown profile", () => {
    const warnings: string[] = [];
    expect(getProfile("nope", (m) => warnings.push(m))).toBe(DEFAULT_PROFILE);
    expect(warnings.length).toBe(1);
  });

  it("maps the claude command basename to the claude profile", () => {
    expect(commandProfileName("claude")).toBe("claude");
    expect(commandProfileName("/usr/local/bin/claude")).toBe("claude");
    expect(commandProfileName("bash")).toBeUndefined();
  });
});

describe("scanIdeas — single-line markers", () => {
  it("extracts «IDEA» / «IDEA:kind» / bare-title ideas anywhere in the pane", () => {
    expect(ideasOf(fixture("marked-ideas.txt"))).toEqual([
      {
        title: "Contextual Edge Ad Selection",
        body: "Pick ads at the CDN edge based on page content + request signals, cutting round-trips and latency to sub-50ms.",
      },
      { title: "Token rotation", body: "may break long-lived sessions", kind: "risk" },
      { title: "Offline-first canvas", body: "" },
    ]);
  });

  it("accepts the ASCII <<IDEA>> alias", () => {
    expect(ideasOf(cap("  <<IDEA:feature>> Edgeless cards :: one note per idea"))).toEqual([
      { title: "Edgeless cards", body: "one note per idea", kind: "feature" },
    ]);
  });

  it("ignores a mid-sentence «IDEA» mention (markers must start the line)", () => {
    expect(ideasOf(cap("● We reserve the «IDEA» marker for genuine ideas only.", "❯"))).toEqual([]);
  });

  it("rejoins a body claude word-wrapped across rows (blank-separated)", () => {
    expect(
      ideasOf(
        cap(
          "● Sure.",
          "",
          "  «IDEA» Offline-first canvas :: cache CRDT ops in IndexedDB and replay",
          "  them on reconnect for full resilience.",
          "",
          "  Thoughts?",
        ),
      ),
    ).toEqual([
      {
        title: "Offline-first canvas",
        body: "cache CRDT ops in IndexedDB and replay them on reconnect for full resilience.",
      },
    ]);
  });
});

describe("scanIdeas — fenced ideas", () => {
  it("parses an indented ```idea block into one Idea with the full multi-line body", () => {
    expect(ideasOf(fixture("fenced-idea.txt"))).toEqual([
      {
        title: "Adopt event-sourced canvas history",
        body:
          "Persist every CRDT op as an append-only log.\n" +
          "Enables time-travel scrub and per-idea provenance.\n" +
          "Cost: storage growth; mitigate with periodic snapshots.",
        kind: "decision",
      },
    ]);
  });

  it("holds back an unterminated fence until it closes (non-final)", () => {
    const open = ["  ```idea kind=decision", "  title: WIP", "  body: still typing"];
    expect(scanIdeas(open, false)).toEqual([]); // fence still open at the tail
    const closed = [...open, "  ```"];
    expect(scanIdeas(closed, false)).toEqual([{ title: "WIP", body: "still typing", kind: "decision" }]);
  });
});

describe("scanIdeas — idea-graph links (#42)", () => {
  it("parses an in-marker @ref into a single 'about' link", () => {
    expect(ideasOf(cap("  «IDEA:risk@a1» Token leak :: refresh races the reattach"))).toEqual([
      {
        title: "Token leak",
        body: "refresh races the reattach",
        kind: "risk",
        links: [{ to: "a1", relation: "about" }],
      },
    ]);
  });

  it("parses @ref with no kind", () => {
    expect(ideasOf(cap("  «IDEA@a1» Offline-first canvas :: cache CRDT ops"))).toEqual([
      { title: "Offline-first canvas", body: "cache CRDT ops", links: [{ to: "a1", relation: "about" }] },
    ]);
  });

  it("accepts @ref on the ASCII <<IDEA>> alias", () => {
    expect(ideasOf(cap("  <<IDEA:feature@b2>> Edgeless cards :: one note per idea"))).toEqual([
      {
        title: "Edgeless cards",
        body: "one note per idea",
        kind: "feature",
        links: [{ to: "b2", relation: "about" }],
      },
    ]);
  });

  it("leaves an unlinked idea without links (graceful degradation)", () => {
    expect(ideasOf(cap("  «IDEA» Plain idea :: no ref"))).toEqual([{ title: "Plain idea", body: "no ref" }]);
  });

  it("reads fenced id / link / rel keys (rel selects the relation)", () => {
    expect(
      ideasOf(
        cap(
          "  ```idea kind=decision",
          "  id: c3",
          "  link: a1",
          "  rel: supersedes",
          "  title: Adopt event sourcing",
          "  body: replaces the snapshot approach",
          "  ```",
        ),
      ),
    ).toEqual([
      {
        title: "Adopt event sourcing",
        body: "replaces the snapshot approach",
        kind: "decision",
        id: "c3",
        links: [{ to: "a1", relation: "supersedes" }],
      },
    ]);
  });

  it("treats fenced `parent:` as an alias for `link:` (defaults to about)", () => {
    expect(
      ideasOf(cap("  ```idea", "  title: Child", "  parent: a1", "  body: branches off a1", "  ```")),
    ).toEqual([{ title: "Child", body: "branches off a1", links: [{ to: "a1", relation: "about" }] }]);
  });
});

describe("scanIdeas — no markers", () => {
  it("returns nothing for a chrome/chat-only capture", () => {
    expect(ideasOf(fixture("chrome-and-chat.txt"))).toEqual([]);
  });

  it("does not promote a markerless bullet list (no heuristic floor any more)", () => {
    expect(ideasOf(cap("● Here are a few:", "  - Offline canvas", "  - Token rotation", "❯"))).toEqual([]);
  });
});

describe("scanIdeas — streaming hold-back", () => {
  it("holds back a still-growing marker line until more text lands below it", () => {
    // The «IDEA» line is the last non-blank line — held back (non-final).
    expect(scanIdeas(["● Thinking.", "", "  «IDEA» Half a titl"], false)).toEqual([]);
    // Next capture: a returned prompt sits below it → the idea is terminated.
    expect(scanIdeas(["● Thinking.", "", "  «IDEA» Half a title :: with a body", "❯"], false)).toEqual([
      { title: "Half a title", body: "with a body" },
    ]);
  });
});

describe("IdeaScanner — session-scoped dedupe", () => {
  it("emits each idea exactly once across repeated captures of the same pane", () => {
    const scanner = new IdeaScanner();
    const frame = cap("● Some chat.", "", "  «IDEA» Edge cache :: serve from CDN", "❯");
    expect(scanner.scan(frame)).toEqual([{ title: "Edge cache", body: "serve from CDN" }]);
    // The same «IDEA» line re-renders every frame until it scrolls off — but the
    // content-keyed dedupe means it is never delivered to the canvas twice.
    expect(scanner.scan(frame)).toEqual([]);
    expect(scanner.scan(frame)).toEqual([]);
  });

  it("dedupes a re-rendered linked idea but keeps distinct link targets apart (#42)", () => {
    const scanner = new IdeaScanner();
    const linked = { title: "Leak", body: "races", kind: "risk", links: [{ to: "a1", relation: "about" }] };
    expect(scanner.scan(cap("  «IDEA:risk@a1» Leak :: races", "❯"))).toEqual([linked]);
    // Same content AND same target re-rendered → not delivered twice.
    expect(scanner.scan(cap("  «IDEA:risk@a1» Leak :: races", "❯"))).toEqual([]);
    // Same content, DIFFERENT target → a distinct edge → emitted.
    expect(
      scanner.scan(cap("  «IDEA:risk@a1» Leak :: races", "  «IDEA:risk@b2» Leak :: races", "❯")),
    ).toEqual([{ title: "Leak", body: "races", kind: "risk", links: [{ to: "b2", relation: "about" }] }]);
  });

  it("treats a different title/body/kind as a distinct idea", () => {
    const scanner = new IdeaScanner();
    expect(scanner.scan(cap("  «IDEA» A :: one", "❯"))).toEqual([{ title: "A", body: "one" }]);
    expect(scanner.scan(cap("  «IDEA» A :: one", "  «IDEA» B :: two", "❯"))).toEqual([
      { title: "B", body: "two" },
    ]);
  });

  it("a pre-seed scan (final, discarded) suppresses ideas already on screen", () => {
    const scanner = new IdeaScanner();
    // Seed with the priming instruction's example marker → never re-emitted.
    scanner.scan("  «IDEA» <short title> :: <one-line description>", true);
    expect(scanner.scan(cap("  «IDEA» <short title> :: <one-line description>", "❯"))).toEqual([]);
    expect(scanner.scan(cap("  «IDEA» Real one :: with substance", "❯"))).toEqual([
      { title: "Real one", body: "with substance" },
    ]);
  });
});

describe("IdeaScanner — near-miss diagnostics", () => {
  it("flags newly-seen near-miss markers (mangled guillemets / wrong wrapper)", () => {
    const onDebug = vi.fn();
    const scanner = new IdeaScanner({ onDebug });
    scanner.scan(cap("● Ideas:", "  Idea: cache at the edge", "  [IDEA] rotate tokens on attach", "❯"));
    const call = onDebug.mock.calls.find((c) => c[0] === "idea.scan");
    expect(call).toBeTruthy();
    expect(call![1].nearMisses).toBe(2);
    expect(String(call![1].nearMissSample)).toContain("Idea: cache at the edge");
  });

  it("does not flag ordinary prose that merely contains the word idea", () => {
    const onDebug = vi.fn();
    const scanner = new IdeaScanner({ onDebug });
    scanner.scan(cap("● Ideally we cache aggressively.", "  That idea is mid-sentence.", "❯"));
    expect(onDebug.mock.calls.some((c) => c[0] === "idea.scan")).toBe(false);
  });
});

// ── extraction-contract §9.8 — idempotent priming (mock tmux) ──

/** A minimal in-memory tmux fake: tracks session existence + records new-session. */
function fakeTmux() {
  const calls: string[][] = [];
  const sessions = new Map<string, { launch: string }>();
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
        // The launch command is the trailing positional arg.
        sessions.set(argAfter(args, "-s")!, { launch: args[args.length - 1] });
        return "";
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

// Short enough to stay inline (long launches go through a temp script file).
const PRIME = "Emit «IDEA» lines for canvas-worthy ideas.";

describe("TmuxSessionBackend — system-prompt priming at launch", () => {
  it("appends the harness's system-prompt flag + prime text to a fresh claude launch", async () => {
    const fake = fakeTmux();
    const backend = new TmuxSessionBackend({ tmux: fake.tmux, sleep: async () => {} });
    await backend.create({ workspaceId: "ws1", command: "claude", prime: PRIME });

    const launch = fake.sessions.get("ai-storm-ws1")?.launch ?? "";
    expect(launch).toContain("--append-system-prompt");
    expect(launch).toContain("Emit «IDEA» lines");
    // No typed-priming side effects any more.
    expect(fake.count("load-buffer")).toBe(0);
  });

  it("reuses an existing session as-is (no second new-session, already primed at launch)", async () => {
    const fake = fakeTmux();
    const backend = new TmuxSessionBackend({ tmux: fake.tmux, sleep: async () => {} });
    await backend.create({ workspaceId: "ws1", command: "claude", prime: PRIME });
    expect(fake.count("new-session")).toBe(1);

    await backend.create({ workspaceId: "ws1", command: "claude", prime: PRIME });
    expect(fake.count("new-session")).toBe(1); // reused, not recreated
  });

  it("never adds the system-prompt flag for a non-contract harness (bash)", async () => {
    const fake = fakeTmux();
    const backend = new TmuxSessionBackend({ tmux: fake.tmux, sleep: async () => {} });
    await backend.create({ workspaceId: "ws3", command: "bash", prime: PRIME });
    const launch = fake.sessions.get("ai-storm-ws3")?.launch ?? "";
    expect(launch).not.toContain("--append-system-prompt");
  });
});
