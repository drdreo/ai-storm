/**
 * Pure mind-map layout (#16, PD-014) — the math behind the canvas "Arrange"
 * action. Free of any tldraw / DOM import so it is unit-testable in the plain
 * Node env (like idea-descriptors).
 *
 * The board's default placement (`applyIdeas`' dock-near-target / grid tail) is a
 * *pile*. Arrange turns the pile into an *organic mind map*: each connected group
 * of related cards becomes a cluster that radiates out from its main idea, with
 * same-kind cards grouped together in the fan, and generous space between distinct
 * clusters so the board doesn't read as one overloaded wall. It is invoked on
 * demand (PD-014), never automatically, so manual placement is only ever rewritten
 * when the user asks.
 *
 * The graph drives the shape:
 *  - an `about` edge (a risk/feature/question of an idea) makes the card a branch
 *    radiating outward from that idea — full circle around a lone main idea, a
 *    rightward fan when the idea also carries history on its left;
 *  - a `supersedes` edge (a Challenge's refined card replacing the original) reads
 *    left→right: the greyed original sits to the LEFT, the new idea to its right is
 *    the anchor everything else fans out from (PD-012).
 *
 * This module computes *target positions only*. Applying them to the editor — and
 * the fact that bound edge-arrows follow their cards for free — lives in the canvas
 * island; relationships are never mutated here.
 */

import { KNOWN_KINDS, normalizeKind } from './idea-descriptors';

export type LayoutRelation = 'about' | 'supersedes';

/** The minimal card shape Arrange needs: identity, kind, current pos, size. */
export interface LayoutCard {
  id: string;
  kind: string;
  /** Current position — only used as a stable tiebreaker for sibling ordering. */
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A directed, typed edge between cards (extracted from the bound arrows). For
 * `about`, `from` is the child (the risk/feature) and `to` is the idea it is about.
 * For `supersedes`, `from` is the new/surviving card and `to` is the original it
 * replaces (which renders as the greyed ghost) — see `connect()` in the island.
 */
export interface LayoutEdge {
  from: string;
  to: string;
  relation: LayoutRelation;
}

/** A computed target position for one card (top-left, world coords). */
export interface LayoutPosition {
  id: string;
  x: number;
  y: number;
}

export interface MindMapOptions {
  /** Top-left origin of the whole arrangement. */
  originX: number;
  originY: number;
  /** Root → first-ring distance for a main idea's direct branches. */
  ring: number;
  /** Parent → child distance for deeper branches. */
  branch: number;
  /** Spacing margin folded into the fit calc, so cards in a fan don't touch. */
  cardGap: number;
  /** Horizontal gap placed between a card and the original it supersedes. */
  supGap: number;
  /** Breathing room between distinct clusters (and singleton lanes). */
  clusterGap: number;
  /** Wrap clusters onto a new row past this width, so the board stays squarish. */
  maxRowWidth: number;
}

export const DEFAULT_MINDMAP: MindMapOptions = {
  originX: 160,
  originY: 160,
  ring: 340,
  branch: 270,
  cardGap: 70,
  supGap: 80,
  clusterGap: 300,
  maxRowWidth: 3400,
};

/** Rightward fan arc (rad) for a main idea that also has history on its left. */
const RIGHT_ARC = 4.6;
/** Cone (rad) a deeper branch's children fan into, centered on the outward dir. */
const CHILD_CONE = 2.2;
const TAU = Math.PI * 2;

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

interface Center {
  id: string;
  cx: number;
  cy: number;
  w: number;
  h: number;
}

/** Sort rank for a kind: known kinds in registry order, unknown next, kindless last. */
function kindRank(kind?: string): number {
  const k = normalizeKind(kind);
  if (!k) return KNOWN_KINDS.length + 1;
  const i = KNOWN_KINDS.indexOf(k as (typeof KNOWN_KINDS)[number]);
  return i >= 0 ? i : KNOWN_KINDS.length;
}

/** Angular "footprint" of one card in a fan — its larger dimension plus the gap. */
function cardSpan(card: LayoutCard, gap: number): number {
  return Math.max(card.w, card.h) + gap;
}

/** Union-find over the edges: returns each card's component representative. */
function components(cards: readonly LayoutCard[], edges: readonly LayoutEdge[]): Map<string, string> {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    // Path-compress.
    let cur = x;
    while (parent.get(cur) !== r) {
      const next = parent.get(cur)!;
      parent.set(cur, r);
      cur = next;
    }
    return r;
  };
  for (const c of cards) parent.set(c.id, c.id);
  for (const e of edges) {
    if (!parent.has(e.from) || !parent.has(e.to)) continue;
    parent.set(find(e.from), find(e.to));
  }
  const rep = new Map<string, string>();
  for (const c of cards) rep.set(c.id, find(c.id));
  return rep;
}

/* -------------------------------------------------------------------------- */
/* Cluster layout — one connected component as a branching mind map            */
/* -------------------------------------------------------------------------- */

/**
 * Lay one connected component out as a mind map in LOCAL coords (root at 0,0),
 * returning each card's center. `about` children fan outward from their parent;
 * a `supersedes` target is pinned to the parent's left as a history breadcrumb.
 */
function placeCluster(
  nodes: readonly LayoutCard[],
  edges: readonly LayoutEdge[],
  opt: MindMapOptions,
): Center[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const children = new Map<string, { id: string; rel: LayoutRelation }[]>();
  const hasParent = new Set<string>();
  const push = (parent: string, child: string, rel: LayoutRelation) => {
    const list = children.get(parent);
    if (list) list.push({ id: child, rel });
    else children.set(parent, [{ id: child, rel }]);
    hasParent.add(child);
  };
  for (const e of edges) {
    // about: child → idea ⇒ idea owns the child branch.
    // supersedes: new → original ⇒ the new card owns the (greyed) original, left.
    if (e.relation === 'about') push(e.to, e.from, 'about');
    else push(e.from, e.to, 'supersedes');
  }

  const childCount = (id: string) => children.get(id)?.length ?? 0;
  // Root = a node nothing points at (a surviving main idea). Prefer the busiest;
  // fall back to the busiest node overall if a cycle leaves no clean root.
  const rootless = nodes.filter((n) => !hasParent.has(n.id));
  const pool = rootless.length ? rootless : [...nodes];
  const primary = pool.reduce((a, b) => (childCount(b.id) > childCount(a.id) ? b : a));
  // Any other rootless nodes become extra branches of the primary so all land.
  for (const r of rootless) if (r.id !== primary.id) push(primary.id, r.id, 'about');

  // Group siblings by kind so same-kind cards sit together in the fan.
  for (const list of children.values()) {
    list.sort((a, b) => {
      const ca = byId.get(a.id)!;
      const cb = byId.get(b.id)!;
      return kindRank(ca.kind) - kindRank(cb.kind) || ca.y - cb.y || ca.x - cb.x;
    });
  }

  const centers = new Map<string, Center>();
  const visited = new Set<string>();

  const place = (id: string, cx: number, cy: number, outward: number, depth: number): void => {
    if (visited.has(id)) return;
    visited.add(id);
    const card = byId.get(id)!;
    centers.set(id, { id, cx, cy, w: card.w, h: card.h });

    const kids = (children.get(id) ?? []).filter((c) => !visited.has(c.id) && byId.has(c.id));
    const about = kids.filter((c) => c.rel === 'about');
    const sup = kids.filter((c) => c.rel === 'supersedes');

    if (about.length) {
      const span = Math.max(...about.map((c) => cardSpan(byId.get(c.id)!, opt.cardGap)));
      const n = about.length;
      const baseDist = depth === 0 ? opt.ring : opt.branch;
      // A lone main idea (no history) gets the full circle; otherwise a cone that
      // points outward (rightward at the root, away-from-parent deeper).
      const fullCircle = depth === 0 && sup.length === 0;
      const arc = fullCircle ? TAU : depth === 0 ? RIGHT_ARC : CHILD_CONE;
      const dist = Math.max(baseDist, n > 1 ? (n * span) / arc : baseDist);
      about.forEach((c, i) => {
        const angle = fullCircle
          ? (TAU * i) / n
          : n === 1
            ? outward
            : outward - arc / 2 + (arc * (i + 0.5)) / n;
        place(c.id, cx + dist * Math.cos(angle), cy + dist * Math.sin(angle), angle, depth + 1);
      });
    }

    // Supersede targets: the greyed original sits to the LEFT of this card.
    sup.forEach((c, k) => {
      const old = byId.get(c.id)!;
      const dist = card.w / 2 + old.w / 2 + opt.supGap;
      const oy =
        sup.length > 1 ? cy + (k - (sup.length - 1) / 2) * (old.h + opt.cardGap) : cy;
      place(c.id, cx - dist, oy, Math.PI, depth + 1);
    });
  };

  place(primary.id, 0, 0, 0, 0);
  // Safety net for any node a cycle left unplaced — drop it beside the root.
  let extra = 1;
  for (const n of nodes) {
    if (!visited.has(n.id)) place(n.id, opt.ring * extra++, opt.ring, 0, 1);
  }
  return [...centers.values()];
}

/* -------------------------------------------------------------------------- */
/* Singleton layout — loose, unrelated cards in a tidy kind-grouped lane block */
/* -------------------------------------------------------------------------- */

/** Lay loose (edgeless) cards as kind-grouped vertical lanes, in LOCAL coords. */
function placeSingletons(cards: readonly LayoutCard[], opt: MindMapOptions): Center[] {
  const lanes = new Map<number, LayoutCard[]>();
  for (const c of cards) {
    const rank = kindRank(c.kind);
    const lane = lanes.get(rank);
    if (lane) lane.push(c);
    else lanes.set(rank, [c]);
  }
  const out: Center[] = [];
  let laneX = 0;
  for (const rank of [...lanes.keys()].sort((a, b) => a - b)) {
    const lane = lanes.get(rank)!.slice().sort((a, b) => a.y - b.y || a.x - b.x);
    const laneW = Math.max(...lane.map((c) => c.w));
    let cy = 0;
    for (const c of lane) {
      out.push({ id: c.id, cx: laneX + laneW / 2, cy: cy + c.h / 2, w: c.w, h: c.h });
      cy += c.h + opt.cardGap;
    }
    laneX += laneW + opt.cardGap;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Packing + the public entry                                                  */
/* -------------------------------------------------------------------------- */

interface Block {
  centers: Center[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function toBlock(centers: Center[]): Block {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of centers) {
    minX = Math.min(minX, c.cx - c.w / 2);
    minY = Math.min(minY, c.cy - c.h / 2);
    maxX = Math.max(maxX, c.cx + c.w / 2);
    maxY = Math.max(maxY, c.cy + c.h / 2);
  }
  return { centers, minX, minY, maxX, maxY };
}

/**
 * Arrange the board as a mind map (#16, PD-014). Cards connected by edges form
 * clusters laid out as branching mind maps (about-children fan out, superseded
 * originals sit to the left); unrelated loose cards are tidied into kind-grouped
 * lanes. Clusters are shelf-packed left-to-right (wrapping past `maxRowWidth`)
 * with `clusterGap` breathing room between them. Pure: returns top-left target
 * positions, mutates nothing.
 */
export function layoutMindMap(
  cards: readonly LayoutCard[],
  edges: readonly LayoutEdge[],
  options: Partial<MindMapOptions> = {},
): LayoutPosition[] {
  const opt = { ...DEFAULT_MINDMAP, ...options };
  if (cards.length === 0) return [];

  const rep = components(cards, edges);
  const groups = new Map<string, LayoutCard[]>();
  for (const c of cards) {
    const key = rep.get(c.id)!;
    const g = groups.get(key);
    if (g) g.push(c);
    else groups.set(key, [c]);
  }

  // Build the blocks: one per relational cluster (≥2 cards), plus a single block
  // gathering every loose card so singletons don't scatter across the canvas.
  const blocks: Block[] = [];
  const singletons: LayoutCard[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) {
      singletons.push(...group);
      continue;
    }
    const ids = new Set(group.map((c) => c.id));
    const clusterEdges = edges.filter((e) => ids.has(e.from) && ids.has(e.to));
    blocks.push(toBlock(placeCluster(group, clusterEdges, opt)));
  }
  // Biggest clusters first for tighter packing; loose-card lanes go last.
  blocks.sort((a, b) => b.centers.length - a.centers.length);
  if (singletons.length) blocks.push(toBlock(placeSingletons(singletons, opt)));

  // Shelf-pack the blocks, then emit world-space top-left positions.
  const out: LayoutPosition[] = [];
  let rowX = 0;
  let rowY = 0;
  let rowH = 0;
  for (const block of blocks) {
    const bw = block.maxX - block.minX;
    const bh = block.maxY - block.minY;
    if (rowX > 0 && rowX + bw > opt.maxRowWidth) {
      rowY += rowH + opt.clusterGap;
      rowX = 0;
      rowH = 0;
    }
    const dx = opt.originX + rowX - block.minX;
    const dy = opt.originY + rowY - block.minY;
    for (const c of block.centers) {
      out.push({ id: c.id, x: c.cx + dx - c.w / 2, y: c.cy + dy - c.h / 2 });
    }
    rowX += bw + opt.clusterGap;
    rowH = Math.max(rowH, bh);
  }
  return out;
}
