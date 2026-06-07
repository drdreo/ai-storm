/**
 * Reading the live board out to text/data — the canvas's read-side ports: normalized
 * markdown (PRD §3.2), the selection hand-off (PRD §3.6), the {@link BoardSnapshot}
 * for synthesis/triage (#28/#60), and the ref-annotated triage serialization (#60).
 * No mutation here (except `cardRef`'s lazy ref mint); these just read the editor.
 */
import type { Editor } from 'tldraw';
import { serializeCards } from '../canvas-text';
import { isTriageableKind, normalizeKind } from '../idea-descriptors';
import type { BoardCard, BoardEdge, BoardSnapshot } from '../synthesis';
import {
  cardRef,
  cardsInOrder,
  content,
  type IdeaCardMeta,
  type IdeaCardShape,
} from './idea-card';
import { ideaEdges } from './edges';

/** Serialize every idea card to a normalized markdown document (PRD §3.2). */
export function serializeEditor(editor: Editor): string {
  return serializeCards(cardsInOrder(editor).map(content));
}

/**
 * Flatten the live board into a {@link BoardSnapshot} for synthesis (#28, PD-015)
 * and triage (#60): every idea card in reading order, plus the typed edge graph.
 * Cards are keyed by their tldraw shape id (the same identity `ideaEdges` reports
 * on its endpoints), so the pure `core/` consumers can cluster without knowing
 * anything about tldraw. Reads `starred` off `meta` (#59) and `superseded` off the
 * styled props (#20/PD-012).
 */
export function collectBoard(editor: Editor): BoardSnapshot {
  const cards = cardsInOrder(editor);
  const cardIds = new Set(cards.map((c) => c.id));
  const boardCards: BoardCard[] = cards.map((c) => ({
    id: c.id,
    kind: c.props.kind,
    title: c.props.title,
    body: c.props.body,
    starred: !!(c.meta as IdeaCardMeta).starred,
    superseded: c.props.superseded,
    origin: c.props.origin,
  }));
  const edges: BoardEdge[] = ideaEdges(editor, cardIds).map((e) => ({
    from: e.from as string,
    to: e.to as string,
    relation: e.relation,
  }));
  return { cards: boardCards, edges };
}

/**
 * Plain text of the current selection (PRD §3.6 agent hand-off): the selected
 * idea cards, or the whole canvas when nothing is selected.
 */
export function selectedText(editor: Editor): string {
  const selected = editor
    .getSelectedShapes()
    .filter((s): s is IdeaCardShape => s.type === 'idea-card');
  if (selected.length === 0) return serializeEditor(editor);
  return serializeCards(selected.map(content));
}

/**
 * Serialize the board for an AI triage pass (#60): one line per card, each LED by
 * its short ref so the agent can address it in a `«SCORE@ref»` reply. Mints a ref
 * for any card lacking one (via {@link cardRef}) so every card is addressable.
 * Deliberately ref-annotated (unlike {@link serializeEditor}, which is kind-badged
 * prose for context) — the ref is the whole point here. Empty board → `''`.
 */
export function serializeForTriage(editor: Editor): string {
  return cardsInOrder(editor)
    // Only rate actionable ideas (#60) — skip risks/questions (commentary).
    .filter((card) => isTriageableKind(card.props.kind))
    .map((card) => {
      const ref = cardRef(editor, card.id);
      const kind = normalizeKind(card.props.kind);
      const tag = kind ? ` [${kind}]` : '';
      const body = card.props.body?.trim();
      const desc = body ? ` — ${body}` : '';
      return `@${ref}${tag} ${card.props.title.trim()}${desc}`;
    })
    .join('\n');
}
