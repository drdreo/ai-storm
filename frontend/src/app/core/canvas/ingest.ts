/**
 * `applyIdeas` - render extracted {@link Idea}s as AI-origin cards + typed edges.
 * This is the ingestion pipeline's one canvas write path; every other canvas
 * mutation is user- or agent-initiated.
 */
import { createShapeId, type Editor, type TLDefaultColorStyle, type TLShapeId } from "tldraw";
import type { Idea, IdeaRelation } from "@ai-storm/shared";
import { normalizeKind, kindColor } from "../idea-descriptors";
import {
  CARD_MAX_H,
  CARD_MAX_W,
  CARD_W,
  ideaCardSizeForContent,
  ideaCards,
  maxRefIndex,
  resolveRef,
  type IdeaCardShape
} from "./idea-card";

const GRID_COL_W = CARD_MAX_W + 70;
const GRID_ROW_H = CARD_MAX_H + 70;
const LINKED_CHILD_GAP = 48;

/** Draw a native arrow bound to both cards and tag it with its relation. */
function connect(editor: Editor, fromId: TLShapeId, toId: TLShapeId, relation: IdeaRelation): void {
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

/**
 * Render a batch of extracted {@link Idea}s as cards + typed edges. Each idea
 * becomes an AI-origin `idea-card`; refs live in `shape.meta.ref` so identity
 * survives reload.
 */
export function applyIdeas(editor: Editor, ideas: Idea[]): void {
  if (ideas.length === 0) return;
  const refToShape = new Map<string, TLShapeId>();
  const childOffset = new Map<TLShapeId, number>();
  const toGhost = new Set<TLShapeId>();
  let nextRef = maxRefIndex(editor) + 1;
  let gridIndex = ideaCards(editor).length;
  const createdAt = Date.now();

  editor.run(() => {
    for (const idea of ideas) {
      const links = (idea.links ?? [])
        .map((l) => ({ link: l, id: refToShape.get(l.to) ?? resolveRef(editor, l.to) }))
        .filter((r): r is { link: typeof r.link; id: TLShapeId } => !!r.id);
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
        const col = gridIndex % 3;
        const row = Math.floor(gridIndex / 3);
        gridIndex += 1;
        x = 120 + col * GRID_COL_W;
        y = 140 + row * GRID_ROW_H;
      }

      // Honour a producer-stamped ref (mcp-idea-capture Â§3.3): the backend MCP
      // tool path mints `i<n>` and already returned it to the agent, so the
      // card MUST carry it for follow-up links/scores to resolve. The `i<n>`
      // namespace is disjoint from our `a<n>` mint (see core/canvas/refs.ts),
      // so honouring it never advances `nextRef` - but a restarted backend can
      // re-issue an `i<n>` that is already on the board (#210). Honouring the
      // duplicate would make the ref ambiguous, so remint a fresh canvas ref.
      let ref = idea.id ?? `a${nextRef++}`;
      if (idea.id && (refToShape.has(idea.id) || resolveRef(editor, idea.id))) {
        ref = `a${nextRef++}`;
        console.warn(
          `[ai-storm] capture ref collision: backend-stamped @${idea.id} already exists on the board; ` +
            `reminted incoming card "${idea.title}" as @${ref} (#210)`
        );
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
          origin: "ai",
          superseded: false,
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
