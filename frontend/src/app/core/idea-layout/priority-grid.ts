/**
 * 2×2 prioritization grid (#60, PD-015) — the impact × effort placement mode,
 * sibling of the mind-map Arrange. Pure like `./mind-map`: computes target
 * positions + overlay frames, mutates nothing.
 */

import type { LayoutPosition } from "./common";

/**
 * The minimal card shape the priority grid needs: identity, size, and a triage
 * score (#60). `impact` / `effort` are the agent-assigned 1..5 scores (delivered
 * via the `«SCORE@ref»` contract and stored on the card's `meta`). A card missing
 * EITHER axis is treated as *unscored* and parked in a lane below the grid, so the
 * mode degrades gracefully on a board that hasn't been triaged yet.
 */
export interface ScoredCard {
  id: string;
  w: number;
  h: number;
  /** Value 1..5 (higher = more impactful); undefined ⇒ unscored. */
  impact?: number;
  /** Value 1..5 (higher = more effort); undefined ⇒ unscored. */
  effort?: number;
}

export interface PriorityGridOptions {
  /** Top-left origin of the whole grid. */
  originX: number;
  originY: number;
  /** Inner size of one quadrant (cards tile inside it). */
  quadW: number;
  quadH: number;
  /** Gap between the two quadrant columns / rows. */
  quadGap: number;
  /** Gap between tiled cards inside a quadrant (and in the parking lane). */
  cardGap: number;
  /** Extra vertical gap before the unscored parking lane. */
  parkGap: number;
  /** Split point on the 1..5 scale: a value `>= mid` is "high". */
  mid: number;
}

export const DEFAULT_PRIORITY_GRID: PriorityGridOptions = {
  originX: 160,
  originY: 160,
  quadW: 760,
  quadH: 520,
  quadGap: 120,
  cardGap: 28,
  parkGap: 160,
  mid: 3
};

/**
 * The four quadrants of the impact×effort grid (#60). The label is what the
 * canvas can title each region with; `col`/`row` are its grid cell (0,0 = top
 * -left). Quick wins (high impact, low effort) sit top-left — where the eye lands.
 */
export const PRIORITY_QUADRANTS = [
  { key: "quick-wins", label: "Quick wins", col: 0, row: 0 },
  { key: "big-bets", label: "Big bets", col: 1, row: 0 },
  { key: "fill-ins", label: "Fill-ins", col: 0, row: 1 },
  { key: "time-sinks", label: "Time sinks", col: 1, row: 1 }
] as const;

export type PriorityQuadrant = (typeof PRIORITY_QUADRANTS)[number]["key"];

/** Which quadrant a scored card falls in (high impact = top, low effort = left). */
export function quadrantOf(impact: number, effort: number, mid = DEFAULT_PRIORITY_GRID.mid): PriorityQuadrant {
  const highImpact = impact >= mid;
  const lowEffort = effort < mid;
  if (highImpact) return lowEffort ? "quick-wins" : "big-bets";
  return lowEffort ? "fill-ins" : "time-sinks";
}

/**
 * Tile a set of cards left-to-right, top-to-bottom inside a box at (x0,y0),
 * also reporting how tall the tiling came out — the measure the dynamic
 * quadrant frames are sized from (#100).
 */
function tile(
  cards: readonly ScoredCard[],
  x0: number,
  y0: number,
  boxW: number,
  gap: number
): { positions: LayoutPosition[]; height: number } {
  const positions: LayoutPosition[] = [];
  let cx = x0;
  let cy = y0;
  let rowH = 0;
  let bottom = y0;
  for (const c of cards) {
    if (cx > x0 && cx + c.w > x0 + boxW) {
      // Wrap to the next row within the box.
      cx = x0;
      cy += rowH + gap;
      rowH = 0;
    }
    positions.push({ id: c.id, x: cx, y: cy });
    cx += c.w + gap;
    rowH = Math.max(rowH, c.h);
    bottom = Math.max(bottom, cy + c.h);
  }
  return { positions, height: bottom - y0 };
}

/** Breathing room a frame adds around its quadrant's tiling box on each side. */
const FRAME_PAD = 28;
/** Extra headroom above the tiling box, reserving space for the frame's label. */
const FRAME_HEADER = 48;

/**
 * One labeled overlay region of the priority grid (#100): a quadrant's dashed
 * box, or the unscored parking lane's caption. World coords, top-left origin —
 * the same space the cards tile in, inflated so the frame surrounds the cards
 * instead of hugging them. `h === 0` marks a label-only strip (the lane, whose
 * depth depends on how many cards park there).
 */
export interface GridFrame {
  key: PriorityQuadrant | "unscored";
  label: string;
  x: number;
  y: number;
  w: number;
  /** 0 ⇒ label-only (no box) — used for the unscored lane. */
  h: number;
}

/** What the priority-grid layout hands the canvas: card targets + overlay frames. */
export interface PriorityGridLayout {
  /** Top-left target positions for every card (scored and parked). */
  positions: LayoutPosition[];
  /** The labeled quadrant boxes (+ "Not triaged" caption) the overlay draws. */
  frames: GridFrame[];
}

/**
 * Lay the board out as a **2×2 impact×effort prioritization grid** (#60, PD-014's
 * sibling placement mode). Each scored card is binned into its quadrant — quick
 * wins (high impact / low effort) top-left, big bets top-right, fill-ins bottom
 * -left, time sinks bottom-right — and tiled within that quadrant's box. Cards
 * missing a score are parked in a full-width lane beneath the grid (so an
 * un-triaged board still arranges cleanly instead of piling at the origin).
 *
 * The geometry is content-aware (#100): the quadrant width grows past
 * `opt.quadW` when the fullest quadrant needs more columns (≈√n, so a crowded
 * quadrant stays squarish instead of scrolling into a deep strip), and each
 * ROW's height grows to whatever its taller quadrant actually tiled — the
 * returned {@link GridFrame}s trace that real footprint, so the labels never
 * lie about where a quadrant ends. Columns stay aligned (one width for all
 * four) to keep the 2×2 reading as a grid.
 *
 * Pure: returns top-left target positions + overlay frames, mutates nothing —
 * the canvas applies positions exactly like `layoutMindMap` (bound edge-arrows
 * follow for free) and draws the frames while grid mode is on.
 */
export function layoutPriorityGrid(
  cards: readonly ScoredCard[],
  options: Partial<PriorityGridOptions> = {}
): PriorityGridLayout {
  const opt = { ...DEFAULT_PRIORITY_GRID, ...options };
  if (cards.length === 0) return { positions: [], frames: [] };

  const buckets = new Map<PriorityQuadrant, ScoredCard[]>();
  const unscored: ScoredCard[] = [];
  for (const c of cards) {
    if (typeof c.impact !== "number" || typeof c.effort !== "number") {
      unscored.push(c);
      continue;
    }
    const q = quadrantOf(c.impact, c.effort, opt.mid);
    const list = buckets.get(q);
    if (list) list.push(c);
    else buckets.set(q, [c]);
  }

  // Content-aware quadrant width: enough columns (≈√n of the fullest bucket,
  // sized by the widest card) that a crowded quadrant tiles squarish, never
  // narrower than the configured minimum so a sparse board keeps its shape.
  const fullest = Math.max(0, ...[...buckets.values()].map((b) => b.length));
  const widest = Math.max(0, ...cards.map((c) => c.w));
  const columns = Math.ceil(Math.sqrt(fullest));
  const quadW = Math.max(opt.quadW, columns * (widest + opt.cardGap) - opt.cardGap);

  // Measure each quadrant's tiling at a local origin first — row heights (and
  // therefore the bottom row's y) depend on how tall the TOP row came out.
  const measured = new Map<PriorityQuadrant, { positions: LayoutPosition[]; height: number }>();
  for (const quad of PRIORITY_QUADRANTS) {
    const bucket = buckets.get(quad.key);
    if (bucket?.length) measured.set(quad.key, tile(bucket, 0, 0, quadW, opt.cardGap));
  }
  const rowHeight = (row: number) =>
    Math.max(
      opt.quadH,
      ...PRIORITY_QUADRANTS.filter((q) => q.row === row).map((q) => measured.get(q.key)?.height ?? 0)
    );
  const rowH = [rowHeight(0), rowHeight(1)];
  const rowY = [opt.originY, opt.originY + rowH[0] + opt.quadGap];

  const positions: LayoutPosition[] = [];
  const frames: GridFrame[] = [];
  for (const quad of PRIORITY_QUADRANTS) {
    const x0 = opt.originX + quad.col * (quadW + opt.quadGap);
    const y0 = rowY[quad.row];
    const m = measured.get(quad.key);
    if (m) positions.push(...m.positions.map((p) => ({ id: p.id, x: p.x + x0, y: p.y + y0 })));
    frames.push({
      key: quad.key,
      label: quad.label,
      x: x0 - FRAME_PAD,
      y: y0 - FRAME_HEADER,
      w: quadW + 2 * FRAME_PAD,
      h: rowH[quad.row] + FRAME_HEADER + FRAME_PAD
    });
  }

  if (unscored.length) {
    const laneY = rowY[1] + rowH[1] + opt.parkGap;
    const laneW = 2 * quadW + opt.quadGap;
    positions.push(...tile(unscored, opt.originX, laneY, laneW, opt.cardGap).positions);
    frames.push({
      key: "unscored",
      label: "Not triaged",
      x: opt.originX - FRAME_PAD,
      y: laneY - FRAME_HEADER,
      w: laneW + 2 * FRAME_PAD,
      h: 0
    });
  }

  return { positions, frames };
}
