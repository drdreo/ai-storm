import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
} from '@angular/core';
import { Toolbar, ToolbarWidget } from '@angular/aria/toolbar';
import { WorkspaceService } from '../core/workspace.service';
import { IngestionService } from '../core/ingestion.service';
import { AgentService } from '../core/agent.service';
import { BackendService } from '../core/backend.service';
import { TerminalComponent } from './terminal.component';

/**
 * Conversational Control Hub (PRD §3.1). The conversation surface is a real
 * terminal (xterm.js, fed the raw PTY stream — see TerminalComponent), so this
 * shell provides the session controls, the harness selector, the downstream
 * agent run output, and diagnostic readouts of the background connection. Ideas
 * land on the canvas, not here.
 */
@Component({
  selector: 'as-control-hub',
  imports: [Toolbar, ToolbarWidget, TerminalComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (workspaces.active(); as ws) {
      <header class="bar">
        <div class="diag">
          <span class="conn" [attr.data-state]="backend.state()"></span>
          <span>{{ backend.state() }}</span>
          <span class="sep">·</span>
          <span>{{ ws.status }}</span>
        </div>
        <div class="session" ngToolbar orientation="horizontal" aria-label="Session controls">
          @if (ingestion.isAttached(ws.id)) {
            <button ngToolbarWidget value="stop" class="stop" (click)="stop(ws.id)">Stop</button>
          } @else {
            <button ngToolbarWidget value="start" class="start" (click)="start(ws.id)">
              Start session
            </button>
          }
          <button ngToolbarWidget value="clear" class="ghost" (click)="ingestion.clearTerminal(ws.id)">
            Clear
          </button>
        </div>
      </header>

      <div class="config">
        <label>harness</label>
        <input
          class="harness"
          [value]="ws.terminal.agentCommand || 'claude'"
          [disabled]="ingestion.isAttached(ws.id)"
          placeholder="claude"
          spellcheck="false"
          (change)="setHarness(ws.id, $event)"
          title="The AI CLI launched for this workspace's session (PRD §2). Keystrokes are sent to its PTY."
        />
        <span class="hint">a real terminal — type directly; ideas land on the canvas</span>
      </div>

      <section class="terminal-wrap">
        @if (!ingestion.isAttached(ws.id)) {
          <div class="empty">No session yet. Start a session, then talk to the agent in the terminal; ideas land on the canvas.</div>
        }
        <as-terminal />
      </section>

      @if (agentRun(); as run) {
        <section class="agent">
          <div class="agent__head">
            <span>agent: {{ ws.terminal.agentCommand || 'claude' }}</span>
            <span class="agent__status" [attr.data-state]="run.status">
              {{ run.status }}{{ run.code !== undefined ? ' (' + run.code + ')' : '' }}
            </span>
          </div>
          @if (run.output) {
            <pre class="agent__out">{{ run.output }}</pre>
          }
        </section>
      }
    }
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        height: 100%;
        min-height: 0;
      }
      .bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--space-3);
        border-bottom: 1px solid var(--border-strong);
        background: var(--panel-bg);
        box-shadow: var(--shadow-sm);
      }
      .diag {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        font-size: 0.7rem;
        font-weight: 600;
        color: var(--text-dim);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .conn {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--danger);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--danger) 22%, transparent);
        transition: box-shadow var(--dur) var(--ease-out);
      }
      .conn[data-state='open'] {
        background: var(--ok);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 22%, transparent);
      }
      .conn[data-state='connecting'] {
        background: var(--warn);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--warn) 22%, transparent);
        animation: pulse 1.4s var(--ease-out) infinite;
      }
      @keyframes pulse {
        50% {
          opacity: 0.45;
        }
      }
      .sep {
        opacity: 0.35;
      }
      .config {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        padding: var(--space-2) var(--space-3);
        border-bottom: 1px solid var(--border);
        background: var(--sidebar-bg);
        font-size: 0.7rem;
        color: var(--text-faint);
      }
      .config label {
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .harness {
        flex: 0 0 auto;
        width: 180px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border-strong);
        background: var(--input-bg);
        color: var(--text);
        padding: 0.3rem 0.55rem;
        font-family: var(--mono);
        font-size: 0.76rem;
        transition:
          border-color var(--dur-fast) var(--ease-out),
          box-shadow var(--dur-fast) var(--ease-out);
      }
      .harness:hover:not(:disabled) {
        border-color: var(--accent);
      }
      .harness:focus {
        outline: none;
        border-color: var(--accent);
        box-shadow: 0 0 0 3px var(--accent-ring);
      }
      .harness:disabled {
        opacity: 0.5;
      }
      .config .hint {
        opacity: 0.7;
        font-style: italic;
      }
      .session {
        display: flex;
        gap: var(--space-2);
      }
      .session button {
        border-radius: var(--radius-sm);
        padding: 0.36rem 0.75rem;
        cursor: pointer;
        font: inherit;
        font-size: 0.76rem;
        font-weight: 600;
        border: 1px solid var(--border-strong);
        background: var(--btn-bg);
        color: var(--text-dim);
        transition:
          background var(--dur-fast) var(--ease-out),
          color var(--dur-fast) var(--ease-out),
          border-color var(--dur-fast) var(--ease-out),
          transform var(--dur-fast) var(--ease-out);
      }
      .session button:hover {
        background: var(--btn-hover);
        color: var(--text);
      }
      .session button:active {
        transform: translateY(1px);
      }
      .session button:focus-visible {
        outline: none;
        box-shadow: 0 0 0 3px var(--accent-ring);
      }
      .session:focus,
      .session:focus-visible {
        outline: none;
      }
      .start {
        color: var(--ok) !important;
        border-color: color-mix(in srgb, var(--ok) 35%, var(--border-strong)) !important;
      }
      .start:hover {
        background: color-mix(in srgb, var(--ok) 14%, var(--btn-bg)) !important;
      }
      .stop {
        color: var(--danger) !important;
        border-color: color-mix(in srgb, var(--danger) 35%, var(--border-strong)) !important;
      }
      .stop:hover {
        background: color-mix(in srgb, var(--danger) 14%, var(--btn-bg)) !important;
      }
      .terminal-wrap {
        position: relative;
        flex: 1;
        min-height: 0;
        background: var(--bg);
      }
      .terminal-wrap as-terminal {
        display: block;
        height: 100%;
      }
      .empty {
        position: absolute;
        inset: 0;
        z-index: 1;
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
        align-items: flex-start;
        justify-content: flex-start;
        color: var(--text-faint);
        font-family: var(--sans);
        font-size: 0.82rem;
        line-height: 1.5;
        padding: var(--space-3);
        pointer-events: none;
        background: var(--bg);
      }
      .empty::before {
        content: '~';
        font-family: var(--mono);
        font-size: 1.1rem;
        color: var(--accent);
        opacity: 0.7;
      }
      .agent {
        border-top: 1px solid var(--border-strong);
        max-height: 35%;
        overflow-y: auto;
        background: var(--sidebar-bg);
      }
      .agent__head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 0.5rem var(--space-3);
        font-size: 0.7rem;
        font-weight: 600;
        letter-spacing: 0.03em;
        color: var(--text-dim);
        position: sticky;
        top: 0;
        background: var(--panel-bg);
        border-bottom: 1px solid var(--border);
      }
      .agent__status {
        text-transform: uppercase;
        letter-spacing: 0.05em;
        font-size: 0.66rem;
      }
      .agent__status[data-state='exit'] {
        color: var(--ok);
      }
      .agent__status[data-state='error'] {
        color: var(--danger);
      }
      .agent__status[data-state='running'] {
        color: var(--accent);
      }
      .agent__out {
        margin: 0;
        padding: var(--space-3);
        font-family: var(--mono);
        font-size: 0.74rem;
        line-height: 1.5;
        white-space: pre-wrap;
        word-break: break-word;
        color: var(--text);
      }
    `,
  ],
})
export class ControlHubComponent {
  readonly workspaces = inject(WorkspaceService);
  readonly ingestion = inject(IngestionService);
  readonly backend = inject(BackendService);
  readonly #agent = inject(AgentService);

  readonly agentRun = computed(() => {
    const id = this.workspaces.activeId();
    return id ? this.#agent.run(id)() : null;
  });

  constructor() {
    // Resume a durable session after a reload / hot-switch (PRD §3.5). A page
    // reload loses the client-side pipeline but the named backend session
    // survives, so on (re)activation we re-attach to it. We gate on the
    // *persisted* live status ('active' / 'streaming') as the proxy for "this
    // workspace had a session", so merely visiting a never-started workspace
    // does not spawn a harness. `attach` is idempotent: it reconnects to the
    // surviving session rather than respawning it.
    effect(() => {
      const ws = this.workspaces.active();
      if (!ws) return;
      const wasLive = ws.status === 'active' || ws.status === 'streaming';
      if (wasLive && !this.ingestion.isAttached(ws.id)) {
        this.ingestion.attach(ws.id, ws.terminal);
      }
    });
  }

  setHarness(id: string, event: Event): void {
    const value = (event.target as HTMLInputElement).value.trim();
    this.workspaces.patchTerminal(id, { agentCommand: value || 'claude' });
  }

  start(id: string): void {
    const ws = this.workspaces.active();
    if (ws) this.ingestion.attach(id, ws.terminal);
  }

  stop(id: string): void {
    // Explicit "Stop" tears the durable session down (PRD §5.2). A browser
    // refresh / socket drop only detaches and leaves the session alive (§3.5).
    this.ingestion.kill(id);
  }
}
