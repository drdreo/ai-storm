import { useCallback, useState } from 'react'
import { Plus, MoreVertical } from 'lucide-react'
import {
  Sidebar as UISidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInput,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { useWorkspaceStore, workspace } from '../stores/workspace.store'
import { ingestion } from '../stores/ingestion.store'
import type { WorkspaceMeta, WorkspaceStatus } from '../core/models'

/** Status → dot color (Tailwind utilities; theming comes later). */
const STATUS_DOT: Record<WorkspaceStatus, string> = {
  idle: 'bg-muted-foreground/40',
  active: 'bg-emerald-500',
  streaming: 'bg-sky-500 animate-pulse',
  error: 'bg-destructive',
}

/**
 * Global navigation sidebar (PRD §3.4). Lists every workspace with a title and
 * live status, and performs the sub-100ms hot-switch by changing the active id.
 * Built on shadcn's Sidebar primitives; the per-row kebab is a Radix
 * DropdownMenu and rename is an inline SidebarInput.
 */
export function Sidebar() {
  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const activeId = useWorkspaceStore((s) => s.activeId)
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
    <UISidebar collapsible="none" className="border-r">
      <SidebarHeader className="flex-row items-center justify-between gap-2 px-3 py-3">
        <span className="flex items-center gap-2 text-sm font-semibold">
          <span className="size-2.5 rounded-sm bg-primary" />
          ai-storm
        </span>
        <Button
          size="icon"
          variant="outline"
          className="size-7"
          title="New workspace"
          aria-label="New workspace"
          onClick={add}
        >
          <Plus />
        </Button>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {workspaces.map((ws) => {
                const isActive = ws.id === activeId
                const editing = editingId === ws.id
                return (
                  <SidebarMenuItem key={ws.id}>
                    {editing ? (
                      <SidebarInput
                        ref={renameInputRef}
                        defaultValue={ws.title}
                        aria-label="Rename workspace"
                        onKeyDown={(e) => onRenameKey(e, ws)}
                        onBlur={(e) => commitRename(ws, e.currentTarget.value)}
                      />
                    ) : (
                      <>
                        <SidebarMenuButton
                          isActive={isActive}
                          onClick={() => workspace.setActive(ws.id)}
                          onDoubleClick={() => setEditingId(ws.id)}
                          tooltip={ws.title}
                        >
                          <span
                            className={cn('size-2 shrink-0 rounded-full', STATUS_DOT[ws.status])}
                          />
                          <span className="truncate">{ws.title}</span>
                        </SidebarMenuButton>
                        <SidebarMenuBadge className="right-8 text-[0.62rem] uppercase tracking-wide">
                          {ws.status}
                        </SidebarMenuBadge>

                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <SidebarMenuAction
                              showOnHover
                              aria-label={`Manage ${ws.title}`}
                            >
                              <MoreVertical />
                            </SidebarMenuAction>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent side="right" align="start" className="min-w-[156px]">
                            <DropdownMenuItem onSelect={() => setEditingId(ws.id)}>
                              Rename
                            </DropdownMenuItem>
                            <DropdownMenuItem variant="destructive" onSelect={() => remove(ws.id)}>
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </>
                    )}
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </UISidebar>
  )
}
