/**
 * On-demand board re-flows and the triage actions that feed them (#16/#60, PD-014):
 * the organic mind map, the 2×2 impact×effort grid, the `«SCORE@ref»` score sink,
 * and the multi-select mark toggle (#29). All take the live `Editor`; all are
 * user-triggered (never auto-rewrite a manual placement).
 */
import { atom, type Atom, Box, type Editor, type TLShapeId } from "tldraw";
import type { AgentArtifact, Completion, Reference, Score } from "@ai-storm/shared";
import { layoutMindMap, layoutPriorityGrid, type GridFrame, type ScoredCard } from "../idea-layout";
import { githubIssueKey, type IssueLink } from "../issue-links";
import { type CardLink, upsertLink } from "../card-links";
import { ideaCards, resolveRef, type IdeaCardMeta, type IdeaCardShape } from "./idea-card";
import { ideaEdges } from "./edges";

/**
 * Which arrangement the board is currently in (#100): the last arrange action
 * applied — mind map, or priority grid with its labeled quadrant frames — or
 * `null` when neither has run (or grid labels were dismissed). Drives the
 * Arrange menu's checkmarks and, in grid mode, the on-canvas quadrant overlay.
 */
export type ActiveBoardLayout = { mode: "mind-map" } | { mode: "grid"; frames: GridFrame[] };

/**
 * The per-editor active-layout state (#100). Held in a tldraw {@link atom} (so
 * `track`ed components — the on-canvas overlay and the Arrange menu — react to
 * it), keyed by editor in a WeakMap: each project's island gets its own, and it
 * vanishes with the editor on project switch. Set by {@link arrangeMindMap} /
 * {@link arrangePriorityGrid} (each arrange ends the other's mode), cleared by
 * the menu's "Hide grid labels".
 */
const layoutModes = new WeakMap<Editor, Atom<ActiveBoardLayout | null>>();

export function activeBoardLayout(editor: Editor): Atom<ActiveBoardLayout | null> {
  let mode = layoutModes.get(editor);
  if (!mode) {
    mode = atom<ActiveBoardLayout | null>("activeBoardLayout", null);
    layoutModes.set(editor, mode);
  }
  return mode;
}

/** A card's manual placement (#169) — the fields an arrange overwrites. */
type FreePlacement = { x: number; y: number; rotation: number };

/**
 * The board's pre-arrangement free layout (#169) — each idea card's hand-placed
 * `x/y/rotation` captured the moment the board first left free mode, so removing
 * the arrangement (its chip ✕, "Clear all", or the Arrange menu) can drop every
 * card back exactly where the user had dragged it. Keyed by editor in a WeakMap
 * alongside {@link layoutModes}: it resets on project switch and never persists —
 * once the session ends the arrangement itself is what the board keeps.
 */
const freeLayouts = new WeakMap<Editor, Map<TLShapeId, FreePlacement>>();

/**
 * Snapshot every idea card's current manual placement (#169) as the free layout to
 * restore later. The arrange actions call this right before re-flowing the board,
 * but only via {@link captureFreeLayoutOnce}: switching straight from mind map to
 * grid must keep the *original* free layout, never snapshot an arranged one.
 */
function captureFreeLayoutOnce(editor: Editor): void {
  // Already arranged → the current placement is an arrangement, not the user's.
  if (activeBoardLayout(editor).get()) return;
  const snapshot = new Map<TLShapeId, FreePlacement>();
  for (const c of ideaCards(editor)) snapshot.set(c.id, { x: c.x, y: c.y, rotation: c.rotation });
  freeLayouts.set(editor, snapshot);
}

/**
 * Restore the free layout captured before the board was arranged (#169) and return
 * to free mode — the "remove arrangement" action behind the arrangement chip's ✕
 * and "Clear all". Puts every still-present card back at
 * its snapshot `x/y/rotation` (cards streamed in after the arrange keep their spot),
 * then clears both the snapshot and the {@link activeBoardLayout} atom. With no
 * snapshot it just drops the arrangement flag, so it is always safe to call.
 */
export function restoreFreeLayout(editor: Editor): void {
  const snapshot = freeLayouts.get(editor);
  if (snapshot) {
    const updates = ideaCards(editor)
      .filter((c) => snapshot.has(c.id))
      .map((c) => {
        const p = snapshot.get(c.id)!;
        return { id: c.id, type: "idea-card" as const, x: p.x, y: p.y, rotation: p.rotation };
      });
    if (updates.length > 0) editor.run(() => editor.updateShapes(updates));
    freeLayouts.delete(editor);
  }
  activeBoardLayout(editor).set(null);
}

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
  // Remember the hand-placed layout the first time we leave free mode (#169), so
  // removing the arrangement can restore it.
  captureFreeLayoutOnce(editor);
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
  // The board is now a mind map (#100): checks the menu item, ends grid mode.
  activeBoardLayout(editor).set({ mode: "mind-map" });
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
 * Apply a {@link Completion} (#167) to the card it targets: resolve the ref and
 * stamp `done` onto its `meta` (the field the card body reads to show the done
 * state). A completion for an unknown ref is ignored (the card may have been
 * deleted). Stored on `meta`, so no schema migration and it persists with the
 * board — exactly like the keep-mark star (#59) and the triage score (#60). The
 * manual context-menu toggle ({@link markSelectedDone}) writes the same field.
 */
export function applyCompletion(editor: Editor, completion: Completion): void {
  const id = resolveRef(editor, completion.ref);
  if (!id) return;
  const shape = editor.getShape(id);
  if (!shape || shape.type !== "idea-card") return;
  editor.updateShape({ id, type: "idea-card", meta: { ...shape.meta, done: completion.done } });
}

/**
 * Stamp created-issue links back onto their source cards (#125): each artifact
 * from a finished create-issues run carries the short refs of the cards it was
 * generated from (parsed server-side from the run's summary table); resolve
 * each ref and write the issue onto that card's `meta.issue` — the back-link
 * the card renders as a clickable chip. Unknown refs are ignored (the card may
 * have been deleted); a later artifact for the same card wins (last write, like
 * a re-triage). Stored on `meta`, so no schema migration — like the score (#60).
 */
export function applyIssueLinks(editor: Editor, artifacts: readonly AgentArtifact[]): void {
  for (const artifact of artifacts) {
    const issue: IssueLink = {
      provider: "github",
      key: githubIssueKey(artifact.url) ?? artifact.url,
      url: artifact.url,
      title: artifact.title
    };
    for (const ref of artifact.refs ?? []) {
      const id = resolveRef(editor, ref);
      if (!id) continue;
      const shape = editor.getShape(id);
      if (!shape || shape.type !== "idea-card") continue;
      editor.updateShape({ id, type: "idea-card", meta: { ...shape.meta, issue } });
    }
  }
}

/**
 * Attach an external-link reference to its target card (#227) — the apply path
 * for the MCP `link_idea` tool, the generic sibling of {@link applyIssueLinks}.
 * Resolves the reference's short ref, appends the link to the card's `meta.links`
 * via {@link upsertLink} (deduped by URL, last write wins the label), and
 * preserves any existing links/meta. Unknown refs are ignored (the card may have
 * been deleted). Stored on `meta`, so no schema migration — like the score (#60).
 */
export function applyReference(editor: Editor, reference: Reference): void {
  const id = resolveRef(editor, reference.ref);
  if (!id) return;
  const shape = editor.getShape(id);
  if (!shape || shape.type !== "idea-card") return;
  const link: CardLink = reference.label ? { url: reference.url, label: reference.label } : { url: reference.url };
  const links = upsertLink(((shape.meta as IdeaCardMeta).links ?? []) as CardLink[], link);
  editor.updateShape({ id, type: "idea-card", meta: { ...shape.meta, links } });
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
  // Remember the hand-placed layout the first time we leave free mode (#169).
  captureFreeLayoutOnce(editor);
  const scored: ScoredCard[] = cards.map((c) => {
    const score = (c.meta as IdeaCardMeta).score;
    return { id: c.id, w: c.props.w, h: c.props.h, impact: score?.impact, effort: score?.effort };
  });
  const { positions, frames } = layoutPriorityGrid(scored);
  editor.run(() => {
    editor.updateShapes(positions.map((p) => ({ id: p.id as TLShapeId, type: "idea-card" as const, x: p.x, y: p.y })));
  });
  // Turn priority-grid mode on (#100): the overlay draws the layout's labeled
  // quadrant frames (sized to what actually tiled, including a "Not triaged"
  // lane caption only when unscored cards parked there).
  activeBoardLayout(editor).set({ mode: "grid", frames });
  // Frame the grid INCLUDING the overlay's labeled boxes (not just the cards, as
  // zoomToFit would), so the quadrant labels are on screen right after arranging.
  const bounds = editor.getCurrentPageBounds() ?? new Box(0, 0, 0, 0);
  const withFrames = frames.reduce((acc, f) => acc.union(new Box(f.x, f.y, f.w, Math.max(f.h, 1))), Box.From(bounds));
  editor.zoomToBounds(withFrames, { animation: { duration: 200 } });
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

/**
 * Mark/unmark every selected idea card done (#167) — the manual counterpart to
 * the MCP `mark_idea_done` tool, wired to the context menu for a single card or a
 * bulk selection. Toggles as a group like {@link markSelected}: if every selected
 * card is already done, this reopens them all; otherwise it marks them all done.
 * No-op when no idea card is selected.
 */
export function markSelectedDone(editor: Editor): void {
  const sel = editor.getSelectedShapes().filter((s): s is IdeaCardShape => s.type === "idea-card");
  if (sel.length === 0) return;
  const allDone = sel.every((s) => (s.meta as IdeaCardMeta).done);
  editor.run(() =>
    editor.updateShapes(
      sel.map((s) => ({
        id: s.id,
        type: "idea-card" as const,
        meta: { ...s.meta, done: !allDone }
      }))
    )
  );
}
