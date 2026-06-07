/**
 * The typed edge graph behind the cards. Shared by both board reading
 * ({@link ../canvas/serialize}'s `collectBoard`) and the layouts
 * ({@link ../canvas/layout}'s `arrangeMindMap`), so it lives on its own.
 */
import type { Editor, TLShapeId } from 'tldraw';
import type { LayoutEdge, LayoutRelation } from '../idea-layout';

/**
 * The typed graph behind the cards: one {@link LayoutEdge} per bound arrow whose
 * endpoints are both idea cards. `connect()` always binds `start` to the source
 * card and `end` to the target, so the binding terminals recover the edge's
 * direction; the relation rides in the arrow's `meta`. Arrows with a missing or
 * non-card endpoint (mid-drag, or a user's plain arrow) are skipped.
 */
export function ideaEdges(editor: Editor, cardIds: ReadonlySet<TLShapeId>): LayoutEdge[] {
  const edges: LayoutEdge[] = [];
  for (const shape of editor.getCurrentPageShapes()) {
    if (shape.type !== 'arrow') continue;
    let from: TLShapeId | undefined;
    let to: TLShapeId | undefined;
    for (const b of editor.getBindingsFromShape(shape, 'arrow')) {
      const terminal = (b.props as { terminal?: 'start' | 'end' }).terminal;
      if (terminal === 'start') from = b.toId;
      else if (terminal === 'end') to = b.toId;
    }
    if (!from || !to || !cardIds.has(from) || !cardIds.has(to)) continue;
    const relation: LayoutRelation =
      (shape.meta as { relation?: string }).relation === 'supersedes' ? 'supersedes' : 'about';
    edges.push({ from, to, relation });
  }
  return edges;
}
