/**
 * Stateful scanning layer (extraction-contract §7.1): the session-scoped
 * dedupe sinks and the scanners that feed them from successive pane captures.
 * The grammar and pure parse/scan functions live in `./markers.ts`; this
 * module owns everything that spans captures — the seen-sets shared across
 * producers (capture scan + MCP capture tools), the two-frame confirmation,
 * and near-miss diagnostics.
 */

import { ideaIdentityKey, type CreateIdeaInput, type Score } from "@ai-storm/shared";
import { IDEA_MARKER, MARKER_NEAR_MISS, scanIdeas, scanScores, toTrimmedLines } from "./markers.ts";

// Per-idea identity for session-scoped dedupe (§7.1) is the shared
// `ideaIdentityKey` (title + kind + links; the volatile body is excluded — a pane
// resize re-wraps it and would otherwise make the idea look "new", #38). The
// session's `IdeaSink` is the single dedupe authority: a re-rendered marker is
// never re-sent, so the canvas just draws what it receives. Links stay part of
// identity (idea-graph §5.1): the same title at a different target is a distinct
// edge.

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
  offer(idea: CreateIdeaInput): boolean {
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
  scan(capture: string, final = false): CreateIdeaInput[] {
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
  #confirmAgainstPreviousFrame(parsed: CreateIdeaInput[]): CreateIdeaInput[] {
    const confirmed: CreateIdeaInput[] = [];
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
  #emitDiagnostics(lines: string[], fresh: CreateIdeaInput[]): void {
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
