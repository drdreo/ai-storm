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
import { Tab, TabContent, TabList, TabPanel, Tabs } from '@angular/aria/tabs';
import { Toolbar, ToolbarWidget } from '@angular/aria/toolbar';
import { WorkspaceService } from '../core/workspace.service';
import { CanvasService } from '../core/canvas.service';
import { AgentService } from '../core/agent.service';
import { kindLabel } from '../core/idea-descriptors';
import type { CanvasMode } from '../core/models';

/**
 * Structural Workspace Canvas (PRD §3.1, §4.1). Hosts the framework-agnostic
 * BlockSuite editor as a plain web component, toggles between linear document
 * (page) and spatial node (edgeless) layouts over the same data, and exposes
 * the downstream agent macro on the current selection (PRD §3.6).
 */
@Component({
  selector: 'as-canvas-pane',
  imports: [Tabs, TabList, Tab, TabPanel, TabContent, Toolbar, ToolbarWidget],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="pane" ngTabs>
    <div class="toolbar">
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
      @if (activeMode() === 'edgeless' && kinds().length) {
        <div class="filters" role="group" aria-label="Filter cards by kind">
          @for (kind of kinds(); track kind) {
            <button
              type="button"
              class="chip"
              [class.off]="hiddenKinds().has(kind)"
              [attr.aria-pressed]="!hiddenKinds().has(kind)"
              (click)="toggleKind(kind)"
              [title]="'Toggle ' + label(kind) + ' cards on the canvas (#21)'"
            >
              {{ label(kind) }}
            </button>
          }
        </div>
      }
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

      <!--
        Aria Tabs requires one ngTabPanel per ngTab (and each panel an
        ngTabContent template). There is a SINGLE shared BlockSuite editor (the
        .host below) that renders the same doc as either a linear page or a
        spatial edgeless surface, switched imperatively by setMode(). It cannot
        live inside a panel: Aria marks the non-selected panel inert, which would
        leave the one editor non-interactive on the other tab. So the panels are
        the accessible targets the tabs control, and the shared editor sits below
        them as the surface they describe (#42).
      -->
      <div ngTabPanel value="page"><ng-template ngTabContent></ng-template></div>
      <div ngTabPanel value="edgeless"><ng-template ngTabContent></ng-template></div>

      <div class="host" #host></div>
    </div>
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        height: 100%;
      }
      /* ngTabs wrapper: own the column layout so the editor host can flex-fill
         while the (zero-height) tab panels sit between the toolbar and host. */
      .pane {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-height: 0;
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
      /* Kind-driven filter chips (#21), sitting left of the action buttons. */
      .filters {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--space-1);
        margin-left: auto;
      }
      .chip {
        border: 1px solid var(--border-strong);
        border-radius: var(--radius-md);
        background: var(--surface-raised);
        color: var(--text);
        padding: 0.28rem 0.6rem;
        cursor: pointer;
        font: inherit;
        font-size: 0.75rem;
        font-weight: 500;
        transition:
          background var(--dur-fast) var(--ease-out),
          color var(--dur-fast) var(--ease-out),
          border-color var(--dur-fast) var(--ease-out),
          opacity var(--dur-fast) var(--ease-out);
      }
      .chip:hover {
        background: var(--btn-hover);
      }
      .chip.off {
        background: var(--input-bg);
        color: var(--text-dim);
        opacity: 0.6;
      }
      .chip:focus-visible {
        outline: none;
        box-shadow: 0 0 0 3px var(--accent-ring);
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

    // Bidirectional canvas (#13, #15): the card verbs (Discuss / Expand /
    // Challenge / Find risks) live on the selected idea card's element-toolbar
    // More menu. When one fires, frame the card's text for that intent and type
    // it into the active workspace's live terminal as an editable prompt.
    this.#canvas.onCardVerb((text, intent, sourceRef) => {
      const ws = this.workspaces.active();
      if (ws) this.#agent.discussText(ws.id, text, intent, sourceRef);
    });
  }

  /** The active workspace's current canvas mode, defaulting to 'page'. */
  readonly activeMode = computed<CanvasMode>(() => this.workspaces.active()?.mode ?? 'page');

  /**
   * Distinct idea kinds present on the active workspace's canvas (#21), one
   * filter chip each. Recomputes when a new batch of AI cards lands (the canvas
   * service bumps `ideasTick`) or the active workspace changes.
   */
  readonly kinds = computed<string[]>(() => {
    this.#canvas.ideasTick();
    const active = this.workspaces.active();
    return active ? this.#canvas.kindsPresent(active.id) : [];
  });

  /** Kinds the user has hidden from the edgeless surface (#21), local UI state. */
  readonly hiddenKinds = signal<ReadonlySet<string>>(new Set());

  /** Presentation label for a kind chip (#21), e.g. `risk` → `⚠ Risk`. */
  label(kind: string): string {
    return kindLabel(kind);
  }

  /**
   * Toggle a kind's visibility on the edgeless canvas (#21): flips local
   * `hiddenKinds` state and drives every matching note's `displayMode` via the
   * canvas service.
   */
  toggleKind(kind: string): void {
    const active = this.workspaces.active();
    if (!active) return;
    const hidden = new Set(this.hiddenKinds());
    const willHide = !hidden.has(kind);
    if (willHide) hidden.add(kind);
    else hidden.delete(kind);
    this.hiddenKinds.set(hidden);
    this.#canvas.setKindVisible(active.id, kind, !willHide);
  }

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
