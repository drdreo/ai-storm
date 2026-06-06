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
 * The intent behind feeding a selection into the prompt. Extensible: #15 adds
 * further verbs (e.g. `expand`, `challenge`) by widening this union and adding a
 * matching entry to {@link PROMPT_TEMPLATES}.
 */
export type PromptIntent = 'discuss';

/**
 * Frames a (trimmed, non-empty) selection into an editable prompt per intent.
 *
 * Invariant: every template ends with a TRAILING SPACE and NO trailing newline,
 * so the cursor lands ready for the user to type and nothing is auto-submitted.
 */
export const PROMPT_TEMPLATES: Record<PromptIntent, (selection: string) => string> = {
  discuss: (selection) =>
    `Regarding these notes from the canvas:\n\n${selection}\n\nLet's discuss: `,
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
