/**
 * `applyIdeas` — the tldraw port of `CanvasService.applyIdeas`: render a batch of
 * extracted {@link CreateIdeaInput}s as AI-origin cards + typed edges. The one write-path the
 * ingestion pipeline drives; everything else on the canvas is user-or-agent action.
 */
import { createShapeId, type Editor, type TLDefaultColorStyle, type TLShapeId } from "tldraw";
import type { CreateIdeaInput, IdeaRelation } from "@ai-storm/shared";
import { normalizeKind, kindColor } from "../idea-descriptors";
import { CARD_MAX_W, CARD_W, ideaCardSizeForContent, ideaCards, resolveRef, type IdeaCardShape } from "./idea-card";

const GRID_X = 120;
const GRID_Y = 140;
const GRID_COLS = 3;
const GRID_COL_W = CARD_MAX_W + 70;
const GRID_ROW_GAP = 70;
const LINKED_CHILD_GAP = 48;

/**
 * Draw a native arrow bound to both cards and tag it with its relation. The
 * binding makes tldraw track the endpoints as cards move (the connector
 * behaviour BlockSuite needed a spike for — here it is built in). `relation`
 * lives in the arrow `meta` (the typed-edge payload) and styles the arrow:
 * `supersedes` is red + dashed, `about` is a plain grey link.
 */
function connect(editor: Editor, fromId: TLShapeId, toId: TLShapeId, relation: IdeaRelation): void {
  const arrowId = createShapeId();
  editor.createShape({
    id: arrowId,
    type: "arrow",
    meta: { relation },
    props: {
      color: relation === "supersedes" ? "red" : "grey",
      dash: relation === "supersedes" ? "dashed" : "solid",
      // Placeholder endpoints; the bindings below drive the real geometry.
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

/**
 * Render a batch of extracted {@link CreateIdeaInput}s as cards + typed edges — the tldraw
 * port of `CanvasService.applyIdeas`. Each idea becomes an AI-origin `idea-card`
 * colored by its kind (a shared StyleProp); the first link whose target ref
 * already exists places the card near its target and draws a relation-styled
 * arrow; a `supersedes` link ghosts the target (#20, PD-012). Backend-reserved
 * refs (`i1`, `i2`, …) live in `shape.meta.ref` so identity survives reload.
 */
export function applyIdeas(editor: Editor, ideas: CreateIdeaInput[]): void {
  if (ideas.length === 0) return;
  const refToShape = new Map<string, TLShapeId>();
  const childOffset = new Map<TLShapeId, number>();
  const toGhost = new Set<TLShapeId>();
  const cards = ideaCards(editor);
  const gridColY = Array.from({ length: GRID_COLS }, () => GRID_Y);
  for (const card of cards) {
    const col = Math.max(0, Math.min(GRID_COLS - 1, Math.round((card.x - GRID_X) / GRID_COL_W)));
    gridColY[col] = Math.max(gridColY[col], card.y + card.props.h + GRID_ROW_GAP);
  }
  // One timestamp for the whole batch — its cards are born together (#124).
  const createdAt = Date.now();

  editor.run(() => {
    for (const idea of ideas) {
      // Resolve every link whose target ref already has a card (graceful
      // degradation: an unresolved link is dropped; an idea with none lands on
      // the grid). A merge (#62) carries several supersede links at once, so we
      // connect them all — not just the first.
      const links = (idea.links ?? [])
        .map((l) => ({ link: l, id: refToShape.get(l.to) ?? resolveRef(editor, l.to) }))
        .filter((r): r is { link: typeof r.link; id: TLShapeId } => !!r.id);
      // The first resolved link anchors layout; the rest still get connectors.
      const targetId = links[0]?.id;
      const kind = normalizeKind(idea.kind) ?? "";
      const size = ideaCardSizeForContent({ kind, title: idea.title, body: idea.body, origin: "ai" });

      let x: number;
      let y: number;
      if (targetId) {
        const target = editor.getShape(targetId) as IdeaCardShape | undefined;
        const yOffset = childOffset.get(targetId) ?? 0;
        childOffset.set(targetId, yOffset + size.h + LINKED_CHILD_GAP);
        x = (target?.x ?? 0) + (target?.props.w ?? CARD_W) + 90;
        y = (target?.y ?? 0) + yOffset;
      } else {
        const col = gridColY.indexOf(Math.min(...gridColY));
        x = GRID_X + col * GRID_COL_W;
        y = gridColY[col];
        gridColY[col] += size.h + GRID_ROW_GAP;
      }

      // Honour the backend-reserved project-global ref. A duplicate would make
      // addressing ambiguous, so never remint in the browser: the backend
      // allocator is the sole authority.
      const ref = idea.ref;
      if (!ref) {
        console.error(`[ai-storm] refused to create "${idea.title}" without a backend-reserved ref`);
        continue;
      }
      if (refToShape.has(ref) || resolveRef(editor, ref)) {
        console.error(`[ai-storm] refused duplicate backend ref @${ref} for "${idea.title}"`);
        continue;
      }
      const id = createShapeId();
      editor.createShape<IdeaCardShape>({
        id,
        type: "idea-card",
        x,
        y,
        meta: { ref, createdAt },
        props: {
          w: size.w,
          h: size.h,
          kind,
          title: idea.title,
          body: idea.body,
          origin: "ai", // applyIdeas is the AI producer (#31, PD-009)
          superseded: false,
          // Kind sets the default tint (#21); a kindless AI card defaults to blue.
          color: (kindColor(kind) as TLDefaultColorStyle) ?? "blue"
        }
      });
      refToShape.set(ref, id);

      for (const { link, id: tId } of links) {
        const relation = link.relation ?? "about";
        connect(editor, id, tId, relation);
        if (relation === "supersedes") toGhost.add(tId);
      }
    }

    for (const id of toGhost) {
      editor.updateShape<IdeaCardShape>({ id, type: "idea-card", props: { superseded: true } });
    }
  });
}
