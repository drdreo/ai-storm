import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { WorkspaceService } from './core/workspace.service';
import { BackendService } from './core/backend.service';
import { SidebarComponent } from './components/sidebar.component';
import { CanvasPaneComponent } from './components/canvas-pane.component';
import { ControlHubComponent } from './components/control-hub.component';

/**
 * Root shell (PRD §3.1): a persistent sidebar, the structural workspace canvas
 * (left pane) and the conversational control hub (right pane). Boots the
 * crash-recovery sequence before rendering the panes.
 */
@Component({
  selector: 'as-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SidebarComponent, CanvasPaneComponent, ControlHubComponent],
  template: `
    @if (workspaces.booted()) {
      <div class="shell">
        <as-sidebar />
        <main class="canvas-pane">
          <as-canvas-pane />
        </main>
        <aside class="hub-pane">
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
        min-width: 0;
        border-left: 1px solid var(--border-strong);
        background: var(--panel-bg);
        display: flex;
        flex-direction: column;
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
