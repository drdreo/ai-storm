import { Injectable, signal } from '@angular/core';
import type { ClientMessage, ServerMessage } from './protocol';

export type ServerMessageHandler = (msg: ServerMessage) => void;
export type ConnectionState = 'connecting' | 'open' | 'closed';

/**
 * WebSocket client for the local backend loop (PRD §4.2).
 *
 * Maintains a single socket that multiplexes every workspace. Inbound messages
 * are fanned out to per-workspace subscribers keyed by `workspaceId`, so each
 * isolated workspace (PRD §3.4) only sees its own stream. Auto-reconnects with
 * a bounded backoff so terminal disconnections survive (PRD §3.5).
 */
@Injectable({ providedIn: 'root' })
export class BackendService {
  readonly state = signal<ConnectionState>('closed');

  #socket: WebSocket | null = null;
  #url: string;
  #handlers = new Map<string, Set<ServerMessageHandler>>();
  #globalHandlers = new Set<ServerMessageHandler>();
  #outbox: ClientMessage[] = [];
  #reconnectDelay = 500;
  #reconnectTimer: number | null = null;
  #shouldRun = false;

  constructor() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.#url = `${proto}://${location.host}/pty`;
  }

  connect(): void {
    this.#shouldRun = true;
    this.#open();
  }

  #open(): void {
    if (this.#socket && this.#socket.readyState <= WebSocket.OPEN) return;
    this.state.set('connecting');
    const socket = new WebSocket(this.#url);
    this.#socket = socket;

    socket.onopen = () => {
      this.state.set('open');
      this.#reconnectDelay = 500;
      // Flush anything queued while disconnected.
      const queued = this.#outbox.splice(0);
      for (const msg of queued) this.#rawSend(msg);
    };

    socket.onmessage = (event) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      this.#dispatch(msg);
    };

    socket.onclose = () => {
      this.state.set('closed');
      this.#socket = null;
      if (this.#shouldRun) this.#scheduleReconnect();
    };

    socket.onerror = () => {
      socket.close();
    };
  }

  #scheduleReconnect(): void {
    if (this.#reconnectTimer !== null) return;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#reconnectDelay = Math.min(this.#reconnectDelay * 2, 8000);
      this.#open();
    }, this.#reconnectDelay) as unknown as number;
  }

  #dispatch(msg: ServerMessage): void {
    for (const h of this.#globalHandlers) h(msg);
    const id = 'workspaceId' in msg ? msg.workspaceId : undefined;
    if (id) {
      const set = this.#handlers.get(id);
      if (set) for (const h of set) h(msg);
    }
  }

  /** Subscribe to messages for a specific workspace. Returns an unsubscribe fn. */
  subscribe(workspaceId: string, handler: ServerMessageHandler): () => void {
    let set = this.#handlers.get(workspaceId);
    if (!set) {
      set = new Set();
      this.#handlers.set(workspaceId, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
      if (set!.size === 0) this.#handlers.delete(workspaceId);
    };
  }

  /** Subscribe to every message regardless of workspace (diagnostics). */
  subscribeAll(handler: ServerMessageHandler): () => void {
    this.#globalHandlers.add(handler);
    return () => this.#globalHandlers.delete(handler);
  }

  send(msg: ClientMessage): void {
    if (this.#socket?.readyState === WebSocket.OPEN) {
      this.#rawSend(msg);
    } else {
      this.#outbox.push(msg);
      if (this.#shouldRun) this.#open();
    }
  }

  #rawSend(msg: ClientMessage): void {
    try {
      this.#socket?.send(JSON.stringify(msg));
    } catch {
      this.#outbox.push(msg);
    }
  }

  disconnect(): void {
    this.#shouldRun = false;
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    this.#socket?.close();
    this.#socket = null;
    this.state.set('closed');
  }
}
