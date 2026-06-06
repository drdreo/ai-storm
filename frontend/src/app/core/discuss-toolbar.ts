import { ConfigExtension, type ExtensionType } from '@blocksuite/block-std';
import {
  AIStarIcon,
  BanIcon,
  ExpandWideIcon,
  WarningIcon,
  type AdvancedMenuItem,
  type MenuItemGroup,
} from '@blocksuite/blocks';
import type { PromptIntent } from './prompt-framing';

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
 * A card-level AI verb (#13 / #15): a label + icon bound to a {@link PromptIntent}.
 * Clicking it frames the selected card's text with that intent and types it into
 * the live terminal as an editable prompt (see {@link AgentService.discussText}).
 */
interface CardVerb {
  readonly intent: PromptIntent;
  readonly label: string;
  readonly icon: AdvancedMenuItem<DiscussMenuContext>['icon'];
}

/**
 * The card verbs, in menu order. #13 shipped `discuss`; #15 adds the common
 * brainstorm moves. This is the single place that maps a verb to its menu
 * presentation — the prompt wording lives centrally in `PROMPT_TEMPLATES`
 * (prompt-framing.ts) so the two stay in lockstep: a new verb is one row here
 * plus one template there. (#15's `merge` is intentionally absent — it needs a
 * card-picker submenu + code-level merge, not a templated prompt.)
 */
const CARD_VERBS: readonly CardVerb[] = [
  { intent: 'discuss', label: 'Discuss', icon: AIStarIcon },
  { intent: 'expand', label: 'Expand', icon: ExpandWideIcon },
  { intent: 'challenge', label: 'Challenge', icon: BanIcon },
  { intent: 'find-risks', label: 'Find risks', icon: WarningIcon },
];

/**
 * Bidirectional canvas (#13, #15) — surface the card-level AI verbs on a selected
 * idea card itself, rather than on the canvas top toolbar. This adds one entry
 * per {@link CARD_VERBS} verb to the edgeless element-toolbar's "More …" overflow
 * menu (the contextual toolbar BlockSuite shows when an `affine:note` card is
 * selected) via the supported config seam — {@link ConfigExtension}'s
 * `toolbarMoreMenu.configure` hook on the `affine:page` flavour. A top-level
 * toolbar button would need an unsupported internal hook, so we deliberately live
 * in the More menu, all verbs sharing this one `ai-storm` group.
 *
 * @param onVerb invoked with the clicked verb's {@link PromptIntent} and the menu
 *   context when the user picks a verb. The context exposes `getNoteBlock()` (the
 *   selected note model); the caller serializes the note's text, frames it for the
 *   intent, and hands it to the agent.
 * @returns a BlockSuite {@link ExtensionType} to append to the editor's
 *   `edgelessSpecs` (see {@link CanvasService.mount}).
 */
export function discussToolbarExtension(
  onVerb: (intent: PromptIntent, ctx: DiscussMenuContext) => void,
): ExtensionType {
  const items: AdvancedMenuItem<DiscussMenuContext>[] = CARD_VERBS.map((verb) => ({
    type: `ai-storm-${verb.intent}`,
    label: verb.label,
    icon: verb.icon,
    // Only offered for a single selected note card — `getNoteBlock()` is null
    // for any other (or multiple) edgeless selection.
    when: (ctx) => !!ctx.getNoteBlock(),
    action: (ctx) => onVerb(verb.intent, ctx),
  }));
  const group: MenuItemGroup<DiscussMenuContext> = {
    type: 'ai-storm',
    items,
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
