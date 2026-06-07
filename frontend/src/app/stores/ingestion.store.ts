import { create } from 'zustand'
import type { Idea } from '@ai-storm/shared'
import { backend } from './backend.store'
import { canvas } from './canvas.store'
import { workspace } from './workspace.store'
import { RenderScheduler } from '../core/render-scheduler'
import type { TerminalConfig } from '../core/models'

/** Cap on raw bytes buffered before a terminal mounts, so an attached-but-never-
 *  viewed workspace cannot grow without bound (oldest chunks are dropped). */
const MAX_BUFFERED_DATA = 256 * 1024

/** A mounted xterm.js terminal's sink — the component registers these. */
export interface TerminalSink {
  /** Write base64-encoded raw PTY bytes to the terminal. */
  write(dataB64: string): void
  /** Clear the terminal's scrollback + viewport. */
  clear(): void
  /** Move keyboard focus into the terminal (bidirectional canvas, #13). */
  focus?(): void
}

/** Live streaming machinery (exists only while a session is attached). */
interface Pipeline {
  scheduler: RenderScheduler<Idea>
  unsubscribe: () => void
  /** The attach message, re-sent on socket reopen to resume the session (§3.5). */
  reattach: () => void
  unsubscribeOpen: () => void
}

/** Per-workspace terminal binding (survives attach/detach cycles). */
interface TerminalState {
  /** The mounted terminal's sink, or null until the component registers it. */
  sink: TerminalSink | null
  /** Raw `data` chunks (base64) received before the terminal mounted. */
  buffer: string[]
  bufferedBytes: number
}

/**
 * Stateful ingestion pipeline (PRD §3.3 + §5.1).
 *
 * The backend streams two surfaces per workspace
 * (docs/design/ai-response-extraction-contract.md):
 *
 *   `data` → raw PTY bytes → the workspace's xterm.js terminal.
 *   `idea` → RenderScheduler<Idea> → canvas.applyIdeas — one discrete card per
 *            idea, with ideas arriving in the same paint frame collapsed into a
 *            single batched mutation.
 *
 * Pipelines are independent per workspace (PRD §3.4) and torn down on detach
 * (PRD §5.2); the lightweight terminal binding persists so a workspace keeps its
 * terminal across attach/detach cycles.
 *
 * Port note: the only reactive surface is which workspaces are attached
 * (`attached`), which the control hub reads to flip Start/Stop and the empty
 * state. Everything else is imperative module state, as in the Angular service.
 */

interface IngestionState {
  attached: Record<string, true>
}

export const useIngestionStore = create<IngestionState>(() => ({ attached: {} }))

// ---- Imperative module state -----------------------------------------------

const terminals = new Map<string, TerminalState>()
const active = new Map<string, Pipeline>()

function terminal(workspaceId: string): TerminalState {
  let t = terminals.get(workspaceId)
  if (!t) {
    t = { sink: null, buffer: [], bufferedBytes: 0 }
    terminals.set(workspaceId, t)
  }
  return t
}

function markAttached(workspaceId: string, on: boolean): void {
  useIngestionStore.setState((s) => {
    if (on === !!s.attached[workspaceId]) return s
    const next = { ...s.attached }
    if (on) next[workspaceId] = true
    else delete next[workspaceId]
    return { attached: next }
  })
}

/** Forward raw PTY bytes to the terminal (or buffer until it mounts). */
function ingestData(workspaceId: string, dataB64: string): void {
  const t = terminal(workspaceId)
  if (t.sink) {
    t.sink.write(dataB64)
    return
  }
  t.buffer.push(dataB64)
  t.bufferedBytes += dataB64.length
  // Drop oldest chunks past the cap (a never-viewed session must stay bounded).
  while (t.bufferedBytes > MAX_BUFFERED_DATA && t.buffer.length > 1) {
    t.bufferedBytes -= t.buffer.shift()!.length
  }
}

/** Route one extracted idea to the canvas via the render scheduler. */
function ingestIdea(workspaceId: string, idea: Idea): void {
  const p = active.get(workspaceId)
  if (!p) return
  p.scheduler.enqueueAll([idea])
}

function applyStatus(workspaceId: string, status: string): void {
  switch (status) {
    case 'responding':
      workspace.setStatus(workspaceId, 'streaming')
      break
    case 'created':
    case 'attached':
    case 'idle':
      workspace.setStatus(workspaceId, 'active')
      break
    case 'killed':
      workspace.setStatus(workspaceId, 'idle')
      break
  }
}

function teardownPipeline(workspaceId: string): Pipeline | undefined {
  const p = active.get(workspaceId)
  if (!p) return undefined
  p.unsubscribe()
  p.unsubscribeOpen()
  p.scheduler.dispose()
  active.delete(workspaceId)
  markAttached(workspaceId, false)
  return p
}

export const ingestion = {
  /**
   * Ensure the durable session exists and start ingesting its streams.
   * Idempotent (PRD §3.5): a second call for an already-attached workspace is a
   * no-op, and the backend reuses a running session rather than respawning it.
   */
  attach(workspaceId: string, config: TerminalConfig, cols = 120, rows = 32): void {
    if (active.has(workspaceId)) return
    // Pre-create the terminal binding so a sink can register immediately.
    terminal(workspaceId)

    const scheduler = new RenderScheduler<Idea>({
      sink: (batch) => canvas.applyIdeas(workspaceId, batch),
      // Ideas are low-frequency and deduped one-per-marker; a small cap still
      // collapses multiple ideas in one frame into a single applyIdeas call.
      maxPerFrame: 8,
    })

    const unsubscribe = backend.subscribe(workspaceId, (msg) => {
      switch (msg.type) {
        case 'data':
          ingestData(workspaceId, msg.data)
          break
        case 'idea':
          ingestIdea(workspaceId, msg.idea)
          break
        case 'score':
          // Triage score (#60) → update the target card's meta on the canvas.
          canvas.applyScore(workspaceId, msg.score)
          break
        case 'session-status':
          applyStatus(workspaceId, msg.status)
          break
        case 'exit':
          active.get(workspaceId)?.scheduler.flushNow()
          workspace.setStatus(workspaceId, 'idle')
          break
        case 'error':
          workspace.setStatus(workspaceId, 'error')
          break
      }
    })

    // The interactive session defaults to launching the configured AI harness
    // (e.g. `claude`), so prompts typed in the terminal go to the agent — not to
    // a raw shell. An explicit `shell` override takes precedence.
    const harness = config.shell?.trim() || config.agentCommand?.trim() || 'claude'
    const harnessArgs = config.shell ? config.args ?? [] : config.agentArgs ?? []
    const reattach = () => {
      backend.send({
        type: 'attach',
        workspaceId,
        shell: harness,
        args: harnessArgs,
        cwd: config.cwd,
        cols,
        rows,
        mode: config.mode,
      })
    }
    // Re-issue the attach whenever the socket (re)opens so a backend restart or
    // refresh resumes the durable session without losing the agent (§3.5).
    const unsubscribeOpen = backend.onOpen(reattach)

    active.set(workspaceId, { scheduler, unsubscribe, reattach, unsubscribeOpen })
    markAttached(workspaceId, true)

    backend.connect()
    reattach()
  },

  /**
   * Bind a mounted terminal for a workspace. Flushes any data buffered before
   * the terminal mounted, then forwards subsequent `data` live. Returns an
   * unbind fn the component calls on teardown.
   */
  registerTerminal(workspaceId: string, sink: TerminalSink): () => void {
    const t = terminal(workspaceId)
    t.sink = sink
    if (t.buffer.length > 0) {
      for (const chunk of t.buffer) sink.write(chunk)
      t.buffer = []
      t.bufferedBytes = 0
    }
    return () => {
      if (t.sink === sink) t.sink = null
    }
  },

  /** Forward raw keystrokes from the terminal to the session's PTY. */
  sendInput(workspaceId: string, data: string): void {
    backend.send({ type: 'input', workspaceId, data })
  },

  resize(workspaceId: string, cols: number, rows: number): void {
    backend.send({ type: 'resize', workspaceId, cols, rows })
  },

  /** Clear the workspace's terminal display (does not touch the session). */
  clearTerminal(workspaceId: string): void {
    terminals.get(workspaceId)?.sink?.clear()
  },

  /**
   * Move keyboard focus into the workspace's terminal (bidirectional canvas,
   * #13). Used after typing a framed prompt so the user can edit/submit it
   * without first clicking the terminal. No-op if no terminal is mounted.
   */
  focusTerminal(workspaceId: string): void {
    terminals.get(workspaceId)?.sink?.focus?.()
  },

  isAttached(workspaceId: string): boolean {
    return active.has(workspaceId)
  },

  /**
   * Stop ingesting locally but LEAVE the durable session alive on the backend
   * (refresh / hot-switch — PRD §3.5). Use {@link kill} to tear it down.
   */
  detach(workspaceId: string): void {
    const p = teardownPipeline(workspaceId)
    if (!p) return
    backend.send({ type: 'detach', workspaceId })
    workspace.setStatus(workspaceId, 'idle')
  },

  /** Terminate the session entirely (PRD §5.2 teardown). */
  kill(workspaceId: string): void {
    const p = teardownPipeline(workspaceId)
    backend.send({ type: 'kill', workspaceId })
    if (p) workspace.setStatus(workspaceId, 'idle')
  },
}
