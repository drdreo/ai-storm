/**
 * Shared vocabulary of the layout feature folder: the minimal card/edge shapes
 * both placement modes consume, plus the graph/kind helpers they share
 * (union-find clustering, kind ranking). Free of any tldraw / DOM import so
 * everything stays unit-testable in the plain Node env.
 */

import { KNOWN_KINDS, normalizeKind } from "../idea-descriptors";

export type LayoutRelation = "about" | "supersedes";

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

/** A card's computed center position + size, in cluster-local coords. */
export interface Center {
  id: string;
  cx: number;
  cy: number;
  w: number;
  h: number;
}

/** Sort rank for a kind: known kinds in registry order, unknown next, kindless last. */
export function kindRank(kind?: string): number {
  const k = normalizeKind(kind);
  if (!k) return KNOWN_KINDS.length + 1;
  const i = KNOWN_KINDS.indexOf(k as (typeof KNOWN_KINDS)[number]);
  return i >= 0 ? i : KNOWN_KINDS.length;
}

/** Union-find over the edges: returns each id's component representative. */
export function components(ids: readonly string[], edges: readonly LayoutEdge[]): Map<string, string> {
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
  for (const id of ids) parent.set(id, id);
  for (const e of edges) {
    if (!parent.has(e.from) || !parent.has(e.to)) continue;
    parent.set(find(e.from), find(e.to));
  }
  const rep = new Map<string, string>();
  for (const id of ids) rep.set(id, find(id));
  return rep;
}

/**
 * Card ids sharing a connected cluster with any of `selectedIds` (#131 focus
 * mode) — the same union-find grouping `layoutMindMap` arranges by, so
 * focusing reads as "zoom into this cluster." A selected id outside `ids` is
 * ignored; an empty (or entirely-unmatched) `selectedIds` yields an empty set.
 */
export function clusterIds<T extends string>(
  ids: readonly T[],
  edges: readonly LayoutEdge[],
  selectedIds: ReadonlySet<T>
): Set<T> {
  const rep = components(ids, edges);
  const targetReps = new Set<string>();
  for (const id of selectedIds) {
    const r = rep.get(id);
    if (r) targetReps.add(r);
  }
  if (targetReps.size === 0) return new Set();
  const result = new Set<T>();
  for (const id of ids) {
    if (targetReps.has(rep.get(id)!)) result.add(id);
  }
  return result;
}
