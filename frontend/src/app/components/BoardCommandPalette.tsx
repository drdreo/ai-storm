import { useMemo } from 'react'
import {
  FileOutput,
  Filter,
  Grid2X2,
  LayoutList,
  ListRestart,
  Play,
  Plus,
  Settings,
  Sparkles,
  Square,
  Workflow,
} from 'lucide-react'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import type { WorkspaceMeta } from '../core/models'
import type { BoardFilter } from '../core/canvas/filter'

type CommandIcon = typeof Plus

interface CommandAction {
  id: string
  group: string
  label: string
  hint: string
  keywords?: readonly string[]
  icon: CommandIcon
  disabledReason?: string
  run(): void
}

interface BoardCommandPaletteProps {
  open: boolean
  onOpenChange(open: boolean): void
  active: WorkspaceMeta | null
  workspaces: readonly WorkspaceMeta[]
  attached: boolean
  board: {
    mounted: boolean
    cardCount: number
    facets: {
      hasAi: boolean
      hasUser: boolean
      hasMarked: boolean
      hasSuperseded: boolean
      hasTriaged: boolean
    }
    filter: BoardFilter
  }
  onNewIdea(): void
  onStartSession(): void
  onStopSession(): void
  onTriage(): void
  onSynthesize(): void
  onHandoff(): void
  onArrangeMindMap(): void
  onArrangePriorityGrid(): void
  onPatchFilter(patch: Partial<BoardFilter>): void
  onClearFilters(): void
  onOpenSettings(): void
  onSwitchWorkspace(workspaceId: string): void
}

function hasActiveFilter(filter: BoardFilter): boolean {
  return (
    filter.hiddenKinds.size > 0 ||
    filter.origin !== 'all' ||
    filter.markedOnly ||
    !filter.showSuperseded ||
    filter.triagedOnly
  )
}

export function BoardCommandPalette(props: BoardCommandPaletteProps) {
  const noWorkspace = props.active ? undefined : 'Create or switch to a workspace first.'
  const boardUnavailable =
    noWorkspace ?? (!props.board.mounted ? 'The board is still mounting.' : undefined)
  const emptyBoard = boardUnavailable ?? (props.board.cardCount === 0 ? 'The board is empty.' : undefined)
  const noSession = noWorkspace ?? (!props.attached ? 'Start a session first.' : undefined)
  const noSessionOrEmpty = noSession ?? emptyBoard

  const actions = useMemo<CommandAction[]>(() => {
    const filter = props.board.filter
    const activeFilter = hasActiveFilter(filter)

    return [
      {
        id: 'new-idea',
        group: 'Board',
        label: 'New idea',
        hint: 'Create a user idea card in the center of the visible board.',
        icon: Plus,
        disabledReason: boardUnavailable,
        run: props.onNewIdea,
      },
      {
        id: props.attached ? 'stop-session' : 'start-session',
        group: 'Session',
        label: props.attached ? 'Stop session' : 'Start session',
        hint: props.attached
          ? 'Stop the attached terminal session for this workspace.'
          : 'Attach or resume the terminal session for this workspace.',
        icon: props.attached ? Square : Play,
        disabledReason: noWorkspace,
        run: props.attached ? props.onStopSession : props.onStartSession,
      },
      {
        id: 'triage',
        group: 'Agent',
        label: 'Triage board',
        hint: 'Ask the live agent to score every idea for impact, effort, and confidence.',
        keywords: ['rate', 'score', 'prioritize'],
        icon: Sparkles,
        disabledReason: noSessionOrEmpty,
        run: props.onTriage,
      },
      {
        id: 'synthesize',
        group: 'Agent',
        label: 'Synthesize board',
        hint: 'Read the current board into themes, decisions, questions, and highlights.',
        keywords: ['summary', 'converge'],
        icon: LayoutList,
        disabledReason: emptyBoard,
        run: props.onSynthesize,
      },
      {
        id: 'handoff',
        group: 'Agent',
        label: 'Hand off board / selection',
        hint: 'Generate a spec or PRD from the selection, or the whole board.',
        keywords: ['spec', 'prd', 'export'],
        icon: FileOutput,
        disabledReason: emptyBoard,
        run: props.onHandoff,
      },
      {
        id: 'arrange-mind-map',
        group: 'Arrange',
        label: 'Arrange mind map',
        hint: 'Reflow ideas into the existing relationship-based mind map layout.',
        keywords: ['layout', 'cluster'],
        icon: Workflow,
        disabledReason: emptyBoard,
        run: props.onArrangeMindMap,
      },
      {
        id: 'arrange-priority-grid',
        group: 'Arrange',
        label: 'Arrange priority grid',
        hint: 'Reflow ideas into the existing impact and effort grid.',
        keywords: ['layout', 'impact', 'effort'],
        icon: Grid2X2,
        disabledReason: emptyBoard,
        run: props.onArrangePriorityGrid,
      },
      {
        id: 'filter-ai',
        group: 'Filters',
        label: filter.origin === 'ai' ? 'Show all origins' : 'Show AI ideas only',
        hint: 'Toggle the same origin filter used by the canvas Filter menu.',
        icon: Filter,
        disabledReason: boardUnavailable ?? (!props.board.facets.hasAi ? 'No AI ideas on this board.' : undefined),
        run: () => props.onPatchFilter({ origin: filter.origin === 'ai' ? 'all' : 'ai' }),
      },
      {
        id: 'filter-user',
        group: 'Filters',
        label: filter.origin === 'user' ? 'Show all origins' : 'Show user ideas only',
        hint: 'Toggle user-origin idea filtering.',
        icon: Filter,
        disabledReason:
          boardUnavailable ?? (!props.board.facets.hasUser ? 'No user ideas on this board.' : undefined),
        run: () => props.onPatchFilter({ origin: filter.origin === 'user' ? 'all' : 'user' }),
      },
      {
        id: 'filter-marked',
        group: 'Filters',
        label: filter.markedOnly ? 'Show all ideas' : 'Show marked ideas only',
        hint: 'Toggle the marked-only board filter.',
        icon: Filter,
        disabledReason:
          boardUnavailable ?? (!props.board.facets.hasMarked ? 'No marked ideas on this board.' : undefined),
        run: () => props.onPatchFilter({ markedOnly: !filter.markedOnly }),
      },
      {
        id: 'filter-triaged',
        group: 'Filters',
        label: filter.triagedOnly ? 'Show all ideas' : 'Show triaged ideas only',
        hint: 'Toggle the triaged-only board filter.',
        icon: Filter,
        disabledReason:
          boardUnavailable ??
          (!props.board.facets.hasTriaged ? 'No triaged ideas on this board yet.' : undefined),
        run: () => props.onPatchFilter({ triagedOnly: !filter.triagedOnly }),
      },
      {
        id: 'filter-superseded',
        group: 'Filters',
        label: filter.showSuperseded ? 'Hide superseded ideas' : 'Show superseded ideas',
        hint: 'Toggle superseded idea visibility.',
        icon: Filter,
        disabledReason:
          boardUnavailable ??
          (!props.board.facets.hasSuperseded ? 'No superseded ideas on this board.' : undefined),
        run: () => props.onPatchFilter({ showSuperseded: !filter.showSuperseded }),
      },
      {
        id: 'filter-clear',
        group: 'Filters',
        label: 'Clear filters',
        hint: 'Reset every board filter to visible.',
        icon: ListRestart,
        disabledReason: boardUnavailable ?? (!activeFilter ? 'No filters are active.' : undefined),
        run: props.onClearFilters,
      },
      {
        id: 'settings',
        group: 'App',
        label: 'Open settings',
        hint: 'Open appearance settings for this device.',
        icon: Settings,
        run: props.onOpenSettings,
      },
      ...props.workspaces.map<CommandAction>((ws) => ({
        id: `workspace-${ws.id}`,
        group: 'Workspaces',
        label: `Switch workspace: ${ws.title}`,
        hint: `Open ${ws.title}. Current status: ${ws.status}.`,
        keywords: ['switch workspace', ws.status],
        icon: Workflow,
        disabledReason: ws.id === props.active?.id ? 'Already viewing this workspace.' : undefined,
        run: () => props.onSwitchWorkspace(ws.id),
      })),
    ]
  }, [boardUnavailable, emptyBoard, noSessionOrEmpty, noWorkspace, props])

  const groups = useMemo(() => {
    const order: string[] = []
    const byGroup = new Map<string, CommandAction[]>()
    for (const action of actions) {
      if (!byGroup.has(action.group)) {
        order.push(action.group)
        byGroup.set(action.group, [])
      }
      byGroup.get(action.group)!.push(action)
    }
    return order.map((group) => [group, byGroup.get(group)!] as const)
  }, [actions])

  const run = (action: CommandAction) => {
    if (action.disabledReason) return
    action.run()
    props.onOpenChange(false)
  }

  return (
    <CommandDialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title="Command palette"
      description="Search and run board commands."
    >
      <CommandInput placeholder="Search commands..." />
      <CommandList>
        <CommandEmpty>No commands found.</CommandEmpty>
        {groups.map(([group, groupActions]) => (
          <CommandGroup key={group} heading={group}>
            {groupActions.map((action) => {
              const Icon = action.icon
              const disabled = !!action.disabledReason
              return (
                <CommandItem
                  key={action.id}
                  disabled={disabled}
                  value={[action.label, action.hint, action.group, ...(action.keywords ?? [])].join(' ')}
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
              )
            })}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  )
}
