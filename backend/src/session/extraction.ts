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
export const CLAUDE_PROFILE: HarnessProfile = {
  name: "claude",
  supportsIdeaContract: true,
  ideaFallback: true,
  // claude's idle input is a bordered box; a bare ">"/"❯" is the best anchor,
  // but completion mostly relies on the poller's idle-timeout (design §4.3.2).
  promptMarkers: [/^[>❯]$/u],
  promptPrefix: /^\s*[>❯]\s?/u,
  readyMarker: /^\s*[╭│]\s*[>❯]/u, // the bordered input box appeared
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

    // 2) Spinner verb frames: "* Catapulting…", "✽ Forging… (5s · ↓ 227 tokens)",
    //    "✶ Metamorphosing…". Leading claude spinner glyph + text ENDING in an
    //    ellipsis (the discriminator vs a markdown bullet), optional "(… tokens)".
    /^\s*[*✻✽✶✷●∗·]\s+\S.*…(?:\s*\([^)]*\))?\s*$/u,

    // 3) "Worked for 3s" status (same glyph family, no ellipsis).
    /^\s*[*✻✽✶✷●∗·]\s+Worked for\b.*$/u,

    // 4) Auto-mode / agents affordance:
    //    "⏵⏵ auto mode on (shift+tab to cycle) · ← for agents"
    /^\s*⏵⏵?\s.*$/u,
    /(?:^|·)\s*←\s+for agents\s*$/u,

    // 5) Tip / continuation gutter:
    //    "⎿  Tip: Run claude --continue or claude --resume to resume a conversation"
    /^\s*⎿\s.*$/u, // claude's tool-result/gutter glyph
    /\bclaude\s+--(?:continue|resume)\b/u, // resume hint anywhere

    // 6) Shortcuts hint / placeholder.
    /^\s*\?\s+for shortcuts\s*$/u,
    /^\s*Try\s+".*"\s*$/u,

    // 7) Box-drawing borders of the input panel (U+2500–U+257F incl. ╭╮╰╯│ ─).
    //    ASCII "---" markdown dividers are NOT matched (only box-drawing range).
    /^[─-╿\s]+$/u,
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

// Heuristic-floor structural patterns (mirror markdown-block-parser.ts).
const HEU_HEADING = /^(#{1,6})\s+(.*)$/;
const HEU_BULLET = /^[-*+]\s+(.*)$/;
const HEU_NUMBERED = /^(\d{1,9})[.)]\s+(.*)$/;

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
function ideaFromFence(kind: string | undefined, bodyLines: string[]): Idea {
  let title: string | undefined;
  let kindV = kind;
  const bodyParts: string[] = [];
  let inBody = false;

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

/** tmux only wraps a row that has filled the full column width (§3.3, no-`-J`). */
function rowWasWrapped(row: string, paneWidth: number): boolean {
  return paneWidth > 0 && row.length >= paneWidth;
}

/**
 * Contract parse (extraction-contract §3.3). Splits a chrome-stripped region
 * into `chat` and `ideas`. When `final` is false, a still-growing tail (the
 * last idea/chat line, or an unterminated fence) is held back so a half-typed
 * idea is never emitted as a finished card (§9 risk 3); on `finalize` we re-run
 * with `final: true` to flush whatever remains.
 */
export function parseContract(
  region: string[],
  paneWidth: number,
  final: boolean,
): { chat: string[]; ideas: Idea[] } {
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

    // Form 1 — single-line marker (with optional reflow-wrapped continuation).
    const m = IDEA_MARKER.exec(line);
    if (m) {
      const kind = m[1] ?? m[2];
      let logical = line;
      let k = i;
      // Rejoin reflow-wrapped continuation rows (only relevant without `-J`).
      while (
        k + 1 < n &&
        rowWasWrapped(region[k], paneWidth) &&
        !IDEA_MARKER.test(region[k + 1]) &&
        !IDEA_FENCE_OPEN.test(region[k + 1]) &&
        region[k + 1].trim() !== ""
      ) {
        k++;
        logical += region[k];
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
  #paneWidth: number;

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
      /** Pane width in columns, for the no-`-J` reflow rejoin (§3.3). */
      paneWidth?: number;
    } = {},
  ) {
    this.#profile = profile;
    this.#onWarn = opts.onWarn;
    this.#onHeuristic = opts.onHeuristic;
    this.#paneWidth = opts.paneWidth ?? 0;
  }

  get responding(): boolean {
    return this.#responding;
  }

  get profile(): HarnessProfile {
    return this.#profile;
  }

  /** Update the pane width used for the reflow rejoin (on resize). */
  setPaneWidth(cols: number): void {
    this.#paneWidth = cols > 0 ? cols : 0;
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
    const region = lines.slice(start);

    // Completion: the trailing non-empty line is an idle prompt marker — but
    // ONLY trust this once we have anchored on the echo of our own input.
    // Otherwise the idle prompt already on screen before we sent anything looks
    // like an instant (empty) "completion". When we cannot anchor (e.g. a shell
    // whose PS1 prompt we don't recognise), completion is left to the poller's
    // idle-timeout `finalize()` instead (design §4.3.2).
    const complete = this.#anchored && this.#trailingPrompt(region);

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

    if (complete) this.#responding = false;
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
    this.#responding = false;
    return { chat: newChat, ideas: newIdeas, complete: true };
  }

  /** Re-anchor after a resize/reflow: forget the cached pane (design §4 reflow). */
  reanchor(): void {
    this.#lastLines = [];
    if (this.#responding) this.#baseline = 0;
  }

  /** Contract parse + heuristic floor over a chrome-stripped region. */
  #extract(region: string[], final: boolean): { chat: string[]; ideas: Idea[] } {
    const parsed = parseContract(region, this.#paneWidth, final);
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
