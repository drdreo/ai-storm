/**
 * Pure canvas placement math (#16, #60; PD-014/PD-015), split by mode:
 *  - `common.ts` — shared card/edge shapes + graph/kind helpers (union-find
 *    clustering, `clusterIds` for #131 focus mode);
 *  - `mind-map.ts` — the organic mind-map Arrange;
 *  - `priority-grid.ts` — the 2×2 impact×effort prioritization grid.
 *
 * Everything is free of tldraw / DOM imports so it stays unit-testable in the
 * plain Node env. Importers keep using `../idea-layout`.
 */

export { clusterIds, type LayoutCard, type LayoutEdge, type LayoutPosition, type LayoutRelation } from "./common";
export { DEFAULT_MINDMAP, layoutMindMap, type MindMapOptions } from "./mind-map";
export {
  DEFAULT_PRIORITY_GRID,
  PRIORITY_QUADRANTS,
  layoutPriorityGrid,
  quadrantOf,
  type GridFrame,
  type PriorityGridLayout,
  type PriorityGridOptions,
  type PriorityQuadrant,
  type ScoredCard
} from "./priority-grid";
