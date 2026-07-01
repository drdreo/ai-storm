import { useCallback, useState } from 'react'
import { Plus, MoreHorizontal, ChevronDown, Settings } from 'lucide-react'
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
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useWorkspaceStore, workspace } from '../stores/workspace.store'
import { useBackendStore } from '../stores/backend.store'
import { ingestion } from '../stores/ingestion.store'
import { SettingsDialog } from './SettingsDialog'
import type { WorkspaceMeta, WorkspaceStatus } from '../core/models'

/**
 * Status → dot styling. Each state carries a NON-COLOR channel too (WCAG 1.4.1):
 * idle is a hollow ring, active a solid disc, streaming a pulsing disc, and error
 * a solid square — so the state is legible without relying on hue alone.
 */
const STATUS_DOT: Record<WorkspaceStatus, string> = {
  idle: 'rounded-full border border-muted-foreground/50',
  active: 'rounded-full bg-emerald-500',
  streaming: 'rounded-full bg-sky-500 animate-pulse ring-2 ring-sky-500/30',
  error: 'rounded-[2px] bg-destructive',
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
export function Sidebar({
  settingsOpen,
  onSettingsOpenChange,
}: {
  settingsOpen: boolean
  onSettingsOpenChange: (open: boolean) => void
}) {
  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const activeId = useWorkspaceStore((s) => s.activeId)
  const connState = useBackendStore((s) => s.state)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<WorkspaceMeta | null>(null)

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

  // Deleting a workspace drops its canvas + IndexedDB store for good, so the
  // kebab only *requests* deletion (opens a themed confirm dialog, audit H5);
  // the irreversible work runs on explicit confirm, never on window.confirm.
  const confirmDelete = () => {
    if (!deleteTarget) return
    ingestion.detach(deleteTarget.id)
    void workspace.remove(deleteTarget.id)
    setDeleteTarget(null)
  }

  return (
    <UISidebar variant="inset" collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            {/* Presentational brand mark — not interactive, so render as a div
                (audit H4): a real <button> with no action is a confusing focus
                stop and a false button role for screen readers. */}
            <SidebarMenuButton asChild size="lg" className="cursor-default hover:bg-transparent">
              <div>
                <img src="/assets/logo.png" alt="" className="size-8 rounded-lg" />
                <div className="grid flex-1 text-left leading-tight">
                  <span className="truncate font-semibold">ai-storm</span>
                  <span className="truncate text-xs text-muted-foreground">
                    brainstorm workspace
                  </span>
                </div>
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
                            <span className={cn('size-2', STATUS_DOT[ws.status])} />
                          </span>
                          <span className="truncate">{ws.title}</span>
                          <span className="sr-only">— {ws.status}</span>
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
                              onSelect={() => setDeleteTarget(ws)}
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
            {/* Connection readout, not a control — render as a div (audit H4). */}
            <SidebarMenuButton
              asChild
              size="sm"
              className="cursor-default hover:bg-transparent"
              tooltip={`backend ${connState}`}
            >
              <div>
                <span className="flex size-4 items-center justify-center">
                  <span className={cn('size-2 rounded-full', CONN_DOT[connState])} />
                </span>
                <span className="truncate text-xs text-muted-foreground">backend {connState}</span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="sm"
              onClick={() => onSettingsOpenChange(true)}
              tooltip="Settings"
            >
              <Settings className="size-4" />
              <span className="truncate text-xs">Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <SettingsDialog open={settingsOpen} onOpenChange={onSettingsOpenChange} />

      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete workspace?</DialogTitle>
            <DialogDescription>
              “{deleteTarget?.title}” and its canvas will be permanently deleted. This can’t be
              undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" size="sm">
                Cancel
              </Button>
            </DialogClose>
            <Button variant="destructive" size="sm" onClick={confirmDelete}>
              Delete workspace
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SidebarRail />
    </UISidebar>
  )
}
