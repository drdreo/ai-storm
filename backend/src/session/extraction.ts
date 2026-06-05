/**
 * Response extraction (design §4.3 + extraction-contract §3, §5) — the net-new
 * core of the session layer.
 *
 * Turns an interactive harness's terminal pane into a pre-split stream of
 * **chat** lines (the AI's conversational reply, destined for the hub) and
 * **ideas** (brainstorming notes, destined for the canvas), excluding the
 * echoed user prompt and the harness chrome (prompt glyphs, spinners, status
 * footers, the claude TUI status bar / auto-mode / tips). It is the part
 * agent-orchestrator does NOT have: AO streams raw bytes to xterm.js; we
 * extract structured text and split it by an explicit contract.
 *
 * The module is deliberately source-agnostic. It is fed successive *captures* —
 * the full, ANSI-flattened text of the pane as it currently reads — and emits
 * the newly-finalized chat lines + ideas plus a completion flag. On POSIX a
 * capture is `tmux capture-pane -p` output; on Windows it is the running
 * transcript reconstructed from the node-pty byte stream (design §5.2). The
 * byte SOURCE differs; these extraction RULES are shared.
 *
 * Pipeline per capture (extraction-contract §7.1):
 *  1. Anchor on the echoed input line (`beginResponse`) and slice the response
 *     region (design §4.4: prompt → echoed-input → output → prompt).
 *  2. STAGE 1 — chrome strip: drop prompt glyphs + per-harness chrome regexes.
 *  3. STAGE 2 — contract parse (§3.3): split the survivors into `chat` and
 *     `ideas` via the `«IDEA»` / `<<IDEA>>` / fenced ```idea contract.
 *  4. Heuristic floor (§5.3): only when NO markers were present and the profile
 *     opts in — promote a bullet/heading list to ideas, and LOG that we did.
 *  5. Hold-back + dedupe: never emit a still-growing chat tail or a half-typed
 *     idea; dedupe ideas by (title, body, kind) within a response.
 *
 * Pure and runtime-free so it is unit-testable against recorded fixtures.
 */

import type { Idea } from "@ai-storm/shared";

export type { Idea };

/** Per-harness rules selecting prompt markers, chrome, and contract behaviour. */
export interface HarnessProfile {
  name: string;
  /**
   * Lines that, on their own, are the harness's idle input prompt. Used both to
   * detect completion (the prompt reappearing) and to drop prompt chrome.
   * Matched against the right-trimmed line, so they should be anchored bare
   * glyphs (e.g. `^>>>$`) — never something that also matches real content.
   */
  promptMarkers: RegExp[];
  /**
   * Strips a leading prompt glyph from an echoed-input line so it can be
   * compared to the text we sent (e.g. turns `>>> print(1)` into `print(1)`).
   */
  promptPrefix: RegExp;
  /** Lines matching any of these are chrome (spinners, status) and dropped. */
  chrome: RegExp[];
  /**
   * Does this harness understand the §4 idea contract (→ prime it)? A bare
   * shell / non-AI command sets this false and is never primed.
   */
  supportsIdeaContract: boolean;
  /** Pane signature meaning "ready for input" (priming readiness probe, §4.3). */
  readyMarker?: RegExp;
  /**
   * Enable the prose→idea heuristic fallback when no markers are present
   * (§5.3). Conservative default: only claude opts in.
   */
  ideaFallback: boolean;
  /**
   * Optional anchor for the START of an assistant turn (e.g. claude prefixes its
   * reply with a "● " bullet). When set, the response region is anchored on the
   * most recent such line instead of byte-matching the echoed input — claude
   * re-wraps and re-indents the echo, which defeats echo matching. Harnesses
   * that plainly echo input (python/bash) leave this unset.
   */
  responseMarker?: RegExp;
  /**
   * Optional leading decoration stripped from each surviving response line — the
   * assistant's left margin (claude's "● " first-line bullet or its 2-space
   * continuation indent). Presentation chrome, removed so it never reaches chat
   * and the contract parser sees flush-left text.
   */
  responsePrefix?: RegExp;
  /**
   * Optional explicit "response finished" signal in the pane (claude prints a
   * "✻ <Verb> for <n>s" done-line when a turn completes). When present in the
   * response region this completes the response immediately — more precise than
   * the poller's idle-timeout, which can fire during a mid-stream pause and drop
   * the lines that follow (e.g. the ideas after an intro sentence).
   */
  completionMarker?: RegExp;
}

/**
 * Sensible default profile. Handles bare REPL/shell prompts (`>`, `❯`, `>>>`,
 * `...`, `$`, `#`), common spinner frames, and "thinking…" status lines. A
 * generic harness is chat-only (no contract, no fallback) until proven
 * otherwise; refine per harness via {@link getProfile}.
 */
export const DEFAULT_PROFILE: HarnessProfile = {
  name: "default",
  promptMarkers: [
    /^>>>$/, // python REPL primary
    /^\.\.\.$/, // python REPL continuation
    /^[>❯$#%]$/, // bare shell / generic prompt glyph
    /^[a-zA-Z][\w.-]*[>❯]$/, // named prompts like "claude>"
  ],
  promptPrefix: /^\s*(?:>>>|\.\.\.|[>❯$#%])\s?/,
  chrome: [
    // Braille spinner frames (e.g. "⠋", "⠙ Working…"), optionally with a label.
    // Deliberately NOT matching ascii "-"/"|"/"*" frames: those collide with
    // markdown bullets and dividers, and tmux already collapses in-place
    // `\r`-rewritten spinners to their final frame (design §4.1).
    /^[⠀-⣿]+(?:\s+.*)?$/u,
    // "thinking…", "Working...", "esc to interrupt" style status lines.
    /^\s*(?:thinking|working|loading|generating|processing|esc to interrupt)[.…\s]*$/i,
    // Box-drawing UI borders (status footers, panels). U+2500–U+257F only, so
    // an ascii markdown divider ("---") is preserved as real content.
    /^[─-╿\s]+$/u,
  ],
  supportsIdeaContract: false,
  ideaFallback: false,
};

/**
 * The claude harness profile (extraction-contract §5) — the heuristic floor.
 * Stage-1 chrome regexes are Appendix B verbatim (the single source of truth);
 * `supportsIdeaContract`/`ideaFallback` enable priming + the prose fallback.
 */
// Regexes verified against a live claude 2.1.165 capture-pane (see §5.2). The
// real TUI differs from the design's idealized §1 sample: the prompt is a bare
// "❯" between horizontal rules, replies are "● "-bulleted, and the spinner
// done-line uses a randomised verb ("Brewed for 4s", "Baked for 3s").
export const CLAUDE_PROFILE: HarnessProfile = {
  name: "claude",
  supportsIdeaContract: true,
  ideaFallback: true,
  // claude 2.1.x renders a bare "❯" input prompt (between two horizontal rules),
  // NOT a "> "; completion otherwise relies on the poller's idle-timeout (§4.3.2).
  promptMarkers: [/^[>❯]$/u],
  promptPrefix: /^\s*[>❯]\s?/u,
  readyMarker: /^\s*❯/u, // the "❯" input prompt has appeared (ready for input)
  // Assistant turns start with a "● " bullet; anchor on it (§4.3). claude
  // indents the whole message body by a 2-space left margin, with "● " on the
  // first line — strip either so the margin/bullet never reaches chat and the
  // contract parser sees flush-left text.
  responseMarker: /^\s*●\s/u,
  responsePrefix: /^(?:●\s|\s{2})/u,
  // claude prints "✻ <Verb> for <n>s" when a turn is fully done — a precise
  // completion signal (vs the idle-timeout, which can fire mid-stream). The
  // leading glyph cycles through claude's dingbat-star set (U+2722–U+2747:
  // ✢ ✶ ✷ ✻ ✽ …) plus `* · ∗ ⋆`, so match the whole family, not a fixed list.
  completionMarker: /^\s*[*·∗⋆✢-❇]\s+\w+ for \d+(?:\.\d+)?\s*[smhd]\b/iu,
  chrome: [
    // 1) Status bar:
    //    "Opus 4.8 (1M context) | main | ~/path | ctx:29.0k/1000k (3%) | 5h:33%"
    //    Anchored on the highly-distinctive ctx:<n>/<n> (<n>%) signature.
    /^.*\bctx:\s*[\d.]+[kmg]?\s*\/\s*[\d.]+[kmg]?\s*\(\s*\d+\s*%\s*\).*$/iu,

    // 1b) Same status bar, TRUNCATED: when the pane is narrower than the bar,
    //    claude cuts the trailing "ctx:n/n (n%)" with an ellipsis (e.g.
    //    "Opus 4.8 (1M context) | feat/x | ~/very/long/path/worktrees/a…"), so
    //    the ctx: anchor above misses it. Anchor on the model header
    //    "(<n> context) |" — the context token immediately followed by the
    //    status bar's pipe separator survives truncation and is specific enough
    //    that prose merely mentioning a context window won't collide.
    /\(\s*[\d.]+\s*[kmgt]?\s+context\s*\)\s*\|/iu,

    // 1c) Opus 4.8 status bar — the format changed from the "ctx:n/n (n%)" above
    //    to a per-segment bar: "[Opus 4.8 (1M context)] 📁 …/path | 🌿 main |
    //    0% context | $0.00". Anchor on the "| <n>% context" segment: the pipe +
    //    "n% context" only occurs in the bar, while prose mentioning a context
    //    window ("the (1M context) window") has no such pipe segment.
    /\|\s*\d+\s*%\s+context\b/iu,

    // 1d) Same bar, TRUNCATED to the model header on a narrow pane:
    //    "[Opus 4.8 (1M context)] 📁 …". The bracketed "[<model> (<n> context)]"
    //    header at line start is distinct from prose (no sentence opens with it).
    /^\s*\[[^\]]*\(\s*[\d.]+\s*[kmgt]?\s+context\s*\)\]/iu,

    // 2) Spinner verb frames: "* Catapulting…", "✽ Forging… (5s · ↓ 227 tokens)",
    //    "✢ Sprouting… (24s)". Leading claude spinner glyph (the dingbat-star
    //    family U+2722–U+2747, plus `* · ∗ ⋆`) + text ENDING in an ellipsis (the
    //    discriminator vs a markdown bullet), optional trailing "(… tokens)".
    /^\s*[*·●∗⋆✢-❇]\s+\S.*…(?:\s*\([^)]*\))?\s*$/u,

    // 3) Spinner DONE line: "✻ Worked for 3s", "✻ Brewed for 4s", "✻ Baked for
    //    3s" — claude randomises the verb, so match "<glyph> <Verb> for <n><unit>".
    /^\s*[*·∗⋆✢-❇]\s+\w+ for \d+(?:\.\d+)?\s*[smhd]\b.*$/iu,

    // 4) Auto-mode / agents affordance:
    //    "⏵⏵ auto mode on (shift+tab to cycle) · PR #10 · ← for agents"
    /^\s*⏵⏵?\s.*$/u,
    /(?:^|·)\s*←\s+for agents\s*$/u,

    // 5) Tip / continuation gutter:
    //    "⎿  Tip: Run claude --continue or claude --resume to resume a conversation"
    /^\s*⎿\s.*$/u, // claude's tool-result/gutter glyph
    /\bclaude\s+--(?:continue|resume)\b/u, // resume hint anywhere

    // 6) Shortcuts / queued-message hints and placeholders.
    /^\s*\?\s+for shortcuts\s*$/u,
    /^\s*Press up to edit queued messages\s*$/iu,
    /^\s*Try\s+".*"\s*$/u,

    // 7) Box-drawing borders + the bare "❯" input prompt line (U+2500–U+257F incl.
    //    ╭╮╰╯│ ─). The "❯ …" input line (idle prompt, echoed input, or a queued
    //    suggestion) is chrome; "❯" doesn't collide with markdown so this is safe.
    /^[─-╿\s]+$/u,
    /^\s*❯/u,
  ],
};

const PROFILES: Record<string, HarnessProfile> = {
  default: DEFAULT_PROFILE,
  claude: CLAUDE_PROFILE,
  // `bash`/`sh` print a PS1 prompt that is too variable to anchor on; rely on
  // idle-timeout completion (the poller's `finalize`) rather than a marker.
  bash: { ...DEFAULT_PROFILE, name: "bash", promptMarkers: [/^[>❯$#%]$/] },
  // python3 -i — the deterministic REPL used in the verification spike (§4.4).
  python: {
    ...DEFAULT_PROFILE,
    name: "python",
    promptMarkers: [/^>>>$/, /^\.\.\.$/],
    promptPrefix: /^\s*(?:>>>|\.\.\.)\s?/,
  },
};

/**
 * Resolve a harness profile by name, falling back to the default. When an
 * unknown profile is requested we LOG (design §10) rather than silently guess.
 */
export function getProfile(name: string | undefined, onWarn?: (msg: string) => void): HarnessProfile {
  if (!name) return DEFAULT_PROFILE;
  const profile = PROFILES[name];
  if (!profile) {
    onWarn?.(`No harness profile "${name}"; using default prompt/chrome rules.`);
    return DEFAULT_PROFILE;
  }
  return profile;
}

/**
 * Map a harness command to a profile name (extraction-contract §7.2). Uses the
 * command basename so `/usr/local/bin/claude` resolves like `claude`. Unknown
 * commands return undefined → `getProfile` falls back to the default profile.
 */
export function commandProfileName(command: string): string | undefined {
  if (!command) return undefined;
  const base = command.trim().split(/[\\/]/).pop() ?? "";
  return base === "claude" ? "claude" : undefined;
}

// ── Contract grammar (extraction-contract Appendix B — single source of truth) ──

/** `«IDEA[:kind]»` / `<<IDEA[:kind]>>` at line start; group 3 is the remainder. */
const IDEA_MARKER = /^\s*(?:«IDEA(?::([a-z][\w-]*))?»|<<IDEA(?::([a-z][\w-]*))?>>)\s*(.*)$/u;
/** ` ```idea [kind=…] ` opens a fenced (multi-line body) idea. */
const IDEA_FENCE_OPEN = /^\s*```idea(?:\s+kind=([a-z][\w-]*))?\s*$/u;
/** A bare ` ``` ` closes a fenced idea. */
const IDEA_FENCE_CLOSE = /^\s*```\s*$/;
/** Fenced-body recognised keys (case-insensitive): title / body / kind. */
const FENCE_KEY = /^(title|body|kind)\s*:\s*(.*)$/i;

/**
 * A line that LOOKS like an attempted idea marker but did not parse — used to
 * diagnose a contract-following lapse: mangled guillemets (`«IDEA »`, `?IDEA?`),
 * the bare word (`Idea: …`), bracketed (`[IDEA]`), or markdown-wrapped
 * (`**IDEA**`). Anchored at line start so a mid-sentence "idea" is not flagged,
 * and `\bidea\b` so "Ideally"/"ideas" don't trip it.
 */
const MARKER_NEAR_MISS = /^\s*[^\w\s]{0,4}\s*idea\b/iu;

// Heuristic-floor structural patterns (mirror markdown-block-parser.ts, but
// tolerate a leading indent — claude word-wraps/indents its message body).
const HEU_HEADING = /^\s*(#{1,6})\s+(.*)$/;
const HEU_BULLET = /^\s*[-*+]\s+(.*)$/;
const HEU_NUMBERED = /^\s*(\d{1,9})[.)]\s+(.*)$/;

/** Parse a single-line idea: `title :: body`, split on the FIRST `::`. */
function ideaFromLine(kind: string | undefined, logical: string): Idea {
  const rest = logical.replace(IDEA_MARKER, "$3").trim(); // remainder after marker
  const sep = rest.indexOf("::");
  const title = (sep >= 0 ? rest.slice(0, sep) : rest).trim();
  const body = (sep >= 0 ? rest.slice(sep + 2) : "").trim();
  return kind ? { title, body, kind } : { title, body };
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
  const bodyParts: string[] = [];
  let inBody = false;

  // claude indents the whole assistant message (and thus the fenced block) by a
  // left margin, so trim each line before recognising `title:`/`body:`/`kind:`.
  const bodyLines = rawBodyLines.map((l) => l.trim());
  for (const line of bodyLines) {
    if (inBody) {
      bodyParts.push(line);
      continue;
    }
    const km = FENCE_KEY.exec(line);
    if (km) {
      const key = km[1].toLowerCase();
      const value = km[2];
      if (key === "title") title = value.trim();
      else if (key === "kind") kindV = value.trim() || kindV;
      else {
        // body:
        inBody = true;
        if (value.trim() !== "") bodyParts.push(value);
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
  return kindV ? { title: finalTitle, body, kind: kindV } : { title: finalTitle, body };
}

/**
 * Contract parse (extraction-contract §3.3). Splits a chrome-stripped region
 * into `chat` and `ideas`. When `final` is false, a still-growing tail (the
 * last idea/chat line, or an unterminated fence) is held back so a half-typed
 * idea is never emitted as a finished card (§9 risk 3); on `finalize` we re-run
 * with `final: true` to flush whatever remains.
 *
 * A single-line idea whose body word-wraps across several rows is rejoined: the
 * agent (and `capture-pane -J`) wrap at word boundaries and separate logical
 * units with a BLANK line, so the body continues on the following non-blank,
 * non-marker rows until a blank line / the next marker — independent of pane
 * width.
 */
export function parseContract(region: string[], final: boolean): { chat: string[]; ideas: Idea[] } {
  const chat: string[] = [];
  const ideas: Idea[] = [];
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
      const kind = m[1] ?? m[2];
      let logical = line;
      let k = i;
      // Absorb continuation rows until a blank line / next marker / fence.
      while (
        k + 1 < n &&
        region[k + 1].trim() !== "" &&
        !IDEA_MARKER.test(region[k + 1]) &&
        !IDEA_FENCE_OPEN.test(region[k + 1])
      ) {
        k++;
        logical += " " + region[k].trim(); // re-insert the space consumed at the wrap
      }
      if (!final && k >= lastNonBlank) break; // growing idea at the tail → hold back
      ideas.push(ideaFromLine(kind, logical));
      i = k + 1;
      continue;
    }

    // Everything else is chat — but hold back the still-growing last line.
    if (!final && i === lastNonBlank) break;
    chat.push(line);
    i++;
  }

  return { chat, ideas };
}

/** Result of feeding the extractor one capture (extraction-contract §6). */
export interface ExtractResult {
  /** Newly-finalized conversational lines for the chat hub (may be empty). */
  chat: string[];
  /** Newly-finalized extracted ideas for the canvas (may be empty). */
  ideas: Idea[];
  /** True when the response is complete (idle prompt returned / idle timeout). */
  complete: boolean;
}

/** Stable per-idea identity key for within-response dedupe (§7.1). */
function ideaKey(idea: Idea): string {
  return `${idea.title} ${idea.body} ${idea.kind ?? ""}`;
}

/** Split a capture into lines and drop trailing blank lines (pane padding). */
function toTrimmedLines(capture: string): string[] {
  const lines = capture.replace(/\r\n/g, "\n").split("\n").map((l) => l.replace(/\s+$/, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export class ResponseExtractor {
  readonly #profile: HarnessProfile;
  readonly #onWarn?: (msg: string) => void;
  readonly #onHeuristic?: (count: number) => void;
  readonly #onDebug?: (event: string, data: Record<string, string | number>) => void;

  /** Most recent capture's trimmed lines — kept so a send can baseline off it. */
  #lastLines: string[] = [];
  /** True between `beginResponse` and completion. */
  #responding = false;
  /** Lines of the input we sent, used to anchor/skip the echo. */
  #sentLines: string[] = [];
  /** Absolute line index in the pane just before the echo (baseline fallback). */
  #baseline = 0;
  /** How many CHAT lines we have already emitted this cycle. */
  #chatEmitted = 0;
  /** Most recent chrome-stripped response region — `finalize` re-parses it. */
  #lastRegion: string[] = [];
  /** Idea identity keys already emitted this response (dedupe, §7.1). */
  #seenIdeas = new Set<string>();
  /** Whether we have already logged the heuristic floor firing this response. */
  #heuristicLogged = false;
  /** True once we successfully anchored on the echoed input this cycle. */
  #anchored = false;
  /** Whether we already warned about a missing anchor this cycle. */
  #warnedNoAnchor = false;

  constructor(
    profile: HarnessProfile = DEFAULT_PROFILE,
    opts: {
      onWarn?: (msg: string) => void;
      /** Logged when the heuristic floor promotes prose to ideas (§5.3). */
      onHeuristic?: (count: number) => void;
      /**
       * Per-response contract diagnostics (chat/ideas counts, near-misses) so a
       * contract-following lapse is observable. Called once per completed
       * response; the consumer chooses the log level (a near-miss is worth a
       * warning, an ordinary chat-only reply is debug).
       */
      onDebug?: (event: string, data: Record<string, string | number>) => void;
    } = {},
  ) {
    this.#profile = profile;
    this.#onWarn = opts.onWarn;
    this.#onHeuristic = opts.onHeuristic;
    this.#onDebug = opts.onDebug;
  }

  get responding(): boolean {
    return this.#responding;
  }

  /** Whether we anchored on this turn's echoed input yet (diagnostic). */
  get anchored(): boolean {
    return this.#anchored;
  }

  get profile(): HarnessProfile {
    return this.#profile;
  }

  /** Record the input we just submitted so its echo is skipped (design §4.3.1). */
  beginResponse(sent: string): void {
    const normalized = sent.replace(/\r/g, "").replace(/\n+$/, "");
    this.#sentLines = normalized.length > 0 ? normalized.split("\n") : [];
    this.#baseline = this.#lastLines.length;
    this.#chatEmitted = 0;
    this.#lastRegion = [];
    this.#seenIdeas = new Set();
    this.#heuristicLogged = false;
    this.#responding = true;
    this.#anchored = false;
    this.#warnedNoAnchor = false;
  }

  /**
   * Feed a fresh full-pane capture. Returns the newly-finalized chat lines +
   * ideas and whether the response is now complete.
   */
  ingest(capture: string): ExtractResult {
    const lines = toTrimmedLines(capture);
    this.#lastLines = lines;
    if (!this.#responding) return { chat: [], ideas: [], complete: false };

    const start = this.#responseStart(lines);
    // Strip the assistant-turn bullet ("● ") from each row so it never reaches
    // chat and the contract parser sees clean text (extraction-contract §5.2).
    const prefix = this.#profile.responsePrefix;
    const region = prefix ? lines.slice(start).map((l) => l.replace(prefix, "")) : lines.slice(start);

    // Completion: either the profile's explicit done-line appears (claude's
    // "✻ <Verb> for <n>s" — precise, avoids completing during a mid-stream
    // pause) OR the trailing non-empty line is an idle prompt marker. Trusted
    // ONLY once we have anchored, so the idle prompt already on screen before we
    // sent anything doesn't look like an instant (empty) "completion". Otherwise
    // completion is left to the poller's idle-timeout `finalize()` (design §4.3.2).
    const cm = this.#profile.completionMarker;
    const complete =
      this.#anchored && (this.#trailingPrompt(region) || (!!cm && region.some((l) => cm.test(l))));

    // STAGE 1 — chrome strip (now per-profile; claude strips the TUI status
    // bar, spinners, auto-mode, tips — extraction-contract §5.2).
    const stripped = region.filter((line) => !this.#isPrompt(line) && !this.#isChrome(line));
    this.#lastRegion = stripped;

    // STAGE 2 (+ heuristic floor) — split into chat + ideas, holding back the
    // still-growing tail unless this capture completes the response.
    const { chat, ideas } = this.#extract(stripped, complete);

    const newChat = chat.slice(this.#chatEmitted);
    this.#chatEmitted = chat.length;
    const newIdeas = this.#dedupe(ideas);

    if (complete) {
      this.#emitSummary(stripped, chat, ideas);
      this.#responding = false;
    }
    return { chat: newChat, ideas: newIdeas, complete };
  }

  /**
   * Force completion when the pane has gone idle for IDLE_MS without the prompt
   * marker reappearing (design §4.3.2). Re-parses the held-back region with
   * `final: true` and flushes any held-back chat tail + final idea.
   */
  finalize(): ExtractResult {
    if (!this.#responding) return { chat: [], ideas: [], complete: false };
    const { chat, ideas } = this.#extract(this.#lastRegion, true);
    const newChat = chat.slice(this.#chatEmitted);
    this.#chatEmitted = chat.length;
    const newIdeas = this.#dedupe(ideas);
    this.#emitSummary(this.#lastRegion, chat, ideas);
    this.#responding = false;
    return { chat: newChat, ideas: newIdeas, complete: true };
  }

  /**
   * Emit one structured diagnostic per completed response (extraction-contract
   * observability). Reports chat/idea counts split by source (contract vs
   * heuristic floor) and any **near-misses** — lines that looked like an idea
   * marker but did not parse — so a contract-following lapse (the agent ignoring
   * or mangling the `«IDEA»` format) is visible rather than silently dropped to
   * chat. No-op unless an `onDebug` consumer is wired.
   */
  #emitSummary(region: string[], chat: string[], ideas: Idea[]): void {
    if (!this.#onDebug) return;
    const nearMisses = region.filter((l) => MARKER_NEAR_MISS.test(l) && !IDEA_MARKER.test(l));
    const heuristicIdeas = ideas.reduce((n, i) => (i.kind === "heuristic" ? n + 1 : n), 0);
    const data: Record<string, string | number> = {
      profile: this.#profile.name,
      chat: chat.length,
      ideas: ideas.length,
      contractIdeas: ideas.length - heuristicIdeas,
      heuristicIdeas,
      nearMisses: nearMisses.length,
    };
    if (nearMisses.length > 0) {
      // A small, truncated sample of the offending lines — enough to see HOW the
      // agent deviated (e.g. "Idea: …" with no guillemets) without flooding logs.
      data.nearMissSample = nearMisses
        .slice(0, 3)
        .map((l) => l.trim().slice(0, 80))
        .join(" ⏎ ");
    }
    this.#onDebug("extract.contract", data);
  }

  /** Re-anchor after a resize/reflow: forget the cached pane (design §4 reflow). */
  reanchor(): void {
    this.#lastLines = [];
    if (this.#responding) this.#baseline = 0;
  }

  /** Contract parse + heuristic floor over a chrome-stripped region. */
  #extract(region: string[], final: boolean): { chat: string[]; ideas: Idea[] } {
    const parsed = parseContract(region, final);
    if (parsed.ideas.length > 0 || !this.#profile.ideaFallback) return parsed;
    // Heuristic floor (§5.3): the agent emitted NO markers and the profile opts
    // in — promote a bullet/heading list to ideas, logging that we fell back.
    const promoted = this.#classifyProse(parsed.chat);
    if (!promoted) return parsed;
    if (!this.#heuristicLogged) {
      this.#heuristicLogged = true;
      this.#onHeuristic?.(promoted.ideas.length);
    }
    return promoted;
  }

  /**
   * Conservative prose→ideas classifier (§5.3). Fires only when the chat region
   * looks like an idea list: ≥2 bullet/numbered/heading lines. Each such line
   * becomes a `kind: "heuristic"` idea; surrounding prose stays in chat.
   */
  #classifyProse(chat: string[]): { chat: string[]; ideas: Idea[] } | null {
    const isStructural = (line: string) =>
      HEU_HEADING.test(line) || HEU_BULLET.test(line) || HEU_NUMBERED.test(line);
    if (chat.filter(isStructural).length < 2) return null;

    const remaining: string[] = [];
    const ideas: Idea[] = [];
    for (const line of chat) {
      const heading = HEU_HEADING.exec(line);
      const bullet = HEU_BULLET.exec(line);
      const numbered = HEU_NUMBERED.exec(line);
      const text = heading?.[2] ?? bullet?.[1] ?? numbered?.[2];
      // (heading group 1 is the # run; bullet/numbered group 1/2 is the text.)
      if (text !== undefined) ideas.push({ title: text.trim(), body: "", kind: "heuristic" });
      else remaining.push(line);
    }
    return { chat: remaining, ideas };
  }

  /** Drop ideas already emitted this response; record the survivors. */
  #dedupe(ideas: Idea[]): Idea[] {
    const out: Idea[] = [];
    for (const idea of ideas) {
      const key = ideaKey(idea);
      if (this.#seenIdeas.has(key)) continue;
      this.#seenIdeas.add(key);
      out.push(idea);
    }
    return out;
  }

  /** Index of the first response line: just after the echoed input. */
  #responseStart(lines: string[]): number {
    // Marker-anchored harnesses (claude): the assistant turn starts with a "● "
    // bullet. We must anchor on the turn that answers THIS prompt, not a marker
    // from a previous turn still on screen (e.g. the priming "● READY", whose
    // own done-line would otherwise complete us instantly and drop the real
    // reply). So we first locate the echo of the input we just sent — claude
    // renders it on a prompt line ("❯ <prompt>") — and anchor on the first "● "
    // BELOW it. Until that echo appears we anchor on NOTHING (return an empty
    // region), so a stale previous turn is never mistaken for this one.
    const rm = this.#profile.responseMarker;
    if (rm) {
      const from = this.#echoEnd(lines);
      if (from < 0) return lines.length; // our prompt's echo isn't on screen yet
      for (let i = lines.length - 1; i >= from; i--) {
        if (rm.test(lines[i])) {
          this.#anchored = true;
          return i;
        }
      }
      return lines.length; // assistant turn for this prompt hasn't rendered yet
    }

    if (this.#sentLines.length === 0) {
      // No input text to anchor on (e.g. a bare Enter); use the baseline.
      return Math.min(this.#baseline, lines.length);
    }
    const first = this.#sentLines[0];
    // Search from the bottom for the most recent echo of our input.
    for (let i = lines.length - 1; i >= 0; i--) {
      if (this.#matchesEcho(lines[i], first)) {
        this.#anchored = true;
        return Math.min(i + this.#sentLines.length, lines.length);
      }
    }
    // Anchor not found: fall back to the pre-send baseline and warn once so a
    // missing prompt profile is visible rather than silently mis-attributed.
    if (!this.#anchored && !this.#warnedNoAnchor) {
      this.#warnedNoAnchor = true;
      this.#onWarn?.(
        `Could not anchor on echoed input under profile "${this.#profile.name}"; ` +
          `falling back to position baseline. Response attribution may be imprecise.`,
      );
    }
    return Math.min(this.#baseline, lines.length);
  }

  /**
   * Index just after the echoed input on a marker-anchored harness (claude).
   * Finds the most recent prompt line ("❯ …") whose text is the start of what we
   * just sent (claude word-wraps the echo, so the first row is a prefix) and
   * returns the line after it. Returns:
   *  - `0` when there is nothing to match on (a bare Enter, or the unit-test
   *    harness that calls `beginResponse("")`) → anchor on any assistant marker;
   *  - `-1` when we DO have sent text but its echo isn't on screen yet → the
   *    caller must not anchor, so a stale previous turn isn't picked up.
   */
  #echoEnd(lines: string[]): number {
    const firstSent = this.#sentLines[0]?.trim();
    const ready = this.#profile.readyMarker;
    if (!firstSent || firstSent.length < 3 || !ready) return 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!ready.test(lines[i])) continue;
      const content = lines[i].replace(this.#profile.promptPrefix, "").trim();
      if (content.length >= 3 && firstSent.startsWith(content)) return i + 1;
    }
    return -1; // echo of our prompt not visible yet
  }

  /** Does `line` echo the line of input we sent (with or without a prompt glyph)? */
  #matchesEcho(line: string, sentFirst: string): boolean {
    const want = sentFirst.replace(/\s+$/, "");
    if (line.replace(/\s+$/, "") === want) return true;
    const stripped = line.replace(this.#profile.promptPrefix, "").replace(/\s+$/, "");
    return stripped === want;
  }

  #isPrompt(line: string): boolean {
    const t = line.replace(/\s+$/, "");
    return this.#profile.promptMarkers.some((re) => re.test(t));
  }

  #isChrome(line: string): boolean {
    // The harness's idle input box (e.g. claude's bordered "│ > …" prompt line)
    // is persistent chrome that sits in the captured region but is not pure
    // box-drawing, so the BORDER rule misses it. The profile's `readyMarker`
    // already identifies that line — reuse it so the input box never reaches
    // chat (the Appendix B chrome regexes themselves stay verbatim).
    if (this.#profile.readyMarker?.test(line)) return true;
    return this.#profile.chrome.some((re) => re.test(line));
  }

  /** True if the response region ends with a reappeared idle prompt marker. */
  #trailingPrompt(region: string[]): boolean {
    for (let i = region.length - 1; i >= 0; i--) {
      if (region[i] === "") continue;
      return this.#isPrompt(region[i]);
    }
    return false;
  }
}
