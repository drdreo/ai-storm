import { useCallback, useState } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useWorkspaceStore, workspace } from '../stores/workspace.store'
import { ingestion } from '../stores/ingestion.store'
import type { WorkspaceMeta } from '../core/models'

/**
 * Global navigation sidebar (PRD §3.4). Lists every workspace with a
 * human-readable title and live status, and performs the sub-100ms hot-switch
 * by simply changing the active id — the canvas + terminal rebind off the store.
 *
 * Workspace management lives on the rows themselves (no bottom buttons): a
 * double-click on the title (or the kebab's "Rename") turns it into an inline
 * input, and a per-row kebab (⋮) opens a Radix `DropdownMenu` (shadcn) to rename
 * or delete. New workspaces are created from the header "+". The nav is a styled
 * roving-tabindex listbox (replacing `@angular/aria` Listbox; PD-018).
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

  const select = (id: string) => workspace.setActive(id)

  // Roving keyboard nav with selection-follows-focus (the sub-100ms hot-switch).
  const onListKey = (event: React.KeyboardEvent) => {
    if (editingId) return
    const idx = workspaces.findIndex((w) => w.id === activeId)
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      const next = workspaces[Math.min(idx + 1, workspaces.length - 1)]
      if (next) select(next.id)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      const prev = workspaces[Math.max(idx - 1, 0)]
      if (prev) select(prev.id)
    }
  }

  // ---- Inline rename ------------------------------------------------------

  const beginRename = (ws: WorkspaceMeta) => setEditingId(ws.id)

  const commitRename = (ws: WorkspaceMeta, value: string) => {
    // Only the active edit commits — guards the blur fired by Esc/Enter teardown.
    if (editingId !== ws.id) return
    const title = value.trim()
    if (title && title !== ws.title) workspace.rename(ws.id, title)
    setEditingId(null)
  }

  const onRenameKey = (event: React.KeyboardEvent<HTMLInputElement>, ws: WorkspaceMeta) => {
    event.stopPropagation()
    if (event.key === 'Enter') {
      event.preventDefault()
      commitRename(ws, event.currentTarget.value)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      setEditingId(null) // discard — no rename
    }
  }

  const remove = (id: string) => {
    if (!confirm('Delete this workspace and its canvas? This cannot be undone.')) return
    // Detach first so the durable session is left intact (PRD §3.5); remove()
    // recreates a workspace if this was the last one.
    ingestion.detach(id)
    void workspace.remove(id)
  }

  return (
    <div className="flex h-full select-none flex-col border-r border-border-base bg-sidebar">
      <header className="flex items-center justify-between border-b border-border-base px-4 pb-3 pt-4">
        <span className="inline-flex items-center gap-2 text-[0.95rem] font-bold tracking-[-0.01em] text-text before:h-[9px] before:w-[9px] before:rounded-[3px] before:bg-[linear-gradient(135deg,var(--accent),var(--accent-press))] before:shadow-[0_0_0_3px_var(--accent-soft)] before:content-['']">
          ai-storm
        </span>
        <button
          className="grid h-7 w-7 place-items-center rounded-md border border-border-strong bg-btn text-[17px] leading-none text-text-dim transition-all hover:border-accent hover:bg-btn-hover hover:text-text active:scale-90 active:bg-btn-press focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-accent-ring"
          title="New workspace"
          aria-label="New workspace"
          onClick={add}
        >
          +
        </button>
      </header>

      <ul
        className="m-0 flex flex-1 list-none flex-col gap-0.5 overflow-y-auto p-2 focus:outline-none"
        role="listbox"
        aria-label="Workspaces"
        tabIndex={0}
        onKeyDown={onListKey}
      >
        {workspaces.map((ws) => {
          const isActive = ws.id === activeId
          const editing = editingId === ws.id
          return (
            <li
              key={ws.id}
              role="option"
              aria-selected={isActive}
              aria-label={ws.title}
              onClick={() => !editing && select(ws.id)}
              className={`group relative grid cursor-pointer grid-cols-[10px_1fr_auto_auto] items-center gap-2 rounded-lg px-[0.6rem] py-2 text-left text-[0.86rem] transition-colors ${
                isActive
                  ? 'as-rail bg-accent-soft font-medium text-text'
                  : 'text-text-dim hover:bg-overlay hover:text-text'
              }`}
            >
              <span className="as-dot" data-status={ws.status} />
              {editing ? (
                // Inline rename: commits on Enter/blur, cancels on Esc.
                <input
                  ref={renameInputRef}
                  className="-my-[0.16rem] w-full min-w-0 rounded-md border border-accent bg-input px-[0.35rem] py-[0.15rem] text-[0.86rem] text-text focus:outline-none focus:ring-3 focus:ring-accent-ring"
                  type="text"
                  defaultValue={ws.title}
                  aria-label="Rename workspace"
                  onKeyDown={(e) => onRenameKey(e, ws)}
                  onBlur={(e) => commitRename(ws, e.currentTarget.value)}
                  onClick={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                />
              ) : (
                <span
                  className="overflow-hidden text-ellipsis whitespace-nowrap tracking-[-0.005em]"
                  title={ws.title}
                  onDoubleClick={(e) => {
                    e.stopPropagation()
                    beginRename(ws)
                  }}
                >
                  {ws.title}
                </span>
              )}
              {!editing && (
                <span
                  className={`text-[0.62rem] font-semibold uppercase tracking-[0.06em] ${isActive ? 'text-accent opacity-90' : 'opacity-55'}`}
                >
                  {ws.status}
                </span>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    className={`grid h-[22px] w-[22px] place-items-center rounded-md border border-transparent bg-transparent text-[15px] leading-none text-text-dim transition-all hover:border-border-strong hover:bg-btn-hover hover:text-text focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-accent-ring aria-expanded:border-accent aria-expanded:bg-btn-press aria-expanded:text-text aria-expanded:opacity-100 ${isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                    aria-label={`Manage ${ws.title}`}
                    onClick={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => e.stopPropagation()}
                  >
                    <span aria-hidden="true">⋮</span>
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[156px]">
                  <DropdownMenuItem
                    onSelect={() => beginRename(ws)}
                    onClick={(e) => e.stopPropagation()}
                  >
                    Rename
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => remove(ws.id)}
                    onClick={(e) => e.stopPropagation()}
                  >
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
