import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { WorkspaceService } from './core/workspace.service';
import { BackendService } from './core/backend.service';
import { SidebarComponent } from './components/sidebar.component';
import { CanvasPaneComponent } from './components/canvas-pane.component';
import { ControlHubComponent } from './components/control-hub.component';
import { TldrawSpikeComponent } from './spike/tldraw-spike.component';

const HUB_MIN_WIDTH = 320;
const HUB_WIDTH_KEY = 'as:hub-width';

function restoreHubWidth(): number {
  const raw = Number(localStorage.getItem(HUB_WIDTH_KEY));
  return Number.isFinite(raw) && raw >= HUB_MIN_WIDTH ? raw : 424;
}

/**
 * Root shell (PRD §3.1): a persistent sidebar, the structural workspace canvas
 * (left pane) and the conversational control hub (right pane). Boots the
 * crash-recovery sequence before rendering the panes.
 */
@Component({
  selector: 'as-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SidebarComponent, CanvasPaneComponent, ControlHubComponent, TldrawSpikeComponent],
  template: `
    @if (workspaces.booted()) {
      <div class="shell" [style.--hub-w]="hubWidthPx()">
        <as-sidebar />
        <main class="canvas-pane">
          @if (showSpike()) {
            <!--
              Spike (#52): swap the BlockSuite canvas for the tldraw React island,
              keeping the real sidebar + hub chrome around it. @defer code-splits
              React + tldraw into their own chunk (used only here), so they stay
              out of the main bundle and the bundle-size figure is honest.
            -->
            @defer (on immediate) {
              <as-tldraw-spike />
            } @placeholder {
              <div class="boot"><div class="boot__spinner"></div><p>Loading tldraw spike…</p></div>
            }
          } @else {
            <as-canvas-pane />
          }
        </main>
        <aside class="hub-pane">
          <div
            class="resize-handle"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize terminal pane"
            (pointerdown)="startResize($event)"
          ></div>
          <as-control-hub />
        </aside>
      </div>
    } @else {
      <div class="boot">
        <div class="boot__spinner"></div>
        <p>{{ bootError() ?? 'Restoring workspaces…' }}</p>
      </div>
    }
  `,
  styles: [
    `
      :host {
        display: block;
        height: 100vh;
        width: 100vw;
        overflow: hidden;
      }
      .shell {
        display: grid;
        grid-template-columns: var(--sidebar-w, 244px) 1fr var(--hub-w, 424px);
        height: 100%;
        background: var(--bg);
      }
      .canvas-pane {
        position: relative;
        min-width: 0;
        background: var(--canvas-bg);
        overflow: hidden;
        /* The light canvas is the focal plane — lift it above the dark shell. */
        box-shadow:
          -8px 0 24px -12px rgba(0, 0, 0, 0.55),
          8px 0 24px -12px rgba(0, 0, 0, 0.55);
        z-index: 1;
      }
      .hub-pane {
        position: relative;
        min-width: 0;
        border-left: 1px solid var(--border-strong);
        background: var(--panel-bg);
        display: flex;
        flex-direction: column;
      }
      /* Draggable splitter straddling the hub's left border (PRD §3.1). */
      .resize-handle {
        position: absolute;
        left: -4px;
        top: 0;
        bottom: 0;
        width: 8px;
        z-index: 5;
        cursor: col-resize;
        touch-action: none;
      }
      .resize-handle::after {
        content: '';
        position: absolute;
        left: 3px;
        top: 0;
        bottom: 0;
        width: 2px;
        background: transparent;
        transition: background var(--dur-fast) var(--ease-out);
      }
      .resize-handle:hover::after,
      .resize-handle:active::after {
        background: var(--accent);
      }
      .boot {
        height: 100%;
        display: grid;
        place-content: center;
        gap: var(--space-5);
        justify-items: center;
        color: var(--text-dim);
        background: radial-gradient(
          120% 80% at 50% 0%,
          var(--panel-bg) 0%,
          var(--bg) 60%
        );
      }
      .boot p {
        margin: 0;
        font-size: 0.9rem;
        letter-spacing: 0.01em;
      }
      .boot__spinner {
        width: 30px;
        height: 30px;
        border: 2.5px solid var(--border-strong);
        border-top-color: var(--accent);
        border-radius: 50%;
        animation: spin 0.7s var(--ease-out) infinite;
      }
      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }
    `,
  ],
})
export class AppComponent implements OnInit {
  readonly workspaces = inject(WorkspaceService);
  readonly #backend = inject(BackendService);
  readonly bootError = signal<string | null>(null);

  /**
   * Spike (#52) toggle: `?spike=tldraw` swaps the BlockSuite canvas for the
   * tldraw React island. Read once at construction — the URL doesn't change at
   * runtime — so the comparison can be driven without a build flag.
   */
  readonly showSpike = signal(
    new URLSearchParams(globalThis.location?.search ?? '').get('spike') === 'tldraw',
  );

  // Resizable terminal (hub) pane. Width drives the `--hub-w` grid column; the
  // terminal's own ResizeObserver refits xterm + re-sends cols/rows on change.
  readonly hubWidth = signal(restoreHubWidth());
  readonly hubWidthPx = computed(() => `${this.hubWidth()}px`);

  startResize(ev: PointerEvent): void {
    ev.preventDefault();
    const handle = ev.target as HTMLElement;
    handle.setPointerCapture(ev.pointerId);
    const max = () => Math.max(HUB_MIN_WIDTH, window.innerWidth * 0.7);
    const move = (e: PointerEvent) => {
      const w = Math.min(Math.max(window.innerWidth - e.clientX, HUB_MIN_WIDTH), max());
      this.hubWidth.set(Math.round(w));
    };
    const up = () => {
      handle.releasePointerCapture(ev.pointerId);
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      localStorage.setItem(HUB_WIDTH_KEY, String(this.hubWidth()));
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  }

  async ngOnInit(): Promise<void> {
    try {
      await this.workspaces.boot();
      this.#backend.connect();
    } catch (err) {
      this.bootError.set(
        'Failed to restore local storage: ' +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }
}
