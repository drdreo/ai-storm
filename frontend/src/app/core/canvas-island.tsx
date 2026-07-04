/**
 * The tldraw canvas — a React island the stores mount as the single spatial surface
 * (PD-011: edgeless is the only surface; PD-013: ideas replace, now). This module is
 * the **entry point**: it wires the custom shape, the native menus (#21/#29), and the
 * card-verb bar (#13/#15) into `<Tldraw>`, and re-exports the editor-driven ports the
 * framework-agnostic stores call. The pieces themselves live in `./canvas/`:
 *
 * - `canvas/idea-card`  — the `idea-card` shape, its util/body, and identity helpers
 * - `canvas/ingest`     — `applyIdeas` (the ingestion write-path)
 * - `canvas/serialize`  — board → text/snapshot reads (PRD §3.2/§3.6, #28/#60)
 * - `canvas/filter`     — the multi-facet board filter model (#21)
 * - `canvas/focus`      — focus-mode's related-cluster computation (#131)
 * - `canvas/layout`     — arrange/grid re-flows + triage score + mark (#16/#60/#29)
 * - `canvas/edges`      — the typed edge graph shared by reads and layouts
 * - `canvas/portable`   — board ↔ portable JSON for workspace export/import (#105)
 * - `canvas/CardVerbBar`, `canvas/menus` — the in-canvas UI
 *
 * "As close to native tldraw as possible": native arrows for edges, the native styles
 * system for color, native menu slots for chrome, and `persistenceKey` → IndexedDB.
 */
import { Tldraw, type Editor, type TLComponents } from "tldraw";
import "tldraw/tldraw.css";
import { useMemo, useState, useEffect } from "react";
import { useThemeStore } from "../stores/theme.store";
import { IdeaCardShapeUtil } from "./canvas/idea-card";
import { CardVerbBar, type CardVerbHandler } from "./canvas/CardVerbBar";
import { CanvasEmptyState, type EmptyStateActions } from "./canvas/CanvasEmptyState";
import { CanvasMainMenu, CanvasContextMenu, FilterApplier, FocusQuickActions, useFilterAtom } from "./canvas/menus";
import { IDEA_TOOLS, ideaToolOverrides, IdeaToolbar } from "./canvas/idea-tool";
import { copyTextOptions } from "./canvas/copy-text";
import type { BoardFilter } from "./canvas/filter";

// Re-export the editor-driven ports the stores drive against the mounted workspace.
export { applyIdeas } from "./canvas/ingest";
export {
  serializeEditor,
  serializeForTriage,
  serializeForHandoff,
  collectBoard,
  selectedText
} from "./canvas/serialize";
export { applyScore } from "./canvas/layout";
export { exportBoard, importBoard } from "./canvas/portable";

const SHAPE_UTILS = [IdeaCardShapeUtil];

/** The seam between the stores and this React island. */
export interface CanvasBridge {
  /** Called once the editor for the mounted workspace is ready. */
  onEditorMount(editor: Editor): void;
  /** Fired when a card verb (#13/#15) is picked on a selected card. */
  onCardVerb: CardVerbHandler;
  /** Shares the live per-workspace filter atom with app-level commands (#96). */
  onFilterMount?(controller: { get(): BoardFilter; set(filter: BoardFilter): void }): () => void;
}

export function CanvasIsland({
  workspaceId,
  bridge,
  emptyStateActions,
  sessionAttached = false
}: {
  workspaceId: string;
  bridge: CanvasBridge;
  /** Primary-action handlers for the first-run empty state (#106). */
  emptyStateActions?: EmptyStateActions;
  /** Whether a live session backs this workspace — gates the card verbs (#106). */
  sessionAttached?: boolean;
}): React.JSX.Element {
  // One store per workspace, keyed by id → its own IndexedDB room (PD-001,
  // local-first; survives reload). Changing `key`/`persistenceKey` remounts
  // <Tldraw> onto the next workspace's store — the hot-switch of PRD §3.4.
  //
  // The filter atom is created here, so it's scoped to this island: switching
  // workspaces remounts CanvasIsland (it's keyed by id in CanvasPane), which
  // discards this atom and mints a fresh one — each board gets its own filter,
  // reset on switch, with no shared global state to clear (#21).
  const $filter = useFilterAtom();
  useEffect(() => {
    return bridge.onFilterMount?.({
      get: () => $filter.get(),
      set: (filter) => $filter.set(filter)
    });
  }, [$filter, bridge]);

  // Mirror the app theme (#77) into tldraw's own color scheme. The preference
  // accepts the same 'light' | 'dark' | 'system' values as our store, so we feed
  // `mode` straight through once the editor for this workspace has mounted.
  const themeMode = useThemeStore((s) => s.mode);
  const [editor, setEditor] = useState<Editor | null>(null);
  useEffect(() => {
    editor?.user.updateUserPreferences({ colorScheme: themeMode });
  }, [editor, themeMode]);

  const components = useMemo<TLComponents>(
    () => ({
      MainMenu: () => <CanvasMainMenu $filter={$filter} />,
      ContextMenu: CanvasContextMenu,
      // Surface the manual "Idea" tool (#31) next to tldraw's native tools.
      Toolbar: IdeaToolbar,
      // Focus-mode exit (#131) is appended to the native top-left QuickActions,
      // so it never overlaps the main menu and doesn't shift the style panel.
      QuickActions: FocusQuickActions,
      InFrontOfTheCanvas: () => (
        <>
          <CanvasEmptyState actions={emptyStateActions} />
          <CardVerbBar onVerb={bridge.onCardVerb} disabled={!sessionAttached} />
          <FilterApplier $filter={$filter} />
        </>
      )
    }),
    [$filter, bridge, emptyStateActions, sessionAttached]
  );
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <Tldraw
        key={workspaceId}
        persistenceKey={`ai-storm:ws:${workspaceId}`}
        shapeUtils={SHAPE_UTILS}
        tools={IDEA_TOOLS}
        overrides={ideaToolOverrides}
        options={copyTextOptions}
        components={components}
        onMount={(ed) => {
          setEditor(ed);
          bridge.onEditorMount(ed);
        }}
      />
    </div>
  );
}
