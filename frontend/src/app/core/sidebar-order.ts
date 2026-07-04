import { generateKeyBetween } from "fractional-indexing";

/**
 * Sidebar ordering (#128 drag & drop) — fractional-index sort keys.
 *
 * Folders and workspaces carry an `order` string (fractional-indexing key);
 * inserting between two neighbors only writes the moved item, which keeps CRDT
 * merge conflicts minimal. Items persisted before this feature have no key and
 * sort first, tie-broken by `createdAt` (self-healed to real keys at boot).
 */

interface Orderable {
  order?: string;
  createdAt: number;
}

/** Total order: keyless items first (by age), then fractional keys ascending. */
export function compareByOrder(a: Orderable, b: Orderable): number {
  const ka = a.order ?? "";
  const kb = b.order ?? "";
  if (ka !== kb) return ka < kb ? -1 : 1;
  return a.createdAt - b.createdAt;
}

/**
 * Sort key for inserting at `dropIndex` into `siblings` (sorted, and excluding
 * the item being moved). Degenerate neighbor keys (equal/inverted, possible
 * after a concurrent-write merge) fall back to appending after `prev`.
 */
export function computeOrder(siblings: readonly Orderable[], dropIndex: number): string {
  const prev = siblings[dropIndex - 1]?.order ?? null;
  const next = siblings[dropIndex]?.order ?? null;
  try {
    return generateKeyBetween(prev, next);
  } catch {
    return generateKeyBetween(prev, null);
  }
}

/** Key ranking after every item in `siblings` (append to end of a container). */
export function orderAfterAll(siblings: readonly Orderable[]): string {
  return computeOrder(siblings, siblings.length);
}
