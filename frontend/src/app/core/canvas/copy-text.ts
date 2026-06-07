/**
 * Copy-as-text (#74 follow-up) — make Copy/Cut on idea cards put their **text** on
 * the clipboard, not tldraw's shape payload. Native tldraw copy writes two things:
 * a `text/html` blob holding the (base64-compressed) shape content for pasting back
 * into a canvas, and a `text/plain` fallback joined from each shape's `getText()`.
 * Our card has no `getText`, so `text/plain` was empty and consumers fell back to
 * the base64 blob — exactly the "it copies as base64" the user hit.
 *
 * The fix uses tldraw's own seam: `options.onBeforeCopyToClipboard` (the
 * clipboard-events example) runs on the SHARED copy path — Ctrl/Cmd+C *and* the
 * menu item both route through `handleNativeOrMenuCopy`. For a pure idea-card
 * selection we write the normalized markdown ourselves and return `false`, which
 * blocks tldraw's shape-blob write entirely (so no stray base64 lands on the
 * clipboard). Any other selection returns `undefined` → tldraw copies as normal,
 * so a mixed selection's other shapes aren't lost.
 */
import type { Editor, TldrawOptions } from 'tldraw';
import { serializeCards } from '../canvas-text';
import { content, type IdeaCardShape } from './idea-card';

/**
 * The markdown for the current selection when we should own Copy — i.e. it's
 * *exactly* idea cards, no other shapes. Returns null otherwise (defer to tldraw).
 */
function selectedCardsText(editor: Editor): string | null {
  const selected = editor.getSelectedShapes();
  const cards = selected.filter((s): s is IdeaCardShape => s.type === 'idea-card');
  // Pure-card selection only — else tldraw's copy must run so the other shapes
  // still make it onto the clipboard.
  if (cards.length === 0 || cards.length !== selected.length) return null;
  const text = serializeCards(cards.map(content));
  return text.trim() ? text : null;
}

/**
 * The `<Tldraw options>` slice this module owns. `onBeforeCopyToClipboard` fires
 * for both the keyboard shortcut and the menu action; returning `false` suppresses
 * tldraw's own clipboard write after we've put the text there ourselves. For a cut
 * we also delete the cards — returning `false` short-circuits tldraw before its own
 * cut-delete, so we own that half too.
 */
export const copyTextOptions: Partial<TldrawOptions> = {
  async onBeforeCopyToClipboard({ editor, operation }) {
    const text = selectedCardsText(editor);
    if (text === null) return; // not a pure-card selection → let tldraw copy
    await navigator.clipboard?.writeText(text);
    if (operation === 'cut') editor.deleteShapes(editor.getSelectedShapeIds());
    return false;
  },
};
