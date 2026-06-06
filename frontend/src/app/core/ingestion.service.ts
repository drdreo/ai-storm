import { Injectable, inject } from '@angular/core';
import type { Idea } from '@ai-storm/shared';
import { BackendService } from './backend.service';
import { CanvasService } from './canvas.service';
import { WorkspaceService } from './workspace.service';
import { RenderScheduler } from './render-scheduler';
import type { TerminalConfig } from './models';

/** Cap on raw bytes buffered before a terminal mounts, so an attached-but-never-
 *  viewed workspace cannot grow without bound (oldest chunks are dropped). */
const MAX_BUFFERED_DATA = 256 * 1024;

/** A mounted xterm.js terminal's sink — the component registers these. */
export interface TerminalSink {
  /** Write base64-encoded raw PTY bytes to the terminal. */
  write(dataB64: string): void;
  /** Clear the terminal's scrollback + viewport. */
  clear(): void;
}

/** Live streaming machinery (exists only while a session is attached). */
interface Pipeline {
  scheduler: RenderScheduler<Idea>;
  unsubscribe: () => void;
  /** The attach message, re-sent on socket reopen to resume the session (§3.5). */
  reattach: () => void;
  unsubscribeOpen: () => void;
}

/** Per-workspace terminal binding (survives attach/detach cycles). */
interface TerminalState {
  /** The mounted terminal's sink, or null until the component registers it. */
  sink: TerminalSink | null;
  /** Raw `data` chunks (base64) received before the terminal mounted. */
  buffer: string[];
  bufferedBytes: number;
}

/**
 * Stateful ingestion pipeline (PRD §3.3 + §5.1).
 *
 * The backend streams two surfaces per workspace
 * (docs/design/ai-response-extraction-contract.md):
 *
 *   `data` → raw PTY bytes → the workspace's xterm.js terminal (the conversation
 *            surface renders itself; no chat extraction). Forwarded to a
 *            {@link TerminalSink} the TerminalComponent registers, buffered until
 *            the terminal mounts.
 *   `idea` → RenderScheduler<Idea> → CanvasService.applyIdeas — one discrete
 *            tinted/badged edgeless card per idea, with ideas arriving in the
 *            same paint frame collapsed into a single batched CRDT mutation.
 *
 * Pipelines are independent per workspace (PRD §3.4) and torn down on detach
 * (PRD §5.2); the lightweight terminal binding persists so a workspace keeps its
 * terminal across attach/detach cycles.
 */
@Injectable({ providedIn: 'root' })
export class IngestionService {
  readonly #backend = inject(BackendService);
  readonly #canvas = inject(CanvasService);
  readonly #workspaces = inject(WorkspaceService);

  #terminals = new Map<string, TerminalState>();
  #active = new Map<string, Pipeline>();

  /**
   * Ensure the durable session exists and start ingesting its streams.
   * Idempotent (PRD §3.5): a second call for an already-attached workspace is a
   * no-op, and the backend reuses a running session rather than respawning it.
   */
  attach(workspaceId: string, config: TerminalConfig, cols = 120, rows = 32): void {
    if (this.#active.has(workspaceId)) return;
    // Pre-create the terminal binding so a sink can register immediately.
    this.#terminal(workspaceId);

    const scheduler = new RenderScheduler<Idea>({
      sink: (batch) => this.#canvas.applyIdeas(workspaceId, batch),
      // Ideas are low-frequency and deduped one-per-marker; a small cap still
      // collapses multiple ideas in one frame into a single applyIdeas call
      // (one CRDT transaction), preserving the §5.1 frame-decoupling.
      maxPerFrame: 8,
    });

    const unsubscribe = this.#backend.subscribe(workspaceId, (msg) => {
      switch (msg.type) {
        case 'data':
          this.#ingestData(workspaceId, msg.data);
          break;
        case 'idea':
          this.#ingestIdea(workspaceId, msg.idea);
          break;
        case 'session-status':
          this.#applyStatus(workspaceId, msg.status);
          break;
        case 'exit':
          this.#active.get(workspaceId)?.scheduler.flushNow();
          this.#workspaces.setStatus(workspaceId, 'idle');
          break;
        case 'error':
          this.#workspaces.setStatus(workspaceId, 'error');
          break;
      }
    });

    // The interactive session defaults to launching the configured AI harness
    // (e.g. `claude`), so prompts typed in the terminal go to the agent — not to
    // a raw shell. An explicit `shell` override takes precedence.
    const harness = config.shell?.trim() || config.agentCommand?.trim() || 'claude';
    const harnessArgs = config.shell ? config.args ?? [] : config.agentArgs ?? [];
    const reattach = () => {
      this.#backend.send({
        type: 'attach',
        workspaceId,
        shell: harness,
        args: harnessArgs,
        cwd: config.cwd,
        cols,
        rows,
      });
    };
    // Re-issue the attach whenever the socket (re)opens so a backend restart or
    // refresh resumes the durable session without losing the agent (§3.5).
    const unsubscribeOpen = this.#backend.onOpen(reattach);

    this.#active.set(workspaceId, { scheduler, unsubscribe, reattach, unsubscribeOpen });

    this.#backend.connect();
    reattach();
  }

  /** Forward raw PTY bytes to the terminal (or buffer until it mounts). */
  #ingestData(workspaceId: string, dataB64: string): void {
    const t = this.#terminal(workspaceId);
    if (t.sink) {
      t.sink.write(dataB64);
      return;
    }
    t.buffer.push(dataB64);
    t.bufferedBytes += dataB64.length;
    // Drop oldest chunks past the cap (a never-viewed session must stay bounded).
    while (t.bufferedBytes > MAX_BUFFERED_DATA && t.buffer.length > 1) {
      t.bufferedBytes -= t.buffer.shift()!.length;
    }
  }

  /** Route one extracted idea to the canvas via the render scheduler. */
  #ingestIdea(workspaceId: string, idea: Idea): void {
    const p = this.#active.get(workspaceId);
    if (!p) return;
    p.scheduler.enqueueAll([idea]);
  }

  /**
   * Bind a mounted terminal for a workspace. Flushes any data buffered before
   * the terminal mounted, then forwards subsequent `data` live. Returns an
   * unbind fn the component calls on teardown.
   */
  registerTerminal(workspaceId: string, sink: TerminalSink): () => void {
    const t = this.#terminal(workspaceId);
    t.sink = sink;
    if (t.buffer.length > 0) {
      for (const chunk of t.buffer) sink.write(chunk);
      t.buffer = [];
      t.bufferedBytes = 0;
    }
    return () => {
      if (t.sink === sink) t.sink = null;
    };
  }

  #applyStatus(workspaceId: string, status: string): void {
    switch (status) {
      case 'responding':
        this.#workspaces.setStatus(workspaceId, 'streaming');
        break;
      case 'created':
      case 'attached':
      case 'idle':
        this.#workspaces.setStatus(workspaceId, 'active');
        break;
      case 'killed':
        this.#workspaces.setStatus(workspaceId, 'idle');
        break;
    }
  }

  /** Forward raw keystrokes from the terminal to the session's PTY. */
  sendInput(workspaceId: string, data: string): void {
    this.#backend.send({ type: 'input', workspaceId, data });
  }

  resize(workspaceId: string, cols: number, rows: number): void {
    this.#backend.send({ type: 'resize', workspaceId, cols, rows });
  }

  /** Clear the workspace's terminal display (does not touch the session). */
  clearTerminal(workspaceId: string): void {
    this.#terminals.get(workspaceId)?.sink?.clear();
  }

  isAttached(workspaceId: string): boolean {
    return this.#active.has(workspaceId);
  }

  /**
   * Stop ingesting locally but LEAVE the durable session alive on the backend
   * (refresh / hot-switch — PRD §3.5). Use {@link kill} to tear it down.
   */
  detach(workspaceId: string): void {
    const p = this.#teardownPipeline(workspaceId);
    if (!p) return;
    this.#backend.send({ type: 'detach', workspaceId });
    this.#workspaces.setStatus(workspaceId, 'idle');
  }

  /** Terminate the session entirely (PRD §5.2 teardown). */
  kill(workspaceId: string): void {
    const p = this.#teardownPipeline(workspaceId);
    this.#backend.send({ type: 'kill', workspaceId });
    if (p) this.#workspaces.setStatus(workspaceId, 'idle');
  }

  #teardownPipeline(workspaceId: string): Pipeline | undefined {
    const p = this.#active.get(workspaceId);
    if (!p) return undefined;
    p.unsubscribe();
    p.unsubscribeOpen();
    p.scheduler.dispose();
    this.#active.delete(workspaceId);
    return p;
  }

  #terminal(workspaceId: string): TerminalState {
    let t = this.#terminals.get(workspaceId);
    if (!t) {
      t = { sink: null, buffer: [], bufferedBytes: 0 };
      this.#terminals.set(workspaceId, t);
    }
    return t;
  }
}
