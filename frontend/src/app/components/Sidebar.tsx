import { useCallback, useState } from 'react'
import { Plus, MoreHorizontal, Sparkles, ChevronDown } from 'lucide-react'
import {
  Sidebar as UISidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@/components/ui/sidebar'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { useWorkspaceStore, workspace } from '../stores/workspace.store'
import { useBackendStore } from '../stores/backend.store'
import { ingestion } from '../stores/ingestion.store'
import type { WorkspaceMeta, WorkspaceStatus } from '../core/models'

/** Status → dot color (Tailwind utilities; theming comes later). */
const STATUS_DOT: Record<WorkspaceStatus, string> = {
  idle: 'bg-muted-foreground/40',
  active: 'bg-emerald-500',
  streaming: 'bg-sky-500 animate-pulse',
  error: 'bg-destructive',
}

const CONN_DOT: Record<string, string> = {
  open: 'bg-emerald-500',
  connecting: 'bg-amber-500 animate-pulse',
  closed: 'bg-destructive',
}

/**
 * Global navigation sidebar (PRD §3.4), built on shadcn's app-sidebar
 * composition: an inset, icon-collapsible Sidebar with a branded header, a
 * collapsible "Workspaces" group whose action (+) creates a workspace, a rail
 * toggle, and a footer showing the backend connection. Entries are stock
 * SidebarMenuButtons (default styling + the built-in active indicator). The
 * per-row kebab is a Radix DropdownMenu; rename is an inline input.
 */
export function Sidebar() {
  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const activeId = useWorkspaceStore((s) => s.activeId)
  const connState = useBackendStore((s) => s.state)
  const [editingId, setEditingId] = useState<string | null>(null)

  /** Focus (and select) the freshly-rendered inline rename input. */
  const renameInputRef = useCallback((el: HTMLInputElement | null) => {
    if (el) {
      el.focus()
      el.select()
    }
  }, [])

  const add = () => {
    const id = workspace.create('Untitled Project')
    workspace.setActive(id)
  }

  const commitRename = (ws: WorkspaceMeta, value: string) => {
    if (editingId !== ws.id) return
    const title = value.trim()
    if (title && title !== ws.title) workspace.rename(ws.id, title)
    setEditingId(null)
  }

  const onRenameKey = (e: React.KeyboardEvent<HTMLInputElement>, ws: WorkspaceMeta) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commitRename(ws, e.currentTarget.value)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setEditingId(null)
    }
  }

  const remove = (id: string) => {
    if (!confirm('Delete this workspace and its canvas? This cannot be undone.')) return
    ingestion.detach(id)
    void workspace.remove(id)
  }

  return (
    <UISidebar variant="inset" collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" className="cursor-default hover:bg-transparent">
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                <Sparkles className="size-4" />
              </div>
              <div className="grid flex-1 text-left leading-tight">
                <span className="truncate font-semibold">ai-storm</span>
                <span className="truncate text-xs text-muted-foreground">brainstorm workspace</span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <Collapsible defaultOpen className="group/collapsible">
          <SidebarGroup>
            <SidebarGroupLabel asChild>
              <CollapsibleTrigger className="w-full">
                Workspaces
                <ChevronDown className="ml-1 size-3.5 transition-transform group-data-[state=closed]/collapsible:-rotate-90" />
              </CollapsibleTrigger>
            </SidebarGroupLabel>
            <SidebarGroupAction title="New workspace" aria-label="New workspace" onClick={add}>
              <Plus /> <span className="sr-only">New workspace</span>
            </SidebarGroupAction>
            <CollapsibleContent>
              <SidebarGroupContent>
                <SidebarMenu>
                  {workspaces.map((ws) => {
                    const isActive = ws.id === activeId
                    if (editingId === ws.id) {
                      return (
                        <SidebarMenuItem key={ws.id}>
                          <SidebarInput
                            ref={renameInputRef}
                            defaultValue={ws.title}
                            aria-label="Rename workspace"
                            onKeyDown={(e) => onRenameKey(e, ws)}
                            onBlur={(e) => commitRename(ws, e.currentTarget.value)}
                          />
                        </SidebarMenuItem>
                      )
                    }
                    return (
                      <SidebarMenuItem key={ws.id}>
                        <SidebarMenuButton
                          isActive={isActive}
                          onClick={() => workspace.setActive(ws.id)}
                          onDoubleClick={() => setEditingId(ws.id)}
                          tooltip={`${ws.title} · ${ws.status}`}
                        >
                          <span className="flex size-4 items-center justify-center">
                            <span className={cn('size-2 rounded-full', STATUS_DOT[ws.status])} />
                          </span>
                          <span className="truncate">{ws.title}</span>
                        </SidebarMenuButton>

                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <SidebarMenuAction showOnHover aria-label={`Manage ${ws.title}`}>
                              <MoreHorizontal />
                            </SidebarMenuAction>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent side="right" align="start" className="min-w-[156px]">
                            <DropdownMenuItem onSelect={() => setEditingId(ws.id)}>
                              Rename
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              variant="destructive"
                              onSelect={() => remove(ws.id)}
                            >
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </SidebarMenuItem>
                    )
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </CollapsibleContent>
          </SidebarGroup>
        </Collapsible>

       
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="sm"
              className="cursor-default hover:bg-transparent"
              tooltip={`backend ${connState}`}
            >
              <span className="flex size-4 items-center justify-center">
                <span className={cn('size-2 rounded-full', CONN_DOT[connState])} />
              </span>
              <span className="truncate text-xs text-muted-foreground">backend {connState}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <SidebarRail />
    </UISidebar>
  )
}
