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
 * island (see {@link useFilterAtom}) and passed in, so it's per-project and resets
 * on board switch with no shared global.
 */
import { useEffect, useRef, useState } from "react";
import {
  atom,
  track,
  useEditor,
  useActions,
  type Atom,
  type Editor,
  type TLShapeId,
  type TLUiOverrides,
  DefaultMainMenu,
  DefaultMainMenuContent,
  DefaultContextMenu,
  DefaultContextMenuContent,
  DefaultQuickActions,
  DefaultQuickActionsContent,
  type TLUiContextMenuProps,
  TldrawUiMenuGroup,
  TldrawUiMenuSubmenu,
  TldrawUiMenuCheckboxItem,
  TldrawUiMenuItem
} from "tldraw";
import { kindLabel, KNOWN_KINDS, normalizeKind } from "../idea-descriptors";
import { serializeCards } from "../canvas-text";
import { ui, useUiStore } from "../../stores/ui.store";
import { content, ideaCards, type IdeaCardMeta, type IdeaCardShape } from "./idea-card";
import { applyFilter, boardFacets, EMPTY_FILTER, type BoardFilter } from "./filter";
import { activeBoardLayout, arrangeMindMap, arrangePriorityGrid, markSelected } from "./layout";
import { createUserIdea } from "./idea-tool";
import { focusedCardIds } from "./focus";

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

/** A project's live filter, held in a tldraw signal so it outlives menu open/close. */
export type FilterAtom = Atom<BoardFilter>;

/** A fresh filter atom for the current project, discarded when the island remounts. */
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
 * Invisible board⇄filter binding (#21, #131): re-applies the filter — and, while
 * focus mode is on, a further restriction to the selected cluster — as per-card
 * opacity whenever the filter, focus mode, selection, or the set of cards
 * changes. Always mounted (it renders `InFrontOfTheCanvas`, not in the menu), so
 * freshly-streamed cards honour the active filter even while the menu is closed.
 * `track` re-runs it on board changes; reading the selection only while focus
 * mode is on means selecting a card doesn't re-render this when focus is off.
 * `cardsKey`/`focusKey` key the effect off identity (not opacity), so applying
 * the filter — which only touches opacity/lock — can't loop.
 *
 * The focused cluster is captured ONCE, on the moment focus mode turns on, from
 * whatever is selected then — and then held fixed until focus mode is explicitly
 * turned off (context menu, exit pill, palette, Escape). It deliberately does
 * NOT track later selection changes: clicking, right-clicking, or editing a card
 * inside the focused set must not re-narrow or re-widen the board (that made
 * cards flicker in and out, and effectively "un-focused" the board while the
 * chrome stayed hidden). An empty selection on entry captures `null` — the cue
 * to go fullscreen over the whole board without narrowing.
 */
export const FilterApplier = track(function FilterApplier({ $filter }: { $filter: FilterAtom }): null {
  const editor = useEditor();
  const filter = $filter.get();
  const focusMode = useUiStore((s) => s.focusMode);
  const focusIds = useRef<Set<TLShapeId> | null>(null);
  const wasFocused = useRef(false);
  if (focusMode && !wasFocused.current) {
    // off → on edge: snapshot the cluster around the current selection.
    focusIds.current = focusedCardIds(editor, new Set(editor.getSelectedShapeIds()));
  } else if (!focusMode) {
    focusIds.current = null;
  }
  wasFocused.current = focusMode;
  const active = focusMode ? focusIds.current : null;
  const cardsKey = ideaCards(editor)
    .map((c) => c.id)
    .join(",");
  const focusKey = active ? [...active].join(",") : "";
  useEffect(() => {
    applyFilter(editor, filter, active);
  }, [editor, filter, cardsKey, focusKey]);
  return null;
});

/**
 * Register the focus-mode toggle as a native tldraw **action** (#131), so tldraw's
 * own keyboard system owns the Ctrl/⌘+Shift+F shortcut — the idiomatic override
 * (tldraw.dev/reference/tldraw/TLUiOverrides), mirroring how {@link ideaToolOverrides}
 * binds the Idea tool's `i`. This is the *only* real binding: a `kbd` on a rendered
 * menu item is a display hint, not a handler (tldraw's `useKeyboardShortcuts` binds
 * from `actions`/`tools` alone), and the QuickActions item only mounts while focused
 * — so it could never register the shortcut to *enter*. One action toggles both ways
 * and works whenever the canvas is focused, replacing the old window keydown handler.
 */
export const focusModeOverrides: TLUiOverrides = {
  actions(_editor, actions) {
    actions["toggle-focus-mode"] = {
      id: "toggle-focus-mode",
      label: "Focus mode",
      kbd: "cmd+shift+f,ctrl+shift+f",
      readonlyOk: true,
      onSelect: () => ui.toggleFocusMode()
    };
    return actions;
  }
};

/**
 * The focus-mode exit control (#131), appended to tldraw's native top-left
 * QuickActions (undo/redo/…) instead of overlaid as an app-chrome button — the
 * custom-menus pattern (tldraw.dev/examples/custom-menus): keep
 * {@link DefaultQuickActionsContent} and add our own item. It sits in the native
 * UI layer, so it never collides with the main menu and — unlike the top-right
 * `SharePanel` — doesn't shift the style panel. Only shown while focus mode is on;
 * the shortcut and command palette exit too, but a pointer-only user needs a
 * visible way back once the app chrome is hidden. Spreads the {@link focusModeOverrides}
 * action so its handler and the `⌘⇧F` hint come from that single source; only the
 * label/icon are specialised for the exit direction.
 */
export function FocusQuickActions(): React.JSX.Element {
  const focusMode = useUiStore((s) => s.focusMode);
  const actions = useActions();
  return (
    <DefaultQuickActions>
      <DefaultQuickActionsContent />
      {focusMode && <TldrawUiMenuItem {...actions["toggle-focus-mode"]} icon="cross-2" label="Exit focus mode" />}
    </DefaultQuickActions>
  );
}

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
  // Active arrangement (#100): reading the atom inside `track` keeps the
  // checkmarks and the submenu's "· grid" / "· mind map" cue live while open.
  const layoutMode = activeBoardLayout(editor).get()?.mode ?? null;
  const arrangeLabel =
    layoutMode === "grid" ? "Arrange · grid" : layoutMode === "mind-map" ? "Arrange · mind map" : "Arrange";
  const extraKinds = facets.kinds.filter((k) => !(KNOWN_KINDS as readonly string[]).includes(k));
  const displayKinds = [...KNOWN_KINDS, ...extraKinds];

  return (
    <DefaultMainMenu>
      <DefaultMainMenuContent />
      <TldrawUiMenuGroup id="ai-storm">
        <TldrawUiMenuSubmenu id="arrange" label={arrangeLabel} size="small">
          {/* Checkboxes, not plain items (#100): each arrange is a *mode* the
              board stays in (grid additionally keeps its quadrant labels up), so
              the menu reflects which one is active. Re-selecting the checked one
              re-tidies fresh cards. */}
          <TldrawUiMenuGroup id="arrange-layouts">
            <TldrawUiMenuCheckboxItem
              id="arrange-mind-map"
              label="Mind map · by idea"
              checked={layoutMode === "mind-map"}
              readonlyOk
              onSelect={() => arrangeMindMap(editor)}
            />
            <TldrawUiMenuCheckboxItem
              id="arrange-priority-grid"
              label="Priority grid · by score"
              checked={layoutMode === "grid"}
              readonlyOk
              onSelect={() => arrangePriorityGrid(editor)}
            />
          </TldrawUiMenuGroup>
          {layoutMode === "grid" && (
            <TldrawUiMenuGroup id="arrange-grid-exit">
              <TldrawUiMenuItem
                id="hide-grid-labels"
                label="Hide grid labels"
                readonlyOk
                onSelect={() => void activeBoardLayout(editor).set(null)}
              />
            </TldrawUiMenuGroup>
          )}
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
  const focusMode = useUiStore((s) => s.focusMode);
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

  // Focus the selected cards' cluster (#131) — the right-click twin of
  // Ctrl/⌘+Shift+F and the palette entry. Entering first widens the selection to the whole connected cluster
  // ({@link focusedCardIds}), then goes fullscreen — {@link FilterApplier} reads
  // that selection to decide what stays visible. While already focused the same
  // slot exits instead, since cards remain visible in focus mode and a plain
  // "Focus cards" here would otherwise silently toggle focus *off*.
  const focusSelected = () => {
    if (focusMode) {
      ui.setFocusMode(false);
      return;
    }
    const focusIds = focusedCardIds(editor, new Set(selectedCards.map((c) => c.id)));
    if (focusIds) {
      editor.setSelectedShapes(Array.from(focusIds));
      ui.setFocusMode(true);
    }
  };

  return (
    <DefaultContextMenu {...props}>
      {selectedCards.length > 0 ? (
        <TldrawUiMenuGroup id="ai-storm-card">
          <TldrawUiMenuItem id="focus" label={focusMode ? "Exit focus" : "⤢ Focus cards"} onSelect={focusSelected} />
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
