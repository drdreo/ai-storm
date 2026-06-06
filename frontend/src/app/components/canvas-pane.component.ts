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
import type { Idea } from '@ai-storm/shared';
import { IdeaComposerComponent } from './idea-composer.component';

/**
 * Structural Workspace Canvas (PRD §3.1, §4.1). Hosts the framework-agnostic
 * BlockSuite editor as a plain web component, toggles between linear document
 * (page) and spatial node (edgeless) layouts over the same data, and exposes
 * the downstream agent macro on the current selection (PRD §3.6).
 */
@Component({
  selector: 'as-canvas-pane',
  imports: [Tabs, TabList, Tab, Toolbar, ToolbarWidget, IdeaComposerComponent],
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
        <as-idea-composer (capture)="onCaptureIdea($event)" />
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
        padding: var(--space-2) var(--space-3);
        border-bottom: 1px solid var(--border-strong);
        background: var(--panel-bg);
        box-shadow: var(--shadow-sm);
        gap: var(--space-2);
        z-index: 2;
      }
      /* Segmented control for the Document / Canvas view toggle. */
      .modes {
        display: inline-flex;
        gap: 2px;
        padding: 2px;
        border: 1px solid var(--border-strong);
        border-radius: var(--radius-md);
        background: var(--input-bg);
      }
      .modes button {
        border: 0;
        background: transparent;
        color: var(--text-dim);
        padding: 0.34rem 0.85rem;
        border-radius: 6px;
        cursor: pointer;
        font: inherit;
        font-size: 0.8rem;
        font-weight: 500;
        transition:
          background var(--dur-fast) var(--ease-out),
          color var(--dur-fast) var(--ease-out);
      }
      .modes button:hover:not(.on) {
        color: var(--text);
      }
      .modes button.on {
        background: var(--surface-raised);
        color: var(--text);
        box-shadow: var(--shadow-sm);
      }
      .modes button:focus-visible {
        outline: none;
        box-shadow: 0 0 0 3px var(--accent-ring);
      }
      .modes:focus,
      .modes:focus-visible,
      .actions:focus,
      .actions:focus-visible {
        outline: none;
      }
      .actions {
        display: flex;
        gap: var(--space-2);
      }
      .actions button {
        border-radius: var(--radius-md);
        padding: 0.42rem 0.8rem;
        cursor: pointer;
        font: inherit;
        font-size: 0.8rem;
        font-weight: 500;
        border: 1px solid var(--border-strong);
        transition:
          background var(--dur-fast) var(--ease-out),
          color var(--dur-fast) var(--ease-out),
          border-color var(--dur-fast) var(--ease-out),
          transform var(--dur-fast) var(--ease-out),
          box-shadow var(--dur-fast) var(--ease-out);
      }
      .actions button:active {
        transform: translateY(1px);
      }
      .actions button:focus-visible {
        outline: none;
        box-shadow: 0 0 0 3px var(--accent-ring);
      }
      .ghost {
        background: var(--btn-bg);
        color: var(--text-dim);
      }
      .ghost:hover {
        background: var(--btn-hover);
        color: var(--text);
        border-color: var(--border-strong);
      }
      .accent {
        background: var(--accent);
        color: var(--on-accent);
        border-color: var(--accent);
        font-weight: 600;
        box-shadow:
          var(--shadow-sm),
          inset 0 1px 0 rgba(255, 255, 255, 0.18);
      }
      .accent:hover {
        background: var(--accent-hover);
        border-color: var(--accent-hover);
      }
      .accent:active {
        background: var(--accent-press);
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

  /**
   * Human idea-capture sink (#31, PD-002). Routes a human-authored idea to the
   * active workspace's canvas via the same pipeline AI-extracted ideas use; does
   * not switch the canvas view mode.
   */
  onCaptureIdea(idea: Idea): void {
    const active = this.workspaces.active();
    if (active) void this.#canvas.captureIdea(active.id, idea);
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
