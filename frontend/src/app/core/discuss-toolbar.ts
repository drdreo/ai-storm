import { ConfigExtension, type ExtensionType } from '@blocksuite/block-std';
import { AIStarIcon, type AdvancedMenuItem, type MenuItemGroup } from '@blocksuite/blocks';

/**
 * Structural view of the edgeless element-toolbar "More …" menu context that
 * this module actually uses. BlockSuite's concrete `ElementToolbarMoreMenuContext`
 * is neither re-exported from `@blocksuite/blocks` top-level nor reachable through
 * its package `exports` map, so we narrow to the members we need — the selected
 * note accessor (#13). The full context carries far more; this is the minimal
 * contract the caller relies on, kept `any`-free.
 */
export interface DiscussMenuContext {
  /** The selected `affine:note` model, or null for any other selection. */
  getNoteBlock(): { children: readonly { id: string }[] } | null;
}

/**
 * Bidirectional canvas (#13) — surface the "Discuss" verb on a selected idea
 * card itself, rather than on the canvas top toolbar. This adds an entry to the
 * edgeless element-toolbar's "More …" overflow menu (the contextual toolbar
 * BlockSuite shows when an `affine:note` card is selected) via the supported
 * config seam — {@link ConfigExtension}'s `toolbarMoreMenu.configure` hook on
 * the `affine:page` flavour. A top-level toolbar button would need an
 * unsupported internal hook, so we deliberately live in the More menu, which is
 * also where future card verbs (#15: expand / challenge / …) will hang, all
 * sharing this one `ai-storm` group.
 *
 * @param onDiscuss invoked with the menu context when the user clicks "Discuss".
 *   The context exposes `getNoteBlock()` (the selected note model); the caller
 *   serializes the note's text and hands it to the agent.
 * @returns a BlockSuite {@link ExtensionType} to append to the editor's
 *   `edgelessSpecs` (see {@link CanvasService.mount}).
 */
export function discussToolbarExtension(
  onDiscuss: (ctx: DiscussMenuContext) => void,
): ExtensionType {
  const item: AdvancedMenuItem<DiscussMenuContext> = {
    type: 'discuss',
    label: 'Discuss',
    icon: AIStarIcon,
    // Only offered for a single selected note card — `getNoteBlock()` is null
    // for any other (or multiple) edgeless selection.
    when: (ctx) => !!ctx.getNoteBlock(),
    action: (ctx) => onDiscuss(ctx),
  };
  const group: MenuItemGroup<DiscussMenuContext> = {
    type: 'ai-storm',
    items: [item],
  };
  return ConfigExtension('affine:page', {
    toolbarMoreMenu: {
      configure: (groups: MenuItemGroup<DiscussMenuContext>[]) => {
        groups.unshift(group);
        return groups;
      },
    },
  });
}
