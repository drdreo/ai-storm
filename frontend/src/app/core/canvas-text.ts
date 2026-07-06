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
import { decorateTitle } from "./idea-descriptors";

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
  return cards.map(cardToText).join("\n\n").trim();
}

/** An idea-card with the lifecycle flags the hand-off serializer reads (#89). */
export interface HandoffCard extends CardContent {
  /** Keep-mark (#59): the user flagged this one as worth keeping. */
  starred: boolean;
  /** Lifecycle (#20/PD-012): replaced by a refined card via a `supersedes` edge. */
  superseded: boolean;
  /**
   * Stable short ref (idea-graph §4), set only when the hand-off needs the
   * agent to name source cards back (#125, the create-issues back-link): the
   * heading then carries a trailing ` [@ref]` tag the framing explains.
   */
  ref?: string;
}

/**
 * Serialize a board into the spec/PRD hand-off input (#89, PD-015) — the text fed
 * to the downstream agent so it can generate a spec. Like {@link serializeCards}
 * but lifecycle-aware: superseded ghosts are dropped (they lost an argument and
 * should not shape the spec — issue #89), and keep-marked cards (#59) are flagged
 * with a leading ★ so the agent foregrounds the user's priorities. Empty input —
 * or input that is all ghosts — yields `''`.
 */
export function handoffCardsToText(cards: readonly HandoffCard[]): string {
  return cards
    .filter((card) => !card.superseded)
    .map((card) => {
      let text = card.starred ? cardToText(card).replace(/^### /, "### ★ ") : cardToText(card);
      if (card.ref) {
        // Tag the heading line with the card's ref (#125) so the agent can name
        // its source cards in the created-issues summary.
        const [heading, ...rest] = text.split("\n");
        text = [`${heading} [@${card.ref}]`, ...rest].join("\n");
      }
      return text;
    })
    .join("\n\n")
    .trim();
}
