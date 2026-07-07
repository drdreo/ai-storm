/**
 * Board ↔ {@link PortableBoard} bridge (#105) — the editor-facing read/write side
 * of project export/import. Cards are keyed by their stable short ref (not the
 * tldraw shape id, which is regenerated on import), so a round trip survives
 * moving to a fresh canvas. Mirrors `ingest.ts`'s `applyIdeas` layout/connector
 * logic, but (unlike `applyIdeas`) preserves origin/superseded/starred instead of
 * always stamping AI provenance.
 */
import { createShapeId, type Editor, type TLContent, type TLDefaultColorStyle, type TLShapeId } from "tldraw";
import { normalizeKind, kindColor } from "../idea-descriptors";
import type { PortableBoard } from "../project-portable";
import {
  CARD_MAX_W,
  cardRef,
  ideaCardSizeForContent,
  ideaCards,
  type IdeaCardMeta,
  type IdeaCardShape
} from "./idea-card";
import { ideaEdges } from "./edges";

const GRID_X = 120;
const GRID_Y = 140;
const GRID_COLS = 3;
const GRID_COL_W = CARD_MAX_W + 70;
const GRID_ROW_GAP = 70;

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

/**
 * Full-fidelity tldraw snapshot of the page — every shape (not just idea
 * cards), positions, arrows, and embedded assets. Exported alongside the
 * portable board so an import can restore the canvas exactly; the ref-keyed
 * board remains the stable, validated fallback. `TLContent` carries its own
 * serialized schema, so tldraw migrates old snapshots on import.
 */
export async function exportTldrawContent(editor: Editor): Promise<TLContent | undefined> {
  const ids = Array.from(editor.getCurrentPageShapeIds());
  if (ids.length === 0) return undefined;
  const content = editor.getContentFromCurrentPage(ids);
  return editor.resolveAssetsInContent(content);
}

/** Restore a full-fidelity snapshot onto the (normally empty) live canvas. */
export function importTldrawContent(editor: Editor, content: TLContent): void {
  editor.putContentOntoCurrentPage(content, { preservePosition: true, select: false });
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
    const gridColY = Array.from({ length: GRID_COLS }, () => GRID_Y);
    board.cards.forEach((card) => {
      const id = createShapeId();
      const col = gridColY.indexOf(Math.min(...gridColY));
      const size = ideaCardSizeForContent(card);
      editor.createShape<IdeaCardShape>({
        id,
        type: "idea-card",
        x: GRID_X + col * GRID_COL_W,
        y: gridColY[col],
        meta: { ref: card.ref, starred: card.starred } satisfies IdeaCardMeta,
        props: {
          w: size.w,
          h: size.h,
          kind: card.kind,
          title: card.title,
          body: card.body,
          origin: card.origin,
          superseded: card.superseded,
          color: (kindColor(normalizeKind(card.kind)) as TLDefaultColorStyle) ?? "blue"
        }
      });
      gridColY[col] += size.h + GRID_ROW_GAP;
      refToShape.set(card.ref, id);
    });

    for (const edge of board.edges) {
      const fromId = refToShape.get(edge.from);
      const toId = refToShape.get(edge.to);
      if (fromId && toId) connect(editor, fromId, toId, edge.relation);
    }
  });
}
