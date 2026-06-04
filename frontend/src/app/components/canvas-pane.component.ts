import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  viewChild,
} from '@angular/core';
import { Tab, TabList, Tabs } from '@angular/aria/tabs';
import { Toolbar, ToolbarWidget } from '@angular/aria/toolbar';
import { WorkspaceService } from '../core/workspace.service';
import { CanvasService } from '../core/canvas.service';
import { AgentService } from '../core/agent.service';
import type { CanvasMode } from '../core/models';

/**
 * Structural Workspace Canvas (PRD §3.1, §4.1). Hosts the framework-agnostic
 * BlockSuite editor as a plain web component, toggles between linear document
 * (page) and spatial node (edgeless) layouts over the same data, and exposes
 * the downstream agent macro on the current selection (PRD §3.6).
 */
@Component({
  selector: 'as-canvas-pane',
  imports: [Tabs, TabList, Tab, Toolbar, ToolbarWidget],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="toolbar" ngTabs>
      <div
        class="modes"
        ngTabList
        orientation="horizontal"
        selectionMode="follow"
        [selectedTab]="activeMode()"
        (selectedTabChange)="onModeChange($event)"
        aria-label="Canvas view mode"
      >
        <button ngTab value="page" [class.on]="activeMode() === 'page'">
          Document
        </button>
        <button ngTab value="edgeless" [class.on]="activeMode() === 'edgeless'">
          Canvas
        </button>
      </div>
      <div class="actions" ngToolbar orientation="horizontal" aria-label="Canvas actions">
        <button
          ngToolbarWidget
          value="inject-context"
          class="ghost"
          (click)="injectContext()"
          title="Serialize canvas into the terminal loop (PRD 3.2)"
        >
          Inject context
        </button>
        <button
          ngToolbarWidget
          value="send-to-agent"
          class="accent"
          (click)="dispatchSelection()"
          title="Send selection to the local agent (PRD 3.6)"
        >
          Send to agent ▸
        </button>
      </div>
    </div>
    <div class="host" #host></div>
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        height: 100%;
      }
      .toolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0.5rem 0.75rem;
        border-bottom: 1px solid var(--border);
        background: var(--panel-bg);
        gap: 0.5rem;
      }
      .modes {
        display: inline-flex;
        border: 1px solid var(--border);
        border-radius: 8px;
        overflow: hidden;
      }
      .modes button {
        border: 0;
        background: var(--btn-bg);
        color: var(--text-dim);
        padding: 0.4rem 0.85rem;
        cursor: pointer;
        font: inherit;
        font-size: 0.8rem;
      }
      .modes button.on {
        background: var(--accent-soft);
        color: var(--text);
      }
      .modes:focus,
      .modes:focus-visible,
      .actions:focus,
      .actions:focus-visible {
        outline: none;
      }
      .actions {
        display: flex;
        gap: 0.5rem;
      }
      .actions button {
        border-radius: 8px;
        padding: 0.42rem 0.8rem;
        cursor: pointer;
        font: inherit;
        font-size: 0.8rem;
        border: 1px solid var(--border);
      }
      .ghost {
        background: var(--btn-bg);
        color: var(--text-dim);
      }
      .ghost:hover {
        background: var(--btn-hover);
        color: var(--text);
      }
      .accent {
        background: var(--accent);
        color: #08111d;
        border-color: var(--accent);
        font-weight: 600;
      }
      .accent:hover {
        filter: brightness(1.08);
      }
      .host {
        flex: 1;
        min-height: 0;
        overflow: auto;
        background: var(--canvas-bg);
      }
      .host affine-editor-container {
        display: block;
        height: 100%;
      }
    `,
  ],
})
export class CanvasPaneComponent {
  readonly workspaces = inject(WorkspaceService);
  readonly #canvas = inject(CanvasService);
  readonly #agent = inject(AgentService);
  readonly host = viewChild.required<ElementRef<HTMLElement>>('host');

  constructor() {
    // React to workspace switches — mount/rebind the shared editor (PRD §3.4).
    effect(() => {
      const active = this.workspaces.active();
      const hostEl = this.host().nativeElement;
      if (!active) return;
      this.#canvas.mount(hostEl, active.id, active.mode);
    });
  }

  /** The active workspace's current canvas mode, defaulting to 'page'. */
  readonly activeMode = computed<CanvasMode>(() => this.workspaces.active()?.mode ?? 'page');

  /** React to the tablist selection (Document/Canvas) changing. */
  onModeChange(value: string | undefined): void {
    if (value === 'page' || value === 'edgeless') this.setMode(value);
  }

  setMode(mode: CanvasMode): void {
    const active = this.workspaces.active();
    if (!active) return;
    this.workspaces.setMode(active.id, mode);
    this.#canvas.setMode(mode);
  }

  injectContext(): void {
    const active = this.workspaces.active();
    if (active) this.#agent.injectContext(active.id);
  }

  dispatchSelection(): void {
    const active = this.workspaces.active();
    if (active) this.#agent.dispatch(active.id, active.terminal);
  }
}
