/**
 * Idea scanner (extraction-contract §3) — the robust 20% we keep after dropping
 * server-side chat extraction.
 *
 * The conversation surface is now a real terminal: raw PTY bytes are streamed to
 * the browser and rendered by xterm.js, so the fragile half — per-version chrome
 * regexes, echo anchoring, the "● " reply marker, response-completion detection
 * — is gone. All that remains here is scanning the rendered pane for the
 * explicit `«IDEA»` / ` ```idea ` markers we define via priming and emitting the
 * ideas they describe.
 *
 * The module is deliberately source-agnostic. It is fed successive *captures* —
 * the full, flattened text of the pane as it currently reads (a `tmux
 * capture-pane -p` snapshot on POSIX, a `TerminalScreen` render on Windows) —
 * and returns the newly-seen ideas. Because the same marker line re-renders on
 * every frame until it scrolls off, ideas are deduped by their identity
 * (`ideaIdentityKey` — title + kind + links; the volatile body is excluded so a
 * pane resize that re-wraps it can't resurface the idea as "new", #38) across the
 * WHOLE session. There are no response boundaries any more.
 *
 * Pure and runtime-free so it is unit-testable against recorded fixtures.
 */

import { ideaIdentityKey, type Idea, type IdeaLink, type IdeaRelation, type Score } from "@ai-storm/shared";

export type { Idea, Score };

/**
 * Everything a harness profile needs to wire itself to the backend MCP server
 * at launch (mcp-idea-capture §4.3). Built backend-side at `create()` — the
 * URL embeds the per-session routing token, so it is never derived from
 * anything the model says.
 */
export interface McpLaunchContext {
  /** Per-session MCP endpoint: `http://127.0.0.1:<port>/mcp/<workspaceId>/<token>`. */
  url: string;
  /** Logical MCP server name ("ai-storm"); harness tool ids derive from it
   *  (`mcp__<serverName>__capture_idea`). Fixed so `--allowedTools` stays stable. */
  serverName: string;
}

/**
 * Per-harness rules. Reduced to what the idea scan still needs: whether the
 * harness understands the §4 idea contract (→ prime it) and the pane signature
 * meaning "ready for input" (the priming readiness probe). The chat-extraction
 * fields (prompt/chrome/response/completion markers) are gone — the terminal
 * renders itself now.
 */
export interface HarnessProfile {
  name: string;
  /**
   * Does this harness understand the §4 idea contract (→ prime it)? A bare
   * shell / non-AI command sets this false and is never primed.
   */
  supportsIdeaContract: boolean;
  /**
   * CLI/config flag this harness uses to inject launch-time instructions. When
   * set and a prime text is given, the backend launches the harness with
   * `[systemPromptFlag, systemPromptValue(primeText)]` so the idea contract is
   * part of the system/developer prompt — followed from the first turn, with
   * nothing typed into the terminal (far more reliable than injecting a priming
   * message). Absent → no priming.
   */
  systemPromptFlag?: string;
  /** Transform the prime text into the value paired with `systemPromptFlag`. */
  systemPromptValue?: (prime: string) => string;
  /** Default CLI flags for this harness unless the caller already supplied them. */
  defaultArgs?: string[];
  /**
   * CLI flag this harness uses to select a model, paired with `defaultModel`.
   * When both are set the backend launches the harness with `[modelFlag,
   * defaultModel]` — unless the caller already passed `modelFlag` in the args —
   * so a profile can default to a fast/cheap model without the user typing it.
   */
  modelFlag?: string;
  /** Model passed via `modelFlag` at launch when the caller supplies none. */
  defaultModel?: string;
  /** One-off Codex/pi-style config overrides appended unless the caller supplies the key. */
  defaultConfig?: Record<string, string>;
  /**
   * Build the CLI args that wire this harness to the backend MCP server
   * (mcp-idea-capture §4.3). Absent → the harness gets no MCP and stays on the
   * marker-scan path — graceful degradation by construction (§11.6): codex/pi
   * stay markers-only until their MCP config surfaces are verified against
   * pinned versions (§11.2). Presence also selects the MCP base prime over the
   * marker prime (§5) — one mechanism per session.
   */
  mcpArgs?: (ctx: McpLaunchContext) => string[];
}

/** A generic harness understands no contract until proven otherwise. */
export const DEFAULT_PROFILE: HarnessProfile = {
  name: "default",
  supportsIdeaContract: false
};

/**
 * The claude harness profile. `supportsIdeaContract` enables priming, delivered
 * via claude's `--append-system-prompt` flag at launch.
 */
export const CLAUDE_PROFILE: HarnessProfile = {
  name: "claude",
  supportsIdeaContract: true,
  systemPromptFlag: "--append-system-prompt",
  modelFlag: "--model",
  // Default to a fast, cheap model for the idea-scanning session; the user can
  // still override with an explicit `--model` in the harness args.
  defaultModel: "haiku",
  // MCP wiring (mcp-idea-capture §4.3): inline `--mcp-config` plus pre-allowed
  // tool ids so no permission prompt interrupts the brainstorm (§12.3).
  mcpArgs: ({ url, serverName }) => [
    "--mcp-config",
    JSON.stringify({ mcpServers: { [serverName]: { type: "http", url } } }),
    "--allowedTools",
    `mcp__${serverName}__capture_idea,mcp__${serverName}__capture_score`
  ]
};

/**
 * The pi harness profile. Pi intentionally supports the same system-prompt and
 * model flags we rely on for Claude Code, so it can be primed at launch through
 * the same profile seam and then driven as a real interactive TUI.
 */
export const PI_PROFILE: HarnessProfile = {
  name: "pi",
  supportsIdeaContract: true,
  systemPromptFlag: "--append-system-prompt",
  modelFlag: "--model"
  // No defaultModel: pi is multi-provider and already has user/project default
  // model settings. Forcing haiku here would break users authenticated through
  // OpenAI, Copilot, Gemini, etc.; explicit `--model` args still pass through.
};

/**
 * The Codex CLI profile. Codex has no `--append-system-prompt` flag; the
 * supported launch seam is a one-off config override, so we inject the same
 * idea contract as `developer_instructions` via `-c`. `--no-alt-screen` keeps
 * the conversation in tmux's normal scrollback so `capture-pane` can see the
 * emitted `«IDEA»` / `«SCORE»` markers instead of an alternate-screen TUI.
 */
export const CODEX_PROFILE: HarnessProfile = {
  name: "codex",
  supportsIdeaContract: true,
  systemPromptFlag: "-c",
  systemPromptValue: (prime) => `developer_instructions=${JSON.stringify(prime)}`,
  defaultArgs: ["--no-alt-screen"],
  modelFlag: "--model",
  // Keep the live brainstorming harness fast/cheap by default. Users can still
  // override with explicit `--model` / `-c model_reasoning_effort=...` args.
  defaultModel: "gpt-5.3-codex-spark",
  defaultConfig: { model_reasoning_effort: JSON.stringify("medium") }
};

const PROFILES: Record<string, HarnessProfile> = {
  default: DEFAULT_PROFILE,
  claude: CLAUDE_PROFILE,
  pi: PI_PROFILE,
  codex: CODEX_PROFILE,
  bash: { ...DEFAULT_PROFILE, name: "bash" },
  python: { ...DEFAULT_PROFILE, name: "python" }
};

/**
 * Build the final argv for a contract-aware harness profile. Kept here so tmux
 * and node-pty launch paths stay byte-for-byte aligned. `mcp` is the optional
 * MCP launch context (mcp-idea-capture §4.3): only a profile that declares
 * `mcpArgs` consumes it, and — like the model/config args — the injection is
 * idempotent against a caller who already supplied `--mcp-config` themselves.
 * Absent `mcp` (or absent `mcpArgs`) leaves the argv byte-identical to before.
 */
export function launchArgsForProfile(
  profile: HarnessProfile,
  baseArgs: string[],
  prime?: string,
  mcp?: McpLaunchContext
): string[] {
  const defaultArgs = (profile.defaultArgs ?? []).filter((arg) => !baseArgs.includes(arg));
  const modelArgs =
    profile.modelFlag && profile.defaultModel && !baseArgs.includes(profile.modelFlag)
      ? [profile.modelFlag, profile.defaultModel]
      : [];
  const configArgs = Object.entries(profile.defaultConfig ?? {}).flatMap(([key, value]) =>
    hasConfigOverride(baseArgs, key) ? [] : ["-c", `${key}=${value}`]
  );
  const mcpArgs = profile.mcpArgs && mcp && !baseArgs.includes("--mcp-config") ? profile.mcpArgs(mcp) : [];
  const primeArgs =
    profile.systemPromptFlag && prime ? [profile.systemPromptFlag, profile.systemPromptValue?.(prime) ?? prime] : [];
  return [...baseArgs, ...defaultArgs, ...modelArgs, ...configArgs, ...mcpArgs, ...primeArgs];
}

function hasConfigOverride(args: readonly string[], key: string): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-c" || arg === "--config") {
      const value = args[i + 1];
      if (value?.startsWith(`${key}=`)) return true;
      i++;
      continue;
    }
    if (arg.startsWith("-c") && arg.slice(2).trimStart().startsWith(`${key}=`)) return true;
    if (arg.startsWith("--config=") && arg.slice("--config=".length).startsWith(`${key}=`)) return true;
  }
  return false;
}

/**
 * Resolve a harness profile by name, falling back to the default. When an
 * unknown profile is requested we LOG (design §10) rather than silently guess.
 */
export function getProfile(name: string | undefined, onWarn?: (msg: string) => void): HarnessProfile {
  if (!name) return DEFAULT_PROFILE;
  const profile = PROFILES[name];
  if (!profile) {
    onWarn?.(`No harness profile "${name}"; using default rules.`);
    return DEFAULT_PROFILE;
  }
  return profile;
}

/**
 * Map a harness command to a profile name (extraction-contract §7.2). Uses the
 * command basename so `/usr/local/bin/claude` resolves like `claude` and Windows
 * npm shims such as `pi.cmd` resolve like `pi`. Unknown commands return
 * undefined → `getProfile` falls back to the default profile.
 */
export function commandProfileName(command: string): string | undefined {
  if (!command) return undefined;
  const base = command.trim().split(/[\\/]/).pop() ?? "";
  const normalized = base.replace(/\.(?:cmd|ps1|exe)$/i, "").toLowerCase();
  if (normalized === "claude") return "claude";
  if (normalized === "pi") return "pi";
  if (normalized === "codex") return "codex";
  return undefined;
}

// ── Contract grammar (extraction-contract Appendix B — single source of truth) ──

/**
 * `«IDEA[:kind][@ref[!]…]»` / `<<IDEA[:kind][@ref[!]…]>>` at line start. The
 * in-marker tag is `[:kind][@ref[!]…]` (idea-graph design §5.1): one or more
 * `@ref` tokens link this idea to the cards with those short refs; a trailing `!`
 * on a ref makes THAT link a `supersedes` (the idea REPLACES the target) instead
 * of the default `about`. Multiple chained refs (`@a1!@a2!`) let a single idea
 * supersede several sources — the multi-select `combine`/merge verb (#62). The
 * `!` form keeps `supersedes` on the robust single-line marker — the fenced
 * `rel:` key (below) is unreliable because the agent's TUI renders the code fence
 * away before the backend captures the screen (PD-008).
 * Groups: 1/3 = kind (guillemet/ASCII), 2/4 = the ref chain (`@a1!@a2`),
 * 5 = the remainder (`title :: body`). Individual refs are parsed from the chain
 * by {@link REF_TOKEN}.
 */
const IDEA_MARKER =
  /^\s*(?:«IDEA(?::([a-z][\w-]*))?((?:@[\w-]+!?)+)?»|<<IDEA(?::([a-z][\w-]*))?((?:@[\w-]+!?)+)?>>)\s*(.*)$/u;
/** One `@ref` (with optional trailing `!`) within an {@link IDEA_MARKER} chain. */
const REF_TOKEN = /@([\w-]+)(!)?/gu;
/** ` ```idea [kind=…] ` opens a fenced (multi-line body) idea. */
const IDEA_FENCE_OPEN = /^\s*```idea(?:\s+kind=([a-z][\w-]*))?\s*$/u;
/** A bare ` ``` ` closes a fenced idea. */
const IDEA_FENCE_CLOSE = /^\s*```\s*$/;

/**
 * `«SCORE@ref» <impact>/<effort>[/<confidence>]` at line start (#60) — the AI
 * triage marker. Unlike `«IDEA»` it never creates a card: it carries a 1..5
 * impact/effort(/confidence) rating for the EXISTING card with that short ref.
 * Confidence is optional. The `@ref` is required — a score with no target is
 * meaningless. ASCII alias `<<SCORE@ref>>` accepted like the idea marker.
 * Groups: 1/2 = ref (guillemet/ASCII), 3 = impact, 4 = effort, 5 = confidence.
 */
const SCORE_MARKER = /^\s*(?:«SCORE@([\w-]+)»|<<SCORE@([\w-]+)>>)\s*([1-5])\s*\/\s*([1-5])(?:\s*\/\s*([1-5]))?\s*$/u;
/**
 * Fenced-body recognised keys (case-insensitive): title / body / kind, plus the
 * idea-graph keys id / link (alias parent) / rel (idea-graph design §5.1).
 */
const FENCE_KEY = /^(title|body|kind|id|link|parent|rel)\s*:\s*(.*)$/i;

/**
 * A line that LOOKS like an attempted idea marker but did not parse — used to
 * diagnose a contract-following lapse: mangled guillemets (`«IDEA »`, `?IDEA?`),
 * the bare word (`Idea: …`), bracketed (`[IDEA]`), or markdown-wrapped
 * (`**IDEA**`). Anchored at line start so a mid-sentence "idea" is not flagged,
 * and `\bidea\b` so "Ideally"/"ideas" don't trip it.
 */
const MARKER_NEAR_MISS = /^\s*[^\w\s]{0,4}\s*idea\b/iu;

/**
 * Leading turn bullet that harnesses render on the FIRST row of an assistant
 * turn (`● <text>` in Claude Code, `• <text>` in Codex); subsequent rows carry
 * only a margin (already absorbed by the markers' `^\s*`). Stripped before
 * scanning so an idea the agent leads its reply with — `• «IDEA…»` — is still
 * anchored as a marker. Without this, only ideas that fall on a later
 * (margin-only) row are detected.
 */
const TURN_BULLET = /^\s*[●•]\s+/u;

/**
 * Minimal, version-stable terminal furniture that BOUNDS an idea body when
 * rejoining word-wrapped rows: a box-drawing/blank rule, or a line that opens
 * with a prompt glyph (the input box sitting directly below the reply). This is
 * NOT the fragile per-version status-bar/spinner chrome we deleted — just enough
 * that the word-wrap rejoin never swallows the prompt that follows an idea.
 */
const CHROME_BOUNDARY = /^\s*(?:[─-╿\s]+|[>❯].*)$/u;

/** Coerce a relation token to a known {@link IdeaRelation}, else undefined. */
function parseRelation(value: string): IdeaRelation | undefined {
  const v = value.trim().toLowerCase();
  return v === "about" || v === "supersedes" ? v : undefined;
}

/**
 * Parse a single-line idea: `title :: body`, split on the FIRST `::`. Each in-marker
 * `@ref` in the chain becomes a link to that card (idea-graph §5.1) — `supersedes`
 * when that ref carried a trailing `!`, otherwise the default `about`. A chain of
 * supersede refs (`@a1!@a2!`) is the multi-select `combine` verb folding several
 * sources into one merged idea (#62).
 */
function ideaFromLine(kind: string | undefined, refChain: string | undefined, logical: string): Idea {
  const rest = logical.replace(IDEA_MARKER, "$5").trim(); // remainder after marker
  const sep = rest.indexOf("::");
  const title = (sep >= 0 ? rest.slice(0, sep) : rest).trim();
  const body = (sep >= 0 ? rest.slice(sep + 2) : "").trim();
  const idea: Idea = { title, body };
  if (kind) idea.kind = kind;
  const links = parseRefChain(refChain);
  if (links.length) idea.links = links;
  return idea;
}

/**
 * Split a marker ref chain (`@a1!@a2`) into typed links — one per `@ref`, each
 * `supersedes` if it carried a trailing `!`, else `about` (idea-graph §5.1).
 */
function parseRefChain(refChain: string | undefined): IdeaLink[] {
  if (!refChain) return [];
  const links: IdeaLink[] = [];
  for (const m of refChain.matchAll(REF_TOKEN)) {
    links.push({ to: m[1], relation: m[2] ? "supersedes" : "about" });
  }
  return links;
}

/**
 * Parse a fenced idea body. Recognised keys `title:`/`body:`/`kind:` seed the
 * fields; the first non-key line (with no key yet seen) is the title; every
 * line after `body:` (or every non-key line once a title exists) accumulates
 * verbatim into the body (extraction-contract §3.2 Form 2).
 */
function ideaFromFence(kind: string | undefined, rawBodyLines: string[]): Idea {
  let title: string | undefined;
  let kindV = kind;
  let id: string | undefined;
  let linkTo: string | undefined;
  let relation: IdeaRelation | undefined;
  const bodyParts: string[] = [];
  let inBody = false;

  // claude indents the whole assistant message (and thus the fenced block) by a
  // left margin, so trim each line before recognising the `key:` lines.
  const bodyLines = rawBodyLines.map((l) => l.trim());
  for (const line of bodyLines) {
    if (inBody) {
      bodyParts.push(line);
      continue;
    }
    const km = FENCE_KEY.exec(line);
    if (km) {
      const key = km[1].toLowerCase();
      const value = km[2].trim();
      switch (key) {
        case "title":
          title = value;
          break;
        case "kind":
          kindV = value || kindV;
          break;
        case "id":
          id = value || id;
          break;
        case "link":
        case "parent":
          linkTo = value || linkTo;
          break;
        case "rel":
          relation = parseRelation(value) ?? relation;
          break;
        default:
          // body:
          inBody = true;
          if (km[2].trim() !== "") bodyParts.push(km[2]);
          break;
      }
      continue;
    }
    // Non-key line: the first becomes the title, the rest spill into the body.
    if (title === undefined) title = line.trim();
    else {
      inBody = true;
      bodyParts.push(line);
    }
  }

  const finalTitle = (title ?? "").trim();
  const body = bodyParts.join("\n").trim();
  const idea: Idea = kindV ? { title: finalTitle, body, kind: kindV } : { title: finalTitle, body };
  if (id) idea.id = id;
  if (linkTo) idea.links = [{ to: linkTo, relation: relation ?? "about" }];
  return idea;
}

/**
 * Scan a chrome-free region for idea markers and return the ideas it contains
 * (extraction-contract §3.3). When `final` is false, a still-growing tail (the
 * last marker line, or an unterminated fence) is held back so a half-rendered
 * idea is never emitted as a finished card — on the next capture the line is no
 * longer the tail and is emitted complete. The non-idea text is ignored: the
 * terminal already renders the conversation, so only ideas matter here.
 *
 * A single-line idea whose body word-wraps across several rows is rejoined: the
 * agent (and `capture-pane -J`) wrap at word boundaries, so the body continues
 * on the following non-blank, non-marker rows until a blank line / the next
 * marker — independent of pane width.
 */
export function scanIdeas(rawRegion: string[], final: boolean): Idea[] {
  const ideas: Idea[] = [];
  // Strip the claude turn bullet up front so every downstream check (marker
  // match, word-wrap rejoin, hold-back tail, near-miss) sees the same lines.
  const region = rawRegion.map((l) => l.replace(TURN_BULLET, ""));
  const n = region.length;

  // Index of the last non-blank line — the "growing tail" we hold back.
  let lastNonBlank = -1;
  for (let k = 0; k < n; k++) if (region[k].trim() !== "") lastNonBlank = k;

  let i = 0;
  while (i < n) {
    const line = region[i];

    // Form 2 — fenced block.
    const fence = IDEA_FENCE_OPEN.exec(line);
    if (fence) {
      const kind = fence[1];
      const bodyLines: string[] = [];
      let j = i + 1;
      while (j < n && !IDEA_FENCE_CLOSE.test(region[j])) bodyLines.push(region[j++]);
      const closed = j < n;
      if (!closed && !final) break; // open fence at the tail → hold back
      ideas.push(ideaFromFence(kind, bodyLines));
      i = closed ? j + 1 : n; // consume the closing fence (or the rest)
      continue;
    }

    // Form 1 — single-line marker, rejoining word-wrapped continuation rows.
    const m = IDEA_MARKER.exec(line);
    if (m) {
      const kind = m[1] ?? m[3];
      const refChain = m[2] ?? m[4];
      let logical = line;
      let k = i;
      // Absorb continuation rows until a blank line / next marker / fence /
      // terminal furniture (e.g. the input prompt directly below the reply).
      while (
        k + 1 < n &&
        region[k + 1].trim() !== "" &&
        !IDEA_MARKER.test(region[k + 1]) &&
        !IDEA_FENCE_OPEN.test(region[k + 1]) &&
        !CHROME_BOUNDARY.test(region[k + 1])
      ) {
        k++;
        logical += " " + region[k].trim(); // re-insert the space consumed at the wrap
      }
      if (!final && k >= lastNonBlank) break; // growing idea at the tail → hold back
      ideas.push(ideaFromLine(kind, refChain, logical));
      i = k + 1;
      continue;
    }

    // Non-idea line — ignored (the terminal renders the conversation itself).
    i++;
  }

  return ideas;
}

// Per-idea identity for session-scoped dedupe (§7.1) is the shared
// `ideaIdentityKey` (title + kind + links; the volatile body is excluded — a pane
// resize re-wraps it and would otherwise make the idea look "new", #38). The
// session's `IdeaSink` is the single dedupe authority: a re-rendered marker is
// never re-sent, so the canvas just draws what it receives. Links stay part of
// identity (idea-graph §5.1): the same title at a different target is a distinct
// edge.

/**
 * Scan a region for `«SCORE@ref»` markers (#60) and return the scores they carry.
 * Each marker is a single, self-terminating line (no body to word-wrap), so —
 * unlike {@link scanIdeas} — there is no hold-back/rejoin: a SCORE line either
 * matches in full or is ignored. The `final` flag is accepted for call-site
 * symmetry but unused.
 */
export function scanScores(rawRegion: string[]): Score[] {
  const scores: Score[] = [];
  for (const raw of rawRegion) {
    const line = raw.replace(TURN_BULLET, "");
    const m = SCORE_MARKER.exec(line);
    if (!m) continue;
    const ref = m[1] ?? m[2];
    const score: Score = { ref, impact: Number(m[3]), effort: Number(m[4]) };
    if (m[5]) score.confidence = Number(m[5]);
    scores.push(score);
  }
  return scores;
}

/** Session-scoped dedupe key for a score: ref + the exact rated values. */
function scoreKey(s: Score): string {
  return `${s.ref}:${s.impact}/${s.effort}/${s.confidence ?? ""}`;
}

/**
 * Session-scoped dedupe authority for ideas (§7.1) — the ONE seen-set every idea
 * producer must feed before emitting. Owned by the session (not the scanner) so
 * several producers can share it: the capture scanner today, the MCP
 * `capture_idea` tool (mcp-idea-capture design §6) next — an idea delivered via
 * either channel is never re-emitted by the other. Identity is
 * `ideaIdentityKey` (title + kind + links; the volatile body is excluded so a
 * pane resize that re-wraps it can't resurface the idea as "new", #38).
 */
export class IdeaSink {
  readonly #seen = new Set<string>();

  /** Mark the idea seen; true when it was NEW this session (caller emits it). */
  offer(idea: Idea): boolean {
    const key = ideaIdentityKey(idea);
    if (this.#seen.has(key)) return false;
    this.#seen.add(key);
    return true;
  }

  /**
   * Whether an identity key has been seen, WITHOUT marking it. Lets the
   * two-frame confirmation in {@link IdeaScanner} tell a genuinely pending
   * candidate (parsed, awaiting its confirming frame) apart from an idea the
   * session already delivered — only the former warrants a follow-up scan.
   */
  hasKey(key: string): boolean {
    return this.#seen.has(key);
  }
}

/**
 * Session-scoped dedupe authority for scores — the triage sibling of
 * {@link IdeaSink}, likewise shared across producers (capture scanner now, MCP
 * `capture_score` tool next). Dedupe is by `(ref, impact, effort, confidence)`:
 * a marker re-rendered every frame is delivered once, but a **re-triage** that
 * changes a card's rating passes through as a fresh update (new tuple, unseen).
 */
export class ScoreSink {
  readonly #seen = new Set<string>();

  /** Mark the score seen; true when it was NEW this session (caller emits it). */
  offer(score: Score): boolean {
    const key = scoreKey(score);
    if (this.#seen.has(key)) return false;
    this.#seen.add(key);
    return true;
  }
}

/**
 * Stateful score scanner (#60) — the triage sibling of {@link IdeaScanner}.
 * Feed it each fresh capture; it returns only scores its {@link ScoreSink} has
 * not seen this session. Pass the session's shared sink so other producers
 * dedupe against the same set; the default private sink keeps single-producer
 * use (tests) self-contained.
 *
 * DELIBERATELY no two-frame confirmation here (unlike {@link IdeaScanner}):
 * a `«SCORE@a1» 4/2/3` marker is a single short line matched by a strict,
 * fully-anchored regex — a partial render fails the match outright in all but
 * one case (a cut landing exactly before the optional `/confidence`, yielding a
 * valid `4/2`). Even then the consequence is a transient rating the complete
 * line immediately supersedes (scores are last-write-wins per ref on the
 * canvas), not a persistent bogus card; and the quiescence gating both backends
 * now apply (ScanGate) removes the mid-chunk scan window that produced such
 * cuts. Confirmation would buy nothing but a scan cycle of triage latency.
 */
export class ScoreScanner {
  readonly #sink: ScoreSink;

  constructor(sink: ScoreSink = new ScoreSink()) {
    this.#sink = sink;
  }

  scan(capture: string): Score[] {
    return scanScores(toTrimmedLines(capture)).filter((score) => this.#sink.offer(score));
  }
}

/** Split a capture into lines and drop trailing blank lines (pane padding). */
function toTrimmedLines(capture: string): string[] {
  const lines = capture
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Stateful idea scanner. Feed it each fresh capture; it returns only the ideas
 * its {@link IdeaSink} has not seen before this session. Because the same
 * `«IDEA»` line re-renders on every frame until it scrolls off, the
 * content-keyed dedupe makes repeated scans idempotent — the canvas receives
 * each idea exactly once. Pass the session's shared sink so other producers
 * dedupe against the same set; the default private sink keeps single-producer
 * use (tests) self-contained.
 */
export class IdeaScanner {
  /** Session dedupe authority (§7.1) — shared with any co-producer via opts. */
  readonly #sink: IdeaSink;
  /** Near-miss lines already reported, so a re-rendered pane logs them once. */
  readonly #seenNearMiss = new Set<string>();
  readonly #onDebug?: (event: string, data: Record<string, string | number>) => void;
  /** Two-frame confirmation enabled? (mcp-idea-capture §1.1 hardening, opt-in.) */
  readonly #confirm: boolean;
  /**
   * Identity keys of the ideas parsed from the IMMEDIATELY-PRECEDING non-final
   * scan — the candidate set the next scan confirms against. Replaced wholesale
   * each scan, so a candidate that fails to reappear in the very next frame is
   * dropped and can never "confirm" against a much-later coincidental rerun.
   */
  #prevFrameKeys = new Set<string>();
  /** Candidates parsed last scan that are neither confirmed nor in the sink. */
  #pendingCount = 0;

  constructor(
    opts: {
      /** The session's shared dedupe sink; a private one is made if absent. */
      sink?: IdeaSink;
      /**
       * Opt-in **two-frame confirmation** (the scanner-hardening complement to
       * mcp-idea-capture §2 non-goals / §7; fixes failure mode §1.1): an idea
       * parsed from a non-final scan is only offered to the sink once an idea
       * with an IDENTICAL identity key appeared in the immediately-preceding
       * scan. A half-painted marker row (a chunk/poll boundary mid-repaint —
       * rows BELOW it already painted, so the growing-tail hold-back does not
       * apply) exists in exactly one frame, while a real idea re-renders in
       * every subsequent frame — so confirmation costs one scan cycle of
       * latency and generically kills partial-frame mis-parses. `final: true`
       * scans bypass confirmation: the attach-time seeding scan must suppress
       * everything currently on screen immediately. Off by default so the pure
       * single-scan semantics (and tests) stay unchanged; both backends enable
       * it.
       */
      confirm?: boolean;
      /**
       * Contract diagnostics: a **near-miss** (a line that looked like an idea
       * marker but did not parse) is surfaced so a contract-following lapse (the
       * agent mangling the `«IDEA»` format) is visible rather than silently lost.
       */
      onDebug?: (event: string, data: Record<string, string | number>) => void;
    } = {}
  ) {
    this.#sink = opts.sink ?? new IdeaSink();
    this.#confirm = opts.confirm ?? false;
    this.#onDebug = opts.onDebug;
  }

  /**
   * Scan a fresh full-pane capture and return the newly-seen ideas. `final`
   * defaults to false so a still-rendering idea at the very bottom is held back
   * until the next capture pushes more text below it.
   */
  scan(capture: string, final = false): Idea[] {
    const lines = toTrimmedLines(capture);
    const parsed = scanIdeas(lines, final);
    // Two-frame confirmation gates what reaches the sink; the sink is fed ONLY
    // on confirmation, so a confirmed idea is offered exactly once.
    const candidates = this.#confirm && !final ? this.#confirmAgainstPreviousFrame(parsed) : parsed;
    if (this.#confirm && final) {
      // A final scan emits immediately, but still counts as a frame: record its
      // keys so an idea visible at seed time is "already seen last frame".
      this.#prevFrameKeys = new Set(parsed.map(ideaIdentityKey));
    }
    const fresh = candidates.filter((idea) => this.#sink.offer(idea));
    // Pending = this frame's keys not yet delivered: they need ONE more scan to
    // confirm. An event-driven caller (the Windows gate) uses this to schedule
    // that follow-up — without it a candidate parsed from the LAST output burst
    // of a turn would stall unconfirmed until the next output arrives.
    this.#pendingCount = this.#confirm ? [...this.#prevFrameKeys].filter((key) => !this.#sink.hasKey(key)).length : 0;
    this.#emitDiagnostics(lines, fresh);
    return fresh;
  }

  /**
   * Number of candidates from the most recent scan still awaiting their
   * confirming frame (always 0 when confirmation is off). Non-zero tells an
   * event-driven scan scheduler to grant one more pass over the settled screen.
   */
  get pendingConfirmation(): number {
    return this.#pendingCount;
  }

  /**
   * Keep only ideas whose identity key was parsed from the immediately-
   * preceding scan, then replace the candidate set with THIS frame's keys
   * (stale candidates are dropped, never lingering to match a later rerun).
   */
  #confirmAgainstPreviousFrame(parsed: Idea[]): Idea[] {
    const confirmed: Idea[] = [];
    const frameKeys = new Set<string>();
    for (const idea of parsed) {
      const key = ideaIdentityKey(idea);
      frameKeys.add(key);
      if (this.#prevFrameKeys.has(key)) confirmed.push(idea);
    }
    this.#prevFrameKeys = frameKeys;
    return confirmed;
  }

  /**
   * Surface newly-seen ideas and near-miss markers. Both are deduped against the
   * session so the same re-rendered pane is not re-reported on every poll; a
   * diagnostic fires only when there is something new (a fresh idea or a fresh
   * near-miss — a line that looked like a marker but did not parse).
   */
  #emitDiagnostics(lines: string[], fresh: Idea[]): void {
    if (!this.#onDebug) return;
    const freshNearMiss = lines.filter(
      (l) => MARKER_NEAR_MISS.test(l) && !IDEA_MARKER.test(l) && !this.#seenNearMiss.has(l.trim())
    );
    for (const l of freshNearMiss) this.#seenNearMiss.add(l.trim());
    if (fresh.length === 0 && freshNearMiss.length === 0) return;
    const data: Record<string, string | number> = {
      ideas: fresh.length,
      nearMisses: freshNearMiss.length
    };
    if (freshNearMiss.length > 0) {
      data.nearMissSample = freshNearMiss
        .slice(0, 3)
        .map((l) => l.trim().slice(0, 80))
        .join(" ⏎ ");
    }
    this.#onDebug("idea.scan", data);
  }
}
