/**
 * Board statistics (#129, and the convergence signals of #99) — a pure,
 * deterministic *reading* of the board into counts and a generation timeline.
 *
 * Like {@link ./summarize summarizeBoard}, this is an on-demand synthesis with no
 * agent round-trip and no tldraw dependency, so it is instant, reproducible, and
 * unit-testable in the plain Node env. It consumes the same {@link BoardSnapshot}
 * the canvas island already flattens (`collectBoard`), reading the two extra
 * fields that snapshot now carries — `createdAt` (#124) for the timeline and
 * `score` (#60) for the triaged count.
 *
 * Scope note (#129): session-level metrics the issue also lists — agent
 * performance, time/token spent — are deliberately absent. Sessions are ephemeral
 * PTY streams with no persisted log, so there is no data source for them here;
 * this module reports only what the live board actually knows.
 */
import { isTriageableKind, KNOWN_KINDS, normalizeKind } from "./idea-descriptors";
import type { BoardSnapshot } from "./summarize";

/** One kind bucket in the breakdown — a kind and how many cards carry it. */
export interface KindCount {
  /** Normalized kind key (e.g. `risk`), or `""` for kindless cards. */
  kind: string;
  count: number;
}

/** One time-slice of the generation timeline — how many ideas landed within it. */
export interface TimelineBucket {
  /** Epoch ms at the START of the slice (buckets are equal-width, in order). */
  start: number;
  count: number;
}

/** The board read into headline counts + a generation timeline (#129/#99). */
export interface BoardStats {
  /** Total idea cards on the board. */
  total: number;
  /** AI-created cards (#31). */
  aiCount: number;
  /** User-drawn cards (#31). */
  userCount: number;
  /**
   * Per-kind breakdown, known kinds first in registry order (#21), then any
   * unknown tags, then a trailing kindless bucket (key `""`). Only kinds with at
   * least one card appear.
   */
  kinds: KindCount[];
  /** Starred "keep" cards (#59/#99). */
  markedCount: number;
  /** Superseded ghosts (#20/PD-012/#99). */
  supersededCount: number;
  /** Cards carrying an AI triage score (#60). */
  triagedCount: number;
  /**
   * Triageable cards still lacking a score (#60/#99) — the actionable backlog.
   * Excludes the commentary kinds triage skips (risk/question), so it never
   * counts a card that would never be scored.
   */
  untriagedCount: number;
  /** Open questions — cards of kind `question` (#99). */
  openQuestions: number;
  /** Decisions made — cards of kind `decision` (#99). */
  decisions: number;
  /** Cards touched by no typed edge — the loose, unconnected ideas (#99). */
  unlinkedCount: number;
  /** How many cards carry a `createdAt` — the timeline is built from these. */
  datedCount: number;
  /**
   * Ideas-per-slice histogram over the dated cards' lifetime (#129). Equal-width
   * buckets from the first to the last dated card; empty when fewer than two
   * dated cards exist (nothing meaningful to plot).
   */
  timeline: TimelineBucket[];
  /** Time span the timeline covers, in ms (0 when the timeline is empty). */
  timelineSpanMs: number;
  /** True when the board has no idea cards (the panel shows an empty state). */
  isEmpty: boolean;
}

/** Default number of equal-width slices in the generation timeline. */
export const TIMELINE_BUCKETS = 16;

/**
 * Bucket dated card timestamps into `bucketCount` equal-width, ordered slices
 * spanning the first→last card (#129). Returns `[]` for fewer than two dated
 * cards, or when every card shares the same instant (a zero-width span has no
 * meaningful histogram). Exported for direct testing. Pure.
 */
export function bucketTimeline(times: readonly number[], bucketCount = TIMELINE_BUCKETS): TimelineBucket[] {
  const sorted = [...times].sort((a, b) => a - b);
  if (sorted.length < 2) return [];
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const span = last - first;
  if (span <= 0) return [];

  const width = span / bucketCount;
  const buckets: TimelineBucket[] = Array.from({ length: bucketCount }, (_, i) => ({
    start: first + i * width,
    count: 0
  }));
  for (const t of sorted) {
    // The final card sits exactly on `last`; clamp it into the last bucket
    // instead of overflowing to index `bucketCount`.
    const idx = Math.min(bucketCount - 1, Math.floor((t - first) / width));
    buckets[idx].count++;
  }
  return buckets;
}

/**
 * Order the kind breakdown: known kinds in registry order first (#21), then any
 * unknown tags alphabetically, then the kindless bucket (`""`) last.
 */
function orderKinds(counts: Map<string, number>): KindCount[] {
  const out: KindCount[] = [];
  for (const k of KNOWN_KINDS) {
    const n = counts.get(k);
    if (n) out.push({ kind: k, count: n });
  }
  const unknown = [...counts.keys()]
    .filter((k) => k && !KNOWN_KINDS.includes(k as (typeof KNOWN_KINDS)[number]))
    .sort();
  for (const k of unknown) out.push({ kind: k, count: counts.get(k)! });
  const kindless = counts.get("");
  if (kindless) out.push({ kind: "", count: kindless });
  return out;
}

/** The empty-board result — every count zero, `isEmpty` set. */
function emptyStats(): BoardStats {
  return {
    total: 0,
    aiCount: 0,
    userCount: 0,
    kinds: [],
    markedCount: 0,
    supersededCount: 0,
    triagedCount: 0,
    untriagedCount: 0,
    openQuestions: 0,
    decisions: 0,
    unlinkedCount: 0,
    datedCount: 0,
    timeline: [],
    timelineSpanMs: 0,
    isEmpty: true
  };
}

/**
 * Read a {@link BoardSnapshot} into {@link BoardStats} (#129/#99). Pure and
 * deterministic — a single pass over the cards for the counts, plus the edge
 * endpoints for the unlinked tally and the dated timestamps for the timeline. An
 * empty board yields an all-zero result (`isEmpty: true`) rather than throwing.
 */
export function computeBoardStats(snapshot: BoardSnapshot): BoardStats {
  const { cards, edges } = snapshot;
  if (cards.length === 0) return emptyStats();

  const linked = new Set<string>();
  for (const e of edges) {
    linked.add(e.from);
    linked.add(e.to);
  }

  const kindCounts = new Map<string, number>();
  const times: number[] = [];
  let aiCount = 0;
  let markedCount = 0;
  let supersededCount = 0;
  let triagedCount = 0;
  let untriagedCount = 0;
  let openQuestions = 0;
  let decisions = 0;
  let unlinkedCount = 0;

  for (const card of cards) {
    const kind = normalizeKind(card.kind) ?? "";
    kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1);
    if (card.origin === "ai") aiCount++;
    if (card.starred) markedCount++;
    if (card.superseded) supersededCount++;
    if (card.score) triagedCount++;
    else if (isTriageableKind(card.kind)) untriagedCount++;
    if (kind === "question") openQuestions++;
    if (kind === "decision") decisions++;
    if (!linked.has(card.id)) unlinkedCount++;
    if (typeof card.createdAt === "number") times.push(card.createdAt);
  }

  const timeline = bucketTimeline(times);
  const timelineSpanMs = timeline.length ? Math.max(...times) - Math.min(...times) : 0;

  return {
    total: cards.length,
    aiCount,
    userCount: cards.length - aiCount,
    kinds: orderKinds(kindCounts),
    markedCount,
    supersededCount,
    triagedCount,
    untriagedCount,
    openQuestions,
    decisions,
    unlinkedCount,
    datedCount: times.length,
    timeline,
    timelineSpanMs,
    isEmpty: false
  };
}
