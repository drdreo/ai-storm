import {
  ChangeDetectionStrategy,
  Component,
  Directive,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  signal,
} from '@angular/core';
import { Listbox, Option } from '@angular/aria/listbox';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@angular/aria/menu';
import { WorkspaceService } from '../core/workspace.service';
import { IngestionService } from '../core/ingestion.service';
import type { WorkspaceMeta } from '../core/models';

/** Focus (and select) a freshly-rendered inline input — the rename field. */
@Directive({ selector: '[asAutofocus]' })
export class AutofocusDirective {
  constructor() {
    const el = inject(ElementRef).nativeElement as HTMLInputElement;
    afterNextRender(() => {
      el.focus();
      el.select();
    });
  }
}

/**
 * Global navigation sidebar (PRD §3.4). Lists every workspace with a
 * human-readable title and live status, and performs the sub-100ms hot-switch
 * by simply changing the active id — CanvasService rebinds the shared editor.
 *
 * Workspace management lives on the rows themselves (no bottom buttons): a
 * double-click on the title (or the kebab's "Rename") turns it into an inline
 * input, and a per-row kebab (⋮) opens an `@angular/aria` menu to rename or
 * delete. New workspaces are created from the header "+".
 */
@Component({
  selector: 'as-sidebar',
  imports: [Listbox, Option, Menu, MenuContent, MenuItem, MenuTrigger, AutofocusDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="head">
      <span class="brand">ai-storm</span>
      <button class="add" title="New workspace" aria-label="New workspace" (click)="add()">+</button>
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
          [class.editing]="editingId() === ws.id"
        >
          <span class="dot" [attr.data-status]="ws.status"></span>
          @if (editingId() === ws.id) {
            <!-- Inline rename: commits on Enter/blur, cancels on Esc. Key/click
                 events are stopped so the parent listbox doesn't treat typing as
                 navigation/typeahead or steal the selection. -->
            <input
              asAutofocus
              class="rename-input"
              type="text"
              [value]="ws.title"
              aria-label="Rename workspace"
              (keydown)="onRenameKey($event, ws)"
              (blur)="commitRename(ws, $event)"
              (click)="$event.stopPropagation()"
              (pointerdown)="$event.stopPropagation()"
            />
          } @else {
            <span class="title" [title]="ws.title" (dblclick)="beginRename(ws, $event)">{{ ws.title }}</span>
          }
          <span class="status">{{ ws.status }}</span>
          <button
            class="kebab"
            ngMenuTrigger
            [menu]="wsMenu"
            [attr.aria-label]="'Manage ' + ws.title"
            (click)="openMenu(ws, $event)"
            (pointerdown)="$event.stopPropagation()"
            (dblclick)="$event.stopPropagation()"
          >
            <span aria-hidden="true">⋮</span>
          </button>
        </li>
      }
    </ul>

    <!-- One shared menu, positioned at the kebab that opened it; acts on the
         workspace captured in menuFor(). Rendered outside the scrolling list so
         it is never clipped. Escape / focus-out dismiss it (aria menu). -->
    <div
      class="ws-menu"
      ngMenu
      #wsMenu="ngMenu"
      [style.top.px]="menuPos()?.top"
      [style.left.px]="menuPos()?.left"
    >
      <ng-template ngMenuContent>
        <button ngMenuItem value="rename" class="menu-item" (click)="renameFromMenu(wsMenu)">
          Rename
        </button>
        <button ngMenuItem value="delete" class="menu-item danger" (click)="deleteFromMenu(wsMenu)">
          Delete
        </button>
      </ng-template>
    </div>
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
        grid-template-columns: 10px 1fr auto auto;
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
      .rename-input {
        min-width: 0;
        width: 100%;
        border-radius: var(--radius-sm);
        border: 1px solid var(--accent);
        background: var(--input-bg);
        color: var(--text);
        padding: 0.15rem 0.35rem;
        margin: -0.16rem 0;
        font: inherit;
        font-size: 0.86rem;
      }
      .rename-input:focus {
        outline: none;
        box-shadow: 0 0 0 3px var(--accent-ring);
      }
      .status {
        font-size: 0.62rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        opacity: 0.55;
      }
      /* While renaming, the status chip would crowd the input — hide it. */
      .item.editing .status {
        display: none;
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
      /* Kebab — quiet until the row is hovered/active or the menu is open. */
      .kebab {
        display: grid;
        place-items: center;
        width: 22px;
        height: 22px;
        border-radius: var(--radius-sm);
        border: 1px solid transparent;
        background: transparent;
        color: var(--text-dim);
        cursor: pointer;
        font-size: 15px;
        line-height: 1;
        opacity: 0;
        transition:
          background var(--dur-fast) var(--ease-out),
          color var(--dur-fast) var(--ease-out),
          border-color var(--dur-fast) var(--ease-out),
          opacity var(--dur-fast) var(--ease-out);
      }
      .item:hover .kebab,
      .item.active .kebab,
      .kebab[aria-expanded='true'] {
        opacity: 1;
      }
      .kebab:hover {
        background: var(--btn-hover);
        color: var(--text);
        border-color: var(--border-strong);
      }
      .kebab[aria-expanded='true'] {
        background: var(--btn-press);
        color: var(--text);
        border-color: var(--accent);
      }
      .kebab:focus-visible {
        outline: none;
        opacity: 1;
        box-shadow: 0 0 0 3px var(--accent-ring);
      }
      /* Floating actions menu (aria-driven). Hidden unless data-visible. */
      .ws-menu {
        position: fixed;
        z-index: 50;
        min-width: 156px;
        display: none;
        flex-direction: column;
        gap: 2px;
        padding: var(--space-2);
        border: 1px solid var(--border-strong);
        border-radius: var(--radius-md);
        background: var(--panel-bg);
        box-shadow: var(--shadow-md, 0 10px 30px -12px rgba(0, 0, 0, 0.7));
      }
      .ws-menu[data-visible='true'] {
        display: flex;
      }
      .ws-menu:focus,
      .ws-menu:focus-visible {
        outline: none;
      }
      .menu-item {
        display: flex;
        align-items: center;
        padding: 0.42rem 0.6rem;
        border: 0;
        border-radius: var(--radius-sm);
        background: transparent;
        color: var(--text-dim);
        cursor: pointer;
        text-align: left;
        font: inherit;
        font-size: 0.82rem;
        font-weight: 500;
        transition:
          background var(--dur-fast) var(--ease-out),
          color var(--dur-fast) var(--ease-out);
      }
      .menu-item:hover,
      .menu-item:focus-visible,
      .menu-item[tabindex='0'] {
        outline: none;
        background: var(--surface-overlay);
        color: var(--text);
      }
      .menu-item.danger:hover,
      .menu-item.danger:focus-visible,
      .menu-item.danger[tabindex='0'] {
        background: color-mix(in srgb, var(--danger) 16%, transparent);
        color: var(--danger);
      }
    `,
  ],
})
export class SidebarComponent {
  readonly workspaces = inject(WorkspaceService);
  readonly #ingestion = inject(IngestionService);

  /** Id of the workspace currently being renamed inline (null = none). */
  readonly editingId = signal<string | null>(null);
  /** Workspace the open kebab menu acts on. */
  readonly #menuFor = signal<WorkspaceMeta | null>(null);
  /** Viewport coordinates the floating kebab menu anchors to. */
  readonly menuPos = signal<{ top: number; left: number } | null>(null);

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

  // ---- Inline rename ------------------------------------------------------

  beginRename(ws: WorkspaceMeta, event?: Event): void {
    event?.stopPropagation();
    this.editingId.set(ws.id);
  }

  /** Commit the inline edit (Enter / blur). No-ops if the field is empty. */
  commitRename(ws: WorkspaceMeta, event: Event): void {
    // Only the active edit commits — guards the blur fired by Esc/Enter teardown.
    if (this.editingId() !== ws.id) return;
    const title = (event.target as HTMLInputElement).value.trim();
    if (title && title !== ws.title) this.workspaces.rename(ws.id, title);
    this.editingId.set(null);
  }

  onRenameKey(event: KeyboardEvent, ws: WorkspaceMeta): void {
    // Keep the listbox from treating rename keystrokes as navigation/typeahead.
    event.stopPropagation();
    if (event.key === 'Enter') {
      event.preventDefault();
      this.commitRename(ws, event);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.editingId.set(null); // discard — no rename
    }
  }

  // ---- Kebab menu ---------------------------------------------------------

  /** Anchor + arm the shared menu for this row; the trigger handles opening. */
  openMenu(ws: WorkspaceMeta, event: MouseEvent): void {
    event.stopPropagation();
    this.#menuFor.set(ws);
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const width = 156;
    this.menuPos.set({
      top: Math.round(rect.bottom + 6),
      left: Math.round(Math.max(8, rect.right - width)),
    });
  }

  renameFromMenu(menu: Menu<string>): void {
    const ws = this.#menuFor();
    menu.close();
    if (ws) this.beginRename(ws);
  }

  deleteFromMenu(menu: Menu<string>): void {
    const ws = this.#menuFor();
    menu.close();
    if (ws) this.remove(ws.id);
  }

  remove(id: string): void {
    if (!confirm('Delete this workspace and its canvas? This cannot be undone.')) return;
    // Detach first so the durable session is left intact (PRD §3.5); remove()
    // recreates a workspace if this was the last one.
    this.#ingestion.detach(id);
    this.workspaces.remove(id);
  }
}
