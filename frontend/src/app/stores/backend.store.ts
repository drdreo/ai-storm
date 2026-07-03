import { create } from 'zustand'
import type { ClientMessage, ServerMessage } from '@ai-storm/shared'
import { log } from '../../lib/log'

export type ServerMessageHandler = (msg: ServerMessage) => void
export type ConnectionState = 'connecting' | 'open' | 'closed'

/**
 * WebSocket client for the local backend loop (PRD §4.2).
 *
 * Maintains a single socket that multiplexes every workspace. Inbound messages
 * are fanned out to per-workspace subscribers keyed by `workspaceId`, so each
 * isolated workspace (PRD §3.4) only sees its own stream. Auto-reconnects with
 * a bounded backoff so terminal disconnections survive (PRD §3.5).
 *
 * The socket and its handler registries are imperative module singletons (they
 * live outside React, exactly as the old Angular service did); only the
 * connection `state` is reactive, exposed via {@link useBackendStore}.
 */

interface BackendState {
  state: ConnectionState
}

export const useBackendStore = create<BackendState>(() => ({ state: 'closed' }))

function setState(s: ConnectionState): void {
  useBackendStore.setState({ state: s })
}

const proto = location.protocol === 'https:' ? 'wss' : 'ws'
const url = `${proto}://${location.host}/pty`

let socket: WebSocket | null = null
const handlers = new Map<string, Set<ServerMessageHandler>>()
const globalHandlers = new Set<ServerMessageHandler>()
const openHandlers = new Set<() => void>()
let outbox: ClientMessage[] = []
let reconnectDelay = 500
let reconnectTimer: number | null = null
let shouldRun = false

function open(): void {
  if (socket && socket.readyState <= WebSocket.OPEN) return
  setState('connecting')
  const s = new WebSocket(url)
  socket = s

  s.onopen = () => {
    log.info('ws.open', { url })
    setState('open')
    reconnectDelay = 500
    // Flush anything queued while disconnected.
    const queued = outbox.splice(0)
    for (const msg of queued) rawSend(msg)
    // Notify subscribers so durable sessions can be re-attached after a backend
    // restart or socket drop (PRD §3.5). `attach` is idempotent, so re-issuing
    // it against an already-running session simply resumes it.
    for (const h of openHandlers) h()
  }

  s.onmessage = (event) => {
    let msg: ServerMessage
    try {
      msg = JSON.parse(String(event.data)) as ServerMessage
    } catch {
      return
    }
    dispatch(msg)
  }

  s.onclose = () => {
    log.info('ws.close', { willReconnect: shouldRun })
    setState('closed')
    socket = null
    if (shouldRun) scheduleReconnect()
  }

  s.onerror = () => {
    log.warn('ws.error', { url })
    s.close()
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer !== null) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    reconnectDelay = Math.min(reconnectDelay * 2, 8000)
    open()
  }, reconnectDelay) as unknown as number
}

function dispatch(msg: ServerMessage): void {
  for (const h of globalHandlers) h(msg)
  const id = 'workspaceId' in msg ? msg.workspaceId : undefined
  if (id) {
    const set = handlers.get(id)
    if (set) for (const h of set) h(msg)
  }
}

function rawSend(msg: ClientMessage): void {
  try {
    socket?.send(JSON.stringify(msg))
  } catch {
    outbox.push(msg)
  }
}

export const backend = {
  connect(): void {
    shouldRun = true
    open()
  },

  /** Subscribe to messages for a specific workspace. Returns an unsubscribe fn. */
  subscribe(workspaceId: string, handler: ServerMessageHandler): () => void {
    let set = handlers.get(workspaceId)
    if (!set) {
      set = new Set()
      handlers.set(workspaceId, set)
    }
    set.add(handler)
    return () => {
      set!.delete(handler)
      if (set!.size === 0) handlers.delete(workspaceId)
    }
  },

  /** Subscribe to every message regardless of workspace (diagnostics). */
  subscribeAll(handler: ServerMessageHandler): () => void {
    globalHandlers.add(handler)
    return () => globalHandlers.delete(handler)
  },

  /** Run `handler` every time the socket (re)opens. Returns an unsubscribe fn. */
  onOpen(handler: () => void): () => void {
    openHandlers.add(handler)
    return () => openHandlers.delete(handler)
  },

  send(msg: ClientMessage): void {
    if (socket?.readyState === WebSocket.OPEN) {
      rawSend(msg)
    } else {
      outbox.push(msg)
      if (shouldRun) open()
    }
  },

  disconnect(): void {
    shouldRun = false
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    socket?.close()
    socket = null
    setState('closed')
  },
}
