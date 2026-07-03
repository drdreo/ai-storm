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
  IdeaSink,
  ScoreScanner,
  ScoreSink,
  scanIdeas,
  scanScores,
  getProfile,
  commandProfileName,
  launchArgsForProfile,
  DEFAULT_PROFILE,
  CLAUDE_PROFILE,
  PI_PROFILE,
  CODEX_PROFILE,
  type Idea,
  type McpLaunchContext
} from "./extraction.ts";
import { TmuxSessionBackend } from "./tmux-backend.ts";
import { ideaIdentityKey } from "@ai-storm/shared";

/** Build a capture string from screen lines (as `capture-pane -p` would emit). */
const cap = (...lines: string[]): string => lines.join("\n");

/** Read a recorded/synthetic `capture-pane` fixture (extraction-contract §9). */
const fixture = (profile: "claude" | "pi" | "codex", name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${profile}/${name}`, import.meta.url)), "utf-8");

const claudeFixture = (name: string): string => fixture("claude", name);
const piFixture = (name: string): string => fixture("pi", name);
const codexFixture = (name: string): string => fixture("codex", name);

/** Scan a whole capture in one shot (final), discarding the held-back tail. */
const ideasOf = (capture: string) => scanIdeas(capture.replace(/\r\n/g, "\n").split("\n"), true);

describe("profiles", () => {
  it("returns the default profile (no warning) when no name is given", () => {
    const warnings: string[] = [];
    expect(getProfile(undefined, (m) => warnings.push(m))).toBe(DEFAULT_PROFILE);
    expect(warnings.length).toBe(0);
  });

  it("resolves the claude profile by name as contract-aware", () => {
    expect(getProfile("claude")).toBe(CLAUDE_PROFILE);
    expect(CLAUDE_PROFILE.supportsIdeaContract).toBe(true);
    expect(DEFAULT_PROFILE.supportsIdeaContract).toBe(false);
  });

  it("resolves the pi profile by name and primes it like Claude Code", () => {
    expect(getProfile("pi")).toBe(PI_PROFILE);
    expect(PI_PROFILE.supportsIdeaContract).toBe(true);
    expect(PI_PROFILE.systemPromptFlag).toBe("--append-system-prompt");
  });

  it("resolves the codex profile with developer-instructions priming", () => {
    expect(getProfile("codex")).toBe(CODEX_PROFILE);
    expect(CODEX_PROFILE.supportsIdeaContract).toBe(true);
    expect(CODEX_PROFILE.systemPromptFlag).toBe("-c");
    expect(CODEX_PROFILE.systemPromptValue?.("Emit «IDEA» lines")).toBe('developer_instructions="Emit «IDEA» lines"');
    expect(CODEX_PROFILE.defaultArgs).toContain("--no-alt-screen");
  });

  it("defaults the claude profile to a fast model (haiku via --model)", () => {
    expect(CLAUDE_PROFILE.modelFlag).toBe("--model");
    expect(CLAUDE_PROFILE.defaultModel).toBe("haiku");
    // A bare/non-AI harness selects no model.
    expect(DEFAULT_PROFILE.modelFlag).toBeUndefined();
    expect(DEFAULT_PROFILE.defaultModel).toBeUndefined();
  });

  it("lets pi use its own configured default model unless args specify one", () => {
    expect(PI_PROFILE.modelFlag).toBe("--model");
    expect(PI_PROFILE.defaultModel).toBeUndefined();
  });

  it("defaults Codex to the fast/cheap spark model at medium reasoning", () => {
    expect(CODEX_PROFILE.modelFlag).toBe("--model");
    expect(CODEX_PROFILE.defaultModel).toBe("gpt-5.3-codex-spark");
    expect(CODEX_PROFILE.defaultConfig).toEqual({ model_reasoning_effort: '"medium"' });
  });

  it("warns and falls back to default for an unknown profile", () => {
    const warnings: string[] = [];
    expect(getProfile("nope", (m) => warnings.push(m))).toBe(DEFAULT_PROFILE);
    expect(warnings.length).toBe(1);
  });

  it("maps supported command basenames to their profiles", () => {
    expect(commandProfileName("claude")).toBe("claude");
    expect(commandProfileName("/usr/local/bin/claude")).toBe("claude");
    expect(commandProfileName("pi")).toBe("pi");
    expect(commandProfileName("/opt/homebrew/bin/pi")).toBe("pi");
    expect(commandProfileName("codex")).toBe("codex");
    expect(commandProfileName("/opt/homebrew/bin/codex")).toBe("codex");
    expect(commandProfileName("C:\\Users\\me\\AppData\\Roaming\\npm\\pi.cmd")).toBe("pi");
    expect(commandProfileName("C:\\Users\\me\\AppData\\Roaming\\npm\\claude.ps1")).toBe("claude");
    expect(commandProfileName("C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd")).toBe("codex");
    expect(commandProfileName("bash")).toBeUndefined();
  });
});

describe("scanIdeas — single-line markers", () => {
  it("extracts «IDEA» / «IDEA:kind» / bare-title ideas anywhere in the pane", () => {
    expect(ideasOf(claudeFixture("marked-ideas.txt"))).toEqual([
      {
        title: "Contextual Edge Ad Selection",
        body: "Pick ads at the CDN edge based on page content + request signals, cutting round-trips and latency to sub-50ms."
      },
      { title: "Token rotation", body: "may break long-lived sessions", kind: "risk" },
      { title: "Offline-first canvas", body: "" }
    ]);
  });

  it("accepts the ASCII <<IDEA>> alias", () => {
    expect(ideasOf(cap("  <<IDEA:feature>> Edgeless cards :: one note per idea"))).toEqual([
      { title: "Edgeless cards", body: "one note per idea", kind: "feature" }
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
          "  Thoughts?"
        )
      )
    ).toEqual([
      {
        title: "Offline-first canvas",
        body: "cache CRDT ops in IndexedDB and replay them on reconnect for full resilience."
      }
    ]);
  });
});

describe("scanIdeas — fenced ideas", () => {
  it("parses an indented ```idea block into one Idea with the full multi-line body", () => {
    expect(ideasOf(claudeFixture("fenced-idea.txt"))).toEqual([
      {
        title: "Adopt event-sourced canvas history",
        body:
          "Persist every CRDT op as an append-only log.\n" +
          "Enables time-travel scrub and per-idea provenance.\n" +
          "Cost: storage growth; mitigate with periodic snapshots.",
        kind: "decision"
      }
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
        links: [{ to: "a1", relation: "about" }]
      }
    ]);
  });

  it("parses @ref with no kind", () => {
    expect(ideasOf(cap("  «IDEA@a1» Offline-first canvas :: cache CRDT ops"))).toEqual([
      {
        title: "Offline-first canvas",
        body: "cache CRDT ops",
        links: [{ to: "a1", relation: "about" }]
      }
    ]);
  });

  it("parses a trailing `!` on the ref into a 'supersedes' link (PD-012)", () => {
    expect(ideasOf(cap("  «IDEA:feature@a1!» Rotate token on attach :: survives the reconnect race"))).toEqual([
      {
        title: "Rotate token on attach",
        body: "survives the reconnect race",
        kind: "feature",
        links: [{ to: "a1", relation: "supersedes" }]
      }
    ]);
  });

  it("parses `@ref!` supersedes with no kind", () => {
    expect(ideasOf(cap("  «IDEA@a1!» Stronger plan :: addresses the objection"))).toEqual([
      {
        title: "Stronger plan",
        body: "addresses the objection",
        links: [{ to: "a1", relation: "supersedes" }]
      }
    ]);
  });

  it("parses a chained `@a1!@a2!` marker into one idea superseding every source (#62)", () => {
    expect(ideasOf(cap("  «IDEA:feature@a1!@a2!@a3!» Unified store :: one CRDT-backed canvas"))).toEqual([
      {
        title: "Unified store",
        body: "one CRDT-backed canvas",
        kind: "feature",
        links: [
          { to: "a1", relation: "supersedes" },
          { to: "a2", relation: "supersedes" },
          { to: "a3", relation: "supersedes" }
        ]
      }
    ]);
  });

  it("parses a mixed chain (`@a1@a2!`) — about for the bare ref, supersedes for the !", () => {
    expect(ideasOf(cap("  «IDEA@a1@a2!» Merge :: keep a1, replace a2"))).toEqual([
      {
        title: "Merge",
        body: "keep a1, replace a2",
        links: [
          { to: "a1", relation: "about" },
          { to: "a2", relation: "supersedes" }
        ]
      }
    ]);
  });

  it("detects a marker the agent leads its turn with (Claude/Codex turn bullet)", () => {
    // The first row of a harness turn may carry a bullet (Claude: "● ", Codex:
    // "• "); later rows only carry a margin. An idea emitted as the very first
    // line must still parse.
    expect(
      ideasOf(cap("● «IDEA:feature@a5!» Carb + protein pairing :: Toast with any spread", "  90s, no cooking"))
    ).toEqual([
      {
        title: "Carb + protein pairing",
        body: "Toast with any spread 90s, no cooking",
        kind: "feature",
        links: [{ to: "a5", relation: "supersedes" }]
      }
    ]);
    expect(ideasOf(cap("• «IDEA:feature» Browser Codex Harness :: captures browser state"))).toEqual([
      { title: "Browser Codex Harness", body: "captures browser state", kind: "feature" }
    ]);
  });

  it("accepts @ref on the ASCII <<IDEA>> alias", () => {
    expect(ideasOf(cap("  <<IDEA:feature@b2>> Edgeless cards :: one note per idea"))).toEqual([
      {
        title: "Edgeless cards",
        body: "one note per idea",
        kind: "feature",
        links: [{ to: "b2", relation: "about" }]
      }
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
          "  ```"
        )
      )
    ).toEqual([
      {
        title: "Adopt event sourcing",
        body: "replaces the snapshot approach",
        kind: "decision",
        id: "c3",
        links: [{ to: "a1", relation: "supersedes" }]
      }
    ]);
  });

  it("treats fenced `parent:` as an alias for `link:` (defaults to about)", () => {
    expect(ideasOf(cap("  ```idea", "  title: Child", "  parent: a1", "  body: branches off a1", "  ```"))).toEqual([
      { title: "Child", body: "branches off a1", links: [{ to: "a1", relation: "about" }] }
    ]);
  });
});

describe("scanIdeas — no markers", () => {
  it("returns nothing for a chrome/chat-only capture", () => {
    expect(ideasOf(claudeFixture("chrome-and-chat.txt"))).toEqual([]);
  });

  it("does not promote a markerless bullet list (no heuristic floor any more)", () => {
    expect(ideasOf(claudeFixture("heuristic-bullets.txt"))).toEqual([]);
    expect(ideasOf(piFixture("heuristic-bullets.txt"))).toEqual([]);
  });
});

describe("scanIdeas — pi fixtures", () => {
  it("extracts contract markers from pi terminal captures", () => {
    expect(ideasOf(piFixture("marked-ideas.txt"))).toEqual([
      {
        title: "Local model handoff",
        body: "Let pi route cheap brainstorm turns locally and escalate synthesis to the configured cloud model."
      },
      {
        title: "Provider drift",
        body: "multi-provider defaults can make test sessions non-deterministic unless args pin the model",
        kind: "risk"
      }
    ]);
  });
});

describe("scanIdeas — codex fixtures", () => {
  it("extracts contract markers from Codex terminal captures", () => {
    expect(ideasOf(codexFixture("marked-ideas.txt"))).toEqual([
      {
        title: "Spec-first harness adapter",
        body: "Describe each CLI's launch-time priming seam and keep extraction contract tests shared.",
        kind: "feature"
      },
      {
        title: "Alt-screen capture gap",
        body: "Codex must run with --no-alt-screen so tmux capture-pane sees normal scrollback markers.",
        kind: "risk"
      }
    ]);
  });

  it("does not promote markerless Codex bullets", () => {
    expect(ideasOf(codexFixture("heuristic-bullets.txt"))).toEqual([]);
  });
});

describe("scanIdeas — streaming hold-back", () => {
  it("holds back a still-growing marker line until more text lands below it", () => {
    // The «IDEA» line is the last non-blank line — held back (non-final).
    expect(scanIdeas(["● Thinking.", "", "  «IDEA» Half a titl"], false)).toEqual([]);
    // Next capture: a returned prompt sits below it → the idea is terminated.
    expect(scanIdeas(["● Thinking.", "", "  «IDEA» Half a title :: with a body", "❯"], false)).toEqual([
      { title: "Half a title", body: "with a body" }
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

  it("dedupes an idea whose interior spacing drifts after a reflow (#38)", () => {
    const scanner = new IdeaScanner();
    expect(scanner.scan(cap("  «IDEA» Edge cache :: serve from the CDN", "❯"))).toEqual([
      { title: "Edge cache", body: "serve from the CDN" }
    ]);
    // A pane resize re-wraps the line, so the next capture carries the same idea
    // with extra interior spaces. Identity is whitespace-normalized, so it is NOT
    // re-emitted — no duplicate card lands on the canvas (the resize-dup bug).
    expect(scanner.scan(cap("  «IDEA»  Edge   cache ::  serve from  the  CDN", "❯"))).toEqual([]);
  });

  it("dedupes a re-rendered linked idea but keeps distinct link targets apart (#42)", () => {
    const scanner = new IdeaScanner();
    const linked = {
      title: "Leak",
      body: "races",
      kind: "risk",
      links: [{ to: "a1", relation: "about" }]
    };
    expect(scanner.scan(cap("  «IDEA:risk@a1» Leak :: races", "❯"))).toEqual([linked]);
    // Same content AND same target re-rendered → not delivered twice.
    expect(scanner.scan(cap("  «IDEA:risk@a1» Leak :: races", "❯"))).toEqual([]);
    // Same content, DIFFERENT target → a distinct edge → emitted.
    expect(scanner.scan(cap("  «IDEA:risk@a1» Leak :: races", "  «IDEA:risk@b2» Leak :: races", "❯"))).toEqual([
      { title: "Leak", body: "races", kind: "risk", links: [{ to: "b2", relation: "about" }] }
    ]);
  });

  it("treats a different title/body/kind as a distinct idea", () => {
    const scanner = new IdeaScanner();
    expect(scanner.scan(cap("  «IDEA» A :: one", "❯"))).toEqual([{ title: "A", body: "one" }]);
    expect(scanner.scan(cap("  «IDEA» A :: one", "  «IDEA» B :: two", "❯"))).toEqual([{ title: "B", body: "two" }]);
  });

  it("a pre-seed scan (final, discarded) suppresses ideas already on screen", () => {
    const scanner = new IdeaScanner();
    // Seed with the priming instruction's example marker → never re-emitted.
    scanner.scan("  «IDEA» <short title> :: <one-line description>", true);
    expect(scanner.scan(cap("  «IDEA» <short title> :: <one-line description>", "❯"))).toEqual([]);
    expect(scanner.scan(cap("  «IDEA» Real one :: with substance", "❯"))).toEqual([
      { title: "Real one", body: "with substance" }
    ]);
  });
});

describe("IdeaSink / ScoreSink — shared dedupe across producers", () => {
  it("an idea offered to the shared sink directly is never re-emitted by the scanner", () => {
    // The MCP `capture_idea` path (mcp-idea-capture §6): the tool emits via the
    // sink; the fallback scanner then sees the agent ALSO echo a marker line for
    // the same idea — the shared seen-set delivers it exactly once.
    const sink = new IdeaSink();
    const scanner = new IdeaScanner({ sink });
    expect(sink.offer({ title: "Edge cache", body: "serve from CDN" })).toBe(true);
    expect(scanner.scan(cap("  «IDEA» Edge cache :: re-worded body", "❯"))).toEqual([]);
  });

  it("an idea the scanner emitted is rejected when offered to the sink again", () => {
    const sink = new IdeaSink();
    const scanner = new IdeaScanner({ sink });
    expect(scanner.scan(cap("  «IDEA» Edge cache :: serve from CDN", "❯"))).toHaveLength(1);
    expect(sink.offer({ title: "Edge cache", body: "", kind: undefined })).toBe(false);
    // A genuinely new identity still passes.
    expect(sink.offer({ title: "Cold start", body: "" })).toBe(true);
  });

  it("dedupes within a single offer sequence and keeps distinct links apart", () => {
    const sink = new IdeaSink();
    const linked = { title: "Leak", body: "", links: [{ to: "a1", relation: "about" as const }] };
    expect(sink.offer(linked)).toBe(true);
    expect(sink.offer(linked)).toBe(false);
    expect(sink.offer({ ...linked, links: [{ to: "b2", relation: "about" as const }] })).toBe(true);
  });

  it("ScoreSink shared between a scanner and a direct producer delivers once", () => {
    const sink = new ScoreSink();
    const scanner = new ScoreScanner(sink);
    expect(sink.offer({ ref: "a1", impact: 4, effort: 2, confidence: 3 })).toBe(true);
    expect(scanner.scan("«SCORE@a1» 4/2/3")).toEqual([]);
    // A re-triage (new tuple) still flows through the scanner.
    expect(scanner.scan("«SCORE@a1» 5/1/4")).toEqual([{ ref: "a1", impact: 5, effort: 1, confidence: 4 }]);
  });
});

// ── Scanner hardening: two-frame confirmation (mcp-idea-capture §1.1, §7) ──

describe("IdeaScanner — two-frame confirmation (opt-in resize hardening)", () => {
  it("never emits a half-painted marker line; the completed line emits once", () => {
    // Mid-repaint capture: a chunk/poll boundary left the marker row holding
    // HALF the title while a row BELOW it (terminal furniture) is already
    // painted — so the growing-tail hold-back does NOT protect it.
    const truncated = cap("  «IDEA» Resil", "  ────────────", "❯");
    const full = cap("  «IDEA» Resilient cache :: survive restarts", "❯");

    // Without confirmation (the default) the truncated title parses
    // "successfully" and a bogus card lands — the §1.1 failure mode.
    expect(new IdeaScanner().scan(truncated)).toEqual([{ title: "Resil", body: "" }]);

    // With confirmation, the half-painted parse exists in exactly one frame
    // and is never offered to the sink; only the stable complete line emits.
    const scanner = new IdeaScanner({ confirm: true });
    expect(scanner.scan(truncated)).toEqual([]); // candidate, one frame only
    expect(scanner.scan(full)).toEqual([]); // new identity → fresh candidate
    expect(scanner.scan(full)).toEqual([{ title: "Resilient cache", body: "survive restarts" }]);
    expect(scanner.scan(full)).toEqual([]); // sink dedupe: exactly once, ever
  });

  it("emits a stable idea on its second scan (one scan cycle of latency)", () => {
    const scanner = new IdeaScanner({ confirm: true });
    const frame = cap("  «IDEA:risk» Token leak :: refresh races the reattach", "❯");
    expect(scanner.scan(frame)).toEqual([]);
    expect(scanner.scan(frame)).toEqual([{ title: "Token leak", body: "refresh races the reattach", kind: "risk" }]);
  });

  it("drops a candidate not re-seen in the very next scan (no stale confirmation)", () => {
    const scanner = new IdeaScanner({ confirm: true });
    const frame = cap("  «IDEA» Flash :: gone next frame", "❯");
    expect(scanner.scan(frame)).toEqual([]); // candidate
    expect(scanner.scan(cap("just chat", "❯"))).toEqual([]); // not re-seen → dropped
    // A much-later coincidental reappearance must RE-EARN confirmation rather
    // than confirming against the stale candidate from frames ago.
    expect(scanner.scan(frame)).toEqual([]);
    expect(scanner.scan(frame)).toEqual([{ title: "Flash", body: "gone next frame" }]);
  });

  it("final scans bypass confirmation: the seeding scan suppresses immediately", () => {
    const scanner = new IdeaScanner({ confirm: true });
    // Attach-time seed (final, discarded): everything on screen — e.g. the
    // echoed priming example — must enter the sink NOW, not a frame later.
    scanner.scan("  «IDEA» <short title> :: <one-line description>", true);
    const frame = cap("  «IDEA» <short title> :: <one-line description>", "❯");
    expect(scanner.scan(frame)).toEqual([]);
    expect(scanner.scan(frame)).toEqual([]);
    // A genuinely new idea afterwards still flows (confirmed on its 2nd frame).
    const real = cap("  «IDEA» Real one :: with substance", "❯");
    expect(scanner.scan(real)).toEqual([]);
    expect(scanner.scan(real)).toEqual([{ title: "Real one", body: "with substance" }]);
  });

  it("feeds the shared sink only on confirmation, exactly once", () => {
    const sink = new IdeaSink();
    const scanner = new IdeaScanner({ sink, confirm: true });
    const frame = cap("  «IDEA» Edge cache :: serve from CDN", "❯");
    expect(scanner.scan(frame)).toEqual([]); // candidate — the sink is NOT fed yet
    expect(scanner.scan(frame)).toHaveLength(1); // confirmed → offered + emitted
    // The identity now sits in the shared sink exactly once: a co-producer
    // (the MCP capture_idea path) offering the same idea is rejected.
    expect(sink.offer({ title: "Edge cache", body: "different wording" })).toBe(false);
  });

  it("an unconfirmed candidate loses to a co-producer that claims the sink first", () => {
    const sink = new IdeaSink();
    const scanner = new IdeaScanner({ sink, confirm: true });
    const frame = cap("  «IDEA» Edge cache :: serve from CDN", "❯");
    expect(scanner.scan(frame)).toEqual([]); // candidate only — sink untouched
    expect(sink.offer({ title: "Edge cache", body: "" })).toBe(true); // MCP wins
    expect(scanner.scan(frame)).toEqual([]); // confirmed, but already delivered
  });

  it("reports pending candidates so an event-driven scheduler grants a follow-up scan", () => {
    const scanner = new IdeaScanner({ confirm: true });
    const frame = cap("  «IDEA» Edge cache :: serve from CDN", "❯");
    scanner.scan(frame);
    expect(scanner.pendingConfirmation).toBe(1); // needs one more look
    scanner.scan(frame);
    expect(scanner.pendingConfirmation).toBe(0); // delivered — no follow-up loop
    // The non-confirming default never asks for follow-ups.
    const plain = new IdeaScanner();
    plain.scan(frame);
    expect(plain.pendingConfirmation).toBe(0);
  });
});

describe("ideaIdentityKey — title-anchored identity (#38)", () => {
  it("ignores the body: same title+kind is one idea regardless of the description", () => {
    // The body is volatile (terminal reflow / re-streaming); anchoring on the
    // title is what stops a resize resurfacing the same idea as "new".
    expect(ideaIdentityKey({ title: "Edge cache", body: "serve from the CDN" })).toBe(
      ideaIdentityKey({ title: "Edge cache", body: "totally different wording here" })
    );
  });

  it("normalizes title whitespace", () => {
    expect(ideaIdentityKey({ title: "Edge cache", body: "" })).toBe(
      ideaIdentityKey({ title: "  Edge   cache ", body: "" })
    );
  });

  it("separates title from kind so they can't blur across the boundary", () => {
    // title "ab" (no kind) must not collide with title "a" + kind "b".
    expect(ideaIdentityKey({ title: "ab", body: "" })).not.toBe(ideaIdentityKey({ title: "a", body: "", kind: "b" }));
  });

  it("distinguishes kind: a same-titled risk vs. feature are different ideas", () => {
    expect(ideaIdentityKey({ title: "Caching", body: "x", kind: "risk" })).not.toBe(
      ideaIdentityKey({ title: "Caching", body: "x", kind: "feature" })
    );
  });

  it("keeps distinct link targets / relations apart (idea-graph §5.1)", () => {
    const base = { title: "Leak", body: "races", kind: "risk" };
    const aboutA1 = ideaIdentityKey({ ...base, links: [{ to: "a1", relation: "about" }] });
    expect(aboutA1).toBe(ideaIdentityKey({ ...base, links: [{ to: "a1" }] })); // about is the default
    expect(aboutA1).not.toBe(ideaIdentityKey({ ...base, links: [{ to: "b2", relation: "about" }] }));
    expect(aboutA1).not.toBe(ideaIdentityKey({ ...base, links: [{ to: "a1", relation: "supersedes" }] }));
  });

  it("ignores the idea's own id (identity is what it's about, not the minted ref)", () => {
    expect(ideaIdentityKey({ title: "X", body: "y", id: "a9" })).toBe(ideaIdentityKey({ title: "X", body: "y" }));
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
        // The launch command is the trailing positional arg. Long launches are
        // written to a temp script, so store the script body for assertions.
        {
          const launch = args[args.length - 1];
          const script = launch.match(/^bash '(.+)'$/)?.[1];
          sessions.set(argAfter(args, "-s")!, {
            launch: script ? readFileSync(script, "utf8") : launch
          });
        }
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
    expect(launch).toContain("--model");
    expect(launch).toContain("haiku");
    expect(launch).toContain("--append-system-prompt");
    expect(launch).toContain("Emit «IDEA» lines");
    // No typed-priming side effects any more.
    expect(fake.count("load-buffer")).toBe(0);
  });

  it("appends the system-prompt flag to a fresh pi launch without forcing a model", async () => {
    const fake = fakeTmux();
    const backend = new TmuxSessionBackend({ tmux: fake.tmux, sleep: async () => {} });
    await backend.create({ workspaceId: "ws2", command: "pi", prime: PRIME });

    const launch = fake.sessions.get("ai-storm-ws2")?.launch ?? "";
    expect(launch).not.toContain("--model");
    expect(launch).toContain("--append-system-prompt");
    expect(launch).toContain("Emit «IDEA» lines");
  });

  it("does not override an explicit pi model selection", async () => {
    const fake = fakeTmux();
    const backend = new TmuxSessionBackend({ tmux: fake.tmux, sleep: async () => {} });
    await backend.create({
      workspaceId: "ws2",
      command: "pi",
      args: ["--model", "openai/gpt-4o"],
      prime: PRIME
    });

    const launch = fake.sessions.get("ai-storm-ws2")?.launch ?? "";
    expect(launch).toContain("--model");
    expect(launch).toContain("openai/gpt-4o");
  });

  it("injects Codex developer instructions, disables alternate screen, and selects spark medium", async () => {
    const fake = fakeTmux();
    const backend = new TmuxSessionBackend({ tmux: fake.tmux, sleep: async () => {} });
    await backend.create({ workspaceId: "ws4", command: "codex", prime: PRIME });

    const launch = fake.sessions.get("ai-storm-ws4")?.launch ?? "";
    expect(launch).toContain("--no-alt-screen");
    expect(launch).toContain("--model");
    expect(launch).toContain("gpt-5.3-codex-spark");
    expect(launch).toContain("model_reasoning_effort=");
    expect(launch).toContain("medium");
    expect(launch).toContain("-c");
    expect(launch).toContain("developer_instructions=");
    expect(launch).toContain("Emit «IDEA» lines");
    expect(launch).not.toContain("--append-system-prompt");
  });

  it("does not duplicate Codex --no-alt-screen or override explicit Codex model/effort", async () => {
    const fake = fakeTmux();
    const backend = new TmuxSessionBackend({ tmux: fake.tmux, sleep: async () => {} });
    await backend.create({
      workspaceId: "ws5",
      command: "codex",
      args: ["--no-alt-screen", "--model", "gpt-5.5", "-c", 'model_reasoning_effort="high"'],
      prime: PRIME
    });

    const launch = fake.sessions.get("ai-storm-ws5")?.launch ?? "";
    expect((launch.match(/--no-alt-screen/g) ?? []).length).toBe(1);
    expect(launch).toContain("--model");
    expect(launch).toContain("gpt-5.5");
    expect(launch).not.toContain("gpt-5.3-codex-spark");
    expect(launch).toContain("high");
    expect((launch.match(/model_reasoning_effort=/g) ?? []).length).toBe(1);
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

// ── Scanner hardening: resize settle window on the tmux poll (mcp-idea-capture §1.2) ──

describe("TmuxSessionBackend — resize settle window", () => {
  it("skips scanning during the settle window, then resumes (two-frame confirmed)", async () => {
    vi.useFakeTimers();
    try {
      // fakeTmux handles session lifecycle; capture-pane reads a mutable pane.
      const fake = fakeTmux();
      let pane = "";
      const tmux = async (...args: string[]): Promise<string> =>
        args[0] === "capture-pane" ? pane : fake.tmux(...args);
      const backend = new TmuxSessionBackend({ tmux, sleep: async () => {} });
      await backend.create({ workspaceId: "wsR", command: "claude", prime: PRIME });

      const ideas: Idea[] = [];
      await backend.attach(
        "wsR",
        () => {},
        (idea) => ideas.push(idea),
        () => {},
        () => {}
      );

      // Steady state: an idea appears; with two-frame confirmation it emits on
      // the SECOND 400ms poll tick.
      pane = cap("  «IDEA» First :: steady state", "❯");
      await vi.advanceTimersByTimeAsync(400); // tick 1 — candidate
      expect(ideas).toEqual([]);
      await vi.advanceTimersByTimeAsync(400); // tick 2 — confirmed
      expect(ideas).toEqual([{ title: "First", body: "steady state" }]);

      // Resize → the pane repaints at the new width. The next tick lands inside
      // the settle window and must NOT scan the (half-painted) capture.
      await backend.resize("wsR", 80, 24);
      pane = cap("  «IDEA» First :: steady state", "  «IDEA» Second half-pa", "  ─────", "❯");
      await vi.advanceTimersByTimeAsync(400); // tick inside settle — skipped
      expect(ideas).toHaveLength(1);

      // Repaint finished; output quiet past the settle deadline → scanning
      // resumes and the now-complete line confirms over two ticks.
      pane = cap("  «IDEA» First :: steady state", "  «IDEA» Second half :: painted in full", "❯");
      await vi.advanceTimersByTimeAsync(400); // first post-settle tick — candidate
      expect(ideas).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(400); // confirmed
      expect(ideas).toEqual([
        { title: "First", body: "steady state" },
        { title: "Second half", body: "painted in full" }
      ]);
      // The half-painted "Second half-pa" never became a card.
      expect(ideas.some((i) => i.title.includes("half-pa"))).toBe(false);

      backend.detach("wsR");
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── mcp-idea-capture §9.7 — MCP launch-arg injection through the profile seam ──

describe("launchArgsForProfile — MCP launch context (mcp-idea-capture §4.3)", () => {
  const ctx: McpLaunchContext = {
    url: "http://127.0.0.1:8787/mcp/ws1/0123456789abcdef0123456789abcdef",
    serverName: "ai-storm"
  };

  it("wires the claude profile with --mcp-config + --allowedTools exactly once", () => {
    const args = launchArgsForProfile(CLAUDE_PROFILE, [], PRIME, ctx);
    const mcpIdx = args.indexOf("--mcp-config");
    expect(mcpIdx).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(args[mcpIdx + 1])).toEqual({
      mcpServers: { "ai-storm": { type: "http", url: ctx.url } }
    });
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("mcp__ai-storm__capture_idea,mcp__ai-storm__capture_score");
    expect(args.filter((a) => a === "--mcp-config")).toHaveLength(1);
    expect(args.filter((a) => a === "--allowedTools")).toHaveLength(1);
    // The prime stays last on the seam (PD-020 segment ordering unchanged).
    expect(args.indexOf("--append-system-prompt")).toBeGreaterThan(mcpIdx);
  });

  it("is idempotent against a caller-supplied --mcp-config", () => {
    const args = launchArgsForProfile(CLAUDE_PROFILE, ["--mcp-config", "{}"], PRIME, ctx);
    expect(args.filter((a) => a === "--mcp-config")).toHaveLength(1);
    // The whole MCP block is the caller's responsibility then — no stray allow-list.
    expect(args).not.toContain("--allowedTools");
  });

  it("without an MCP context the argv is byte-identical to before", () => {
    expect(launchArgsForProfile(CLAUDE_PROFILE, ["--verbose"], PRIME)).toEqual(
      launchArgsForProfile(CLAUDE_PROFILE, ["--verbose"], PRIME, undefined)
    );
    expect(launchArgsForProfile(CLAUDE_PROFILE, [], PRIME)).not.toContain("--mcp-config");
  });

  it("profiles without mcpArgs (codex, pi, default) ignore the context entirely", () => {
    for (const profile of [CODEX_PROFILE, PI_PROFILE, DEFAULT_PROFILE]) {
      expect(launchArgsForProfile(profile, ["--flag"], PRIME, ctx)).toEqual(
        launchArgsForProfile(profile, ["--flag"], PRIME)
      );
    }
  });
});

describe("scanScores (#60 triage)", () => {
  const scoresOf = (...lines: string[]) => scanScores(lines);

  it("parses impact/effort/confidence from a «SCORE@ref» line", () => {
    expect(scoresOf("«SCORE@a1» 4/2/3")).toEqual([{ ref: "a1", impact: 4, effort: 2, confidence: 3 }]);
  });

  it("treats confidence as optional", () => {
    expect(scoresOf("«SCORE@a2» 5/1")).toEqual([{ ref: "a2", impact: 5, effort: 1 }]);
  });

  it("accepts the ASCII alias and tolerant spacing", () => {
    expect(scoresOf("<<SCORE@b3>>  3 / 4 / 2")).toEqual([{ ref: "b3", impact: 3, effort: 4, confidence: 2 }]);
  });

  it("strips a leading harness turn bullet", () => {
    expect(scoresOf("● «SCORE@a1» 2/2/2")).toEqual([{ ref: "a1", impact: 2, effort: 2, confidence: 2 }]);
    expect(scoresOf("• «SCORE@a1» 2/2/2")).toEqual([{ ref: "a1", impact: 2, effort: 2, confidence: 2 }]);
  });

  it("ignores out-of-range values and mid-sentence mentions", () => {
    expect(scoresOf("«SCORE@a1» 7/2")).toEqual([]); // 7 > 5
    expect(scoresOf("I would score @a1 as 4/2 here")).toEqual([]); // not line-leading
    expect(scoresOf("«SCORE» 4/2")).toEqual([]); // ref is required
  });

  it("scans many score lines in one capture", () => {
    expect(scoresOf("«SCORE@a1» 4/2", "chatter", "«SCORE@a2» 1/5/3")).toEqual([
      { ref: "a1", impact: 4, effort: 2 },
      { ref: "a2", impact: 1, effort: 5, confidence: 3 }
    ]);
  });
});

describe("ScoreScanner dedupe (#60)", () => {
  it("emits a re-rendered score once, but a changed re-triage as a fresh update", () => {
    const s = new ScoreScanner();
    expect(s.scan("«SCORE@a1» 4/2/3")).toEqual([{ ref: "a1", impact: 4, effort: 2, confidence: 3 }]);
    // Same line re-rendered next frame → nothing new.
    expect(s.scan("«SCORE@a1» 4/2/3")).toEqual([]);
    // Re-triage changes the rating → a fresh update flows through.
    expect(s.scan("«SCORE@a1» 5/1/4")).toEqual([{ ref: "a1", impact: 5, effort: 1, confidence: 4 }]);
  });
});
