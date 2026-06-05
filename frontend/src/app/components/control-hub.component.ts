import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { Toolbar, ToolbarWidget } from '@angular/aria/toolbar';
import { WorkspaceService } from '../core/workspace.service';
import { IngestionService } from '../core/ingestion.service';
import { AgentService } from '../core/agent.service';
import { BackendService } from '../core/backend.service';

/**
 * Conversational Control Hub (PRD §3.1). Provides the prompt input, session
 * controls, the agent's conversational reply stream (the `chat` half of the
 * extraction contract — ideas now live on the canvas, not here), downstream
 * agent run output, and diagnostic readouts of the background connection.
 */
@Component({
  selector: 'as-control-hub',
  imports: [Toolbar, ToolbarWidget],
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
          <button ngToolbarWidget value="clear" class="ghost" (click)="ingestion.clearScrollback(ws.id)">
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
          title="The AI CLI launched for this workspace's session (PRD §2). Prompts are sent to its stdin."
        />
        <span class="hint">prompts go to this CLI's stdin</span>
      </div>

      <section class="stream" #stream role="log" aria-live="polite" aria-label="Conversation">
        @for (line of lines(); track $index) {
          <div class="line">{{ line }}</div>
        }
        @if (lines().length === 0) {
          <div class="empty">No messages yet. Start a session and type a prompt below; ideas land on the canvas.</div>
        }
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

      <footer class="composer">
        <textarea
          #prompt
          rows="2"
          placeholder="Type a prompt and press Enter (Shift+Enter for newline)…"
          (keydown)="onKey($event, ws.id)"
        ></textarea>
        <button class="send" (click)="send(ws.id, prompt)">Send</button>
      </footer>
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
      .stream {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        padding: var(--space-3);
        font-family: var(--mono);
        font-size: 0.78rem;
        line-height: 1.5;
        color: var(--text);
        white-space: pre-wrap;
        word-break: break-word;
        background:
          radial-gradient(
            100% 60% at 50% 0%,
            color-mix(in srgb, var(--accent) 4%, transparent) 0%,
            transparent 70%
          ),
          var(--bg);
      }
      .line {
        white-space: pre-wrap;
      }
      .pending {
        opacity: 0.7;
      }
      .empty {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
        align-items: flex-start;
        color: var(--text-faint);
        font-family: var(--sans);
        font-size: 0.82rem;
        line-height: 1.5;
        padding-top: var(--space-2);
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
      .composer {
        display: flex;
        gap: var(--space-2);
        padding: var(--space-3);
        border-top: 1px solid var(--border-strong);
        background: var(--panel-bg);
      }
      textarea {
        flex: 1;
        resize: none;
        border-radius: var(--radius-md);
        border: 1px solid var(--border-strong);
        background: var(--input-bg);
        color: var(--text);
        padding: 0.55rem 0.65rem;
        font: inherit;
        font-size: 0.84rem;
        line-height: 1.45;
        transition:
          border-color var(--dur-fast) var(--ease-out),
          box-shadow var(--dur-fast) var(--ease-out);
      }
      textarea::placeholder {
        color: var(--text-faint);
      }
      textarea:hover {
        border-color: var(--border-strong);
      }
      textarea:focus {
        outline: none;
        border-color: var(--accent);
        box-shadow: 0 0 0 3px var(--accent-ring);
      }
      .send {
        align-self: stretch;
        padding: 0 1.1rem;
        border-radius: var(--radius-md);
        border: 1px solid var(--accent);
        background: var(--accent);
        color: var(--on-accent);
        font: inherit;
        font-weight: 600;
        font-size: 0.84rem;
        cursor: pointer;
        box-shadow:
          var(--shadow-sm),
          inset 0 1px 0 rgba(255, 255, 255, 0.18);
        transition:
          background var(--dur-fast) var(--ease-out),
          border-color var(--dur-fast) var(--ease-out),
          transform var(--dur-fast) var(--ease-out);
      }
      .send:hover {
        background: var(--accent-hover);
        border-color: var(--accent-hover);
      }
      .send:active {
        transform: translateY(1px);
        background: var(--accent-press);
      }
      .send:focus-visible {
        outline: none;
        box-shadow: 0 0 0 3px var(--accent-ring);
      }
    `,
  ],
})
export class ControlHubComponent {
  readonly workspaces = inject(WorkspaceService);
  readonly ingestion = inject(IngestionService);
  readonly backend = inject(BackendService);
  readonly #agent = inject(AgentService);

  readonly stream = viewChild<ElementRef<HTMLElement>>('stream');

  // Reactively follow the active workspace's stream/agent signals.
  readonly lines = computed(() => {
    const id = this.workspaces.activeId();
    return id ? this.ingestion.terminalLines(id)() : [];
  });
  readonly agentRun = computed(() => {
    const id = this.workspaces.activeId();
    return id ? this.#agent.run(id)() : null;
  });

  readonly #autoscroll = signal(0);

  constructor() {
    // Keep the stream pinned to the bottom as new lines arrive.
    effect(() => {
      this.lines();
      const el = this.stream()?.nativeElement;
      if (el) queueMicrotask(() => (el.scrollTop = el.scrollHeight));
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

  onKey(event: KeyboardEvent, id: string): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.send(id, event.target as HTMLTextAreaElement);
    }
  }

  send(id: string, input: HTMLTextAreaElement): void {
    const value = input.value;
    if (!value.trim()) return;
    if (!this.ingestion.isAttached(id)) this.start(id);
    // Real PTY (ConPTY/forkpty): the Enter key is a carriage return; the
    // terminal's line discipline turns it into a submitted line.
    this.ingestion.sendInput(id, value + '\r');
    input.value = '';
  }
}
