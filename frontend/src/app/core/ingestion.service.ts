import { Injectable, inject, signal, type WritableSignal, type Signal } from '@angular/core';
import { BackendService } from './backend.service';
import { CanvasService } from './canvas.service';
import { WorkspaceService } from './workspace.service';
import { SlicingBuffer } from './slicing-buffer';
import { MarkdownBlockParser, type BlockDescriptor } from './markdown-block-parser';
import { RenderScheduler } from './render-scheduler';
import type { TerminalConfig } from './models';

const MAX_TERMINAL_LINES = 4000;

/** Persistent per-workspace view state (survives attach/detach cycles). */
interface View {
  lines: WritableSignal<string[]>;
  pending: WritableSignal<string>;
}

/** Live streaming machinery (exists only while a PTY is attached). */
interface Pipeline {
  buffer: SlicingBuffer;
  parser: MarkdownBlockParser;
  scheduler: RenderScheduler<BlockDescriptor>;
  unsubscribe: () => void;
}

const isBlankParagraph = (d: BlockDescriptor) =>
  d.type === 'paragraph' && d.text.trim() === '';

/**
 * Stateful ingestion pipeline (PRD §3.3 + §5.1).
 *
 * For each workspace it owns the full Output Layer chain:
 *   raw PTY chunk → SlicingBuffer → MarkdownBlockParser → RenderScheduler →
 *   CanvasService.applyBlocks (one batched CRDT mutation per paint frame).
 * The same completed lines also feed a bounded raw-text view for the control
 * hub terminal. Pipelines are independent per workspace (PRD §3.4) and fully
 * torn down on detach (PRD §5.2); the lightweight view signals persist so the
 * UI keeps the scrollback after a stream ends.
 */
@Injectable({ providedIn: 'root' })
export class IngestionService {
  readonly #backend = inject(BackendService);
  readonly #canvas = inject(CanvasService);
  readonly #workspaces = inject(WorkspaceService);

  #views = new Map<string, View>();
  #active = new Map<string, Pipeline>();

  /** Spawn the PTY and start ingesting its stream into the workspace. */
  attach(workspaceId: string, config: TerminalConfig, cols = 120, rows = 32): void {
    if (this.#active.has(workspaceId)) return;
    // Pre-create the view signal so terminalLines/terminalPending are
    // immediately available even before the first data chunk arrives.
    this.#view(workspaceId);

    const scheduler = new RenderScheduler<BlockDescriptor>({
      sink: (batch) => this.#canvas.applyBlocks(workspaceId, batch),
      maxPerFrame: 80,
    });

    const unsubscribe = this.#backend.subscribe(workspaceId, (msg) => {
      switch (msg.type) {
        case 'ready':
          this.#workspaces.setStatus(workspaceId, 'active');
          break;
        case 'data':
          this.#ingest(workspaceId, msg.chunk);
          break;
        case 'exit':
          this.#flush(workspaceId);
          this.#workspaces.setStatus(workspaceId, 'idle');
          break;
        case 'error':
          this.#workspaces.setStatus(workspaceId, 'error');
          break;
      }
    });

    this.#active.set(workspaceId, {
      buffer: new SlicingBuffer(),
      parser: new MarkdownBlockParser(),
      scheduler,
      unsubscribe,
    });

    // The interactive session defaults to launching the configured AI harness
    // (e.g. `claude`), so prompts typed in the control hub go to the agent —
    // not to a raw shell. An explicit `shell` override takes precedence.
    const harness = config.shell?.trim() || config.agentCommand?.trim() || 'claude';
    const harnessArgs = config.shell ? config.args ?? [] : config.agentArgs ?? [];

    this.#backend.connect();
    this.#backend.send({
      type: 'attach',
      workspaceId,
      shell: harness,
      args: harnessArgs,
      cwd: config.cwd,
      cols,
      rows,
    });
  }

  #ingest(workspaceId: string, chunk: string): void {
    const p = this.#active.get(workspaceId);
    if (!p) return;
    const view = this.#view(workspaceId);

    this.#workspaces.setStatus(workspaceId, 'streaming');
    const { lines, pending } = p.buffer.push(chunk);

    if (lines.length > 0) {
      const next = view.lines().concat(lines);
      view.lines.set(
        next.length > MAX_TERMINAL_LINES ? next.slice(-MAX_TERMINAL_LINES) : next,
      );
      const descriptors = p.parser.translateAll(lines).filter((d) => !isBlankParagraph(d));
      if (descriptors.length > 0) p.scheduler.enqueueAll(descriptors);
    }
    view.pending.set(pending);
  }

  #flush(workspaceId: string): void {
    const p = this.#active.get(workspaceId);
    if (!p) return;
    const view = this.#view(workspaceId);
    const tail = p.buffer.flush();
    const descriptors: BlockDescriptor[] = [];
    if (tail.length > 0) {
      view.lines.set(view.lines().concat(tail));
      descriptors.push(...p.parser.translateAll(tail).filter((d) => !isBlankParagraph(d)));
    }
    const fenced = p.parser.flush();
    if (fenced) descriptors.push(fenced);
    if (descriptors.length > 0) p.scheduler.enqueueAll(descriptors);
    view.pending.set('');
    p.scheduler.flushNow();
  }

  sendInput(workspaceId: string, data: string): void {
    this.#backend.send({ type: 'input', workspaceId, data });
  }

  resize(workspaceId: string, cols: number, rows: number): void {
    this.#backend.send({ type: 'resize', workspaceId, cols, rows });
  }

  clearScrollback(workspaceId: string): void {
    const view = this.#views.get(workspaceId);
    view?.lines.set([]);
    view?.pending.set('');
  }

  /** Read-only accessor for a workspace's raw terminal lines. */
  terminalLines(workspaceId: string): Signal<string[]> {
    return this.#view(workspaceId).lines.asReadonly();
  }

  terminalPending(workspaceId: string): Signal<string> {
    return this.#view(workspaceId).pending.asReadonly();
  }

  isAttached(workspaceId: string): boolean {
    return this.#active.has(workspaceId);
  }

  /** Tear down a workspace pipeline and kill its PTY (PRD §5.2). */
  detach(workspaceId: string): void {
    const p = this.#active.get(workspaceId);
    if (!p) return;
    p.unsubscribe();
    p.scheduler.dispose();
    p.buffer.reset();
    this.#active.delete(workspaceId);
    this.#backend.send({ type: 'detach', workspaceId });
    this.#workspaces.setStatus(workspaceId, 'idle');
  }

  #view(workspaceId: string): View {
    let view = this.#views.get(workspaceId);
    if (!view) {
      view = { lines: signal<string[]>([]), pending: signal<string>('') };
      this.#views.set(workspaceId, view);
    }
    return view;
  }
}
