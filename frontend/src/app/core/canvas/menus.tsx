/**
 * The canvas's native tldraw menus (#21/#29, the custom-menus pattern —
 * tldraw.dev/examples/custom-menus):
 *
 * - {@link CanvasMainMenu} — the top-left ☰ with our "Arrange" and "Filter" submenus
 *   appended after the default content.
 * - {@link CanvasContextMenu} — the right-click menu with the card "Mark" action.
 * - {@link FilterApplier} — an invisible binding that applies the live filter to the
 *   board (rendered `InFrontOfTheCanvas`, so it runs even while the menu is closed).
 *
 * The filter selection lives in a tldraw {@link atom} (not React state) because the
 * main-menu content unmounts whenever the menu closes; the atom is created per
 * island (see {@link useFilterAtom}) and passed in, so it's per-workspace and resets
 * on board switch with no shared global.
 */
import { useEffect, useState } from "react";
import {
  atom,
  track,
  useEditor,
  type Atom,
  type Editor,
  DefaultMainMenu,
  DefaultMainMenuContent,
  DefaultContextMenu,
  DefaultContextMenuContent,
  type TLUiContextMenuProps,
  TldrawUiMenuGroup,
  TldrawUiMenuSubmenu,
  TldrawUiMenuCheckboxItem,
  TldrawUiMenuItem
} from "tldraw";
import { kindLabel, KNOWN_KINDS, normalizeKind } from "../idea-descriptors";
import { serializeCards } from "../canvas-text";
import { content, ideaCards, type IdeaCardMeta, type IdeaCardShape } from "./idea-card";
import { applyFilter, boardFacets, EMPTY_FILTER, type BoardFilter } from "./filter";
import { arrangeMindMap, arrangePriorityGrid, markSelected } from "./layout";
import { createUserIdea } from "./idea-tool";

/**
 * Select every idea card matching `pred` (#106) — the shared engine behind the
 * "select marked / untriaged / open questions" context actions. Only VISIBLE cards
 * are eligible: the board filter hides a card by setting `opacity: 0` and locking
 * it (see {@link applyFilter}), so selecting one would be a confusing invisible
 * selection. No-op (clears nothing) when nothing matches.
 */
function selectMatching(editor: Editor, pred: (card: IdeaCardShape) => boolean): void {
  const ids = ideaCards(editor)
    .filter((c) => c.opacity > 0 && pred(c))
    .map((c) => c.id);
  if (ids.length > 0) editor.setSelectedShapes(ids);
}

const isMarked = (c: IdeaCardShape) => !!(c.meta as IdeaCardMeta).starred;
const isUntriaged = (c: IdeaCardShape) => !(c.meta as IdeaCardMeta).score && !c.props.superseded;
const isOpenQuestion = (c: IdeaCardShape) => normalizeKind(c.props.kind) === "question" && !c.props.superseded;

/** A workspace's live filter, held in a tldraw signal so it outlives menu open/close. */
export type FilterAtom = Atom<BoardFilter>;

/** A fresh filter atom for the current workspace, discarded when the island remounts. */
export function useFilterAtom(): FilterAtom {
  return useState(() => atom<BoardFilter>("boardFilter", EMPTY_FILTER))[0];
}

/** Count of engaged facets — drives the "(N)" hint on the submenu label. */
function filterCount(f: BoardFilter): number {
  return (
    (f.hiddenKinds.size > 0 ? 1 : 0) +
    (f.origin !== "all" ? 1 : 0) +
    (f.markedOnly ? 1 : 0) +
    (f.triagedOnly ? 1 : 0) +
    (!f.showSuperseded ? 1 : 0)
  );
}

/**
 * Invisible board⇄filter binding (#21): re-applies the filter as per-card opacity
 * whenever the filter or the set of cards changes. Always mounted (it renders
 * `InFrontOfTheCanvas`, not in the menu), so freshly-streamed cards honour the
 * active filter even while the menu is closed. `track` re-runs it on board changes;
 * `cardsKey` keys the effect off card identity (not opacity), so applying the
 * filter — which only touches opacity/lock — can't loop.
 */
export const FilterApplier = track(function FilterApplier({ $filter }: { $filter: FilterAtom }): null {
  const editor = useEditor();
  const filter = $filter.get();
  const cardsKey = ideaCards(editor)
    .map((c) => c.id)
    .join(",");
  useEffect(() => {
    applyFilter(editor, filter);
  }, [editor, filter, cardsKey]);
  return null;
});

/**
 * The native main menu (top-left ☰) with our "Arrange" and "Filter" submenus
 * appended (#21) — the idiomatic tldraw way to extend a menu: keep
 * {@link DefaultMainMenuContent} and add our own {@link TldrawUiMenuGroup}. `track`
 * makes {@link boardFacets} reactive, so absent facets grey out (disabled) but every
 * option always shows. Toggling writes the filter atom; {@link FilterApplier} applies it.
 */
export const CanvasMainMenu = track(function CanvasMainMenu({ $filter }: { $filter: FilterAtom }): React.JSX.Element {
  const editor = useEditor();
  const filter = $filter.get();
  const facets = boardFacets(editor);

  const patch = (p: Partial<BoardFilter>) => {
    $filter.set({ ...filter, ...p });
  };
  const toggleKind = (kind: string) => {
    const hidden = new Set(filter.hiddenKinds);
    if (hidden.has(kind)) hidden.delete(kind);
    else hidden.add(kind);
    $filter.set({ ...filter, hiddenKinds: hidden });
  };

  const count = filterCount(filter);
  const extraKinds = facets.kinds.filter((k) => !(KNOWN_KINDS as readonly string[]).includes(k));
  const displayKinds = [...KNOWN_KINDS, ...extraKinds];

  return (
    <DefaultMainMenu>
      <DefaultMainMenuContent />
      <TldrawUiMenuGroup id="ai-storm">
        <TldrawUiMenuSubmenu id="arrange" label="Arrange" size="small">
          <TldrawUiMenuGroup id="arrange-layouts">
            <TldrawUiMenuItem
              id="arrange-mind-map"
              label="Mind map · by idea"
              readonlyOk
              onSelect={() => arrangeMindMap(editor)}
            />
            <TldrawUiMenuItem
              id="arrange-priority-grid"
              label="Priority grid · by score"
              readonlyOk
              onSelect={() => arrangePriorityGrid(editor)}
            />
          </TldrawUiMenuGroup>
        </TldrawUiMenuSubmenu>
        <TldrawUiMenuSubmenu id="filter" label={count > 0 ? `Filter (${count})` : "Filter"} size="small">
          <TldrawUiMenuGroup id="filter-kind">
            {displayKinds.map((kind) => (
              <TldrawUiMenuCheckboxItem
                key={kind}
                id={`filter-kind-${kind}`}
                label={kindLabel(kind)}
                checked={!filter.hiddenKinds.has(kind)}
                disabled={!facets.kinds.includes(kind)}
                readonlyOk
                onSelect={() => toggleKind(kind)}
              />
            ))}
          </TldrawUiMenuGroup>
          <TldrawUiMenuGroup id="filter-origin">
            <TldrawUiMenuCheckboxItem
              id="filter-origin-all"
              label="All origins"
              checked={filter.origin === "all"}
              readonlyOk
              onSelect={() => patch({ origin: "all" })}
            />
            <TldrawUiMenuCheckboxItem
              id="filter-origin-ai"
              label="🤖 AI only"
              checked={filter.origin === "ai"}
              disabled={!facets.hasAi}
              readonlyOk
              onSelect={() => patch({ origin: filter.origin === "ai" ? "all" : "ai" })}
            />
            <TldrawUiMenuCheckboxItem
              id="filter-origin-user"
              label="User only"
              checked={filter.origin === "user"}
              disabled={!facets.hasUser}
              readonlyOk
              onSelect={() => patch({ origin: filter.origin === "user" ? "all" : "user" })}
            />
          </TldrawUiMenuGroup>
          <TldrawUiMenuGroup id="filter-more">
            <TldrawUiMenuCheckboxItem
              id="filter-marked"
              label="★ Marked only"
              checked={filter.markedOnly}
              disabled={!facets.hasMarked}
              readonlyOk
              onSelect={() => patch({ markedOnly: !filter.markedOnly })}
            />
            <TldrawUiMenuCheckboxItem
              id="filter-triaged"
              label="⚖ Triaged only"
              checked={filter.triagedOnly}
              disabled={!facets.hasTriaged}
              readonlyOk
              onSelect={() => patch({ triagedOnly: !filter.triagedOnly })}
            />
            <TldrawUiMenuCheckboxItem
              id="filter-superseded"
              label="Show superseded"
              checked={filter.showSuperseded}
              disabled={!facets.hasSuperseded}
              readonlyOk
              onSelect={() => patch({ showSuperseded: !filter.showSuperseded })}
            />
          </TldrawUiMenuGroup>
          {count > 0 && (
            <TldrawUiMenuGroup id="filter-clear">
              <TldrawUiMenuItem
                id="filter-clear"
                label="Clear filters"
                readonlyOk
                onSelect={() => {
                  $filter.set(EMPTY_FILTER);
                }}
              />
            </TldrawUiMenuGroup>
          )}
        </TldrawUiMenuSubmenu>
      </TldrawUiMenuGroup>
    </DefaultMainMenu>
  );
});

/**
 * The native right-click context menu with the card "Mark" action (#29) prepended
 * — the idiomatic home for a selection action: keep {@link DefaultContextMenuContent}
 * and add our own {@link TldrawUiMenuGroup}. `track` makes it reactive to the
 * selection, so the item only appears when an idea card is selected and flips its
 * label between Mark / Unmark to match group state (the same toggle
 * {@link markSelected} performs).
 */
export const CanvasContextMenu = track(function CanvasContextMenu(props: TLUiContextMenuProps): React.JSX.Element {
  const editor = useEditor();
  const selectedCards = editor.getSelectedShapes().filter((s): s is IdeaCardShape => s.type === "idea-card");
  const allStarred = selectedCards.length > 0 && selectedCards.every((s) => (s.meta as IdeaCardMeta).starred);

  // Board-wide "select by trait" (#106): counts drive the disabled state so a verb
  // that would select nothing greys out rather than silently no-op'ing.
  const cards = ideaCards(editor);
  const markedCount = cards.filter(isMarked).length;
  const untriagedCount = cards.filter(isUntriaged).length;
  const openQuestionCount = cards.filter(isOpenQuestion).length;

  // Copy the current pure-card selection as markdown (#106) — the context-menu twin
  // of Ctrl/Cmd+C (see copy-text). Written here directly so it works on a mixed
  // selection too, copying just the idea cards.
  const copyAsMarkdown = () => {
    const text = serializeCards(selectedCards.map(content));
    if (text.trim()) void navigator.clipboard?.writeText(text);
  };

  return (
    <DefaultContextMenu {...props}>
      {selectedCards.length > 0 ? (
        <TldrawUiMenuGroup id="ai-storm-card">
          <TldrawUiMenuItem id="mark" label={allStarred ? "Unmark" : "★ Mark"} onSelect={() => markSelected(editor)} />
          <TldrawUiMenuItem
            id="copy-cards-md"
            label={
              selectedCards.length > 1 ? `⧉ Copy ${selectedCards.length} cards as markdown` : "⧉ Copy card as markdown"
            }
            readonlyOk
            onSelect={copyAsMarkdown}
          />
        </TldrawUiMenuGroup>
      ) : (
        // Right-click on empty canvas: drop a tracked user idea where they clicked
        // (#31) — the manual counterpart to the AI ingest path.
        <TldrawUiMenuGroup id="ai-storm-new">
          <TldrawUiMenuItem
            id="new-idea"
            label="✚ New idea here"
            onSelect={() => createUserIdea(editor, editor.inputs.currentPagePoint)}
          />
        </TldrawUiMenuGroup>
      )}
      {/* Board-wide selection helpers (#106) — always offered, disabled when no card
          qualifies, so the reach for "just the marked ones" is one click, not a
          manual lasso. */}
      <TldrawUiMenuGroup id="ai-storm-select">
        <TldrawUiMenuSubmenu id="select" label="Select" size="small">
          <TldrawUiMenuGroup id="select-traits">
            <TldrawUiMenuItem
              id="select-marked"
              label={markedCount > 0 ? `★ Marked (${markedCount})` : "★ Marked"}
              disabled={markedCount === 0}
              readonlyOk
              onSelect={() => selectMatching(editor, isMarked)}
            />
            <TldrawUiMenuItem
              id="select-untriaged"
              label={untriagedCount > 0 ? `Untriaged (${untriagedCount})` : "Untriaged"}
              disabled={untriagedCount === 0}
              readonlyOk
              onSelect={() => selectMatching(editor, isUntriaged)}
            />
            <TldrawUiMenuItem
              id="select-open-questions"
              label={openQuestionCount > 0 ? `❓ Open questions (${openQuestionCount})` : "❓ Open questions"}
              disabled={openQuestionCount === 0}
              readonlyOk
              onSelect={() => selectMatching(editor, isOpenQuestion)}
            />
          </TldrawUiMenuGroup>
        </TldrawUiMenuSubmenu>
      </TldrawUiMenuGroup>
      <DefaultContextMenuContent />
    </DefaultContextMenu>
  );
});
