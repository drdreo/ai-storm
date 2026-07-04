/**
 * `applyIdeas` — the tldraw port of `CanvasService.applyIdeas`: render a batch of
 * extracted {@link Idea}s as AI-origin cards + typed edges. The one write-path the
 * ingestion pipeline drives; everything else on the canvas is user-or-agent action.
 */
import { createShapeId, type Editor, type TLDefaultColorStyle, type TLShapeId } from "tldraw";
import type { Idea, IdeaRelation } from "@ai-storm/shared";
import { normalizeKind, kindColor } from "../idea-descriptors";
import { CARD_W, CARD_H, ideaCards, maxRefIndex, resolveRef, type IdeaCardShape } from "./idea-card";

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
 * Render a batch of extracted {@link Idea}s as cards + typed edges — the tldraw
 * port of `CanvasService.applyIdeas`. Each idea becomes an AI-origin `idea-card`
 * colored by its kind (a shared StyleProp); the first link whose target ref
 * already exists places the card near its target and draws a relation-styled
 * arrow; a `supersedes` link ghosts the target (#20, PD-012). Refs (`a1`, `a2`,
 * …) live in `shape.meta.ref` so identity survives reload (idea-graph §4).
 */
export function applyIdeas(editor: Editor, ideas: Idea[]): void {
  if (ideas.length === 0) return;
  const refToShape = new Map<string, TLShapeId>();
  const childOffset = new Map<TLShapeId, number>();
  const toGhost = new Set<TLShapeId>();
  // Seed the ref counter from the persisted shapes (not an in-memory count) so
  // minted refs never collide across sessions (idea-graph §4).
  let nextRef = maxRefIndex(editor) + 1;
  let gridIndex = ideaCards(editor).length;
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

      let x: number;
      let y: number;
      if (targetId) {
        const target = editor.getShape(targetId) as IdeaCardShape | undefined;
        const n = childOffset.get(targetId) ?? 0;
        childOffset.set(targetId, n + 1);
        x = (target?.x ?? 0) + (target?.props.w ?? CARD_W) + 90;
        y = (target?.y ?? 0) + n * 165;
      } else {
        const col = gridIndex % 3;
        const row = Math.floor(gridIndex / 3);
        gridIndex += 1;
        x = 120 + col * 320;
        y = 140 + row * 200;
      }

      const kind = normalizeKind(idea.kind) ?? "";
      // Honour a producer-stamped ref (mcp-idea-capture §3.3): the backend MCP
      // tool path mints `i<n>` and already returned it to the agent, so the
      // card MUST carry it for follow-up links/scores to resolve. The `i<n>`
      // namespace is disjoint from our `a<n>` mint (see core/canvas/refs.ts),
      // so honouring it can never collide with — or advance — `nextRef`.
      const ref = idea.id ?? `a${nextRef++}`;
      const id = createShapeId();
      editor.createShape<IdeaCardShape>({
        id,
        type: "idea-card",
        x,
        y,
        meta: { ref, createdAt },
        props: {
          w: CARD_W,
          h: CARD_H,
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
