/**
 * Prompt framing for the bidirectional canvas seam (#13).
 *
 * Pure, framework-agnostic templates that turn a flattened canvas selection into
 * an EDITABLE terminal prompt. The framed string is typed into the live PTY with
 * NO trailing newline, so the cursor lands at the end ready for the user to keep
 * typing or edit before they hit Enter to submit — the interactive seam #14/#15
 * build verbs on top of.
 *
 * Kept dependency-free (no Angular / BlockSuite) so it is unit-testable in the
 * plain Node vitest env.
 */

/**
 * The intent behind feeding a selection into the prompt — one per card verb
 * (#13 `discuss`; #15 `expand` / `challenge` / `find-risks`). Adding a verb is:
 * widen this union, add a matching {@link PROMPT_TEMPLATES} entry, and add a row
 * to `CARD_VERBS` in `discuss-toolbar.ts` (the menu item that carries it).
 */
export type PromptIntent = 'discuss' | 'expand' | 'challenge' | 'find-risks';

/**
 * Frames a (trimmed, non-empty) selection into an editable prompt per intent.
 *
 * Invariant: every template ends with a TRAILING SPACE and NO trailing newline,
 * so the cursor lands ready for the user to type and nothing is auto-submitted.
 * Each verb scaffolds the AI move (#15) but leaves the final clause open, so the
 * user steers it before submitting — the whole point of the editable seam.
 */
export const PROMPT_TEMPLATES: Record<PromptIntent, (selection: string) => string> = {
  discuss: (selection) =>
    `Regarding these notes from the canvas:\n\n${selection}\n\nLet's discuss: `,
  expand: (selection) =>
    `Expand on this idea from the canvas — flesh it out with detail, concrete examples, and next steps:\n\n${selection}\n\nMy angle: `,
  challenge: (selection) =>
    `Play devil's advocate on this idea from the canvas — give the strongest counter-arguments and where it breaks down:\n\n${selection}\n\nPush hardest on: `,
  'find-risks': (selection) =>
    `Find the risks, failure modes, and hidden assumptions in this idea from the canvas:\n\n${selection}\n\nI'm most worried about: `,
};

/**
 * Frame a canvas selection into an editable terminal prompt.
 *
 * Returns `''` for an empty/whitespace-only selection (nothing to discuss);
 * otherwise applies the {@link PromptIntent}'s template to the trimmed selection.
 * The result intentionally has a trailing space and no trailing newline.
 */
export function framePrompt(selection: string, intent: PromptIntent = 'discuss'): string {
  const trimmed = selection.trim();
  if (!trimmed) return '';
  return PROMPT_TEMPLATES[intent](trimmed);
}
