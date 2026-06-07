import { create } from 'zustand'
import type { Editor } from 'tldraw'
import type { Idea, Score } from '@ai-storm/shared'
import type { PromptIntent } from '../core/prompt-framing'
import {
  type CanvasBridge,
  applyIdeas as islandApplyIdeas,
  serializeEditor,
  serializeForTriage,
  applyScore as islandApplyScore,
  selectedText,
  collectBoard,
} from '../core/canvas-island'
import { synthesizeBoard, type ConvergentSummary } from '../core/synthesis'

/**
 * tldraw canvas controller (PRD §3.1, §3.3, §3.6) — the imperative seam over the
 * React {@link CanvasIsland} that holds the tldraw `Editor`.
 *
 * This replaces the old Angular `CanvasService` facade. With React there is no
 * `createRoot`/`render` plumbing here: `CanvasPane` renders `<CanvasIsland>`
 * directly (keyed by workspace id), and this module just holds the live editor
 * handle so the framework-agnostic ingestion/agent stores — which run *outside*
 * the component tree — can drive the canvas. The reactive surface (`ready`,
 * `ideasTick`) is a tiny Zustand store the canvas toolbar subscribes to; the
 * tldraw store itself is not reactive, so `ideasTick` is the recompute trigger
 * for the kind-filter chips (#21).
 *
 * Background ingestion: a workspace whose session is streaming but which is NOT
 * the mounted one has no live editor, so its ideas are queued and drained when
 * it next mounts (single-user v0; full background persistence is the
 * backend-snapshot ticket).
 */

interface CanvasState {
  /** True once the canvas is initialized (parity with the old CRDT-boot flag). */
  ready: boolean
  /**
   * Monotonic counter bumped whenever the mounted canvas gains cards (a fresh
   * `applyIdeas`, or a workspace mounting with persisted cards). The toolbar's
   * kind-filter chips recompute against it (#21).
   */
  ideasTick: number
}

export const useCanvasStore = create<CanvasState>(() => ({
  ready: false,
  ideasTick: 0,
}))

// ---- Imperative singleton state (lives outside React) ----------------------

let editor: Editor | null = null
/** Workspace id the mounted editor currently shows (guards background applies). */
let activeId: string | null = null
/** Ideas streamed to a non-mounted workspace, drained on its next mount. */
const pending = new Map<string, Idea[]>()
/** Fired when a card verb (#13 Discuss / #15 expand/challenge/find-risks) is picked. */
let cardVerbHandler:
  | ((text: string, intent: PromptIntent, sourceRef?: string) => void)
  | null = null

function bumpIdeasTick(): void {
  useCanvasStore.setState((s) => ({ ideasTick: s.ideasTick + 1 }))
}

function onEditorMount(ed: Editor): void {
  editor = ed
  // Drain any ideas that streamed in while this workspace was unmounted.
  const queued = activeId ? pending.get(activeId) : undefined
  if (queued?.length) {
    pending.delete(activeId!)
    islandApplyIdeas(ed, queued)
  }
  // Recompute the kind-filter chips against the now-loaded store (covers a
  // reload restoring persisted cards, not just freshly-drained ones).
  bumpIdeasTick()
}

export const canvas = {
  /**
   * A single stable bridge identity handed to React for the app's lifetime.
   * `CanvasPane` passes this into `<CanvasIsland>`; `onEditorMount` wires the
   * live editor back into this controller.
   */
  bridge: {
    onEditorMount: (ed: Editor) => onEditorMount(ed),
    onCardVerb: (text, intent, sourceRef) => cardVerbHandler?.(text, intent, sourceRef),
  } as CanvasBridge,

  /** No CRDT collection to stand up — just flip ready (parity with old boot). */
  async init(): Promise<void> {
    useCanvasStore.setState({ ready: true })
  },

  /** tldraw owns store loading; nothing to pre-rehydrate (parity shim). */
  async ensureReady(_workspaceId: string): Promise<void> {
    /* tldraw owns store loading; nothing to pre-rehydrate. */
  },

  /**
   * Hot-switch the bound workspace (PRD §3.4). `CanvasPane` remounts
   * `<CanvasIsland>` by changing its `key`/`persistenceKey`; this drops the old
   * editor handle so background applies queue until the new editor mounts. A
   * switch to the already-active workspace is a no-op (keeps the live editor).
   */
  switchTo(workspaceId: string): void {
    if (workspaceId === activeId) return
    activeId = workspaceId
    editor = null
  },

  /**
   * Render a batch of extracted ideas as cards + typed edges. Applied straight
   * to the live editor when the target workspace is the mounted one; otherwise
   * queued and drained when that workspace next mounts.
   */
  applyIdeas(workspaceId: string, ideas: Idea[]): void {
    if (ideas.length === 0) return
    if (editor && workspaceId === activeId) {
      islandApplyIdeas(editor, ideas)
      bumpIdeasTick()
    } else {
      const q = pending.get(workspaceId) ?? []
      q.push(...ideas)
      pending.set(workspaceId, q)
    }
  },

  /**
   * Ref-annotated serialization of the board for an AI triage pass (#60), or `''`
   * if this workspace isn't the mounted one. The agent scores each `@ref` and
   * replies with `«SCORE@ref»` lines that flow back through {@link applyScore}.
   */
  serializeForTriage(workspaceId: string): string {
    if (!editor || workspaceId !== activeId) return ''
    return serializeForTriage(editor)
  },

  /** Apply an extracted triage score to its target card's meta (#60). */
  applyScore(workspaceId: string, score: Score): void {
    if (editor && workspaceId === activeId) islandApplyScore(editor, score)
  },

  /**
   * Synthesize the active board into a convergent summary (#28, PD-015) — a pure,
   * on-demand *reading* of the canvas (themes → decisions → open questions →
   * highlights). Returns `null` when the target workspace isn't the mounted one
   * (no live editor to read). No canvas mutation, no agent round-trip.
   */
  synthesize(workspaceId: string): ConvergentSummary | null {
    if (!editor || workspaceId !== activeId) return null
    return synthesizeBoard(collectBoard(editor))
  },

  /** Serialize the workspace canvas to normalized markdown (PRD §3.2). */
  serializeToText(workspaceId: string): string {
    if (!editor || workspaceId !== activeId) return ''
    return serializeEditor(editor)
  },

  /** Plain text of the current selection — or the whole canvas (PRD §3.6). */
  getSelectedText(): string {
    return editor ? selectedText(editor) : ''
  },

  /** Register the card-verb sink (#13/#15) — see {@link CanvasIsland}'s verb bar. */
  onCardVerb(cb: (text: string, intent: PromptIntent, sourceRef?: string) => void): void {
    cardVerbHandler = cb
  },

  /** Tear down a deleted workspace's canvas state and its persisted store. */
  removeWorkspace(workspaceId: string): void {
    pending.delete(workspaceId)
    // tldraw's local sync names the IndexedDB database
    // `TLDRAW_DOCUMENT_v2<persistenceKey>` (LocalIndexedDb, pinned to tldraw 5.x);
    // deleting it discards the board for good. Best-effort: never block deletion.
    try {
      indexedDB.deleteDatabase(`TLDRAW_DOCUMENT_v2ai-storm:ws:${workspaceId}`)
    } catch {
      /* ignore */
    }
  },
}
