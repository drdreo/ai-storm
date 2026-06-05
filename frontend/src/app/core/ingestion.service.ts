import { Injectable, inject, signal, type WritableSignal, type Signal } from '@angular/core';
import { BackendService } from './backend.service';
import { CanvasService } from './canvas.service';
import { WorkspaceService } from './workspace.service';
import { MarkdownBlockParser, type BlockDescriptor } from './markdown-block-parser';
import { RenderScheduler } from './render-scheduler';
import type { TerminalConfig } from './models';

const MAX_TERMINAL_LINES = 4000;

/** Persistent per-workspace view state (survives attach/detach cycles). */
interface View {
  lines: WritableSignal<string[]>;
}

/** Live streaming machinery (exists only while a session is attached). */
interface Pipeline {
  parser: MarkdownBlockParser;
  scheduler: RenderScheduler<BlockDescriptor>;
  unsubscribe: () => void;
  /** The attach message, re-sent on socket reopen to resume the session (§3.5). */
  reattach: () => void;
  unsubscribeOpen: () => void;
}

const isBlankParagraph = (d: BlockDescriptor) =>
  d.type === 'paragraph' && d.text.trim() === '';

/**
 * Stateful ingestion pipeline (PRD §3.3 + §5.1).
 *
 * The backend now extracts the agent's RESPONSE text server-side (tmux
 * capture-pane diffing — see docs/design/ai-session-layer.md) and ships clean
 * lines as `response` messages. The client therefore no longer cleans raw
 * bytes; it keeps only the *structural* half of the Output Layer:
 *
 *   response lines → MarkdownBlockParser → RenderScheduler →
 *   CanvasService.applyBlocks (one batched CRDT mutation per paint frame).
 *
 * The `SlicingBuffer`/`ansi.ts` raw-cleaning stage moved backend-side with the
 * extractor. Pipelines are independent per workspace (PRD §3.4) and torn down
 * on detach (PRD §5.2); the lightweight view signal persists so the control hub
 * keeps the extracted-response scrollback after a stream ends.
 */
@Injectable({ providedIn: 'root' })
export class IngestionService {
  readonly #backend = inject(BackendService);
  readonly #canvas = inject(CanvasService);
  readonly #workspaces = inject(WorkspaceService);

  #views = new Map<string, View>();
  #active = new Map<string, Pipeline>();

  /**
   * Ensure the durable session exists and start ingesting its responses.
   * Idempotent (PRD §3.5): a second call for an already-attached workspace is a
   * no-op, and the backend reuses a running session rather than respawning it.
   */
  attach(workspaceId: string, config: TerminalConfig, cols = 120, rows = 32): void {
    if (this.#active.has(workspaceId)) return;
    // Pre-create the view signal so terminalLines is immediately available.
    this.#view(workspaceId);

    const scheduler = new RenderScheduler<BlockDescriptor>({
      sink: (batch) => this.#canvas.applyBlocks(workspaceId, batch),
      maxPerFrame: 80,
    });
    const parser = new MarkdownBlockParser();

    const unsubscribe = this.#backend.subscribe(workspaceId, (msg) => {
      switch (msg.type) {
        case 'response':
          this.#ingest(workspaceId, msg.lines, msg.complete);
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
    // (e.g. `claude`), so prompts typed in the control hub go to the agent —
    // not to a raw shell. An explicit `shell` override takes precedence.
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

    this.#active.set(workspaceId, { parser, scheduler, unsubscribe, reattach, unsubscribeOpen });

    this.#backend.connect();
    reattach();
  }

  #ingest(workspaceId: string, lines: string[], complete: boolean): void {
    const p = this.#active.get(workspaceId);
    if (!p) return;
    const view = this.#view(workspaceId);

    if (lines.length > 0) {
      // The control hub's panel shows extracted RESPONSE text only — no raw
      // terminal mirror (design constraint: "no xterm.js mirror").
      const next = view.lines().concat(lines);
      view.lines.set(
        next.length > MAX_TERMINAL_LINES ? next.slice(-MAX_TERMINAL_LINES) : next,
      );
      const descriptors = p.parser.translateAll(lines).filter((d) => !isBlankParagraph(d));
      if (descriptors.length > 0) p.scheduler.enqueueAll(descriptors);
    }

    // On completion, flush any dangling fenced block and paint immediately.
    if (complete) {
      const fenced = p.parser.flush();
      if (fenced) p.scheduler.enqueue(fenced);
      p.scheduler.flushNow();
    }
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

  sendInput(workspaceId: string, data: string): void {
    this.#backend.send({ type: 'input', workspaceId, data });
  }

  resize(workspaceId: string, cols: number, rows: number): void {
    this.#backend.send({ type: 'resize', workspaceId, cols, rows });
  }

  clearScrollback(workspaceId: string): void {
    this.#views.get(workspaceId)?.lines.set([]);
  }

  /** Read-only accessor for a workspace's extracted response lines. */
  terminalLines(workspaceId: string): Signal<string[]> {
    return this.#view(workspaceId).lines.asReadonly();
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

  #view(workspaceId: string): View {
    let view = this.#views.get(workspaceId);
    if (!view) {
      view = { lines: signal<string[]>([]) };
      this.#views.set(workspaceId, view);
    }
    return view;
  }
}
