import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
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
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="head">
      <span class="brand">ai-storm</span>
      <button class="add" title="New workspace" (click)="add()">+</button>
    </header>
    <nav class="list">
      @for (ws of workspaces.workspaces(); track ws.id) {
        <button
          class="item"
          [class.active]="ws.id === workspaces.activeId()"
          (click)="select(ws.id)"
        >
          <span class="dot" [attr.data-status]="ws.status"></span>
          <span class="title" [title]="ws.title">{{ ws.title }}</span>
          <span class="status">{{ ws.status }}</span>
        </button>
      }
    </nav>
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
        padding: 0.85rem 0.9rem;
        border-bottom: 1px solid var(--border);
      }
      .brand {
        font-weight: 700;
        letter-spacing: 0.02em;
        color: var(--text);
      }
      .add {
        width: 26px;
        height: 26px;
        border-radius: 6px;
        border: 1px solid var(--border);
        background: var(--btn-bg);
        color: var(--text);
        font-size: 16px;
        cursor: pointer;
        line-height: 1;
      }
      .add:hover {
        background: var(--btn-hover);
      }
      .list {
        flex: 1;
        overflow-y: auto;
        padding: 0.5rem;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .item {
        display: grid;
        grid-template-columns: 10px 1fr auto;
        align-items: center;
        gap: 0.55rem;
        padding: 0.55rem 0.6rem;
        border: 0;
        border-radius: 8px;
        background: transparent;
        color: var(--text-dim);
        cursor: pointer;
        text-align: left;
        font: inherit;
      }
      .item:hover {
        background: var(--btn-hover);
      }
      .item.active {
        background: var(--accent-soft);
        color: var(--text);
      }
      .title {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .status {
        font-size: 0.66rem;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        opacity: 0.6;
      }
      .dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--text-dim);
      }
      .dot[data-status='streaming'] {
        background: var(--accent);
        box-shadow: 0 0 8px var(--accent);
        animation: pulse 1.2s ease-in-out infinite;
      }
      .dot[data-status='active'] {
        background: #36c275;
      }
      .dot[data-status='error'] {
        background: #e5534b;
      }
      @keyframes pulse {
        50% {
          opacity: 0.35;
        }
      }
      .foot {
        display: flex;
        gap: 0.4rem;
        padding: 0.6rem;
        border-top: 1px solid var(--border);
      }
      .foot button {
        flex: 1;
        padding: 0.4rem;
        border-radius: 6px;
        border: 1px solid var(--border);
        background: var(--btn-bg);
        color: var(--text-dim);
        cursor: pointer;
        font: inherit;
        font-size: 0.78rem;
      }
      .foot button:hover {
        background: var(--btn-hover);
        color: var(--text);
      }
      .remove:hover {
        color: #e5534b;
      }
    `,
  ],
})
export class SidebarComponent {
  readonly workspaces = inject(WorkspaceService);
  readonly #ingestion = inject(IngestionService);

  add(): void {
    const id = this.workspaces.create('Untitled Project');
    this.workspaces.setActive(id);
  }

  select(id: string): void {
    this.workspaces.setActive(id);
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
