import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import * as Toolbar from "@radix-ui/react-toolbar";
import { Command, FileOutput, Scale, ScrollText } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { CanvasIsland } from "../core/canvas-island";
import type { SearchableIdea } from "../core/canvas/search";
import type { SpecFormat, SpecOptions } from "../core/prompt-framing";
import type { ConvergentSummary } from "../core/synthesis";
import { agent } from "../stores/agent.store";
import { canvas, useCanvasStore } from "../stores/canvas.store";
import { ingestion, useIngestionStore } from "../stores/ingestion.store";
import { ui, useUiStore } from "../stores/ui.store";
import { selectActive, useWorkspaceStore, workspace } from "../stores/workspace.store";
import { BoardCommandPalette } from "./BoardCommandPalette";
import { SpecPanel } from "./SpecPanel";
import { SummaryPanel } from "./SummaryPanel";

/**
 * A canvas-macro toolbar button with an accessible {@link Tooltip} (audit H1 —
 * replaces the old `title=`, which never showed on keyboard focus or touch). The
 * Radix `asChild` chain (TooltipTrigger → Toolbar.Button → Button) keeps it a
 * single real <button> with the toolbar's roving-focus and the tooltip's a11y.
 */
function ToolbarVerb({
  onClick,
  tip,
  variant = "default",
  disabled = false,
  disabledTip,
  children
}: {
  onClick: () => void;
  tip: string;
  variant?: "default" | "ghost";
  disabled?: boolean;
  /** Why the verb is unavailable (#106) — shown in place of `tip` when disabled. */
  disabledTip?: string;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* aria-disabled (not the native `disabled`) so the button stays hoverable
            and focusable — a truly-disabled button swallows the events the tooltip
            needs to explain *why* it's off (#106). The click is guarded instead. */}
        <Toolbar.Button asChild>
          <Button
            size="sm"
            variant={variant}
            onClick={disabled ? undefined : onClick}
            aria-disabled={disabled}
            className={disabled ? "pointer-events-auto opacity-50" : undefined}
          >
            {children}
          </Button>
        </Toolbar.Button>
      </TooltipTrigger>
      <TooltipContent>{disabled ? (disabledTip ?? tip) : tip}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Structural Workspace Canvas (PRD §3.1, §4.1). Hosts the tldraw canvas (the
 * React {@link CanvasIsland}) as the single spatial surface (PD-011). The pane
 * is a shadcn toolbar of agent macros (PRD §3.6) over the canvas, which it
 * renders directly (PD-016). The card filter (#21) lives inside the canvas
 * itself (top-right), not in this toolbar.
 */
export function CanvasPane() {
  const active = useWorkspaceStore(selectActive);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const attached = useIngestionStore((s) => (active ? !!s.attached[active.id] : false));
  useCanvasStore((s) => s.ideasTick);
  // Convergence panel (#28): the summary is regenerated each time it opens — a
  // fresh on-demand reading of the current board, never cached stale.
  const [summary, setSummary] = useState<ConvergentSummary | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);
  // Spec hand-off (#89, #110): "Hand off" just opens the panel — the panel owns
  // the format picker and the Generate button, so switching format and re-running
  // is one interaction. Dispatch flows back up through `onGenerate`.
  const [specOpen, setSpecOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const focusMode = useUiStore((s) => s.focusMode);
  // Full-text search index (#124): gathered fresh each time the palette opens —
  // the mounted board read live, every other workspace from its persisted store.
  const [searchIdeas, setSearchIdeas] = useState<readonly SearchableIdea[]>([]);

  // Bidirectional canvas (#13, #15): when a card verb fires, frame the card's
  // text and type it into the active workspace's live terminal. Registered once;
  // reads the latest active workspace at fire time.
  useEffect(() => {
    canvas.onCardVerb((text, intent, sourceRefs) => {
      const ws = selectActive(useWorkspaceStore.getState());
      if (ws) agent.discussText(ws.id, text, intent, sourceRefs);
    });
  }, []);

  // Gather the cross-workspace idea index whenever the palette opens (#124). A
  // stale-guard drops the result if the palette closed before the async read
  // (persisted-board reads hit IndexedDB) resolved.
  useEffect(() => {
    if (!paletteOpen) return;
    let live = true;
    canvas.collectSearchIdeas(workspaces.map((w) => ({ id: w.id, title: w.title }))).then((ideas) => {
      if (live) setSearchIdeas(ideas);
    });
    return () => {
      live = false;
    };
  }, [paletteOpen, workspaces]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      // Focus mode (#131): the Ctrl/⌘+Shift+F toggle is a native tldraw action
      // (see `focusModeOverrides`), so tldraw's own keyboard system owns it — we
      // only keep Escape here as the fast way out, since tldraw's Escape natively
      // cancels/deselects rather than exiting our app-level focus mode.
      if (event.key === "Escape" && useUiStore.getState().focusMode) {
        // Let a more specific Escape win instead of also exiting focus mode:
        // the palette closing itself, or tldraw canceling a tool / text edit /
        // shape selection (all of which land on an editable element or inside
        // the canvas, never on the bare document body).
        if (paletteOpen) return;
        const target = event.target as HTMLElement | null;
        const editing = target?.closest("input, textarea, [contenteditable='true']");
        if (editing) return;
        ui.setFocusMode(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [paletteOpen]);

  // React to workspace switches — rebind the tldraw island (PRD §3.4). Done at
  // render time (idempotent) so the controller's active id is set BEFORE the
  // freshly-keyed CanvasIsland mounts and `onEditorMount` drains its queue.
  if (active) canvas.switchTo(active.id);

  const triage = () => active && agent.triage(active.id);
  const synthesize = () => {
    if (!active) return;
    setSummary(canvas.synthesize(active.id));
    setSummaryOpen(true);
  };
  // Open the panel even if the board is empty — it shows the empty/why state.
  const handoff = () => setSpecOpen(true);
  const generateSpec = (format: SpecFormat, opts: SpecOptions) => {
    if (active) agent.generateSpec(active.id, active.terminal, format, opts);
  };
  // Gates the panel's Generate with why-copy. Only serialized while the panel is
  // open (it walks the board); the `ideasTick` subscription above keeps it fresh.
  const specBoardEmpty = !(specOpen && active && canvas.serializeForHandoff(active.id).trim());
  const startSession = () => {
    if (active) ingestion.attach(active.id, active.terminal);
  };
  const stopSession = () => {
    if (active) ingestion.kill(active.id);
  };
  // Board facts drive the palette's disabled-reason copy, but computing them
  // walks every idea card — so only do it while the palette is open. When it's
  // closed we hand back the cheap "unmounted" shape (no card walk), and each
  // open recomputes fresh (#96 review).
  const boardState = paletteOpen && active ? canvas.boardCommandState(active.id) : canvas.boardCommandState("");

  // First-run empty-state actions (#106), rendered inside the canvas island so a
  // newcomer's first move is one click. Memoized on the facts they close over so
  // the island's component map (which keys off this identity) stays stable.
  const emptyStateActions = useMemo(
    () =>
      active
        ? {
            onNewIdea: () => canvas.createIdea(active.id),
            onStartSession: startSession,
            onOpenSettings: ui.openSettings,
            attached
          }
        : undefined,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [active?.id, attached]
  );

  return (
    <div className="flex h-full flex-col">
      {!focusMode && (
        <div className="z-[2] flex items-center gap-2 border-b bg-background px-3 py-2">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="!h-5" />
          <div className="flex-1" />
          <Toolbar.Root className="flex gap-2" aria-label="Canvas actions">
            <ToolbarVerb onClick={() => setPaletteOpen(true)} variant="ghost" tip="Open command palette (Ctrl/⌘ K)">
              <Command /> Commands
            </ToolbarVerb>
            <ToolbarVerb
              onClick={triage}
              variant="ghost"
              tip="Ask the agent to rate every card — impact, effort, confidence (#60)"
              disabled={!attached}
              disabledTip="Start a session first — triage asks the live agent to score the board"
            >
              <Scale /> Triage
            </ToolbarVerb>
            <ToolbarVerb onClick={synthesize} variant="ghost" tip="Read the board into a convergent summary (#28)">
              <ScrollText /> Synthesize
            </ToolbarVerb>
            <ToolbarVerb
              onClick={handoff}
              tip="Hand off the board to the agent — pick a format (PRD, plan, issues, tasks) and generate (#89, #110)"
              disabled={!attached}
              disabledTip="Start a session first — the hand-off spec is generated by the live agent"
            >
              <FileOutput /> Hand off
            </ToolbarVerb>
          </Toolbar.Root>
        </div>
      )}

      <div className="relative min-h-0 flex-1 overflow-hidden bg-background">
        {active && (
          <CanvasIsland
            key={active.id}
            workspaceId={active.id}
            bridge={canvas.bridge}
            emptyStateActions={emptyStateActions}
            sessionAttached={attached}
          />
        )}
      </div>

      <SummaryPanel open={summaryOpen} onOpenChange={setSummaryOpen} summary={summary} workspaceName={active?.title} />

      <SpecPanel
        open={specOpen}
        onOpenChange={setSpecOpen}
        workspaceId={active?.id}
        workspaceName={active?.title}
        boardEmpty={specBoardEmpty}
        onGenerate={generateSpec}
      />

      <BoardCommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        active={active}
        workspaces={workspaces}
        attached={attached}
        board={boardState}
        onNewIdea={() => active && canvas.createIdea(active.id)}
        onStartSession={startSession}
        onStopSession={stopSession}
        onTriage={triage}
        onSynthesize={synthesize}
        onHandoff={handoff}
        onArrangeMindMap={() => active && canvas.arrangeMindMap(active.id)}
        onArrangePriorityGrid={() => active && canvas.arrangePriorityGrid(active.id)}
        onPatchFilter={(patch) => active && canvas.patchFilter(active.id, patch)}
        onClearFilters={() =>
          active &&
          canvas.patchFilter(active.id, {
            hiddenKinds: new Set(),
            origin: "all",
            markedOnly: false,
            showSuperseded: true,
            triagedOnly: false
          })
        }
        onOpenSettings={ui.openSettings}
        onSwitchWorkspace={workspace.setActive}
        focusMode={focusMode}
        onToggleFocusMode={ui.toggleFocusMode}
        searchIdeas={searchIdeas}
        onRevealIdea={(workspaceId, shapeId) => void workspace.revealIdea(workspaceId, shapeId)}
      />
    </div>
  );
}
