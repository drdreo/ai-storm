/**
 * The idea-card identity/content helpers — the low-level query surface the wider
 * canvas builds on: enumerating cards (`ideaCards`, `allIdeaCards`), reading a
 * card's serializable content, stable reading order, and short-ref minting /
 * resolution (idea-graph §4). Pure functions over the live `Editor`; no React.
 */
import type { Editor, TLShapeId } from "tldraw";
import type { CardContent } from "../../canvas-text";
import { canvasRefIndex } from "../refs";
import type { IdeaCardMeta, IdeaCardShape } from "./schema";

/** Every idea-card shape on the editor's current page. */
export function ideaCards(editor: Editor): IdeaCardShape[] {
  return editor.getCurrentPageShapes().filter((s): s is IdeaCardShape => s.type === "idea-card");
}

/**
 * Every idea-card shape across ALL of the editor's pages (#124). Search must see
 * the whole project, not just the open page — this reads the store directly,
 * mirroring how the persisted-store gather path sees every page's records.
 */
export function allIdeaCards(editor: Editor): IdeaCardShape[] {
  return editor.store
    .allRecords()
    .filter((r): r is IdeaCardShape => r.typeName === "shape" && (r as IdeaCardShape).type === "idea-card");
}

/**
 * Highest `a<n>` ref index currently minted on the canvas (0 if none). Counts
 * ONLY canvas-minted `a<n>` refs: a backend-minted `i<n>` ref (the MCP tool
 * path, mcp-idea-capture §3.3) lives in a disjoint namespace and deliberately
 * contributes nothing — see {@link canvasRefIndex}.
 */
export function maxRefIndex(editor: Editor): number {
  let max = 0;
  for (const card of ideaCards(editor)) {
    max = Math.max(max, canvasRefIndex((card.meta as IdeaCardMeta).ref));
  }
  return max;
}

/** Read a card's content props for serialization. */
export function content(card: IdeaCardShape): CardContent {
  return { kind: card.props.kind, title: card.props.title, body: card.props.body };
}

/** Cards in stable reading order (top-to-bottom, then left-to-right). */
export function cardsInOrder(editor: Editor): IdeaCardShape[] {
  return ideaCards(editor).sort((a, b) => a.y - b.y || a.x - b.x);
}

/**
 * The stable backend-reserved short ref of a card (idea-graph §4). Cards are
 * assigned canonical `iN` refs before creation; a missing ref is a failed or
 * legacy record and is never repaired with a browser-local namespace.
 */
export function cardRef(editor: Editor, shapeId: TLShapeId): string | undefined {
  const shape = editor.getShape(shapeId);
  if (!shape || shape.type !== "idea-card") return undefined;
  return (shape.meta as IdeaCardMeta).ref;
}

/** Resolve a short ref back to its shape id (idea-graph §4), or undefined. */
export function resolveRef(editor: Editor, ref: string): TLShapeId | undefined {
  for (const card of ideaCards(editor)) {
    if ((card.meta as IdeaCardMeta).ref === ref) return card.id;
  }
  return undefined;
}
