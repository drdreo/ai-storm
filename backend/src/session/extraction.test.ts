/**
 * Unit tests for the idea scanner (extraction-contract §3, §9) against recorded
 * `capture-pane` fixtures and synthetic captures. The conversation surface is a
 * real terminal now, so there is no chat/chrome extraction to test — only the
 * robust `«IDEA»` / fenced contract, session-scoped dedupe, near-miss
 * diagnostics, and idempotent priming. This is where the real risk lives, so it
 * is tested in isolation from tmux/node-pty (design §8 step 4).
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IdeaScanner,
  IdeaSink,
  ScoreScanner,
  ScoreSink,
  scanIdeas,
  scanScores,
  getProfile,
  commandProfileName,
  computeFileLaunch,
  launchArgsForProfile,
  profileUsesMcp,
  DEFAULT_PROFILE,
  CLAUDE_PROFILE,
  PI_PROFILE,
  CODEX_PROFILE,
  OPENCODE_PROFILE,
  PI_EXTENSION_FILENAME,
  type Idea,
  type McpLaunchContext
} from "./extraction/index.ts";
import { TOOLS } from "../mcp/endpoint.ts";
import { McpSessionRegistry } from "../mcp/registry.ts";
import { TmuxSessionBackend } from "./tmux-backend.ts";
import { NodePtySessionBackend } from "./nodepty-backend.ts";
import { fakeTmux } from "./test-support/fake-tmux.ts";
import { ideaIdentityKey } from "@ai-storm/shared";

/** Build a capture string from screen lines (as `capture-pane -p` would emit). */
const cap = (...lines: string[]): string => lines.join("\n");

/** Read a recorded/synthetic `capture-pane` fixture (extraction-contract §9). */
const fixture = (profile: "claude" | "pi" | "codex" | "opencode", name: string): string =>
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

  it("wires pi's capture channel AND prime via a generated extension, not argv (#177)", () => {
    expect(getProfile("pi")).toBe(PI_PROFILE);
    expect(PI_PROFILE.supportsIdeaContract).toBe(true);
    expect(PI_PROFILE.usesMcp).toBe(true);
    expect(PI_PROFILE.mcpArgs).toBeUndefined();
    // NO argv priming: a multi-line --append-system-prompt value does not
    // survive the Windows cmd.exe shim wrap (truncates at the first newline,
    // swallowing every later argument) — the prime rides the extension.
    expect(PI_PROFILE.systemPromptFlag).toBeUndefined();
    expect(typeof PI_PROFILE.fileLaunch).toBe("function");
  });

  it("resolves the codex profile with developer-instructions priming", () => {
    expect(getProfile("codex")).toBe(CODEX_PROFILE);
    expect(CODEX_PROFILE.supportsIdeaContract).toBe(true);
    expect(CODEX_PROFILE.systemPromptFlag).toBe("-c");
    expect(CODEX_PROFILE.systemPromptConfigKey).toBe("developer_instructions");
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

  it("defaults Codex to the fast/cheap mini model at medium reasoning", () => {
    expect(CODEX_PROFILE.modelFlag).toBe("--model");
    expect(CODEX_PROFILE.defaultModel).toBe("gpt-5.4-mini");
    expect(CODEX_PROFILE.defaultConfig).toEqual({ model_reasoning_effort: '"medium"' });
  });

  it("warns and falls back to default for an unknown profile", () => {
    const warnings: string[] = [];
    expect(getProfile("nope", (m) => warnings.push(m))).toBe(DEFAULT_PROFILE);
    expect(warnings.length).toBe(1);
  });

  it("resolves the opencode profile as file/env-wired, not argv-wired", () => {
    expect(getProfile("opencode")).toBe(OPENCODE_PROFILE);
    expect(OPENCODE_PROFILE.supportsIdeaContract).toBe(true);
    expect(OPENCODE_PROFILE.usesMcp).toBe(true);
    expect(OPENCODE_PROFILE.mcpArgs).toBeUndefined();
    expect(OPENCODE_PROFILE.systemPromptFlag).toBeUndefined();
    expect(typeof OPENCODE_PROFILE.fileLaunch).toBe("function");
  });

  it("maps supported command basenames to their profiles", () => {
    expect(commandProfileName("claude")).toBe("claude");
    expect(commandProfileName("/usr/local/bin/claude")).toBe("claude");
    expect(commandProfileName("pi")).toBe("pi");
    expect(commandProfileName("/opt/homebrew/bin/pi")).toBe("pi");
    expect(commandProfileName("codex")).toBe("codex");
    expect(commandProfileName("/opt/homebrew/bin/codex")).toBe("codex");
    expect(commandProfileName("opencode")).toBe("opencode");
    expect(commandProfileName("/opt/homebrew/bin/opencode")).toBe("opencode");
    expect(commandProfileName("C:\\Users\\me\\AppData\\Roaming\\npm\\pi.cmd")).toBe("pi");
    expect(commandProfileName("C:\\Users\\me\\AppData\\Roaming\\npm\\claude.ps1")).toBe("claude");
    expect(commandProfileName("C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd")).toBe("codex");
    expect(commandProfileName("bash")).toBeUndefined();
  });
});

describe("profileUsesMcp — argv or file/env MCP wiring", () => {
  it("is true for a profile with mcpArgs (claude)", () => {
    expect(profileUsesMcp(CLAUDE_PROFILE)).toBe(true);
  });

  it("is true for profiles with usesMcp (opencode, pi), which have no mcpArgs", () => {
    expect(profileUsesMcp(OPENCODE_PROFILE)).toBe(true);
    // pi's generated extension is an MCP client over plain fetch (#177) —
    // usesMcp mints the session token and selects the tool-teaching prime.
    expect(profileUsesMcp(PI_PROFILE)).toBe(true);
  });

  it("is true for Codex now that it wires Streamable HTTP MCP via config overrides", () => {
    expect(profileUsesMcp(CODEX_PROFILE)).toBe(true);
  });

  it("is false for profiles with neither", () => {
    expect(profileUsesMcp(DEFAULT_PROFILE)).toBe(false);
  });
});

describe("computeFileLaunch — opencode's file/env launch injection", () => {
  const mcp: McpLaunchContext = {
    url: "http://127.0.0.1:8787/mcp/ws1/0123456789abcdef0123456789abcdef",
    serverName: "ai-storm"
  };

  it("returns a config file + instructions file + OPENCODE_CONFIG env var", () => {
    const result = computeFileLaunch(OPENCODE_PROFILE, { dir: "/tmp/ai-storm-opencode-xyz", mcp, prime: PRIME });
    expect(result).toBeDefined();
    expect(result!.env.OPENCODE_CONFIG).toMatch(/opencode\.json$/);
    const configFile = result!.files.find((f) => f.path.endsWith("opencode.json"))!;
    const config = JSON.parse(configFile.content);
    expect(config.mcp).toEqual({ "ai-storm": { type: "remote", url: mcp.url } });
    expect(config.instructions).toEqual([expect.stringContaining("ai-storm-instructions.md")]);
    const instructionsFile = result!.files.find((f) => f.path.endsWith("ai-storm-instructions.md"))!;
    expect(instructionsFile.content).toBe(PRIME);
  });

  it("omits the mcp key when no MCP context is available (markers-only fallback)", () => {
    const result = computeFileLaunch(OPENCODE_PROFILE, { dir: "/tmp/ai-storm-opencode-xyz", prime: PRIME });
    const config = JSON.parse(result!.files.find((f) => f.path.endsWith("opencode.json"))!.content);
    expect(config.mcp).toBeUndefined();
  });

  it("is idempotent: skips generation entirely if the caller already set OPENCODE_CONFIG", () => {
    const result = computeFileLaunch(OPENCODE_PROFILE, {
      dir: "/tmp/ai-storm-opencode-xyz",
      mcp,
      prime: PRIME,
      callerEnv: { OPENCODE_CONFIG: "/home/user/my-opencode.json" }
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined for profiles with no fileLaunch (byte-identical to before)", () => {
    expect(computeFileLaunch(CLAUDE_PROFILE, { dir: "/tmp/x", prime: PRIME })).toBeUndefined();
    expect(computeFileLaunch(CODEX_PROFILE, { dir: "/tmp/x", prime: PRIME })).toBeUndefined();
  });
});

describe("computeFileLaunch — pi's generated capture extension (#177)", () => {
  const mcp: McpLaunchContext = {
    url: "http://127.0.0.1:8787/mcp/ws1/0123456789abcdef0123456789abcdef",
    serverName: "ai-storm"
  };

  it("writes the extension into the session dir and injects it via `-e <path>` args", () => {
    const result = computeFileLaunch(PI_PROFILE, { dir: "/tmp/ai-storm-pi-xyz", mcp, prime: PRIME });
    expect(result).toBeDefined();
    expect(result!.files).toHaveLength(1);
    const ext = result!.files[0];
    expect(ext.path.endsWith(PI_EXTENSION_FILENAME)).toBe(true);
    expect(result!.args).toEqual(["-e", ext.path]);
    // Everything rides the extension file — no env wiring, no argv prime.
    expect(result!.env).toEqual({});
    // The per-session endpoint URL (token embedded backend-side) is baked in,
    // and so is the prime (delivered via before_agent_start — a multi-line
    // argv prime does not survive pi's Windows cmd.exe shim wrap).
    expect(ext.content).toContain(JSON.stringify(mcp.url));
    expect(ext.content).toContain(JSON.stringify(PRIME));
    expect(ext.content).toContain("before_agent_start");
  });

  it("registers every tool the capture endpoint dispatches (name parity)", () => {
    const result = computeFileLaunch(PI_PROFILE, { dir: "/tmp/ai-storm-pi-xyz", mcp, prime: PRIME });
    const source = result!.files[0].content;
    expect(TOOLS.length).toBeGreaterThanOrEqual(3);
    for (const tool of TOOLS) {
      expect(source).toContain(`name: ${JSON.stringify(tool.name)}`);
    }
  });

  it("still delivers the prime (but registers no tools) when MCP is not configured", () => {
    const result = computeFileLaunch(PI_PROFILE, { dir: "/tmp/ai-storm-pi-xyz", prime: PRIME });
    expect(result).toBeDefined();
    const source = result!.files[0].content;
    expect(source).toContain(JSON.stringify(PRIME));
    expect(source).not.toContain("registerTool");
    expect(source).not.toContain("ENDPOINT");
  });

  it("skips the extension entirely with neither an endpoint nor a prime", () => {
    expect(computeFileLaunch(PI_PROFILE, { dir: "/tmp/ai-storm-pi-xyz" })).toBeUndefined();
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

// ── opencode: pending a real captured session (see #173, docs/guides/harness-authoring.md) ──
//
// opencode is an alt-screen TUI with no `--no-alt-screen` escape hatch (unlike
// codex), so marker-scan-from-capture may be structurally unreliable — this is
// unverified without a live capture. Fixtures + the marker-parity test (per
// docs/design/mcp-idea-capture.md §9.2) are deliberately NOT hand-authored;
// they must come from a real opencode session. Until then this stays `it.todo`.
describe("scanIdeas — opencode fixtures (pending live capture, #173)", () => {
  it.todo("extracts contract markers from opencode terminal captures");
  it.todo("does not promote markerless opencode bullets");
});

describe("opencode marker/MCP parity (mcp-idea-capture.md §9.2, pending live capture, #173)", () => {
  it.todo("produces deep-equal Ideas between the marker-scan path and the MCP capture_idea path");
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

// Short enough to stay inline (long launches go through a temp script file).
const PRIME = "Emit «IDEA» lines for canvas-worthy ideas.";

describe("TmuxSessionBackend — system-prompt priming at launch", () => {
  it("appends the harness's system-prompt flag + prime text to a fresh claude launch", async () => {
    const fake = fakeTmux();
    const backend = new TmuxSessionBackend({ tmux: fake.tmux, sleep: async () => {} });
    await backend.create({ projectId: "ws1", command: "claude", prime: PRIME });

    const launch = fake.sessions.get("ai-storm-ws1")?.launch ?? "";
    expect(launch).toContain("--model");
    expect(launch).toContain("haiku");
    expect(launch).toContain("--append-system-prompt");
    expect(launch).toContain("Emit «IDEA» lines");
    // No typed-priming side effects any more.
    expect(fake.count("load-buffer")).toBe(0);
  });

  it("primes a fresh pi launch via the extension, never argv, without forcing a model", async () => {
    const fake = fakeTmux();
    const backend = new TmuxSessionBackend({ tmux: fake.tmux, sleep: async () => {} });
    await backend.create({ projectId: "ws2", command: "pi", prime: PRIME });

    const launch = fake.sessions.get("ai-storm-ws2")?.launch ?? "";
    expect(launch).not.toContain("--model");
    // The multi-line prime must never enter pi's argv (Windows cmd.exe shim
    // truncates the launch line at the first newline) — it rides the
    // generated extension instead (#177).
    expect(launch).not.toContain("--append-system-prompt");
    expect(launch).toContain("'-e'");
    expect(launch).toContain(PI_EXTENSION_FILENAME);
    await backend.kill("ws2");
  });

  it("does not override an explicit pi model selection", async () => {
    const fake = fakeTmux();
    const backend = new TmuxSessionBackend({ tmux: fake.tmux, sleep: async () => {} });
    await backend.create({
      projectId: "ws2",
      command: "pi",
      args: ["--model", "openai/gpt-4o"],
      prime: PRIME
    });

    const launch = fake.sessions.get("ai-storm-ws2")?.launch ?? "";
    expect(launch).toContain("--model");
    expect(launch).toContain("openai/gpt-4o");
    await backend.kill("ws2");
  });

  it("injects Codex developer instructions, disables alternate screen, and selects mini medium", async () => {
    const fake = fakeTmux();
    const backend = new TmuxSessionBackend({ tmux: fake.tmux, sleep: async () => {} });
    await backend.create({ projectId: "ws4", command: "codex", prime: PRIME });

    const launch = fake.sessions.get("ai-storm-ws4")?.launch ?? "";
    expect(launch).toContain("--no-alt-screen");
    expect(launch).toContain("--model");
    expect(launch).toContain("gpt-5.4-mini");
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
      projectId: "ws5",
      command: "codex",
      args: ["--no-alt-screen", "--model", "gpt-5.5", "-c", 'model_reasoning_effort="high"'],
      prime: PRIME
    });

    const launch = fake.sessions.get("ai-storm-ws5")?.launch ?? "";
    expect((launch.match(/--no-alt-screen/g) ?? []).length).toBe(1);
    expect(launch).toContain("--model");
    expect(launch).toContain("gpt-5.5");
    expect(launch).not.toContain("gpt-5.4-mini");
    expect(launch).toContain("high");
    expect((launch.match(/model_reasoning_effort=/g) ?? []).length).toBe(1);
  });

  it("reuses an existing session as-is (no second new-session, already primed at launch)", async () => {
    const fake = fakeTmux();
    const backend = new TmuxSessionBackend({ tmux: fake.tmux, sleep: async () => {} });
    await backend.create({ projectId: "ws1", command: "claude", prime: PRIME });
    expect(fake.count("new-session")).toBe(1);

    await backend.create({ projectId: "ws1", command: "claude", prime: PRIME });
    expect(fake.count("new-session")).toBe(1); // reused, not recreated
  });

  it("never adds the system-prompt flag for a non-contract harness (bash)", async () => {
    const fake = fakeTmux();
    const backend = new TmuxSessionBackend({ tmux: fake.tmux, sleep: async () => {} });
    await backend.create({ projectId: "ws3", command: "bash", prime: PRIME });
    const launch = fake.sessions.get("ai-storm-ws3")?.launch ?? "";
    expect(launch).not.toContain("--append-system-prompt");
  });

  it("wires opencode via a temp config file + OPENCODE_CONFIG env var, not argv", async () => {
    const fake = fakeTmux();
    const backend = new TmuxSessionBackend({ tmux: fake.tmux, sleep: async () => {} });
    await backend.create({ projectId: "ws6", command: "opencode", prime: PRIME });

    // No argv-level priming/MCP flags — opencode has none.
    const launch = fake.sessions.get("ai-storm-ws6")?.launch ?? "";
    expect(launch).not.toContain("--append-system-prompt");
    expect(launch).not.toContain("--mcp-config");

    // OPENCODE_CONFIG is passed via tmux's -e mechanism on the new-session call.
    const newSession = fake.calls.find((c) => c[0] === "new-session")!;
    const envIdx = newSession.findIndex((a) => a.startsWith("OPENCODE_CONFIG="));
    expect(envIdx).toBeGreaterThan(0);
    expect(newSession[envIdx - 1]).toBe("-e");
    expect(newSession[envIdx]).toMatch(/OPENCODE_CONFIG=.*opencode\.json$/);

    await backend.kill("ws6");
  });

  it("does not write a temp config for opencode if the caller already set OPENCODE_CONFIG", async () => {
    const fake = fakeTmux();
    const backend = new TmuxSessionBackend({ tmux: fake.tmux, sleep: async () => {} });
    await backend.create({
      projectId: "ws7",
      command: "opencode",
      prime: PRIME,
      env: { OPENCODE_CONFIG: "/home/user/my-opencode.json" }
    });
    const newSession = fake.calls.find((c) => c[0] === "new-session")!;
    expect(newSession.filter((a) => a.startsWith("OPENCODE_CONFIG=")).length).toBe(1);
    expect(newSession).toContain("OPENCODE_CONFIG=/home/user/my-opencode.json");
    await backend.kill("ws7");
  });

  it("removes the opencode temp config dir on kill()", async () => {
    const fake = fakeTmux();
    const backend = new TmuxSessionBackend({ tmux: fake.tmux, sleep: async () => {} });
    await backend.create({ projectId: "ws8", command: "opencode", prime: PRIME });

    const newSession = fake.calls.find((c) => c[0] === "new-session")!;
    const configPath = newSession.find((a) => a.startsWith("OPENCODE_CONFIG="))!.slice("OPENCODE_CONFIG=".length);
    expect(existsSync(configPath)).toBe(true);

    await backend.kill("ws8");
    expect(existsSync(configPath)).toBe(false);
  });

  it("still removes the opencode temp config dir on kill() after an idempotent re-create() of the same session", async () => {
    const fake = fakeTmux();
    const backend = new TmuxSessionBackend({ tmux: fake.tmux, sleep: async () => {} });
    await backend.create({ projectId: "ws9", command: "opencode", prime: PRIME });

    const newSession = fake.calls.find((c) => c[0] === "new-session")!;
    const configPath = newSession.find((a) => a.startsWith("OPENCODE_CONFIG="))!.slice("OPENCODE_CONFIG=".length);
    expect(existsSync(configPath)).toBe(true);

    // Reuse path (design §3.3): create() again for the same live session must
    // not drop the tracked fileLaunchDir from #configs.
    await backend.create({ projectId: "ws9", command: "opencode", prime: PRIME });
    expect(fake.count("new-session")).toBe(1); // reused, not recreated

    await backend.kill("ws9");
    expect(existsSync(configPath)).toBe(false);
  });

  /** Resolve the tmux launch text through the long-command script indirection:
   *  launches over 200 chars are written to a temp script (`bash '<path>'`). */
  const launchText = (launch: string): string => {
    const viaScript = launch.match(/^bash '(.+)'$/);
    return viaScript ? readFileSync(viaScript[1], "utf-8") : launch;
  };

  it("wires Codex to the session MCP endpoint when the registry is configured", async () => {
    const registry = new McpSessionRegistry();
    registry.configure("http://127.0.0.1:8787");
    const fake = fakeTmux();
    const backend = new TmuxSessionBackend({ tmux: fake.tmux, sleep: async () => {}, registry });
    await backend.create({ projectId: "wsCodexMcp", command: "codex", prime: PRIME });

    const launch = launchText(fake.sessions.get("ai-storm-wsCodexMcp")?.launch ?? "");
    const url = registry.registerSession("wsCodexMcp")!.url;
    expect(registry.isRegistered("wsCodexMcp")).toBe(true);
    expect(launch).toContain(`mcp_servers.ai-storm.url=${JSON.stringify(url)}`);
    expect(launch).toContain("mcp_servers.ai-storm.enabled=true");
    expect(launch).toContain(
      'mcp_servers.ai-storm.enabled_tools=["capture_idea","capture_score","mark_idea_done","link_idea","get_board_ideas","get_projects"]'
    );
    expect(launch).toContain('mcp_servers.ai-storm.default_tools_approval_mode="approve"');

    await backend.kill("wsCodexMcp");
  });
  it("injects the generated pi capture extension via `-e` when MCP is configured (#177)", async () => {
    const registry = new McpSessionRegistry();
    registry.configure("http://127.0.0.1:8787");
    const fake = fakeTmux();
    const backend = new TmuxSessionBackend({ tmux: fake.tmux, sleep: async () => {}, registry });
    await backend.create({ projectId: "wsPi1", command: "pi", prime: PRIME });

    const launch = launchText(fake.sessions.get("ai-storm-wsPi1")?.launch ?? "");
    // Argv carries only the single-line `-e <temp path>` — no prime, no MCP flags.
    expect(launch).not.toContain("--append-system-prompt");
    expect(launch).toContain("'-e'");
    expect(launch).toContain(PI_EXTENSION_FILENAME);
    expect(launch).not.toContain("--mcp-config");

    // The extension exists on disk with this session's endpoint URL AND the
    // prime baked in (before_agent_start delivery, #177).
    const extPath = launch.match(/'([^']*ai-storm-capture\.ts)'/)?.[1];
    expect(extPath).toBeDefined();
    expect(existsSync(extPath!)).toBe(true);
    const url = registry.registerSession("wsPi1")!.url; // idempotent → same token
    const source = readFileSync(extPath!, "utf-8");
    expect(source).toContain(JSON.stringify(url));
    expect(source).toContain(JSON.stringify(PRIME));

    // Temp files follow the existing fileLaunch lifecycle: removed on kill().
    await backend.kill("wsPi1");
    expect(existsSync(extPath!)).toBe(false);
  });

  it("keeps caller-supplied pi `-e` extensions alongside the injected one (additive, not replaced)", async () => {
    const registry = new McpSessionRegistry();
    registry.configure("http://127.0.0.1:8787");
    const fake = fakeTmux();
    const backend = new TmuxSessionBackend({ tmux: fake.tmux, sleep: async () => {}, registry });
    await backend.create({ projectId: "wsPi2", command: "pi", args: ["-e", "/home/user/my-ext.ts"], prime: PRIME });

    const launch = launchText(fake.sessions.get("ai-storm-wsPi2")?.launch ?? "");
    expect(launch).toContain("my-ext.ts");
    expect(launch).toContain(PI_EXTENSION_FILENAME);
    await backend.kill("wsPi2");
  });

  it("still delivers the prime via the extension when MCP is not configured (capture stays markers-only)", async () => {
    const fake = fakeTmux();
    // A private, UNconfigured registry → registerSession declines → no tools,
    // but the prime still needs its carrier (argv is not an option for pi).
    const backend = new TmuxSessionBackend({
      tmux: fake.tmux,
      sleep: async () => {},
      registry: new McpSessionRegistry()
    });
    await backend.create({ projectId: "wsPi3", command: "pi", prime: PRIME });

    const launch = launchText(fake.sessions.get("ai-storm-wsPi3")?.launch ?? "");
    expect(launch).not.toContain("--append-system-prompt");
    expect(launch).toContain(PI_EXTENSION_FILENAME);
    const extPath = launch.match(/'([^']*ai-storm-capture\.ts)'/)?.[1];
    const source = readFileSync(extPath!, "utf-8");
    expect(source).toContain(JSON.stringify(PRIME));
    expect(source).not.toContain("registerTool"); // no endpoint → no tools
    await backend.kill("wsPi3");
  });
});

describe("NodePtySessionBackend — pi capture extension launch injection (#177)", () => {
  it("writes the extension with the session's endpoint URL and cleans it up on kill()", async () => {
    const registry = new McpSessionRegistry();
    registry.configure("http://127.0.0.1:8787");
    const before = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith("ai-storm-pi-")));

    const backend = new NodePtySessionBackend({ registry });
    // Empty command → the default shell (always resolvable), with the harness
    // profile forced to pi so its fileLaunch runs regardless of what binary
    // actually launches.
    await backend.create({ projectId: "ptyPi1", command: "", harnessProfile: "pi", prime: PRIME });

    const afterCreate = readdirSync(tmpdir()).filter((n) => n.startsWith("ai-storm-pi-"));
    const created = afterCreate.find((n) => !before.has(n));
    expect(created).toBeDefined();
    const dir = join(tmpdir(), created!);
    const extPath = join(dir, PI_EXTENSION_FILENAME);
    expect(existsSync(extPath)).toBe(true);
    const url = registry.registerSession("ptyPi1")!.url; // idempotent → same token
    const source = readFileSync(extPath, "utf-8");
    expect(source).toContain(JSON.stringify(url));
    expect(source).toContain(JSON.stringify(PRIME));

    await backend.kill("ptyPi1");
    expect(existsSync(dir)).toBe(false);
  });
});

describe("NodePtySessionBackend — opencode file/env launch injection", () => {
  it("writes the temp opencode config + instructions and cleans them up on kill()", async () => {
    const before = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith("ai-storm-opencode-")));

    const backend = new NodePtySessionBackend();
    // Empty command → the default shell (always resolvable), with the harness
    // profile forced to opencode so its fileLaunch runs regardless of what
    // binary actually launches.
    await backend.create({ projectId: "ptyOpencode1", command: "", harnessProfile: "opencode", prime: PRIME });

    const afterCreate = readdirSync(tmpdir()).filter((n) => n.startsWith("ai-storm-opencode-"));
    const created = afterCreate.find((n) => !before.has(n));
    expect(created).toBeDefined();
    const dir = join(tmpdir(), created!);
    expect(existsSync(join(dir, "opencode.json"))).toBe(true);
    expect(existsSync(join(dir, "ai-storm-instructions.md"))).toBe(true);
    const config = JSON.parse(readFileSync(join(dir, "opencode.json"), "utf-8"));
    expect(config.instructions).toEqual([join(dir, "ai-storm-instructions.md")]);
    expect(readFileSync(join(dir, "ai-storm-instructions.md"), "utf-8")).toBe(PRIME);

    await backend.kill("ptyOpencode1");
    expect(existsSync(dir)).toBe(false);
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
      await backend.create({ projectId: "wsR", command: "claude", prime: PRIME });

      const ideas: Idea[] = [];
      await backend.attach(
        "wsR",
        () => {},
        (idea) => ideas.push(idea),
        () => {},
        () => {},
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
    expect(args[args.indexOf("--allowedTools") + 1]).toBe(
      "mcp__ai-storm__capture_idea,mcp__ai-storm__capture_score,mcp__ai-storm__mark_idea_done,mcp__ai-storm__link_idea,mcp__ai-storm__get_board_ideas,mcp__ai-storm__get_projects"
    );
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
  it("wires Codex MCP through config overrides", () => {
    const args = launchArgsForProfile(CODEX_PROFILE, [], PRIME, ctx);
    expect(args).toContain('mcp_servers.ai-storm.url="http://127.0.0.1:8787/mcp/ws1/0123456789abcdef0123456789abcdef"');
    expect(args).toContain("mcp_servers.ai-storm.enabled=true");
    expect(args).toContain(
      'mcp_servers.ai-storm.enabled_tools=["capture_idea","capture_score","mark_idea_done","link_idea","get_board_ideas","get_projects"]'
    );
    expect(args).toContain('mcp_servers.ai-storm.default_tools_approval_mode="approve"');
    expect(args.filter((a) => a === "-c")).toHaveLength(6);
  });

  it("does not inject Codex MCP config when caller supplies the server URL", () => {
    const args = launchArgsForProfile(
      CODEX_PROFILE,
      ["-c", 'mcp_servers.ai-storm.url="http://localhost/custom"'],
      PRIME,
      ctx
    );
    expect(args.filter((a) => a.includes("mcp_servers.ai-storm.url=")).length).toBe(1);
    expect(args).not.toContain("mcp_servers.ai-storm.enabled=true");
    expect(args).not.toContain('mcp_servers.ai-storm.default_tools_approval_mode="approve"');
  });

  it("is idempotent against combined model and MCP flags", () => {
    const codexArgs = launchArgsForProfile(CODEX_PROFILE, ["--model=gpt-5.5"], PRIME);
    expect(codexArgs.filter((a) => a === "--model")).toHaveLength(0);
    expect(codexArgs).not.toContain("gpt-5.4-mini");

    const claudeArgs = launchArgsForProfile(CLAUDE_PROFILE, ["--mcp-config={}"], PRIME, ctx);
    expect(claudeArgs.filter((a) => a === "--mcp-config")).toHaveLength(0);
    expect(claudeArgs).not.toContain("--allowedTools");
  });

  it("respects caller-supplied Codex developer instructions", () => {
    const args = launchArgsForProfile(CODEX_PROFILE, ["-c", "developer_instructions=custom"], PRIME);
    expect(args.filter((a) => a === "-c")).toHaveLength(2);
    expect(args.filter((a) => a.includes("developer_instructions=")).length).toBe(1);
    expect(args).toContain("developer_instructions=custom");
  });

  it("without an MCP context the argv is byte-identical to before", () => {
    expect(launchArgsForProfile(CLAUDE_PROFILE, ["--verbose"], PRIME)).toEqual(
      launchArgsForProfile(CLAUDE_PROFILE, ["--verbose"], PRIME, undefined)
    );
    expect(launchArgsForProfile(CLAUDE_PROFILE, [], PRIME)).not.toContain("--mcp-config");
  });

  it("profiles without mcpArgs (pi, default) ignore the context entirely", () => {
    for (const profile of [PI_PROFILE, DEFAULT_PROFILE]) {
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
