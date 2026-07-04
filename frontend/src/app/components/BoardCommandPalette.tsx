import { useEffect, useMemo, useState } from "react";
import {
  Bot,
  CalendarClock,
  FileOutput,
  Filter,
  Grid2X2,
  LayoutList,
  Lightbulb,
  ListRestart,
  Maximize2,
  X,
  Play,
  Plus,
  Settings,
  Sparkles,
  Square,
  Star,
  User,
  Workflow
} from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from "@/components/ui/command";
import { cn } from "@/lib/utils";
import type { WorkspaceMeta } from "../core/models";
import type { BoardFilter } from "../core/canvas/filter";
import { KNOWN_KINDS, kindLabel, normalizeKind } from "../core/idea-descriptors";
import {
  EMPTY_IDEA_SEARCH_FILTER,
  hasActiveIdeaFilter,
  searchIdeas,
  type IdeaSearchFilter,
  type SearchableIdea
} from "../core/canvas/search";

type CommandIcon = typeof Plus;

interface CommandAction {
  id: string;
  group: string;
  label: string;
  hint: string;
  keywords?: readonly string[];
  icon: CommandIcon;
  disabledReason?: string;
  run(): void;
}

interface BoardCommandPaletteProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  active: WorkspaceMeta | null;
  workspaces: readonly WorkspaceMeta[];
  attached: boolean;
  board: {
    mounted: boolean;
    cardCount: number;
    facets: {
      hasAi: boolean;
      hasUser: boolean;
      hasMarked: boolean;
      hasSuperseded: boolean;
      hasTriaged: boolean;
    };
    filter: BoardFilter;
  };
  onNewIdea(): void;
  onStartSession(): void;
  onStopSession(): void;
  onTriage(): void;
  onSynthesize(): void;
  onHandoff(): void;
  onArrangeMindMap(): void;
  onArrangePriorityGrid(): void;
  onPatchFilter(patch: Partial<BoardFilter>): void;
  onClearFilters(): void;
  onOpenSettings(): void;
  onSwitchWorkspace(workspaceId: string): void;
  focusMode: boolean;
    onToggleFocusMode(): void;
  /** Ideas gathered across every workspace for full-text search (#124). */
  searchIdeas: readonly SearchableIdea[];
  /** Open a search result's workspace and pan/zoom to the card (#124). */
  onRevealIdea(workspaceId: string, shapeId: string): void;
}

const MAX_IDEA_RESULTS = 12;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Date facet presets (#124) — cycled by the "Any time" chip. */
const DATE_PRESETS = [
  { id: "any", label: "Any time", ms: undefined },
  { id: "1d", label: "Past 24h", ms: DAY_MS },
  { id: "7d", label: "Past 7 days", ms: 7 * DAY_MS },
  { id: "30d", label: "Past 30 days", ms: 30 * DAY_MS }
] as const;

/** A small pressable filter chip — pressed state mirrors an active facet. */
function FilterChip({
  active,
  onClick,
  children
}: {
  active: boolean;
  onClick(): void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-input bg-transparent text-muted-foreground hover:bg-muted"
      )}
    >
      {children}
    </button>
  );
}

/** The idea-search facet bar (#124): provenance / mark / triage / lifecycle / kind / date. */
function IdeaFilterBar({
  filter,
  onChange,
  availableKinds,
  datePreset,
  onCycleDate
}: {
  filter: IdeaSearchFilter;
  onChange(next: IdeaSearchFilter): void;
  availableKinds: readonly string[];
  datePreset: (typeof DATE_PRESETS)[number];
  onCycleDate(): void;
}) {
  const toggleKind = (kind: string) => {
    const kinds = new Set(filter.kinds);
    if (kinds.has(kind)) kinds.delete(kind);
    else kinds.add(kind);
    onChange({ ...filter, kinds });
  };
  const setOrigin = (origin: IdeaSearchFilter["origin"]) =>
    onChange({ ...filter, origin: filter.origin === origin ? "all" : origin });

  return (
    <div className="flex flex-wrap items-center gap-1.5 px-2 py-2">
      <FilterChip active={filter.origin === "ai"} onClick={() => setOrigin("ai")}>
        <Bot className="size-3" /> AI
      </FilterChip>
      <FilterChip active={filter.origin === "user"} onClick={() => setOrigin("user")}>
        <User className="size-3" /> User
      </FilterChip>
      <FilterChip active={filter.markedOnly} onClick={() => onChange({ ...filter, markedOnly: !filter.markedOnly })}>
        <Star className="size-3" /> Marked
      </FilterChip>
      <FilterChip active={filter.triagedOnly} onClick={() => onChange({ ...filter, triagedOnly: !filter.triagedOnly })}>
        <Sparkles className="size-3" /> Triaged
      </FilterChip>
      <FilterChip active={datePreset.id !== "any"} onClick={onCycleDate}>
        <CalendarClock className="size-3" /> {datePreset.label}
      </FilterChip>
      {availableKinds.map((kind) => (
        <FilterChip key={kind} active={filter.kinds.has(kind)} onClick={() => toggleKind(kind)}>
          {kindLabel(kind)}
        </FilterChip>
      ))}
    </div>
  );
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

export function BoardCommandPalette(props: BoardCommandPaletteProps) {
  // Live search state (#124): the typed query drives cmdk's own filtering AND the
  // idea search; the facet filter narrows which ideas are candidates.
  const [query, setQuery] = useState("");
  const [ideaFilter, setIdeaFilter] = useState<IdeaSearchFilter>(EMPTY_IDEA_SEARCH_FILTER);
  const [dateIndex, setDateIndex] = useState(0);

  // Reset the query and facets each time the palette opens, so a fresh Ctrl+K is
  // a clean slate rather than resuming the last search.
  useEffect(() => {
    if (props.open) {
      setQuery("");
      setIdeaFilter(EMPTY_IDEA_SEARCH_FILTER);
      setDateIndex(0);
    }
  }, [props.open]);

  const datePreset = DATE_PRESETS[dateIndex];
  const cycleDate = () => {
    const next = (dateIndex + 1) % DATE_PRESETS.length;
    setDateIndex(next);
    const ms = DATE_PRESETS[next].ms;
    setIdeaFilter((f) => ({ ...f, createdAfter: ms === undefined ? undefined : Date.now() - ms }));
  };

  // Kinds actually present across the gathered ideas — so the facet bar only
  // offers kinds a search could match (mirrors the canvas Filter menu's approach).
  const availableKinds = useMemo(() => {
    const present = new Set<string>();
    for (const idea of props.searchIdeas) {
      const k = normalizeKind(idea.kind);
      if (k) present.add(k);
    }
    return KNOWN_KINDS.filter((k) => present.has(k));
  }, [props.searchIdeas]);

  // Show the Ideas group whenever the user is searching — a keyword OR any active
  // facet counts as an intent to browse ideas.
  const searching = query.trim() !== "" || hasActiveIdeaFilter(ideaFilter);
  const ideaResults = useMemo(
    () => (searching ? searchIdeas(props.searchIdeas, query, ideaFilter, MAX_IDEA_RESULTS) : []),
    [searching, props.searchIdeas, query, ideaFilter]
  );

  const revealIdea = (idea: SearchableIdea) => {
    props.onRevealIdea(idea.workspaceId, idea.shapeId);
    props.onOpenChange(false);
  };

  const noWorkspace = props.active ? undefined : "Create or switch to a workspace first.";
  const boardUnavailable = noWorkspace ?? (!props.board.mounted ? "The board is still mounting." : undefined);
  const emptyBoard = boardUnavailable ?? (props.board.cardCount === 0 ? "The board is empty." : undefined);
  const noSession = noWorkspace ?? (!props.attached ? "Start a session first." : undefined);
  const noSessionOrEmpty = noSession ?? emptyBoard;

  const actions = useMemo<CommandAction[]>(() => {
    const filter = props.board.filter;
    const activeFilter = hasActiveFilter(filter);

    return [
      {
        id: "new-idea",
        group: "Board",
        label: "New idea",
        hint: "Create a user idea card in the center of the visible board.",
        icon: Plus,
        disabledReason: boardUnavailable,
        run: props.onNewIdea
      },
      {
        id: props.attached ? "stop-session" : "start-session",
        group: "Session",
        label: props.attached ? "Stop session" : "Start session",
        hint: props.attached
          ? "Stop the attached terminal session for this workspace."
          : "Attach or resume the terminal session for this workspace.",
        icon: props.attached ? Square : Play,
        disabledReason: noWorkspace,
        run: props.attached ? props.onStopSession : props.onStartSession
      },
      {
        id: "triage",
        group: "Agent",
        label: "Triage board",
        hint: "Ask the live agent to score every idea for impact, effort, and confidence.",
        keywords: ["rate", "score", "prioritize"],
        icon: Sparkles,
        disabledReason: noSessionOrEmpty,
        run: props.onTriage
      },
      {
        id: "synthesize",
        group: "Agent",
        label: "Synthesize board",
        hint: "Read the current board into themes, decisions, questions, and highlights.",
        keywords: ["summary", "converge"],
        icon: LayoutList,
        disabledReason: emptyBoard,
        run: props.onSynthesize
      },
      {
        id: "handoff",
        group: "Agent",
        label: "Hand off board / selection",
        hint: "Pick a format — PRD, implementation plan, GitHub issues, or agent tasks — and generate it from the board.",
        keywords: ["spec", "prd", "export", "plan", "issues", "tasks"],
        icon: FileOutput,
        disabledReason: emptyBoard,
        run: props.onHandoff
      },
      {
        id: "toggle-focus-mode",
        group: "View",
        label: props.focusMode ? "Exit focus mode" : "Focus mode",
        hint: props.focusMode
          ? "Return to the full canvas and app chrome."
          : "Go fullscreen and show only the selected card(s)' cluster (#131).",
        keywords: ["fullscreen", "zen", "distraction-free", "cluster"],
        icon: props.focusMode ? X : Maximize2,
        disabledReason: boardUnavailable,
        run: props.onToggleFocusMode
      },
      {
        id: "arrange-mind-map",
        group: "Arrange",
        label: "Arrange mind map",
        hint: "Reflow ideas into the existing relationship-based mind map layout.",
        keywords: ["layout", "cluster"],
        icon: Workflow,
        disabledReason: emptyBoard,
        run: props.onArrangeMindMap
      },
      {
        id: "arrange-priority-grid",
        group: "Arrange",
        label: "Arrange priority grid",
        hint: "Reflow ideas into the existing impact and effort grid.",
        keywords: ["layout", "impact", "effort"],
        icon: Grid2X2,
        disabledReason: emptyBoard,
        run: props.onArrangePriorityGrid
      },
      {
        id: "filter-ai",
        group: "Filters",
        label: filter.origin === "ai" ? "Show all origins" : "Show AI ideas only",
        hint: "Toggle the same origin filter used by the canvas Filter menu.",
        icon: Filter,
        disabledReason: boardUnavailable ?? (!props.board.facets.hasAi ? "No AI ideas on this board." : undefined),
        run: () => props.onPatchFilter({ origin: filter.origin === "ai" ? "all" : "ai" })
      },
      {
        id: "filter-user",
        group: "Filters",
        label: filter.origin === "user" ? "Show all origins" : "Show user ideas only",
        hint: "Toggle user-origin idea filtering.",
        icon: Filter,
        disabledReason: boardUnavailable ?? (!props.board.facets.hasUser ? "No user ideas on this board." : undefined),
        run: () => props.onPatchFilter({ origin: filter.origin === "user" ? "all" : "user" })
      },
      {
        id: "filter-marked",
        group: "Filters",
        label: filter.markedOnly ? "Show all ideas" : "Show marked ideas only",
        hint: "Toggle the marked-only board filter.",
        icon: Filter,
        disabledReason:
          boardUnavailable ?? (!props.board.facets.hasMarked ? "No marked ideas on this board." : undefined),
        run: () => props.onPatchFilter({ markedOnly: !filter.markedOnly })
      },
      {
        id: "filter-triaged",
        group: "Filters",
        label: filter.triagedOnly ? "Show all ideas" : "Show triaged ideas only",
        hint: "Toggle the triaged-only board filter.",
        icon: Filter,
        disabledReason:
          boardUnavailable ?? (!props.board.facets.hasTriaged ? "No triaged ideas on this board yet." : undefined),
        run: () => props.onPatchFilter({ triagedOnly: !filter.triagedOnly })
      },
      {
        id: "filter-superseded",
        group: "Filters",
        label: filter.showSuperseded ? "Hide superseded ideas" : "Show superseded ideas",
        hint: "Toggle superseded idea visibility.",
        icon: Filter,
        disabledReason:
          boardUnavailable ?? (!props.board.facets.hasSuperseded ? "No superseded ideas on this board." : undefined),
        run: () => props.onPatchFilter({ showSuperseded: !filter.showSuperseded })
      },
      {
        id: "filter-clear",
        group: "Filters",
        label: "Clear filters",
        hint: "Reset every board filter to visible.",
        icon: ListRestart,
        disabledReason: boardUnavailable ?? (!activeFilter ? "No filters are active." : undefined),
        run: props.onClearFilters
      },
      {
        id: "settings",
        group: "App",
        label: "Open settings",
        hint: "Open appearance settings for this device.",
        icon: Settings,
        run: props.onOpenSettings
      },
      ...props.workspaces.map<CommandAction>((ws) => ({
        id: `workspace-${ws.id}`,
        group: "Workspaces",
        label: `Switch workspace: ${ws.title}`,
        hint: `Open ${ws.title}. Current status: ${ws.status}.`,
        keywords: ["switch workspace", ws.status],
        icon: Workflow,
        disabledReason: ws.id === props.active?.id ? "Already viewing this workspace." : undefined,
        run: () => props.onSwitchWorkspace(ws.id)
      }))
    ];
  }, [boardUnavailable, emptyBoard, noSessionOrEmpty, noWorkspace, props]);

  const groups = useMemo(() => {
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
  }, [actions]);

  const run = (action: CommandAction) => {
    if (action.disabledReason) return;
    action.run();
    props.onOpenChange(false);
  };

  return (
    <CommandDialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title="Command palette"
      description="Search and run board commands."
    >
      <CommandInput placeholder="Search commands and ideas..." value={query} onValueChange={setQuery} />
      {props.searchIdeas.length > 0 && (
        <IdeaFilterBar
          filter={ideaFilter}
          onChange={setIdeaFilter}
          availableKinds={availableKinds}
          datePreset={datePreset}
          onCycleDate={cycleDate}
        />
      )}
      <CommandList>
        <CommandEmpty>No commands or ideas found.</CommandEmpty>
        {ideaResults.length > 0 && (
          <CommandGroup heading="Ideas">
            {ideaResults.map(({ idea }) => {
              const kind = normalizeKind(idea.kind);
              const meta = [idea.workspaceTitle, kind ? kindLabel(kind) : null, idea.superseded ? "superseded" : null]
                .filter(Boolean)
                .join(" · ");
              return (
                <CommandItem
                  key={`${idea.workspaceId}:${idea.shapeId}`}
                  // Value carries the searchable text (so cmdk keeps it) plus a
                  // unique workspace:shape suffix for stable item identity.
                  value={[idea.title, idea.body, kind, idea.workspaceTitle, idea.workspaceId, idea.shapeId].join(" ")}
                  onSelect={() => revealIdea(idea)}
                >
                  {idea.origin === "ai" ? <Bot /> : <Lightbulb />}
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{idea.title || "Untitled idea"}</span>
                    <span className="truncate text-xs text-muted-foreground">{meta}</span>
                  </div>
                  {idea.starred ? <Star className="size-3.5 shrink-0 fill-current text-amber-500" /> : null}
                </CommandItem>
              );
            })}
          </CommandGroup>
        )}
        {groups.map(([group, groupActions]) => (
          <CommandGroup key={group} heading={group}>
            {groupActions.map((action) => {
              const Icon = action.icon;
              const disabled = !!action.disabledReason;
              return (
                <CommandItem
                  key={action.id}
                  disabled={disabled}
                  value={[action.label, action.hint, action.group, ...(action.keywords ?? [])].join(" ")}
                  onSelect={() => run(action)}
                >
                  <Icon />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{action.label}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {disabled ? `Unavailable: ${action.disabledReason}` : action.hint}
                    </span>
                  </div>
                </CommandItem>
              );
            })}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  );
}
