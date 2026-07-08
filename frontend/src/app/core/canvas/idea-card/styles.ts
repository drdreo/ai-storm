/**
 * Shared visual constants and inline-style builders for the idea card — the card
 * ink, the mark hues, the pill/chip style, and the in-edit field reset. Named
 * here (rather than inlined) so the intent is explicit and the values live in one
 * place, shared by the card body and the chip components.
 */

/**
 * Card ink (#77 audit M4). Deliberately card-LOCAL near-black / near-white, NOT
 * the app `--foreground`: the text sits on the card's colored `semi` tint (a
 * sticky-note), so it tracks tldraw's light/dark card surface, not the app
 * chrome behind the canvas. Named here rather than inlined so the intent is
 * explicit and the values live in one place.
 */
export const CARD_INK_LIGHT = "#1c1c1c";
export const CARD_INK_DARK = "#e8e8e8";
/** The gold of the "kept for later" star mark (#29). */
export const STAR_GOLD = "#f5b301";
/** The green of the "done / complete" mark (#167) — a finished, not discarded, card. */
export const DONE_GREEN = "#3fa45b";
/** Warning amber for a low-confidence triage score's chip (#100). */
export const LOW_CONFIDENCE_AMBER = "#e0a712";
/** GitHub's issue-state hues — the linked-issue chip's status dot (#125). */
export const ISSUE_OPEN_GREEN = "#1a7f37";
export const ISSUE_CLOSED_PURPLE = "#8250df";

/**
 * One triage score chip (#100) — a small pill in the card's bottom stat strip,
 * tinted from the card's accent so it stays legible on every card color in both
 * themes. `color-mix` keeps the fill/outline derived from a single accent —
 * normally the card's own, but the confidence chip passes
 * {@link LOW_CONFIDENCE_AMBER} instead when the score is shaky (#100), so a low
 * rating reads as a warning rather than just another same-colored stat.
 */
export const scoreChip = (accent: string): React.CSSProperties => ({
  padding: "1px 7px",
  borderRadius: 999,
  lineHeight: 1.5,
  color: accent,
  background: `color-mix(in srgb, ${accent} 16%, transparent)`,
  border: `1px solid color-mix(in srgb, ${accent} 40%, transparent)`
});

/**
 * Shared style for the in-edit title/body fields (#72): a borderless, transparent
 * textarea that sits exactly where the read-only text was, so entering edit mode
 * doesn't shift the card's layout. Font/size/color are applied per-field.
 */
export const EDIT_FIELD: React.CSSProperties = {
  width: "100%",
  border: "none",
  outline: "none",
  background: "transparent",
  padding: 0,
  margin: 0,
  resize: "none",
  fontFamily: "inherit",
  overflow: "hidden"
};
