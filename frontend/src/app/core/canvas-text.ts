/**
 * Pure idea-card → markdown serialization (PRD §3.2 / §3.6).
 *
 * The tldraw canvas stores each idea as an `idea-card` shape carrying just
 * `{ kind, title, body }` (no nested block tree — unlike the old BlockSuite
 * note). Turning a card back into text is therefore a trivial, framework-free
 * function: a decorated `###` heading (the kind badge + title, via the shared
 * registry) followed by the body. Kept BlockSuite/tldraw-import-free so it runs
 * in the plain Node vitest env, exactly like {@link ./idea-descriptors}.
 *
 * Used by `CanvasService.serializeToText` / `getSelectedText` (which read the
 * card props off the live tldraw editor) and by the card-verb bar (#13/#15,
 * which serializes a single selected card before framing the prompt).
 */
import { decorateTitle } from './idea-descriptors';

/** The minimal idea-card content a serializer needs — the shape's text props. */
export interface CardContent {
  kind: string;
  title: string;
  body: string;
}

/**
 * Serialize one card to a markdown block: a level-3 heading (the title decorated
 * with its kind badge, e.g. `### ⚠ Risk: Token leak`) and, when present, the
 * body on the following lines. A blank body yields the heading alone.
 */
export function cardToText(card: CardContent): string {
  const heading = `### ${decorateTitle(card.title, card.kind)}`;
  const body = card.body?.trim();
  return body ? `${heading}\n\n${body}` : heading;
}

/**
 * Serialize a list of cards into one normalized markdown document — each card a
 * heading+body block, separated by a blank line. Empty input yields `''`.
 */
export function serializeCards(cards: readonly CardContent[]): string {
  return cards.map(cardToText).join('\n\n').trim();
}
