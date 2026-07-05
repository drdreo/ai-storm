/**
 * The board command palette (Ctrl+K, #96) — the view layer only. The action
 * catalog lives in {@link buildCommandActions}, the facet bar in
 * {@link IdeaFilterBar}, and the shared types in `command-palette/types`.
 */
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut
} from "@/components/ui/command";
import { Bot, Lightbulb, Star } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { BoardFilter } from "../../core/canvas/filter";
import {
  EMPTY_IDEA_SEARCH_FILTER,
  hasActiveIdeaFilter,
  type IdeaSearchFilter,
  type SearchableIdea,
  searchIdeas
} from "../../core/canvas/search";
import { kindLabel, KNOWN_KINDS, normalizeKind } from "../../core/idea-descriptors";
import type { ProjectMeta } from "@ai-storm/shared";
import { buildCommandActions, groupActions } from "./actions";
import { DATE_PRESETS, IdeaFilterBar } from "./IdeaFilterBar";
import type { BoardCommandState, CommandAction } from "./types";

interface BoardCommandPaletteProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  active: ProjectMeta | null;
  projects: readonly ProjectMeta[];
  attached: boolean;
  board: BoardCommandState;
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
  onSwitchProject(projectId: string): void;
  focusMode: boolean;
  onToggleFocusMode(): void;
  /** Ideas gathered across every project for full-text search (#124). */
  searchIdeas: readonly SearchableIdea[];
  /** Open a search result's project and pan/zoom to the card (#124). */
  onRevealIdea(projectId: string, shapeId: string): void;
}

const MAX_IDEA_RESULTS = 12;

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
    props.onRevealIdea(idea.projectId, idea.shapeId);
    props.onOpenChange(false);
  };

  const actions = useMemo(() => buildCommandActions(props), [props]);
  const groups = useMemo(() => groupActions(actions), [actions]);

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
              const meta = [idea.projectTitle, kind ? kindLabel(kind) : null, idea.superseded ? "superseded" : null]
                .filter(Boolean)
                .join(" · ");
              return (
                <CommandItem
                  key={`${idea.projectId}:${idea.shapeId}`}
                  // Value carries the searchable text (so cmdk keeps it) plus a
                  // unique project:shape suffix for stable item identity.
                  value={[idea.title, idea.body, kind, idea.projectTitle, idea.projectId, idea.shapeId].join(" ")}
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
                  {action.shortcut && !disabled && <CommandShortcut>{action.shortcut}</CommandShortcut>}
                </CommandItem>
              );
            })}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  );
}
