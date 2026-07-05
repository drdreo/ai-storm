/**
 * Tests for the pure board-stats reading (#129/#99). No tldraw/DOM dependency —
 * runs in the plain Node test env like the other `core/` modules.
 */

import { describe, expect, it } from "vitest";
import { bucketTimeline, computeBoardStats, TIMELINE_BUCKETS } from "./board-stats";
import type { BoardCard, BoardSnapshot } from "./summarize";

function card(id: string, over: Partial<BoardCard> = {}): BoardCard {
  return {
    id,
    kind: "",
    title: id,
    body: "",
    starred: false,
    superseded: false,
    origin: "ai",
    ...over
  };
}

describe("computeBoardStats", () => {
  it("reports an empty board", () => {
    const stats = computeBoardStats({ cards: [], edges: [] });
    expect(stats.isEmpty).toBe(true);
    expect(stats.total).toBe(0);
    expect(stats.kinds).toEqual([]);
    expect(stats.timeline).toEqual([]);
  });

  it("counts totals and AI vs user provenance", () => {
    const stats = computeBoardStats({
      cards: [card("a1", { origin: "ai" }), card("a2", { origin: "ai" }), card("a3", { origin: "user" })],
      edges: []
    });
    expect(stats.total).toBe(3);
    expect(stats.aiCount).toBe(2);
    expect(stats.userCount).toBe(1);
    expect(stats.isEmpty).toBe(false);
  });

  it("orders the kind breakdown: known kinds first, unknowns alpha, kindless last", () => {
    const stats = computeBoardStats({
      cards: [
        card("a1", { kind: "feature" }),
        card("a2", { kind: "risk" }),
        card("a3", { kind: "risk" }),
        card("a4", { kind: "zebra" }), // unknown tag
        card("a5", { kind: "" }) // kindless
      ],
      edges: []
    });
    // registry order is risk, feature, question, decision, todo, heuristic
    expect(stats.kinds).toEqual([
      { kind: "risk", count: 2 },
      { kind: "feature", count: 1 },
      { kind: "zebra", count: 1 },
      { kind: "", count: 1 }
    ]);
  });

  it("normalizes kind casing/whitespace when bucketing", () => {
    const stats = computeBoardStats({
      cards: [card("a1", { kind: "Risk" }), card("a2", { kind: " risk " })],
      edges: []
    });
    expect(stats.kinds).toEqual([{ kind: "risk", count: 2 }]);
  });

  it("tallies convergence signals: marked, superseded, questions, decisions", () => {
    const stats = computeBoardStats({
      cards: [
        card("a1", { starred: true }),
        card("a2", { superseded: true }),
        card("a3", { kind: "question" }),
        card("a4", { kind: "decision" }),
        card("a5", { kind: "decision" })
      ],
      edges: []
    });
    expect(stats.markedCount).toBe(1);
    expect(stats.supersededCount).toBe(1);
    expect(stats.openQuestions).toBe(1);
    expect(stats.decisions).toBe(2);
  });

  it("counts triaged vs untriaged, excluding non-triageable kinds", () => {
    const stats = computeBoardStats({
      cards: [
        card("a1", { kind: "feature", score: { impact: 3, effort: 2 } }), // triaged
        card("a2", { kind: "feature" }), // triageable, untriaged
        card("a3", { kind: "risk" }), // NOT triageable → not counted as untriaged
        card("a4", { kind: "question" }) // NOT triageable
      ],
      edges: []
    });
    expect(stats.triagedCount).toBe(1);
    expect(stats.untriagedCount).toBe(1);
  });

  it("counts unlinked cards as those touched by no edge", () => {
    const snapshot: BoardSnapshot = {
      cards: [card("a1"), card("a2"), card("a3")],
      edges: [{ from: "a1", to: "a2", relation: "about" }]
    };
    const stats = computeBoardStats(snapshot);
    // a1 and a2 are linked; a3 is loose.
    expect(stats.unlinkedCount).toBe(1);
  });

  it("builds a generation timeline from dated cards", () => {
    const t0 = 1_000_000;
    const stats = computeBoardStats({
      cards: [
        card("a1", { createdAt: t0 }),
        card("a2", { createdAt: t0 + 60_000 }),
        card("a3", { createdAt: t0 + 120_000 }),
        card("a4") // undated — excluded from the timeline
      ],
      edges: []
    });
    expect(stats.datedCount).toBe(3);
    expect(stats.timeline).toHaveLength(TIMELINE_BUCKETS);
    // Every dated card lands in some bucket.
    const total = stats.timeline.reduce((n, b) => n + b.count, 0);
    expect(total).toBe(3);
    expect(stats.timelineSpanMs).toBe(120_000);
  });

  it("has no timeline when fewer than two cards are dated", () => {
    const stats = computeBoardStats({ cards: [card("a1", { createdAt: 5 }), card("a2")], edges: [] });
    expect(stats.datedCount).toBe(1);
    expect(stats.timeline).toEqual([]);
    expect(stats.timelineSpanMs).toBe(0);
  });
});

describe("bucketTimeline", () => {
  it("returns [] for fewer than two timestamps", () => {
    expect(bucketTimeline([])).toEqual([]);
    expect(bucketTimeline([42])).toEqual([]);
  });

  it("returns [] when every timestamp is identical (zero-width span)", () => {
    expect(bucketTimeline([7, 7, 7])).toEqual([]);
  });

  it("distributes timestamps across equal-width, ordered buckets", () => {
    const buckets = bucketTimeline([0, 100], 4);
    expect(buckets).toHaveLength(4);
    expect(buckets.map((b) => b.start)).toEqual([0, 25, 50, 75]);
    // 0 lands in the first bucket, 100 (the max) clamps into the last.
    expect(buckets[0].count).toBe(1);
    expect(buckets[3].count).toBe(1);
    expect(buckets[1].count).toBe(0);
  });

  it("clamps the final (max) timestamp into the last bucket rather than overflowing", () => {
    const buckets = bucketTimeline([0, 10, 20, 30, 40], 4);
    expect(buckets.reduce((n, b) => n + b.count, 0)).toBe(5);
    // 40 is the max → last bucket; not dropped past the end.
    expect(buckets[3].count).toBeGreaterThanOrEqual(1);
  });
});
