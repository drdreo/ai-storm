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
    `Challenge this idea from the canvas — stress-test it for the strongest objections, then give me a refined, stronger version that addresses them and supersedes the original:\n\n${selection}\n\nPush hardest on: `,
  'find-risks': (selection) =>
    `Find the risks, failure modes, and hidden assumptions in this idea from the canvas:\n\n${selection}\n\nI'm most worried about: `,
};

/**
 * Frame a canvas selection into an editable terminal prompt.
 *
 * Returns `''` for an empty/whitespace-only selection (nothing to discuss);
 * otherwise applies the {@link PromptIntent}'s template to the trimmed selection.
 * The result intentionally has a trailing space and no trailing newline.
 *
 * When `sourceRef` is given (the short ref of the card the verb fired from,
 * idea-graph design §4/§5), a tagging directive is PREPENDED so the ideas this
 * turn produces come back linked to that card — without disturbing the
 * trailing-space editable seam (the cursor stays at the very end).
 */
export function framePrompt(
  selection: string,
  intent: PromptIntent = 'discuss',
  sourceRef?: string,
): string {
  const trimmed = selection.trim();
  if (!trimmed) return '';
  const body = PROMPT_TEMPLATES[intent](trimmed);
  return sourceRef ? `${refDirective(sourceRef, intent)}\n\n${body}` : body;
}

/**
 * A directive (idea-graph design §5) telling the agent how to link the ideas
 * this turn produces back to the source card, so the backend parses the link
 * and the canvas draws a connector. Prepended (never appended) so the verb's
 * open clause and the cursor stay at the very end.
 *
 * The relation depends on the verb (PD-012): {@link supersedeDirective} for
 * `challenge` (the refined idea *replaces* the source — a `supersedes` edge,
 * expressible only via the fenced form since a single-line `@ref` always
 * resolves to `about`); {@link aboutDirective} for every other verb (the idea
 * is simply *about* the source).
 */
function refDirective(sourceRef: string, intent: PromptIntent): string {
  return intent === 'challenge' ? supersedeDirective(sourceRef) : aboutDirective(sourceRef);
}

/**
 * Tag-each-«IDEA»-line directive for the generic `about` link (#42): the backend
 * parses `«IDEA@<ref>»` into `{ to, relation: 'about' }` and the canvas connects
 * the new card to its source.
 */
function aboutDirective(sourceRef: string): string {
  return `(When you capture ideas from this, tag each «IDEA» line with @${sourceRef} so they link back to this card on the canvas.)`;
}

/**
 * Challenge-as-supersede directive (PD-012): instruct the agent to capture its
 * refined, stronger version as a *superseding* idea. The relation rides on the
 * single-line marker via a trailing `!` after the ref (`@a1!`,
 * extraction-contract §3.2) — NOT the fenced `rel:` form, whose code fence the
 * agent's TUI renders away before the backend captures the screen (PD-008), so
 * it never reaches the parser. Once it lands, the original card recedes to a
 * grey ghost while the refined one takes its place — history kept.
 *
 * Crucially this references `«IDEA»` and the ref **inline**, never as a
 * fully-formed line-leading marker: the directive is echoed onto the terminal,
 * and the backend scans every screen line for markers, so a literal
 * `«IDEA@ref!» … :: …` example here would itself be extracted as a bogus card.
 * Mirrors {@link aboutDirective}'s proven phrasing.
 */
function supersedeDirective(sourceRef: string): string {
  return (
    `(This challenges the card @${sourceRef}. When you capture your refined, stronger version, ` +
    `tag its «IDEA» line @${sourceRef}! — keep the trailing ! right after the ref — so the canvas ` +
    `treats it as REPLACING the original rather than just relating to it.)`
  );
}
