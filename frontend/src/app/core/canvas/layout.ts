/**
 * On-demand board re-flows and the triage actions that feed them (#16/#60, PD-014):
 * the organic mind map, the 2×2 impact×effort grid, the `«SCORE@ref»` score sink,
 * and the multi-select mark toggle (#29). All take the live `Editor`; all are
 * user-triggered (never auto-rewrite a manual placement).
 */
import type { Editor, TLShapeId } from "tldraw";
import type { Score } from "@ai-storm/shared";
import { layoutMindMap, layoutPriorityGrid, type ScoredCard } from "../idea-layout";
import { ideaCards, resolveRef, type IdeaCardMeta, type IdeaCardShape } from "./idea-card";
import { ideaEdges } from "./edges";

/**
 * Re-flow the idea cards into an organic mind map (#16, PD-014) — the canvas
 * "Arrange" action. Reads the typed edge graph, computes target positions with the
 * pure {@link layoutMindMap} helper, and applies them in one transaction: related
 * cards cluster and fan out from their main idea, superseded originals sit to the
 * left, loose cards tidy into kind-grouped lanes. Only card `x/y` change; edges are
 * native arrows bound to both endpoints, so they track their cards for free — "all
 * relationships preserved" without touching the graph. A no-op on an empty board.
 * Runs on demand only (PD-014): the user's manual placement is never auto-rewritten.
 */
export function arrangeMindMap(editor: Editor): void {
  const cards = ideaCards(editor);
  if (cards.length === 0) return;
  const cardIds = new Set(cards.map((c) => c.id));
  const positions = layoutMindMap(
    cards.map((c) => ({
      id: c.id,
      kind: c.props.kind,
      x: c.x,
      y: c.y,
      w: c.props.w,
      h: c.props.h
    })),
    ideaEdges(editor, cardIds)
  );
  editor.run(() => {
    editor.updateShapes(positions.map((p) => ({ id: p.id as TLShapeId, type: "idea-card" as const, x: p.x, y: p.y })));
  });
  // Frame the freshly-tidied board so the new grouping is visible at a glance.
  editor.zoomToFit({ animation: { duration: 200 } });
}

/**
 * Apply a triage {@link Score} (#60) to the card it targets: resolve the score's
 * short ref to a shape and stamp `{impact, effort, confidence}` onto its `meta`
 * (the field the 2×2 grid layout reads). A score for an unknown ref is ignored
 * (the card may have been deleted). Stored on `meta`, so no schema migration and
 * it persists with the board — exactly like the keep-mark star (#59).
 */
export function applyScore(editor: Editor, score: Score): void {
  const id = resolveRef(editor, score.ref);
  if (!id) return;
  const shape = editor.getShape(id);
  if (!shape || shape.type !== "idea-card") return;
  const value: NonNullable<IdeaCardMeta["score"]> = { impact: score.impact, effort: score.effort };
  if (typeof score.confidence === "number") value.confidence = score.confidence;
  editor.updateShape({ id, type: "idea-card", meta: { ...shape.meta, score: value } });
}

/**
 * Re-flow the board into a 2×2 impact×effort prioritization grid (#60) — the
 * "Grid" action, a sibling of Arrange (#16/PD-014). Reads each card's triage
 * score off `meta.score` (delivered by the `«SCORE@ref»` contract), bins it into
 * a quadrant via the pure {@link layoutPriorityGrid}, and applies the positions in
 * one transaction; unscored cards park in a lane below the grid. Like Arrange,
 * only card `x/y` change — bound edge-arrows track their cards for free — and it
 * runs on demand only. A no-op on an empty board.
 */
export function arrangePriorityGrid(editor: Editor): void {
  const cards = ideaCards(editor);
  if (cards.length === 0) return;
  const scored: ScoredCard[] = cards.map((c) => {
    const score = (c.meta as IdeaCardMeta).score;
    return { id: c.id, w: c.props.w, h: c.props.h, impact: score?.impact, effort: score?.effort };
  });
  const positions = layoutPriorityGrid(scored);
  editor.run(() => {
    editor.updateShapes(positions.map((p) => ({ id: p.id as TLShapeId, type: "idea-card" as const, x: p.x, y: p.y })));
  });
  editor.zoomToFit({ animation: { duration: 200 } });
}

/**
 * Mark/unmark every selected idea card (#29) — the multi-select "★ Mark" action.
 * Toggles as a group: if all selected cards are already marked, this clears them;
 * otherwise it marks them all. No-op when no idea card is selected.
 */
export function markSelected(editor: Editor): void {
  const sel = editor.getSelectedShapes().filter((s): s is IdeaCardShape => s.type === "idea-card");
  if (sel.length === 0) return;
  const allStarred = sel.every((s) => (s.meta as IdeaCardMeta).starred);
  editor.run(() =>
    editor.updateShapes(
      sel.map((s) => ({
        id: s.id,
        type: "idea-card" as const,
        meta: { ...s.meta, starred: !allStarred }
      }))
    )
  );
}
