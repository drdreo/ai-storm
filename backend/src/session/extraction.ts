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

import { ideaIdentityKey, type Idea, type IdeaRelation } from "@ai-storm/shared";

export type { Idea };

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
   * CLI flag this harness uses to APPEND a system prompt at launch. When set and
   * a prime text is given, the backend launches the harness with
   * `[systemPromptFlag, primeText]` so the idea contract is part of the system
   * prompt — followed from the first turn, with nothing typed into the terminal
   * (far more reliable than injecting a priming message). Absent → no priming.
   */
  systemPromptFlag?: string;
  /**
   * CLI flag this harness uses to select a model, paired with `defaultModel`.
   * When both are set the backend launches the harness with `[modelFlag,
   * defaultModel]` — unless the caller already passed `modelFlag` in the args —
   * so a profile can default to a fast/cheap model without the user typing it.
   */
  modelFlag?: string;
  /** Model passed via `modelFlag` at launch when the caller supplies none. */
  defaultModel?: string;
}

/** A generic harness understands no contract until proven otherwise. */
export const DEFAULT_PROFILE: HarnessProfile = {
  name: "default",
  supportsIdeaContract: false,
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
};

const PROFILES: Record<string, HarnessProfile> = {
  default: DEFAULT_PROFILE,
  claude: CLAUDE_PROFILE,
  bash: { ...DEFAULT_PROFILE, name: "bash" },
  python: { ...DEFAULT_PROFILE, name: "python" },
};

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
 * command basename so `/usr/local/bin/claude` resolves like `claude`. Unknown
 * commands return undefined → `getProfile` falls back to the default profile.
 */
export function commandProfileName(command: string): string | undefined {
  if (!command) return undefined;
  const base = command.trim().split(/[\\/]/).pop() ?? "";
  return base === "claude" ? "claude" : undefined;
}

// ── Contract grammar (extraction-contract Appendix B — single source of truth) ──

/**
 * `«IDEA[:kind][@ref[!]]»` / `<<IDEA[:kind][@ref[!]]>>` at line start. The
 * in-marker tag is `[:kind][@ref[!]]` (idea-graph design §5.1): an optional
 * `@ref` links this idea to the card with that short ref; a trailing `!` makes
 * that link a `supersedes` (the refined idea REPLACES the target) instead of the
 * default `about`. The `!` form keeps `supersedes` on the robust single-line
 * marker — the fenced `rel:` key (below) is unreliable because the agent's TUI
 * renders the code fence away before the backend captures the screen (PD-008).
 * Groups: 1/4 = kind (guillemet/ASCII), 2/5 = ref, 3/6 = supersedes `!`,
 * 7 = the remainder (`title :: body`).
 */
const IDEA_MARKER =
  /^\s*(?:«IDEA(?::([a-z][\w-]*))?(?:@([\w-]+)(!)?)?»|<<IDEA(?::([a-z][\w-]*))?(?:@([\w-]+)(!)?)?>>)\s*(.*)$/u;
/** ` ```idea [kind=…] ` opens a fenced (multi-line body) idea. */
const IDEA_FENCE_OPEN = /^\s*```idea(?:\s+kind=([a-z][\w-]*))?\s*$/u;
/** A bare ` ``` ` closes a fenced idea. */
const IDEA_FENCE_CLOSE = /^\s*```\s*$/;
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
 * Leading turn bullet that claude renders on the FIRST row of an assistant turn
 * (`● <text>`); subsequent rows carry only a 2-space margin (already absorbed by
 * the markers' `^\s*`). Stripped before scanning so an idea the agent leads its
 * reply with — `● «IDEA…»` — is still anchored as a marker. Without this, only
 * ideas that fall on a later (margin-only) row are detected.
 */
const TURN_BULLET = /^\s*●\s+/u;

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
 * Parse a single-line idea: `title :: body`, split on the FIRST `::`. An in-marker
 * `@ref` becomes a single link to that card (idea-graph §5.1) — `supersedes` when
 * the ref carried a trailing `!`, otherwise the default `about`.
 */
function ideaFromLine(
  kind: string | undefined,
  ref: string | undefined,
  supersedes: boolean,
  logical: string,
): Idea {
  const rest = logical.replace(IDEA_MARKER, "$7").trim(); // remainder after marker
  const sep = rest.indexOf("::");
  const title = (sep >= 0 ? rest.slice(0, sep) : rest).trim();
  const body = (sep >= 0 ? rest.slice(sep + 2) : "").trim();
  const idea: Idea = { title, body };
  if (kind) idea.kind = kind;
  if (ref) idea.links = [{ to: ref, relation: supersedes ? "supersedes" : "about" }];
  return idea;
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
      const kind = m[1] ?? m[4];
      const ref = m[2] ?? m[5];
      const supersedes = !!(m[3] ?? m[6]);
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
      ideas.push(ideaFromLine(kind, ref, supersedes, logical));
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
// scanner is the single dedupe authority: a re-rendered marker is never re-sent,
// so the canvas just draws what it receives. Links stay part of identity
// (idea-graph §5.1): the same title at a different target is a distinct edge.

/** Split a capture into lines and drop trailing blank lines (pane padding). */
function toTrimmedLines(capture: string): string[] {
  const lines = capture.replace(/\r\n/g, "\n").split("\n").map((l) => l.replace(/\s+$/, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Stateful, session-scoped idea scanner. Feed it each fresh capture; it returns
 * only the ideas it has not seen before this session. Because the same `«IDEA»`
 * line re-renders on every frame until it scrolls off, the content-keyed dedupe
 * makes repeated scans idempotent — the canvas receives each idea exactly once.
 */
export class IdeaScanner {
  /** Idea identity keys already emitted this session (dedupe, §7.1). */
  readonly #seen = new Set<string>();
  /** Near-miss lines already reported, so a re-rendered pane logs them once. */
  readonly #seenNearMiss = new Set<string>();
  readonly #onDebug?: (event: string, data: Record<string, string | number>) => void;

  constructor(
    opts: {
      /**
       * Contract diagnostics: a **near-miss** (a line that looked like an idea
       * marker but did not parse) is surfaced so a contract-following lapse (the
       * agent mangling the `«IDEA»` format) is visible rather than silently lost.
       */
      onDebug?: (event: string, data: Record<string, string | number>) => void;
    } = {},
  ) {
    this.#onDebug = opts.onDebug;
  }

  /**
   * Scan a fresh full-pane capture and return the newly-seen ideas. `final`
   * defaults to false so a still-rendering idea at the very bottom is held back
   * until the next capture pushes more text below it.
   */
  scan(capture: string, final = false): Idea[] {
    const lines = toTrimmedLines(capture);
    const ideas = scanIdeas(lines, final);
    const fresh: Idea[] = [];
    for (const idea of ideas) {
      const key = ideaIdentityKey(idea);
      if (this.#seen.has(key)) continue;
      this.#seen.add(key);
      fresh.push(idea);
    }
    this.#emitDiagnostics(lines, fresh);
    return fresh;
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
      (l) => MARKER_NEAR_MISS.test(l) && !IDEA_MARKER.test(l) && !this.#seenNearMiss.has(l.trim()),
    );
    for (const l of freshNearMiss) this.#seenNearMiss.add(l.trim());
    if (fresh.length === 0 && freshNearMiss.length === 0) return;
    const data: Record<string, string | number> = {
      ideas: fresh.length,
      nearMisses: freshNearMiss.length,
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
