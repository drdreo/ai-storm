import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  effect,
  inject,
  viewChild,
} from '@angular/core';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WorkspaceService } from '../core/workspace.service';
import { IngestionService } from '../core/ingestion.service';

/** One live xterm.js terminal bound to a workspace's session. */
interface Entry {
  term: Terminal;
  fit: FitAddon;
  /** The DOM node xterm renders into; appended to the host when active. */
  container: HTMLDivElement;
  /** False until xterm has been opened + wired (done once it is in the DOM). */
  wired: boolean;
  /** Disposes the onData keystroke forwarder. */
  dataDisp: { dispose(): void } | null;
  /** Unregisters the ingestion data sink. */
  unregister: (() => void) | null;
}

/**
 * The conversation surface (PRD §3.1) as a REAL terminal. The backend streams
 * raw PTY bytes (`data`); xterm.js renders them, so tool calls, todos,
 * clarifying questions and diffs all show exactly as the harness draws them —
 * no server-side chat extraction. Keystrokes flow back out via `onData` →
 * `input`. Ideas are handled separately by the canvas.
 *
 * One {@link Terminal} per workspace is kept so each isolated workspace
 * (PRD §3.4) retains its own scrollback; only the active workspace's terminal is
 * attached to the host element, swapped on hot-switch.
 */
@Component({
  selector: 'as-terminal',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="host" #host></div>`,
  styles: [
    `
      :host {
        display: block;
        height: 100%;
        min-height: 0;
      }
      .host {
        height: 100%;
        width: 100%;
        padding: var(--space-2);
        box-sizing: border-box;
        background: var(--bg);
      }
      .host .term {
        height: 100%;
        width: 100%;
      }
      /* xterm sizes its own viewport; let it fill the container. */
      .host .xterm,
      .host .xterm-viewport {
        height: 100% !important;
      }
    `,
  ],
})
export class TerminalComponent implements OnDestroy {
  readonly #workspaces = inject(WorkspaceService);
  readonly #ingestion = inject(IngestionService);
  readonly host = viewChild.required<ElementRef<HTMLElement>>('host');

  readonly #entries = new Map<string, Entry>();
  #resizeObserver: ResizeObserver | null = null;
  #activeId: string | null = null;

  constructor() {
    // Follow the active workspace: show its terminal, creating it on first view.
    effect(() => {
      const ws = this.#workspaces.active();
      const hostEl = this.host().nativeElement;
      if (!ws) return;
      this.#show(ws.id, hostEl);
    });
  }

  #show(workspaceId: string, hostEl: HTMLElement): void {
    if (this.#activeId === workspaceId && this.#entries.get(workspaceId)?.container.parentElement === hostEl) {
      return;
    }
    this.#activeId = workspaceId;
    const entry = this.#ensure(workspaceId, hostEl);
    // Only the active workspace's terminal is in the DOM.
    hostEl.replaceChildren(entry.container);
    // Open + wire xterm now that its container is attached, so the renderer
    // measures real dimensions (opening on a detached node mis-measures).
    if (!entry.wired) this.#wire(workspaceId, entry);
    this.#observe(hostEl);
    // Fit after the swap lands so the container has real dimensions.
    queueMicrotask(() => this.#fit(workspaceId));
  }

  #ensure(workspaceId: string, hostEl: HTMLElement): Entry {
    const existing = this.#entries.get(workspaceId);
    if (existing) return existing;

    const container = document.createElement('div');
    container.className = 'term';

    const styles = getComputedStyle(hostEl);
    const term = new Terminal({
      cursorBlink: true,
      scrollback: 5000,
      fontFamily: styles.getPropertyValue('--mono')?.trim() || 'monospace',
      fontSize: 13,
      theme: { background: styles.getPropertyValue('--bg')?.trim() || '#000' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);

    const entry: Entry = { term, fit, container, wired: false, dataDisp: null, unregister: null };
    this.#entries.set(workspaceId, entry);
    return entry;
  }

  /** Open the terminal in its (now-attached) container and connect the streams. */
  #wire(workspaceId: string, entry: Entry): void {
    entry.term.open(entry.container);
    // Keystrokes → the session's PTY, verbatim.
    entry.dataDisp = entry.term.onData((d) => this.#ingestion.sendInput(workspaceId, d));
    // Raw bytes from the session → the terminal.
    entry.unregister = this.#ingestion.registerTerminal(workspaceId, {
      write: (b64) => entry.term.write(decodeBase64(b64)),
      clear: () => entry.term.clear(),
    });
    entry.wired = true;
  }

  #observe(hostEl: HTMLElement): void {
    if (this.#resizeObserver) return;
    this.#resizeObserver = new ResizeObserver(() => {
      if (this.#activeId) this.#fit(this.#activeId);
    });
    this.#resizeObserver.observe(hostEl);
  }

  /** Fit the active terminal to its container and inform the backend (cols/rows). */
  #fit(workspaceId: string): void {
    const entry = this.#entries.get(workspaceId);
    if (!entry || entry.container.parentElement === null || entry.container.clientWidth === 0) return;
    try {
      entry.fit.fit();
      this.#ingestion.resize(workspaceId, entry.term.cols, entry.term.rows);
    } catch {
      // Container not measurable yet; the next ResizeObserver tick retries.
    }
  }

  ngOnDestroy(): void {
    this.#resizeObserver?.disconnect();
    for (const entry of this.#entries.values()) {
      entry.dataDisp?.dispose();
      entry.unregister?.();
      entry.term.dispose();
    }
    this.#entries.clear();
  }
}

/** Decode base64 PTY bytes into a Uint8Array xterm can write as UTF-8. */
function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
