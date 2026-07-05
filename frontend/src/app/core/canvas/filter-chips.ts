/**
 * The active-filter chip model (#108) — turns the opaque {@link BoardFilter} atom
 * into a flat, ordered list of removable chips for the always-visible bar near the
 * canvas toolbar. Today the only surface for "what's filtered" is the `Filter (N)`
 * submenu label buried in the ☰ menu; this derives a named chip per engaged facet
 * (each hidden kind, the origin restriction, marked-only, triaged-only, superseded
 * hidden) so the state is legible without opening the menu.
 *
 * Pure and tldraw-free (Node-testable): each chip carries a `remove` reducer that
 * returns the filter with just that facet cleared, so the UI (`./FilterChips`) maps
 * a chip's ✕ straight onto the filter atom without re-deriving which facet it was.
 */
import { kindLabel, KNOWN_KINDS } from "../idea-descriptors";
import type { BoardFilter } from "./filter";

/** One engaged facet, rendered as a removable chip (#108). */
export interface FilterChip {
  /** Stable React key / test id for this facet, e.g. `kind-risk`, `origin`. */
  id: string;
  /** Short label naming the active facet, e.g. "Hidden: ⚠ Risk", "🤖 AI only". */
  label: string;
  /** The filter with just this facet cleared — the chip's ✕ target. Pure. */
  remove(filter: BoardFilter): BoardFilter;
}

/**
 * The engaged facets of `filter` as an ordered chip list (#108) — empty when the
 * filter is the no-op {@link EMPTY_FILTER}. Hidden kinds come first (in the canonical
 * {@link KNOWN_KINDS} order, then any extra tags), matching the Filter menu's layout,
 * followed by origin, marked-only, triaged-only, and the superseded-hidden facet.
 */
export function filterChips(filter: BoardFilter): FilterChip[] {
  const chips: FilterChip[] = [];

  // Deterministic order: known kinds in registry order, then unknown #tags.
  const hidden = filter.hiddenKinds;
  const extras = [...hidden].filter((k) => !(KNOWN_KINDS as readonly string[]).includes(k));
  for (const kind of [...KNOWN_KINDS, ...extras]) {
    if (!hidden.has(kind)) continue;
    chips.push({
      id: `kind-${kind}`,
      label: `Hidden: ${kindLabel(kind)}`,
      remove: (f) => {
        const next = new Set(f.hiddenKinds);
        next.delete(kind);
        return { ...f, hiddenKinds: next };
      }
    });
  }

  if (filter.origin !== "all") {
    chips.push({
      id: "origin",
      label: filter.origin === "ai" ? "🤖 AI only" : "User only",
      remove: (f) => ({ ...f, origin: "all" })
    });
  }
  if (filter.markedOnly) {
    chips.push({ id: "marked", label: "★ Marked only", remove: (f) => ({ ...f, markedOnly: false }) });
  }
  if (filter.triagedOnly) {
    chips.push({ id: "triaged", label: "⚖ Triaged only", remove: (f) => ({ ...f, triagedOnly: false }) });
  }
  if (!filter.showSuperseded) {
    chips.push({ id: "superseded", label: "Superseded hidden", remove: (f) => ({ ...f, showSuperseded: true }) });
  }

  return chips;
}
