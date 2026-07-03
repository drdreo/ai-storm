/**
 * Tests for the pure mind-map layout helper (#16, PD-014). No tldraw / DOM
 * dependency, so it runs in the plain Node test env. Radial coordinates are
 * brittle to assert exactly, so these check the *invariants* the layout promises:
 * clustering, supersede-left placement, kind grouping, and cluster separation.
 */

import { describe, it, expect } from "vitest";
import {
  layoutMindMap,
  layoutPriorityGrid,
  quadrantOf,
  DEFAULT_MINDMAP,
  DEFAULT_PRIORITY_GRID,
  type LayoutCard,
  type LayoutEdge,
  type LayoutPosition,
  type ScoredCard
} from "./idea-layout";

/** Compact card factory — fixed 250×132 (the canvas default) unless overridden. */
function card(id: string, kind = "", x = 0, y = 0, w = 250, h = 132): LayoutCard {
  return { id, kind, x, y, w, h };
}

/** Index positions by id, with center helpers, for invariant checks. */
function index(positions: LayoutPosition[], cards: LayoutCard[]) {
  const sizes = new Map(cards.map((c) => [c.id, c]));
  const byId = new Map(positions.map((p) => [p.id, p]));
  return {
    pos: (id: string) => byId.get(id)!,
    center: (id: string) => {
      const p = byId.get(id)!;
      const c = sizes.get(id)!;
      return { x: p.x + c.w / 2, y: p.y + c.h / 2 };
    },
    dist: (a: string, b: string) => {
      const pa = byId.get(a)!;
      const pb = byId.get(b)!;
      return Math.hypot(pa.x - pb.x, pa.y - pb.y);
    }
  };
}

describe("layoutMindMap", () => {
  it("returns nothing for an empty board", () => {
    expect(layoutMindMap([], [])).toEqual([]);
  });

  it("places every card exactly once", () => {
    const cards = [card("idea"), card("r1", "risk"), card("r2", "risk"), card("loose")];
    const edges: LayoutEdge[] = [
      { from: "r1", to: "idea", relation: "about" },
      { from: "r2", to: "idea", relation: "about" }
    ];
    const out = layoutMindMap(cards, edges);
    expect(out.map((p) => p.id).sort()).toEqual(["idea", "loose", "r1", "r2"]);
  });

  it("fans about-children out around their main idea at roughly the ring radius", () => {
    const cards = [card("idea"), card("r1", "risk"), card("r2", "risk"), card("r3", "risk")];
    const edges: LayoutEdge[] = [
      { from: "r1", to: "idea", relation: "about" },
      { from: "r2", to: "idea", relation: "about" },
      { from: "r3", to: "idea", relation: "about" }
    ];
    const ix = index(layoutMindMap(cards, edges), cards);
    // Each risk sits ~ring away from the idea (full-circle fan, so exactly ring).
    for (const r of ["r1", "r2", "r3"]) {
      expect(ix.dist("idea", r)).toBeCloseTo(DEFAULT_MINDMAP.ring, 0);
    }
    // …and at distinct positions (not stacked).
    expect(ix.center("r1")).not.toEqual(ix.center("r2"));
    expect(ix.center("r2")).not.toEqual(ix.center("r3"));
  });

  it("places a superseded original to the LEFT of the new card at the same height", () => {
    const cards = [card("new", "feature"), card("old", "feature")];
    // Challenge: `new` supersedes `old` (PD-012).
    const edges: LayoutEdge[] = [{ from: "new", to: "old", relation: "supersedes" }];
    const ix = index(layoutMindMap(cards, edges), cards);
    expect(ix.center("old").x).toBeLessThan(ix.center("new").x);
    expect(ix.center("old").y).toBeCloseTo(ix.center("new").y, 5);
  });

  it("keeps the new idea as the anchor — risks fan to its right, history to its left", () => {
    const cards = [card("new", "feature"), card("old", "feature"), card("r1", "risk"), card("r2", "risk")];
    const edges: LayoutEdge[] = [
      { from: "new", to: "old", relation: "supersedes" },
      { from: "r1", to: "new", relation: "about" },
      { from: "r2", to: "new", relation: "about" }
    ];
    const ix = index(layoutMindMap(cards, edges), cards);
    const anchorX = ix.center("new").x;
    expect(ix.center("old").x).toBeLessThan(anchorX); // history left
    expect(ix.center("r1").x).toBeGreaterThan(anchorX); // risks fan right
    expect(ix.center("r2").x).toBeGreaterThan(anchorX);
  });

  it("separates distinct clusters with clear breathing room", () => {
    const cards = [card("ideaA"), card("a1", "risk"), card("ideaB"), card("b1", "risk")];
    const edges: LayoutEdge[] = [
      { from: "a1", to: "ideaA", relation: "about" },
      { from: "b1", to: "ideaB", relation: "about" }
    ];
    const ix = index(layoutMindMap(cards, edges), cards);
    // Cross-cluster distance >> within-cluster distance.
    const within = ix.dist("ideaA", "a1");
    const between = Math.min(ix.dist("ideaA", "ideaB"), ix.dist("a1", "b1"));
    expect(between).toBeGreaterThan(within + DEFAULT_MINDMAP.clusterGap / 2);
  });

  it("tidies loose, unrelated cards into kind-grouped lanes", () => {
    // No edges → all singletons. Same-kind cards share a lane (column).
    const cards = [card("r1", "risk", 0, 0), card("r2", "risk", 0, 999), card("f1", "feature")];
    const ix = index(layoutMindMap(cards, []), cards);
    // The two risks share an x (same lane); the feature is in a different lane.
    expect(ix.pos("r1").x).toBe(ix.pos("r2").x);
    expect(ix.pos("f1").x).not.toBe(ix.pos("r1").x);
    // Within the lane, r1 sits above r2.
    expect(ix.pos("r1").y).toBeLessThan(ix.pos("r2").y);
  });

  it("honours a custom origin", () => {
    const cards = [card("only", "risk")];
    const [p] = layoutMindMap(cards, [], { originX: 1000, originY: 500 });
    expect(p).toEqual({ id: "only", x: 1000, y: 500 });
  });
});

/** Compact scored-card factory — fixed 250×132 unless overridden. */
function scored(id: string, impact?: number, effort?: number, w = 250, h = 132): ScoredCard {
  return { id, w, h, impact, effort };
}

describe("quadrantOf", () => {
  const mid = DEFAULT_PRIORITY_GRID.mid; // 3
  it("bins high impact + low effort as quick wins", () => {
    expect(quadrantOf(5, 1, mid)).toBe("quick-wins");
    expect(quadrantOf(3, 2, mid)).toBe("quick-wins");
  });
  it("bins high impact + high effort as big bets", () => {
    expect(quadrantOf(5, 5, mid)).toBe("big-bets");
    expect(quadrantOf(3, 3, mid)).toBe("big-bets");
  });
  it("bins low impact + low effort as fill-ins", () => {
    expect(quadrantOf(2, 1, mid)).toBe("fill-ins");
  });
  it("bins low impact + high effort as time sinks", () => {
    expect(quadrantOf(1, 5, mid)).toBe("time-sinks");
  });
});

describe("layoutPriorityGrid", () => {
  const opt = DEFAULT_PRIORITY_GRID;

  it("is a no-op on an empty board", () => {
    expect(layoutPriorityGrid([])).toEqual([]);
  });

  it("places quick wins top-left and big bets in the right column", () => {
    const positions = layoutPriorityGrid([
      scored("win", 5, 1), // quick win: col 0, row 0
      scored("bet", 5, 5) // big bet:   col 1, row 0
    ]);
    const win = positions.find((p) => p.id === "win")!;
    const bet = positions.find((p) => p.id === "bet")!;
    expect(win.x).toBe(opt.originX);
    expect(win.y).toBe(opt.originY);
    // Big bets sit a full quadrant + gap to the right, same top row.
    expect(bet.x).toBe(opt.originX + opt.quadW + opt.quadGap);
    expect(bet.y).toBe(opt.originY);
  });

  it("places low-impact cards in the bottom row", () => {
    const [fill] = layoutPriorityGrid([scored("fill", 1, 1)]);
    expect(fill.x).toBe(opt.originX);
    expect(fill.y).toBe(opt.originY + opt.quadH + opt.quadGap);
  });

  it("parks unscored cards in a lane below the grid", () => {
    const positions = layoutPriorityGrid([
      scored("win", 5, 1),
      scored("loose") // no scores → parked
    ]);
    const loose = positions.find((p) => p.id === "loose")!;
    const laneY = opt.originY + 2 * opt.quadH + opt.quadGap + opt.parkGap;
    expect(loose.y).toBe(laneY);
    expect(loose.x).toBe(opt.originX);
  });

  it("tiles multiple cards in one quadrant without overlap, wrapping by width", () => {
    // Many narrow cards in the same quadrant: x advances, then wraps to a new row.
    const cards = Array.from({ length: 5 }, (_, i) => scored(`q${i}`, 5, 1, 250, 132));
    const positions = layoutPriorityGrid(cards, { quadW: 600 }); // ~2 per row (250+gap)
    const first = positions.find((p) => p.id === "q0")!;
    const second = positions.find((p) => p.id === "q1")!;
    const third = positions.find((p) => p.id === "q2")!;
    expect(second.x).toBeGreaterThan(first.x); // same row, to the right
    expect(second.y).toBe(first.y);
    expect(third.x).toBe(first.x); // wrapped back to the left
    expect(third.y).toBeGreaterThan(first.y);
  });
});
