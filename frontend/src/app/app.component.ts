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
  standalone: true,
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
        grid-template-columns: var(--sidebar-w, 240px) 1fr var(--hub-w, 420px);
        height: 100%;
      }
      .canvas-pane {
        position: relative;
        min-width: 0;
        background: var(--canvas-bg);
        overflow: hidden;
      }
      .hub-pane {
        min-width: 0;
        border-left: 1px solid var(--border);
        background: var(--panel-bg);
        display: flex;
        flex-direction: column;
      }
      .boot {
        height: 100%;
        display: grid;
        place-content: center;
        gap: 1rem;
        justify-items: center;
        color: var(--text-dim);
      }
      .boot__spinner {
        width: 28px;
        height: 28px;
        border: 3px solid var(--border);
        border-top-color: var(--accent);
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
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
