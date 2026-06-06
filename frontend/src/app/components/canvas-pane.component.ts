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
import { CanvasService } from '../core/canvas.service';
import { AgentService } from '../core/agent.service';
import { kindLabel } from '../core/idea-descriptors';

/**
 * Structural Workspace Canvas (PRD §3.1, §4.1). Hosts the tldraw canvas (a React
 * island owned by {@link CanvasService}) as the single spatial surface (PD-011:
 * no document/page view). The pane is just a toolbar — kind filters (#21) and
 * the agent macros (PRD §3.6) — over the canvas host.
 */
@Component({
  selector: 'as-canvas-pane',
  imports: [Toolbar, ToolbarWidget],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="pane">
      <div class="toolbar">
        @if (kinds().length) {
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
            value="arrange"
            class="ghost"
            (click)="arrange()"
            title="Tidy cards into per-kind groups (#16)"
          >
            ⤳ Arrange
          </button>
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
    </div>
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        height: 100%;
      }
      .pane {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-height: 0;
      }
      .toolbar {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        padding: var(--space-2) var(--space-3);
        border-bottom: 1px solid var(--border-strong);
        background: var(--panel-bg);
        box-shadow: var(--shadow-sm);
        gap: var(--space-2);
        z-index: 2;
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
        margin-right: auto;
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
        position: relative;
        flex: 1;
        min-height: 0;
        overflow: hidden;
        background: var(--canvas-bg);
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
    // React to workspace switches — mount/rebind the tldraw island (PRD §3.4).
    effect(() => {
      const active = this.workspaces.active();
      const hostEl = this.host().nativeElement;
      if (!active) return;
      this.#canvas.mount(hostEl, active.id);
    });

    // Bidirectional canvas (#13, #15): the card verbs (Discuss / Expand /
    // Challenge / Find risks) live on the selected idea card's action bar. When
    // one fires, frame the card's text for that intent and type it into the
    // active workspace's live terminal as an editable prompt.
    this.#canvas.onCardVerb((text, intent, sourceRef) => {
      const ws = this.workspaces.active();
      if (ws) this.#agent.discussText(ws.id, text, intent, sourceRef);
    });
  }

  /**
   * Distinct idea kinds present on the active workspace's canvas (#21), one
   * filter chip each. Recomputes when a new batch of cards lands (the canvas
   * service bumps `ideasTick`) or the active workspace changes.
   */
  readonly kinds = computed<string[]>(() => {
    this.#canvas.ideasTick();
    const active = this.workspaces.active();
    return active ? this.#canvas.kindsPresent(active.id) : [];
  });

  /** Kinds the user has hidden from the canvas (#21), local UI state. */
  readonly hiddenKinds = signal<ReadonlySet<string>>(new Set());

  /** Presentation label for a kind chip (#21), e.g. `risk` → `⚠ Risk`. */
  label(kind: string): string {
    return kindLabel(kind);
  }

  /**
   * Toggle a kind's visibility on the canvas (#21): flips local `hiddenKinds`
   * state and drives every matching card's opacity via the canvas service.
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

  /**
   * Re-flow the canvas cards into per-kind lanes (#16, PD-014). On-demand only —
   * the board never re-arranges itself, so manual placement is preserved.
   */
  arrange(): void {
    const active = this.workspaces.active();
    if (active) this.#canvas.arrange(active.id);
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
