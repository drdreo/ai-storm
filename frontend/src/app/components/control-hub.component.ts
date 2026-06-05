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
 * controls, the live (sanitised) terminal stream, downstream agent run output,
 * and diagnostic readouts of the background terminal connection.
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

      <section class="stream" #stream role="log" aria-live="polite" aria-label="Agent response output">
        @for (line of lines(); track $index) {
          <div class="line">{{ line }}</div>
        }
        @if (lines().length === 0) {
          <div class="empty">No responses yet. Start a session and type a prompt below.</div>
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
        padding: 0.55rem 0.75rem;
        border-bottom: 1px solid var(--border);
      }
      .diag {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        font-size: 0.74rem;
        color: var(--text-dim);
        text-transform: uppercase;
        letter-spacing: 0.03em;
      }
      .conn {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #e5534b;
      }
      .conn[data-state='open'] {
        background: #36c275;
      }
      .conn[data-state='connecting'] {
        background: #e0b341;
      }
      .sep {
        opacity: 0.4;
      }
      .config {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.4rem 0.75rem;
        border-bottom: 1px solid var(--border);
        font-size: 0.72rem;
        color: var(--text-dim);
      }
      .config label {
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .harness {
        flex: 0 0 auto;
        width: 180px;
        border-radius: 6px;
        border: 1px solid var(--border);
        background: var(--input-bg);
        color: var(--text);
        padding: 0.28rem 0.5rem;
        font-family: var(--mono);
        font-size: 0.76rem;
      }
      .harness:disabled {
        opacity: 0.55;
      }
      .config .hint {
        opacity: 0.6;
        font-style: italic;
      }
      .session {
        display: flex;
        gap: 0.4rem;
      }
      .session button {
        border-radius: 6px;
        padding: 0.34rem 0.7rem;
        cursor: pointer;
        font: inherit;
        font-size: 0.76rem;
        border: 1px solid var(--border);
        background: var(--btn-bg);
        color: var(--text-dim);
      }
      .session button:hover {
        background: var(--btn-hover);
        color: var(--text);
      }
      .session:focus,
      .session:focus-visible {
        outline: none;
      }
      .start {
        color: #36c275 !important;
      }
      .stop {
        color: #e5534b !important;
      }
      .stream {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        padding: 0.6rem 0.75rem;
        font-family: var(--mono);
        font-size: 0.78rem;
        line-height: 1.45;
        color: var(--text);
        white-space: pre-wrap;
        word-break: break-word;
      }
      .line {
        white-space: pre-wrap;
      }
      .pending {
        opacity: 0.7;
      }
      .empty {
        color: var(--text-dim);
        font-family: var(--sans);
        font-style: italic;
        padding-top: 0.5rem;
      }
      .agent {
        border-top: 1px solid var(--border);
        max-height: 35%;
        overflow-y: auto;
        background: rgba(0, 0, 0, 0.18);
      }
      .agent__head {
        display: flex;
        justify-content: space-between;
        padding: 0.45rem 0.75rem;
        font-size: 0.72rem;
        color: var(--text-dim);
        position: sticky;
        top: 0;
        background: var(--panel-bg);
      }
      .agent__status[data-state='exit'] {
        color: #36c275;
      }
      .agent__status[data-state='error'] {
        color: #e5534b;
      }
      .agent__status[data-state='running'] {
        color: var(--accent);
      }
      .agent__out {
        margin: 0;
        padding: 0 0.75rem 0.6rem;
        font-family: var(--mono);
        font-size: 0.74rem;
        white-space: pre-wrap;
        word-break: break-word;
        color: var(--text);
      }
      .composer {
        display: flex;
        gap: 0.5rem;
        padding: 0.6rem;
        border-top: 1px solid var(--border);
      }
      textarea {
        flex: 1;
        resize: none;
        border-radius: 8px;
        border: 1px solid var(--border);
        background: var(--input-bg);
        color: var(--text);
        padding: 0.5rem 0.6rem;
        font: inherit;
        font-size: 0.82rem;
      }
      textarea:focus {
        outline: 1px solid var(--accent);
      }
      .send {
        align-self: stretch;
        padding: 0 1rem;
        border-radius: 8px;
        border: 1px solid var(--accent);
        background: var(--accent);
        color: #08111d;
        font-weight: 600;
        cursor: pointer;
      }
      .send:hover {
        filter: brightness(1.08);
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
