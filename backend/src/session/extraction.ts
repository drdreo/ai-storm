/**
 * Response extraction (design §4.3) — the net-new core of the session layer.
 *
 * Turns an interactive harness's terminal pane into a stream of clean
 * **response** lines, excluding the echoed user prompt and the harness chrome
 * (prompt glyphs, spinners, status footers). It is the part agent-orchestrator
 * does NOT have: AO streams raw bytes to xterm.js; we extract structured text.
 *
 * The module is deliberately source-agnostic. It is fed successive *captures* —
 * the full, ANSI-flattened text of the pane as it currently reads — and emits
 * the newly-finalized response lines plus a completion flag. On POSIX a capture
 * is `tmux capture-pane -p` output; on Windows it is the running transcript
 * reconstructed from the node-pty byte stream (design §5.2). The byte SOURCE
 * differs; these extraction RULES are shared.
 *
 * Algorithm (mirrors the §4.4 spike: prompt → echoed-input → output → prompt):
 *  1. Anchor on the line that echoes the input we just sent (`beginResponse`),
 *     and skip it — we know exactly what we sent.
 *  2. Emit everything after the echoed input as response text, until the idle
 *     prompt marker reappears (completion) or the pane goes idle (`finalize`).
 *  3. Filter per-harness chrome (prompt glyphs, spinners, status lines).
 *  4. Hold back the last not-yet-stable line while a response is still in
 *     flight, so a half-written line is never emitted as a finished card.
 *
 * Pure and runtime-free so it is unit-testable against recorded fixtures.
 */

/** Per-harness rules selecting prompt markers and chrome to drop (design §4.3). */
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
}

/**
 * Sensible default profile. Handles bare REPL/shell prompts (`>`, `❯`, `>>>`,
 * `...`, `$`, `#`), common spinner frames, and "thinking…" status lines. Refine
 * per harness via {@link getProfile}; we log rather than silently guess when no
 * specific profile matches (design §10 risk 1).
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
};

const PROFILES: Record<string, HarnessProfile> = {
  default: DEFAULT_PROFILE,
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

/** Result of feeding the extractor one capture. */
export interface ExtractResult {
  /** Newly-finalized response lines (may be empty). */
  lines: string[];
  /** True when the response is complete (idle prompt returned / idle timeout). */
  complete: boolean;
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

  /** Most recent capture's trimmed lines — kept so a send can baseline off it. */
  #lastLines: string[] = [];
  /** True between `beginResponse` and completion. */
  #responding = false;
  /** Lines of the input we sent, used to anchor/skip the echo. */
  #sentLines: string[] = [];
  /** Absolute line index in the pane just before the echo (baseline fallback). */
  #baseline = 0;
  /** How many response lines we have already emitted this cycle. */
  #emitted = 0;
  /** Last computed full response body — `finalize` flushes any held-back tail. */
  #lastResponse: string[] = [];
  /** True once we successfully anchored on the echoed input this cycle. */
  #anchored = false;
  /** Whether we already warned about a missing anchor this cycle. */
  #warnedNoAnchor = false;

  constructor(profile: HarnessProfile = DEFAULT_PROFILE, onWarn?: (msg: string) => void) {
    this.#profile = profile;
    this.#onWarn = onWarn;
  }

  get responding(): boolean {
    return this.#responding;
  }

  /** Record the input we just submitted so its echo is skipped (design §4.3.1). */
  beginResponse(sent: string): void {
    const normalized = sent.replace(/\r/g, "").replace(/\n+$/, "");
    this.#sentLines = normalized.length > 0 ? normalized.split("\n") : [];
    this.#baseline = this.#lastLines.length;
    this.#emitted = 0;
    this.#lastResponse = [];
    this.#responding = true;
    this.#anchored = false;
    this.#warnedNoAnchor = false;
  }

  /**
   * Feed a fresh full-pane capture. Returns the newly-finalized response lines
   * and whether the response is now complete.
   */
  ingest(capture: string): ExtractResult {
    const lines = toTrimmedLines(capture);
    this.#lastLines = lines;
    if (!this.#responding) return { lines: [], complete: false };

    const start = this.#responseStart(lines);
    const region = lines.slice(start);

    // Completion: the trailing non-empty line is an idle prompt marker — but
    // ONLY trust this once we have anchored on the echo of our own input.
    // Otherwise the idle prompt that was ALREADY on screen before we sent
    // anything looks like an instant (empty) "completion". When we cannot
    // anchor (e.g. a shell whose PS1 prompt we don't recognise), completion is
    // left to the poller's idle-timeout `finalize()` instead (design §4.3.2).
    const complete = this.#anchored && this.#trailingPrompt(region);

    // Strip prompt markers and chrome from the response body.
    const body = region.filter((line) => !this.#isPrompt(line) && !this.#isChrome(line));
    this.#lastResponse = body;

    // While a response is in flight the final line may still be growing, so
    // hold it back; emit it only once the response completes.
    const stable = complete ? body.length : Math.max(0, body.length - 1);
    const toEmit = body.slice(this.#emitted, Math.max(this.#emitted, stable));
    this.#emitted = Math.max(this.#emitted, stable);

    if (complete) this.#responding = false;
    return { lines: toEmit, complete };
  }

  /**
   * Force completion when the pane has gone idle for IDLE_MS without the prompt
   * marker reappearing (design §4.3.2). Flushes any held-back tail line.
   */
  finalize(): ExtractResult {
    if (!this.#responding) return { lines: [], complete: false };
    const toEmit = this.#lastResponse.slice(this.#emitted);
    this.#emitted = this.#lastResponse.length;
    this.#responding = false;
    return { lines: toEmit, complete: true };
  }

  /** Re-anchor after a resize/reflow: forget the cached pane (design §4 reflow). */
  reanchor(): void {
    this.#lastLines = [];
    if (this.#responding) this.#baseline = 0;
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
