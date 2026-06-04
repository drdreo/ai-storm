import { Injectable, inject, signal, type Signal, type WritableSignal } from '@angular/core';
import { BackendService } from './backend.service';
import { CanvasService } from './canvas.service';
import { WorkspaceService } from './workspace.service';
import type { TerminalConfig } from './models';

export interface AgentRun {
  status: 'spawned' | 'running' | 'exit' | 'error';
  pid?: number;
  output: string;
  code?: number;
}

/**
 * Input-layer context injection (PRD §3.2) and downstream agent hook (PRD §3.6).
 *
 * - `injectContext` serializes the active canvas to normalized text and pushes
 *   it into the workspace's terminal loop as structural memory.
 * - `dispatch` extracts plain block text and asks the backend to spawn the
 *   local orchestrator subprocess with the payload as a functional argument,
 *   streaming the run's lifecycle back into a signal for the control hub.
 */
@Injectable({ providedIn: 'root' })
export class AgentService {
  readonly #backend = inject(BackendService);
  readonly #canvas = inject(CanvasService);
  readonly #workspaces = inject(WorkspaceService);

  #runs = new Map<string, WritableSignal<AgentRun | null>>();
  #subscribed = new Set<string>();

  /** PRD §3.2 — inject serialized whiteboard state into the terminal loop. */
  injectContext(workspaceId: string): string {
    const document = this.#canvas.serializeToText(workspaceId);
    this.#backend.send({ type: 'context', workspaceId, document: document + '\n' });
    return document;
  }

  /**
   * PRD §3.6 — dispatch the selected block text to the local agent orchestrator.
   * `payloadOverride` lets callers pass explicit text (e.g. a block-level macro);
   * otherwise the current editor selection is used.
   */
  dispatch(workspaceId: string, config: TerminalConfig, payloadOverride?: string): void {
    const payload = (payloadOverride ?? this.#canvas.getSelectedText()).trim();
    if (!payload) return;
    const command = config.agentCommand?.trim() || 'claude';

    this.#ensureSubscription(workspaceId);
    this.#run(workspaceId).set({ status: 'spawned', output: '' });

    this.#backend.connect();
    this.#backend.send({
      type: 'agent',
      workspaceId,
      command,
      args: config.agentArgs ?? [],
      payload,
      cwd: config.cwd,
    });
  }

  #ensureSubscription(workspaceId: string): void {
    if (this.#subscribed.has(workspaceId)) return;
    this.#subscribed.add(workspaceId);
    this.#backend.subscribe(workspaceId, (msg) => {
      if (msg.type !== 'agent-status') return;
      const sig = this.#run(workspaceId);
      const cur = sig() ?? { status: 'spawned', output: '' };
      switch (msg.status) {
        case 'spawned':
          sig.set({ status: 'running', pid: msg.pid, output: '' });
          break;
        case 'stdout':
        case 'stderr':
          sig.set({ ...cur, status: 'running', output: cur.output + (msg.data ?? '') });
          break;
        case 'exit':
          sig.set({ ...cur, status: 'exit', code: msg.code });
          break;
        case 'error':
          sig.set({ ...cur, status: 'error', output: cur.output + (msg.data ?? '') });
          break;
      }
    });
  }

  run(workspaceId: string): Signal<AgentRun | null> {
    return this.#run(workspaceId).asReadonly();
  }

  #run(workspaceId: string): WritableSignal<AgentRun | null> {
    let sig = this.#runs.get(workspaceId);
    if (!sig) {
      sig = signal<AgentRun | null>(null);
      this.#runs.set(workspaceId, sig);
    }
    return sig;
  }
}
