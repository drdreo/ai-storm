import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Listbox, Option } from '@angular/aria/listbox';
import { WorkspaceService } from '../core/workspace.service';
import { IngestionService } from '../core/ingestion.service';
import type { WorkspaceMeta } from '../core/models';

/**
 * Global navigation sidebar (PRD §3.4). Lists every workspace with a
 * human-readable title and live status, and performs the sub-100ms hot-switch
 * by simply changing the active id — CanvasService rebinds the shared editor.
 */
@Component({
  selector: 'as-sidebar',
  imports: [Listbox, Option],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="head">
      <span class="brand">ai-storm</span>
      <button class="add" title="New workspace" (click)="add()">+</button>
    </header>
    <ul
      class="list"
      ngListbox
      orientation="vertical"
      selectionMode="follow"
      [value]="selectedValues()"
      (valueChange)="onSelect($event)"
      aria-label="Workspaces"
    >
      @for (ws of workspaces.workspaces(); track ws.id) {
        <li
          ngOption
          class="item"
          [value]="ws.id"
          [label]="ws.title"
          [class.active]="ws.id === workspaces.activeId()"
        >
          <span class="dot" [attr.data-status]="ws.status"></span>
          <span class="title" [title]="ws.title">{{ ws.title }}</span>
          <span class="status">{{ ws.status }}</span>
        </li>
      }
    </ul>
    @if (workspaces.active(); as active) {
      <footer class="foot">
        <button class="rename" (click)="rename(active)">Rename</button>
        <button class="remove" (click)="remove(active.id)">Delete</button>
      </footer>
    }
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        background: var(--sidebar-bg);
        border-right: 1px solid var(--border);
        height: 100%;
        user-select: none;
      }
      .head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--space-4) var(--space-4) var(--space-3);
        border-bottom: 1px solid var(--border);
      }
      .brand {
        display: inline-flex;
        align-items: center;
        gap: var(--space-2);
        font-weight: 700;
        font-size: 0.95rem;
        letter-spacing: -0.01em;
        color: var(--text);
      }
      /* A small mark gives the wordmark some identity instead of bare text. */
      .brand::before {
        content: '';
        width: 9px;
        height: 9px;
        border-radius: 3px;
        background: linear-gradient(135deg, var(--accent), var(--accent-press));
        box-shadow: 0 0 0 3px var(--accent-soft);
      }
      .add {
        display: grid;
        place-items: center;
        width: 28px;
        height: 28px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border-strong);
        background: var(--btn-bg);
        color: var(--text-dim);
        font-size: 17px;
        cursor: pointer;
        line-height: 1;
        transition:
          background var(--dur-fast) var(--ease-out),
          color var(--dur-fast) var(--ease-out),
          border-color var(--dur-fast) var(--ease-out),
          transform var(--dur-fast) var(--ease-out);
      }
      .add:hover {
        background: var(--btn-hover);
        color: var(--text);
        border-color: var(--accent);
      }
      .add:active {
        transform: scale(0.92);
        background: var(--btn-press);
      }
      .add:focus-visible {
        outline: none;
        box-shadow: 0 0 0 3px var(--accent-ring);
      }
      .list {
        flex: 1;
        overflow-y: auto;
        padding: var(--space-2);
        margin: 0;
        list-style: none;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .list:focus,
      .list:focus-visible,
      .item:focus,
      .item:focus-visible {
        outline: none;
      }
      .item {
        position: relative;
        display: grid;
        grid-template-columns: 10px 1fr auto;
        align-items: center;
        gap: var(--space-2);
        padding: 0.5rem 0.6rem;
        border: 0;
        border-radius: var(--radius-md);
        background: transparent;
        color: var(--text-dim);
        cursor: pointer;
        text-align: left;
        font: inherit;
        font-size: 0.86rem;
        transition:
          background var(--dur-fast) var(--ease-out),
          color var(--dur-fast) var(--ease-out);
      }
      .item:hover {
        background: var(--surface-overlay);
        color: var(--text);
      }
      .item.active {
        background: var(--accent-soft);
        color: var(--text);
        font-weight: 500;
      }
      /* Active-row accent rail — a clearer "you are here" than a flat fill. */
      .item.active::before {
        content: '';
        position: absolute;
        left: 0;
        top: 50%;
        transform: translateY(-50%);
        width: 3px;
        height: 1.1rem;
        border-radius: var(--radius-full);
        background: var(--accent);
      }
      .item.active .status {
        color: var(--accent);
        opacity: 0.9;
      }
      .item:focus-visible {
        box-shadow: inset 0 0 0 1px var(--accent-ring);
      }
      .title {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        letter-spacing: -0.005em;
      }
      .status {
        font-size: 0.62rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        opacity: 0.55;
      }
      .dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--text-faint);
        box-shadow: 0 0 0 3px transparent;
        transition: box-shadow var(--dur) var(--ease-out);
      }
      .dot[data-status='streaming'] {
        background: var(--accent);
        box-shadow: 0 0 0 3px var(--accent-soft);
        animation: pulse 1.4s var(--ease-out) infinite;
      }
      .dot[data-status='active'] {
        background: var(--ok);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 22%, transparent);
      }
      .dot[data-status='error'] {
        background: var(--danger);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--danger) 22%, transparent);
      }
      @keyframes pulse {
        50% {
          opacity: 0.45;
        }
      }
      .foot {
        display: flex;
        gap: var(--space-2);
        padding: var(--space-3);
        border-top: 1px solid var(--border);
      }
      .foot button {
        flex: 1;
        padding: 0.42rem;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border-strong);
        background: var(--btn-bg);
        color: var(--text-dim);
        cursor: pointer;
        font: inherit;
        font-size: 0.76rem;
        font-weight: 500;
        transition:
          background var(--dur-fast) var(--ease-out),
          color var(--dur-fast) var(--ease-out),
          border-color var(--dur-fast) var(--ease-out);
      }
      .foot button:hover {
        background: var(--btn-hover);
        color: var(--text);
        border-color: var(--accent);
      }
      .foot button:active {
        background: var(--btn-press);
      }
      .foot button:focus-visible {
        outline: none;
        box-shadow: 0 0 0 3px var(--accent-ring);
      }
      .remove:hover {
        color: var(--danger);
        border-color: var(--danger);
      }
    `,
  ],
})
export class SidebarComponent {
  readonly workspaces = inject(WorkspaceService);
  readonly #ingestion = inject(IngestionService);

  /**
   * The listbox `[(value)]` model is an array of selected option values. For our
   * single-select navigation we mirror the active workspace id as a one-element
   * array (empty when nothing is active).
   */
  readonly selectedValues = computed<string[]>(() => {
    const id = this.workspaces.activeId();
    return id ? [id] : [];
  });

  add(): void {
    const id = this.workspaces.create('Untitled Project');
    this.workspaces.setActive(id);
  }

  /** React to listbox selection changes — drive the sub-100ms hot-switch. */
  onSelect(values: readonly string[]): void {
    const id = values[0];
    if (id) this.workspaces.setActive(id);
  }

  rename(ws: WorkspaceMeta): void {
    const title = prompt('Rename workspace', ws.title);
    if (title && title.trim()) this.workspaces.rename(ws.id, title.trim());
  }

  remove(id: string): void {
    if (!confirm('Delete this workspace and its canvas? This cannot be undone.')) return;
    this.#ingestion.detach(id);
    this.workspaces.remove(id);
  }
}
