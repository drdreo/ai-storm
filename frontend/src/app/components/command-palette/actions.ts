/**
 * The command palette's action catalog (#96) — a pure builder that turns the
 * current app state into the list of runnable {@link CommandAction}s, including
 * each action's disabled reason. No React here: the view layer memoizes a call
 * to {@link buildCommandActions} and renders the result.
 */
import {
  FileOutput,
  Filter,
  Grid2X2,
  LayoutList,
  ListRestart,
  Maximize2,
  Play,
  Plus,
  Settings,
  Sparkles,
  Square,
  Workflow,
  X
} from "lucide-react";
import type { BoardFilter } from "../../core/canvas/filter";
import type { WorkspaceMeta } from "../../core/models";
import type { BoardCommandState, CommandAction } from "./types";

/** Everything the catalog needs: app state plus the callbacks actions invoke. */
export interface CommandActionContext {
  active: WorkspaceMeta | null;
  workspaces: readonly WorkspaceMeta[];
  attached: boolean;
  board: BoardCommandState;
  focusMode: boolean;

  onNewIdea(): void;

  onStartSession(): void;

  onStopSession(): void;

  onTriage(): void;

  onSummarize(): void;

  onHandoff(): void;

  onArrangeMindMap(): void;

  onArrangePriorityGrid(): void;

  onPatchFilter(patch: Partial<BoardFilter>): void;

  onClearFilters(): void;

  onOpenSettings(): void;

  onSwitchWorkspace(workspaceId: string): void;

  onToggleFocusMode(): void;
}

function hasActiveFilter(filter: BoardFilter): boolean {
  return (
    filter.hiddenKinds.size > 0 ||
    filter.origin !== "all" ||
    filter.markedOnly ||
    !filter.showSuperseded ||
    filter.triagedOnly
  );
}

export function buildCommandActions(ctx: CommandActionContext): CommandAction[] {
  const noWorkspace = ctx.active ? undefined : "Create or switch to a workspace first.";
  const boardUnavailable = noWorkspace ?? (!ctx.board.mounted ? "The board is still mounting." : undefined);
  const emptyBoard = boardUnavailable ?? (ctx.board.cardCount === 0 ? "The board is empty." : undefined);
  const noSession = noWorkspace ?? (!ctx.attached ? "Start a session first." : undefined);
  const noSessionOrEmpty = noSession ?? emptyBoard;

  const filter = ctx.board.filter;
  const activeFilter = hasActiveFilter(filter);

  return [
    {
      id: "new-idea",
      group: "Board",
      label: "New idea",
      hint: "Create a user idea card in the center of the visible board.",
      icon: Plus,
      disabledReason: boardUnavailable,
      run: ctx.onNewIdea
    },
    {
      id: ctx.attached ? "stop-session" : "start-session",
      group: "Session",
      label: ctx.attached ? "Stop session" : "Start session",
      hint: ctx.attached
        ? "Stop the attached terminal session for this workspace."
        : "Attach or resume the terminal session for this workspace.",
      icon: ctx.attached ? Square : Play,
      disabledReason: noWorkspace,
      run: ctx.attached ? ctx.onStopSession : ctx.onStartSession
    },
    {
      id: "triage",
      group: "Agent",
      label: "Triage board",
      hint: "Ask the live agent to score every idea for impact, effort, and confidence.",
      keywords: ["rate", "score", "prioritize"],
      icon: Sparkles,
      disabledReason: noSessionOrEmpty,
      run: ctx.onTriage
    },
    {
      id: "summarize",
      group: "Agent",
      label: "Summarize board",
      hint: "Read the current board into themes, decisions, questions, and highlights.",
      keywords: ["summary", "converge"],
      icon: LayoutList,
      disabledReason: emptyBoard,
      run: ctx.onSummarize
    },
    {
      id: "handoff",
      group: "Agent",
      label: "Export to format",
      hint: "Convert your ideas into a structured format like a PRD, GitHub issues, or agent tasks",
      keywords: ["spec", "prd", "export", "plan", "issues", "tasks"],
      icon: FileOutput,
      disabledReason: emptyBoard,
      run: ctx.onHandoff
    },
    {
      id: "toggle-focus-mode",
      group: "View",
      label: ctx.focusMode ? "Exit focus mode" : "Focus mode",
      hint: ctx.focusMode
        ? "Return to the full canvas and app chrome."
        : "Go fullscreen and show only the selected card(s)",
      keywords: ["fullscreen", "zen", "distraction-free", "cluster"],
      icon: ctx.focusMode ? X : Maximize2,
      shortcut: "Ctrl/⌘ Shift F",
      disabledReason: boardUnavailable,
      run: ctx.onToggleFocusMode
    },
    {
      id: "arrange-mind-map",
      group: "Arrange",
      label: "Arrange mind map",
      hint: "Reflow ideas into the existing relationship-based mind map layout.",
      keywords: ["layout", "cluster"],
      icon: Workflow,
      disabledReason: emptyBoard,
      run: ctx.onArrangeMindMap
    },
    {
      id: "arrange-priority-grid",
      group: "Arrange",
      label: "Arrange priority grid",
      hint: "Reflow ideas into the existing impact and effort grid.",
      keywords: ["layout", "impact", "effort"],
      icon: Grid2X2,
      disabledReason: emptyBoard,
      run: ctx.onArrangePriorityGrid
    },
    {
      id: "filter-ai",
      group: "Filters",
      label: filter.origin === "ai" ? "Show all origins" : "Show AI ideas only",
      hint: "Toggle the same origin filter used by the canvas Filter menu.",
      icon: Filter,
      disabledReason: boardUnavailable ?? (!ctx.board.facets.hasAi ? "No AI ideas on this board." : undefined),
      run: () => ctx.onPatchFilter({ origin: filter.origin === "ai" ? "all" : "ai" })
    },
    {
      id: "filter-user",
      group: "Filters",
      label: filter.origin === "user" ? "Show all origins" : "Show user ideas only",
      hint: "Toggle user-origin idea filtering.",
      icon: Filter,
      disabledReason: boardUnavailable ?? (!ctx.board.facets.hasUser ? "No user ideas on this board." : undefined),
      run: () => ctx.onPatchFilter({ origin: filter.origin === "user" ? "all" : "user" })
    },
    {
      id: "filter-marked",
      group: "Filters",
      label: filter.markedOnly ? "Show all ideas" : "Show marked ideas only",
      hint: "Toggle the marked-only board filter.",
      icon: Filter,
      disabledReason: boardUnavailable ?? (!ctx.board.facets.hasMarked ? "No marked ideas on this board." : undefined),
      run: () => ctx.onPatchFilter({ markedOnly: !filter.markedOnly })
    },
    {
      id: "filter-triaged",
      group: "Filters",
      label: filter.triagedOnly ? "Show all ideas" : "Show triaged ideas only",
      hint: "Toggle the triaged-only board filter.",
      icon: Filter,
      disabledReason:
        boardUnavailable ?? (!ctx.board.facets.hasTriaged ? "No triaged ideas on this board yet." : undefined),
      run: () => ctx.onPatchFilter({ triagedOnly: !filter.triagedOnly })
    },
    {
      id: "filter-superseded",
      group: "Filters",
      label: filter.showSuperseded ? "Hide superseded ideas" : "Show superseded ideas",
      hint: "Toggle superseded idea visibility.",
      icon: Filter,
      disabledReason:
        boardUnavailable ?? (!ctx.board.facets.hasSuperseded ? "No superseded ideas on this board." : undefined),
      run: () => ctx.onPatchFilter({ showSuperseded: !filter.showSuperseded })
    },
    {
      id: "filter-clear",
      group: "Filters",
      label: "Clear filters",
      hint: "Reset every board filter to visible.",
      icon: ListRestart,
      disabledReason: boardUnavailable ?? (!activeFilter ? "No filters are active." : undefined),
      run: ctx.onClearFilters
    },
    {
      id: "settings",
      group: "App",
      label: "Open settings",
      hint: "Open appearance settings for this device.",
      icon: Settings,
      run: ctx.onOpenSettings
    },
    ...ctx.workspaces.map<CommandAction>((ws) => ({
      id: `workspace-${ws.id}`,
      group: "Workspaces",
      label: `Switch workspace: ${ws.title}`,
      hint: `Open ${ws.title}. Current status: ${ws.status}.`,
      keywords: ["switch workspace", ws.status],
      icon: Workflow,
      disabledReason: ws.id === ctx.active?.id ? "Already viewing this workspace." : undefined,
      run: () => ctx.onSwitchWorkspace(ws.id)
    }))
  ];
}

/** Bucket actions by group, preserving first-seen group order. */
export function groupActions(actions: readonly CommandAction[]): readonly (readonly [string, CommandAction[]])[] {
  const order: string[] = [];
  const byGroup = new Map<string, CommandAction[]>();
  for (const action of actions) {
    if (!byGroup.has(action.group)) {
      order.push(action.group);
      byGroup.set(action.group, []);
    }
    byGroup.get(action.group)!.push(action);
  }
  return order.map((group) => [group, byGroup.get(group)!] as const);
}
