/**
 * Board ↔ {@link PortableBoard} bridge (#105) — the editor-facing read/write side
 * of workspace export/import. Cards are keyed by their stable short ref (not the
 * tldraw shape id, which is regenerated on import), so a round trip survives
 * moving to a fresh canvas. Mirrors `ingest.ts`'s `applyIdeas` layout/connector
 * logic, but (unlike `applyIdeas`) preserves origin/superseded/starred instead of
 * always stamping AI provenance.
 */
import { createShapeId, type Editor, type TLDefaultColorStyle, type TLShapeId } from "tldraw";
import { normalizeKind, kindColor } from "../idea-descriptors";
import type { PortableBoard } from "../workspace-portable";
import { CARD_W, CARD_H, cardRef, ideaCards, type IdeaCardMeta, type IdeaCardShape } from "./idea-card";
import { ideaEdges } from "./edges";

/** Snapshot the live board into its portable, ref-keyed JSON form for export. */
export function exportBoard(editor: Editor): PortableBoard {
  const cards = ideaCards(editor);
  const cardIds = new Set(cards.map((c) => c.id));
  const refByShape = new Map<TLShapeId, string>();
  for (const c of cards) refByShape.set(c.id, cardRef(editor, c.id)!);

  return {
    cards: cards.map((c) => ({
      ref: refByShape.get(c.id)!,
      kind: c.props.kind,
      title: c.props.title,
      body: c.props.body,
      origin: c.props.origin,
      superseded: c.props.superseded,
      starred: !!(c.meta as IdeaCardMeta).starred
    })),
    edges: ideaEdges(editor, cardIds)
      .map((e) => ({
        from: refByShape.get(e.from as TLShapeId),
        to: refByShape.get(e.to as TLShapeId),
        relation: e.relation
      }))
      .filter((e): e is PortableBoard["edges"][number] => !!e.from && !!e.to)
  };
}

/** Draw a native arrow connecting two ref-resolved cards, tagged with its relation. */
function connect(editor: Editor, fromId: TLShapeId, toId: TLShapeId, relation: "about" | "supersedes"): void {
  const arrowId = createShapeId();
  editor.createShape({
    id: arrowId,
    type: "arrow",
    meta: { relation },
    props: {
      color: relation === "supersedes" ? "red" : "grey",
      dash: relation === "supersedes" ? "dashed" : "solid",
      start: { x: 0, y: 0 },
      end: { x: 0, y: 0 }
    }
  });
  for (const [terminal, target] of [
    ["start", fromId],
    ["end", toId]
  ] as const) {
    editor.createBinding({
      type: "arrow",
      fromId: arrowId,
      toId: target,
      props: { terminal, normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false }
    });
  }
}

/** Render a previously-exported board onto the (normally empty) live canvas for import. */
export function importBoard(editor: Editor, board: PortableBoard): void {
  const refToShape = new Map<string, TLShapeId>();

  editor.run(() => {
    board.cards.forEach((card, i) => {
      const id = createShapeId();
      const col = i % 3;
      const row = Math.floor(i / 3);
      editor.createShape<IdeaCardShape>({
        id,
        type: "idea-card",
        x: 120 + col * 320,
        y: 140 + row * 200,
        meta: { ref: card.ref, starred: card.starred } satisfies IdeaCardMeta,
        props: {
          w: CARD_W,
          h: CARD_H,
          kind: card.kind,
          title: card.title,
          body: card.body,
          origin: card.origin,
          superseded: card.superseded,
          color: (kindColor(normalizeKind(card.kind)) as TLDefaultColorStyle) ?? "blue"
        }
      });
      refToShape.set(card.ref, id);
    });

    for (const edge of board.edges) {
      const fromId = refToShape.get(edge.from);
      const toId = refToShape.get(edge.to);
      if (fromId && toId) connect(editor, fromId, toId, edge.relation);
    }
  });
}
