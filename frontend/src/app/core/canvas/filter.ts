/**
 * The board filter (#21) — the multi-facet model behind the canvas "Filter" menu,
 * plus the facet scan that greys out empty options and the applier that turns a
 * filter into per-card opacity. Pure logic; the menu UI lives in {@link ./menus}.
 */
import type { Editor } from 'tldraw';
import { normalizeKind } from '../idea-descriptors';
import { ideaCards, type IdeaCardMeta, type IdeaCardShape, type Origin } from './idea-card';

/**
 * The board's filterable dimensions (#21+): the full multi-facet model behind the
 * canvas Filter menu. A card is visible iff it passes EVERY active facet — kind,
 * provenance, mark, lifecycle, and triage — so the facets compose (AND).
 * Pure data; {@link applyFilter} turns it into per-card opacity.
 */
export interface BoardFilter {
  /** Kinds toggled OFF (#21). Empty ⇒ every kind shown. */
  hiddenKinds: ReadonlySet<string>;
  /** Provenance facet (#31): everything, or only AI / only user cards. */
  origin: 'all' | Origin;
  /** Show only starred cards (#29). */
  markedOnly: boolean;
  /** Show superseded ghosts (#20/PD-012). Off ⇒ they drop out entirely. */
  showSuperseded: boolean;
  /** Show only cards carrying an AI triage score (#60). */
  triagedOnly: boolean;
}

/** The no-op filter — every card visible. The Filter menu's reset target. */
export const EMPTY_FILTER: BoardFilter = {
  hiddenKinds: new Set(),
  origin: 'all',
  markedOnly: false,
  showSuperseded: true,
  triagedOnly: false,
};

/**
 * Which facet values actually occur on the current board — drives the menu's
 * "always show every option, grey out the ones with no cards" behaviour (#21). A
 * facet with no matching card would silently hide the whole board, so the UI
 * disables it rather than offering a filter that blanks the canvas.
 */
export interface BoardFacets {
  /** Distinct kinds with at least one card. */
  kinds: string[];
  hasAi: boolean;
  hasUser: boolean;
  hasMarked: boolean;
  hasSuperseded: boolean;
  hasTriaged: boolean;
}

/** Scan the board once for {@link BoardFacets} (#21). */
export function boardFacets(editor: Editor): BoardFacets {
  const kinds = new Set<string>();
  let hasAi = false;
  let hasUser = false;
  let hasMarked = false;
  let hasSuperseded = false;
  let hasTriaged = false;
  for (const card of ideaCards(editor)) {
    const k = normalizeKind(card.props.kind);
    if (k) kinds.add(k);
    if (card.props.origin === 'ai') hasAi = true;
    else hasUser = true;
    const meta = card.meta as IdeaCardMeta;
    if (meta.starred) hasMarked = true;
    if (card.props.superseded) hasSuperseded = true;
    if (meta.score) hasTriaged = true;
  }
  return { kinds: [...kinds], hasAi, hasUser, hasMarked, hasSuperseded, hasTriaged };
}

/** Whether a card survives every active facet of `filter`. Pure. */
function cardVisible(card: IdeaCardShape, filter: BoardFilter): boolean {
  const k = normalizeKind(card.props.kind);
  if (k && filter.hiddenKinds.has(k)) return false;
  if (filter.origin !== 'all' && card.props.origin !== filter.origin) return false;
  const meta = card.meta as IdeaCardMeta;
  if (filter.markedOnly && !meta.starred) return false;
  if (!filter.showSuperseded && card.props.superseded) return false;
  if (filter.triagedOnly && !meta.score) return false;
  return true;
}

/**
 * Apply the whole {@link BoardFilter} to the canvas (#21) by toggling each card's
 * opacity (0 ⇒ hidden) and locking hidden cards out of interaction. Native-tldraw
 * replacement for BlockSuite's `displayMode` toggle; cards stay on the board (data
 * is never removed — just dimmed out), so clearing the filter restores them. Recomputes
 * every card from scratch each call, so it's safe to re-run after new cards stream in.
 */
export function applyFilter(editor: Editor, filter: BoardFilter): void {
  const cards = ideaCards(editor);
  if (cards.length === 0) return;
  editor.run(() =>
    editor.updateShapes(
      cards.map((c) => {
        const visible = cardVisible(c, filter);
        return { id: c.id, type: 'idea-card' as const, opacity: visible ? 1 : 0, isLocked: !visible };
      }),
    ),
  );
}
