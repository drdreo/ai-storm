/**
 * Copy-as-text (#74 follow-up) — make Copy/Cut on idea cards put their **text** on
 * the clipboard, not tldraw's shape payload. tldraw's native copy serializes the
 * selected shapes (a base64-ish blob meant for pasting back into a canvas), which
 * is useless when you want to paste an idea into a doc, chat, or the terminal. So
 * when the selection is *purely* idea cards we override Copy/Cut to write the same
 * normalized markdown {@link serializeCards} produces everywhere else; a mixed or
 * non-card selection falls through to tldraw's default (we don't want to drop the
 * other shapes). Bound via {@link TLUiOverrides.actions}, so it covers both the
 * Ctrl/Cmd+C shortcut and the context-menu item with one hook.
 */
import type { Editor, TLUiOverrides } from 'tldraw';
import { serializeCards } from '../canvas-text';
import { content, type IdeaCardShape } from './idea-card';

/**
 * The selected shapes split into idea cards and everything else. When `others` is
 * empty and `cards` is non-empty, the selection is "purely cards" and we own Copy.
 */
function partitionSelection(editor: Editor): { cards: IdeaCardShape[]; others: number } {
  const selected = editor.getSelectedShapes();
  const cards = selected.filter((s): s is IdeaCardShape => s.type === 'idea-card');
  return { cards, others: selected.length - cards.length };
}

/** Write the selected cards' markdown to the clipboard. Returns false if it can't. */
function copyCardsAsText(editor: Editor): boolean {
  const { cards, others } = partitionSelection(editor);
  // Only take over when the selection is exactly cards — otherwise let tldraw
  // copy normally so a mixed selection's other shapes aren't silently lost.
  if (cards.length === 0 || others > 0) return false;
  const text = serializeCards(cards.map(content));
  if (!text.trim()) return false;
  void navigator.clipboard?.writeText(text);
  return true;
}

/**
 * Override Copy and Cut so a pure idea-card selection lands on the clipboard as
 * text. We keep the original action and only short-circuit when we handled it,
 * delegating to tldraw otherwise (mixed selections, nothing selected, etc.). Cut
 * additionally deletes the cards after copying, matching native cut semantics.
 */
export const copyTextOverrides: TLUiOverrides = {
  actions(editor, actions) {
    const copy = actions.copy;
    const cut = actions.cut;
    return {
      ...actions,
      copy: {
        ...copy,
        onSelect(source) {
          if (copyCardsAsText(editor)) return;
          return copy.onSelect(source);
        },
      },
      cut: {
        ...cut,
        onSelect(source) {
          if (copyCardsAsText(editor)) {
            editor.deleteShapes(editor.getSelectedShapeIds());
            return;
          }
          return cut.onSelect(source);
        },
      },
    };
  },
};
