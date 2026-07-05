/**
 * Focus mode (#131): narrows the visible board to the connected cluster around
 * the current selection, reusing the same union-find grouping Arrange → Mind
 * map uses ({@link clusterIds} in `../idea-layout`) so focusing reads as "zoom
 * into this cluster." The chrome-hiding / fullscreen side lives in `ui.store`
 * and `App`/`CanvasPane`; this module only decides which cards stay visible.
 */
import type { Editor, TLShapeId } from "tldraw";
import { clusterIds } from "../idea-layout";
import { ideaCards } from "./idea-card";
import { ideaEdges } from "./edges";

/**
 * Cards to keep visible while focused on `selectedIds` — their connected
 * cluster(s). An empty selection has nothing to focus on, so this returns
 * `null`: the caller's cue to show the whole board rather than blanking it.
 */
export function focusedCardIds(editor: Editor, selectedIds: ReadonlySet<TLShapeId>): Set<TLShapeId> | null {
  if (selectedIds.size === 0) return null;
  const ids = ideaCards(editor).map((c) => c.id);
  const edges = ideaEdges(editor, new Set(ids));
  const ids_ = clusterIds(ids, edges, selectedIds);
  return ids_.size > 0 ? ids_ : null;
}
