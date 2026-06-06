import { Injectable, inject, signal, type Signal, type WritableSignal } from '@angular/core';
import { BackendService } from './backend.service';
import { CanvasService } from './canvas.service';
import { IngestionService } from './ingestion.service';
import { WorkspaceService } from './workspace.service';
import { framePrompt, type PromptIntent } from './prompt-framing';
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
 * - `discussText` is the bidirectional-canvas seam (#13): it neither silently
 *   injects context nor spawns a subprocess — it types a framed, EDITABLE
 *   prompt into the live interactive session for the user to submit.
 */
@Injectable({ providedIn: 'root' })
export class AgentService {
  readonly #backend = inject(BackendService);
  readonly #canvas = inject(CanvasService);
  readonly #ingestion = inject(IngestionService);
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
    const selection = (payloadOverride ?? this.#canvas.getSelectedText()).trim();
    if (!selection) return;
    const command = config.agentCommand?.trim() || 'claude';

    // PRD §3.2 — automatically inject the serialized canvas as structural
    // memory so the agent receives the full whiteboard context, not just the
    // selected blocks. The selection is called out as the active focus.
    const context = this.#canvas.serializeToText(workspaceId);
    const payload = context
      ? `# Workspace context\n\n${context}\n\n# Selected focus\n\n${selection}`
      : selection;

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

  /**
   * Bidirectional canvas (#13) — feed the given canvas text into the LIVE
   * interactive terminal session as an EDITABLE prompt.
   *
   * Unlike {@link injectContext} (silent structural memory the user never sees)
   * and {@link dispatch} (which spawns a one-shot orchestrator subprocess), this
   * types a framed prompt straight into the attached PTY with NO trailing
   * newline, so the cursor lands ready for the user to edit and submit it
   * themselves. This is the interactive seam #14/#15 build their card verbs on.
   *
   * The text is supplied by the caller (the canvas service serializes the
   * selected idea card whose element-toolbar verb fired), so this service no
   * longer reaches into the editor selection itself. The {@link PromptIntent}
   * selects the framing (#15: Discuss / Expand / Challenge / Find risks).
   *
   * @returns `true` if a prompt was typed; `false` if no session is attached or
   *   the text is empty (nothing happens in either case).
   */
  discussText(
    workspaceId: string,
    text: string,
    intent: PromptIntent = 'discuss',
    sourceRef?: string,
  ): boolean {
    if (!this.#ingestion.isAttached(workspaceId)) return false;
    const prompt = framePrompt(text.trim() ? text : '', intent, sourceRef);
    if (!prompt) return false;
    // No '\r': the prompt stays editable in the terminal until the user submits.
    this.#ingestion.sendInput(workspaceId, prompt);
    this.#ingestion.focusTerminal(workspaceId);
    return true;
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
