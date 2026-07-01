import { create } from 'zustand'
import * as Y from 'yjs'
import { IndexeddbPersistence } from 'y-indexeddb'
import { canvas } from './canvas.store'
import {
  defaultTerminalConfig,
  defaultWorkspaceColor,
  type WorkspaceMeta,
  type WorkspaceStatus,
} from '../core/models'
import { buildExportBundle, type WorkspaceExportBundle } from '../core/workspace-portable'

const REGISTRY_ROOM = 'ai-storm-registry'
const ACTIVE_KEY = 'ai-storm.activeWorkspace'

/**
 * Multi-workspace registry & lifecycle (PRD §3.4, §3.5).
 *
 * Workspace metadata is stored in a dedicated CRDT Y.Doc persisted to its own
 * IndexedDB store, so every change (title, status) is written immediately and
 * survives crashes. The canvas content for each workspace is owned by the
 * {@link canvas} controller (a tldraw store per workspace). On boot we
 * rehydrate both layers and restore the most recently active workspace exactly
 * as it was left.
 *
 * This is a 1:1 port of the Angular `WorkspaceService`: signals → Zustand state,
 * the Y.Doc/persistence are imperative module singletons.
 */

interface WorkspaceState {
  workspaces: WorkspaceMeta[]
  activeId: string | null
  booted: boolean
}

export const useWorkspaceStore = create<WorkspaceState>(() => ({
  workspaces: [],
  activeId: null,
  booted: false,
}))

/** Derived selector: the active workspace meta (or null). */
export function selectActive(s: WorkspaceState): WorkspaceMeta | null {
  return s.activeId ? s.workspaces.find((w) => w.id === s.activeId) ?? null : null
}

// ---- Imperative CRDT singletons (outside React) ----------------------------

const registryDoc = new Y.Doc()
let registryPersistence: IndexeddbPersistence
let map: Y.Map<WorkspaceMeta>

function syncFromMap(): void {
  const list: WorkspaceMeta[] = []
  map.forEach((meta) => list.push(meta))
  list.sort((a, b) => a.createdAt - b.createdAt)
  useWorkspaceStore.setState({ workspaces: list })
}

function write(meta: WorkspaceMeta): void {
  // Structured-clone a plain object into the CRDT map (writes immediately).
  map.set(meta.id, { ...meta, terminal: { ...meta.terminal } })
}

export const workspace = {
  /** Boot sequence (PRD §3.5): rehydrate CRDT stores, restore last workspace. */
  async boot(): Promise<void> {
    if (useWorkspaceStore.getState().booted) return
    await canvas.init()

    map = registryDoc.getMap<WorkspaceMeta>('workspaces')
    registryPersistence = new IndexeddbPersistence(REGISTRY_ROOM, registryDoc)
    await new Promise<void>((resolve) => {
      registryPersistence.once('synced', () => resolve())
    })

    // Keep state in sync with the CRDT registry (immediate writes §3.5).
    map.observe(() => syncFromMap())
    syncFromMap()

    const workspaces = useWorkspaceStore.getState().workspaces
    if (workspaces.length === 0) {
      // First run — stand up a starter workspace.
      const id = workspace.create('Untitled Project')
      workspace.setActive(id)
    } else {
      // Restore the most recently active workspace.
      const stored = localStorage.getItem(ACTIVE_KEY)
      const exists = stored && workspaces.some((w) => w.id === stored)
      const fallback = [...workspaces].sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0]
      workspace.setActive(exists ? stored! : fallback.id)
    }

    // Let the canvas settle before rendering the panes (PRD §3.5 boot). tldraw
    // loads the active workspace's store on mount, so this is a cheap no-op kept
    // for parity / future async restore.
    const active = useWorkspaceStore.getState().activeId
    if (active) await canvas.ensureReady(active)

    useWorkspaceStore.setState({ booted: true })
  },

  create(title: string): string {
    const id = `ws_${crypto.randomUUID()}`
    const now = Date.now()
    const meta: WorkspaceMeta = {
      id,
      title,
      status: 'idle',
      createdAt: now,
      lastActiveAt: now,
      terminal: defaultTerminalConfig(),
      color: defaultWorkspaceColor(id),
    }
    write(meta)
    return id
  },

  rename(id: string, title: string): void {
    const meta = map.get(id)
    if (!meta) return
    write({ ...meta, title })
  },

  setStatus(id: string, status: WorkspaceStatus): void {
    const meta = map.get(id)
    if (meta && meta.status !== status) write({ ...meta, status })
  },

  setColor(id: string, color: string): void {
    const meta = map.get(id)
    if (meta && meta.color !== color) write({ ...meta, color })
  },

  patchTerminal(id: string, patch: Partial<WorkspaceMeta['terminal']>): void {
    const meta = map.get(id)
    if (meta) write({ ...meta, terminal: { ...meta.terminal, ...patch } })
  },

  setActive(id: string): void {
    if (useWorkspaceStore.getState().activeId === id) return
    useWorkspaceStore.setState({ activeId: id })
    localStorage.setItem(ACTIVE_KEY, id)
    const meta = map.get(id)
    if (meta) write({ ...meta, lastActiveAt: Date.now() })
  },

  async remove(id: string): Promise<void> {
    const wasActive = useWorkspaceStore.getState().activeId === id
    let target = useWorkspaceStore.getState().workspaces.find((w) => w.id !== id) ?? null
    if (wasActive && !target) {
      // Deleting the last workspace — stand up a replacement to switch onto.
      const fresh = workspace.create('Untitled Project')
      target = map.get(fresh) ?? null
    }

    // When deleting the ACTIVE workspace, switch the canvas onto the target
    // workspace's store before dropping the deleted one's persisted store.
    if (wasActive && target) {
      await canvas.ensureReady(target.id)
      workspace.setActive(target.id)
      canvas.switchTo(target.id)
    }

    map.delete(id)
    canvas.removeWorkspace(id)
  },

  /**
   * Export a workspace to a portable bundle (#105). Reading the board requires a
   * live editor, so a non-active workspace is switched onto first (an export
   * click opens/activates that workspace, same as clicking its sidebar row).
   */
  async exportBundle(id: string): Promise<WorkspaceExportBundle | null> {
    const meta = map.get(id)
    if (!meta) return null
    if (useWorkspaceStore.getState().activeId !== id) {
      workspace.setActive(id)
      canvas.switchTo(id)
    }
    await canvas.waitForMount(id)
    const board = canvas.exportBoard(id)
    if (!board) return null
    return buildExportBundle(meta, board)
  },

  /**
   * Import a bundle as a brand-new workspace (#105) — never overwrites an
   * existing one. Standing up + activating the workspace mirrors `create` +
   * `setActive`; the imported board is rendered once its (fresh, empty) editor
   * mounts.
   */
  async importBundle(bundle: WorkspaceExportBundle): Promise<string> {
    const id = workspace.create(bundle.workspace.title)
    const meta = map.get(id)!
    write({
      ...meta,
      color: bundle.workspace.color ?? meta.color,
      terminal: { ...meta.terminal, ...bundle.workspace.terminal },
    })
    workspace.setActive(id)
    canvas.switchTo(id)
    await canvas.waitForMount(id)
    canvas.importBoard(id, bundle.board)
    return id
  },
}
