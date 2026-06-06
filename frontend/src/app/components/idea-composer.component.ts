import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  output,
  signal,
  viewChild,
} from '@angular/core';
import type { Idea } from '@ai-storm/shared';
import { buildIdea, KIND_LABEL } from '../core/idea-descriptors';

/**
 * Human idea composer (#31, PD-002). A presentational affordance for a person to
 * author an {@link Idea} card directly — the input-side counterpart to the AI
 * `idea` stream. It owns NO services and touches NO BlockSuite: it only collects
 * `{ title, body, kind? }`, normalizes it via the pure {@link buildIdea} helper
 * (so a human idea is the exact wire object the backend emits), and emits it via
 * `capture` for the host to route through `CanvasService.captureIdea`. Kept
 * presentational so it is trivially unit-testable in isolation.
 */
@Component({
  selector: 'as-idea-composer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      type="button"
      class="ghost toggle"
      [class.on]="open()"
      (click)="toggle()"
      title="Add an idea card to the canvas (#31)"
      aria-haspopup="dialog"
      [attr.aria-expanded]="open()"
    >
      + Add idea
    </button>

    @if (open()) {
      <div class="panel" role="dialog" aria-label="Compose idea">
        <input
          #titleInput
          class="field title"
          type="text"
          [value]="title()"
          (input)="title.set(asValue($event))"
          (keydown.enter)="submit()"
          (keydown.escape)="cancel()"
          placeholder="Idea title (required)"
          aria-label="Idea title"
          spellcheck="false"
        />
        <textarea
          class="field body"
          rows="3"
          [value]="body()"
          (input)="body.set(asValue($event))"
          (keydown.escape)="cancel()"
          (keydown.meta.enter)="submit()"
          (keydown.control.enter)="submit()"
          placeholder="Body (optional)"
          aria-label="Idea body"
        ></textarea>
        <div class="row">
          <select
            class="field kind"
            [value]="kind()"
            (change)="kind.set(asValue($event))"
            (keydown.escape)="cancel()"
            aria-label="Idea kind"
          >
            <option value="">(none)</option>
            @for (k of kinds; track k.value) {
              <option [value]="k.value">{{ k.label }}</option>
            }
          </select>
          <span class="spacer"></span>
          <button type="button" class="ghost" (click)="cancel()">Cancel</button>
          <button type="button" class="accent" [disabled]="!title().trim()" (click)="submit()">
            Add
          </button>
        </div>
      </div>
    }
  `,
  styles: [
    `
      :host {
        position: relative;
        display: inline-flex;
      }
      .toggle {
        border-radius: var(--radius-md);
        padding: 0.42rem 0.8rem;
        cursor: pointer;
        font: inherit;
        font-size: 0.8rem;
        font-weight: 500;
        border: 1px solid var(--border-strong);
        background: var(--btn-bg);
        color: var(--text-dim);
        transition:
          background var(--dur-fast) var(--ease-out),
          color var(--dur-fast) var(--ease-out),
          border-color var(--dur-fast) var(--ease-out),
          transform var(--dur-fast) var(--ease-out);
      }
      .toggle:hover,
      .toggle.on {
        background: var(--btn-hover);
        color: var(--text);
        border-color: var(--border-strong);
      }
      .toggle:active {
        transform: translateY(1px);
      }
      .toggle:focus-visible {
        outline: none;
        box-shadow: 0 0 0 3px var(--accent-ring);
      }
      .panel {
        position: absolute;
        top: calc(100% + var(--space-2));
        left: 0;
        z-index: 10;
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
        width: 280px;
        padding: var(--space-3);
        border: 1px solid var(--border-strong);
        border-radius: var(--radius-md);
        background: var(--panel-bg);
        box-shadow: var(--shadow-md, var(--shadow-sm));
      }
      .field {
        width: 100%;
        box-sizing: border-box;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border-strong);
        background: var(--input-bg);
        color: var(--text);
        padding: 0.36rem 0.55rem;
        font: inherit;
        font-size: 0.8rem;
        transition:
          border-color var(--dur-fast) var(--ease-out),
          box-shadow var(--dur-fast) var(--ease-out);
      }
      .field:hover {
        border-color: var(--accent);
      }
      .field:focus {
        outline: none;
        border-color: var(--accent);
        box-shadow: 0 0 0 3px var(--accent-ring);
      }
      .body {
        resize: vertical;
        font-family: var(--sans, inherit);
        line-height: 1.4;
      }
      .row {
        display: flex;
        align-items: center;
        gap: var(--space-2);
      }
      .kind {
        flex: 0 1 auto;
        width: auto;
      }
      .spacer {
        flex: 1;
      }
      .row button {
        border-radius: var(--radius-sm);
        padding: 0.36rem 0.7rem;
        cursor: pointer;
        font: inherit;
        font-size: 0.78rem;
        font-weight: 500;
        border: 1px solid var(--border-strong);
        transition:
          background var(--dur-fast) var(--ease-out),
          color var(--dur-fast) var(--ease-out),
          border-color var(--dur-fast) var(--ease-out),
          transform var(--dur-fast) var(--ease-out);
      }
      .row button:active {
        transform: translateY(1px);
      }
      .row button:focus-visible {
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
      .accent:hover:not(:disabled) {
        background: var(--accent-hover);
        border-color: var(--accent-hover);
      }
      .accent:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
    `,
  ],
})
export class IdeaComposerComponent {
  /** Emits the normalized human-authored idea for the host to capture. */
  readonly capture = output<Idea>();

  /** Whether the inline compose form is open. */
  readonly open = signal(false);

  readonly title = signal('');
  readonly body = signal('');
  readonly kind = signal('');

  /** Known idea kinds (label + value) for the `<select>`, from {@link KIND_LABEL}. */
  readonly kinds = Object.entries(KIND_LABEL).map(([value, label]) => ({ value, label }));

  // Angular signal queries cannot live on ES-private (`#`) fields (NG1053), so
  // this uses a TS-private field instead of the `#private` convention.
  private readonly titleInput = viewChild<ElementRef<HTMLInputElement>>('titleInput');

  /** Read the current value off an input/textarea/select change or input event. */
  asValue(event: Event): string {
    return (event.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value;
  }

  toggle(): void {
    this.open() ? this.cancel() : this.openForm();
  }

  /** Open the form and focus the title input on the next frame. */
  openForm(): void {
    this.open.set(true);
    queueMicrotask(() => this.titleInput()?.nativeElement.focus());
  }

  /**
   * Normalize the fields via {@link buildIdea}; emit `capture` and reset only
   * when the result is non-null (a missing title is a no-op so the user can fix
   * it). Keeps the wire-shaping in one pure place.
   */
  submit(): void {
    const idea = buildIdea(this.title(), this.body(), this.kind());
    if (!idea) {
      this.titleInput()?.nativeElement.focus();
      return;
    }
    this.capture.emit(idea);
    this.#reset();
    this.open.set(false);
  }

  /** Discard the draft and close the form. */
  cancel(): void {
    this.#reset();
    this.open.set(false);
  }

  #reset(): void {
    this.title.set('');
    this.body.set('');
    this.kind.set('');
  }
}
