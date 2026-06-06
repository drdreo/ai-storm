import { Injectable, computed, inject, signal } from '@angular/core';
import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { CanvasService } from './canvas.service';
import { defaultTerminalConfig, type WorkspaceMeta, type WorkspaceStatus } from './models';

const REGISTRY_ROOM = 'ai-storm-registry';
const ACTIVE_KEY = 'ai-storm.activeWorkspace';

/**
 * Multi-workspace registry & lifecycle (PRD §3.4, §3.5).
 *
 * Workspace metadata is stored in a dedicated CRDT Y.Doc persisted to its own
 * IndexedDB store, so every change (title, status) is written immediately and
 * survives crashes. The canvas content for each workspace is owned by
 * CanvasService (a tldraw store per workspace). On boot we rehydrate both layers
 * and restore the most recently active workspace exactly as it was left.
 */
@Injectable({ providedIn: 'root' })
export class WorkspaceService {
  readonly canvas = inject(CanvasService);

  readonly workspaces = signal<WorkspaceMeta[]>([]);
  readonly activeId = signal<string | null>(null);
  readonly active = computed(() => {
    const id = this.activeId();
    return id ? this.workspaces().find((w) => w.id === id) ?? null : null;
  });
  readonly booted = signal(false);

  #registryDoc = new Y.Doc();
  #registryPersistence!: IndexeddbPersistence;
  #map!: Y.Map<WorkspaceMeta>;

  /** Boot sequence (PRD §3.5): rehydrate CRDT stores, restore last workspace. */
  async boot(): Promise<void> {
    if (this.booted()) return;
    await this.canvas.init();

    this.#map = this.#registryDoc.getMap<WorkspaceMeta>('workspaces');
    this.#registryPersistence = new IndexeddbPersistence(REGISTRY_ROOM, this.#registryDoc);
    await new Promise<void>((resolve) => {
      this.#registryPersistence.once('synced', () => resolve());
    });

    // Keep signals in sync with the CRDT registry (immediate writes §3.5).
    this.#map.observe(() => this.#syncFromMap());
    this.#syncFromMap();

    if (this.workspaces().length === 0) {
      // First run — stand up a starter workspace.
      const id = this.create('Untitled Project');
      this.setActive(id);
    } else {
      // Restore the most recently active workspace.
      const stored = localStorage.getItem(ACTIVE_KEY);
      const exists = stored && this.workspaces().some((w) => w.id === stored);
      const fallback = [...this.workspaces()].sort(
        (a, b) => b.lastActiveAt - a.lastActiveAt,
      )[0];
      this.setActive(exists ? stored! : fallback.id);
    }

    // Let the canvas settle before rendering the panes (PRD §3.5 boot). tldraw
    // loads the active workspace's store on mount, so this is a cheap no-op kept
    // for parity / future async restore.
    const active = this.activeId();
    if (active) await this.canvas.ensureReady(active);

    this.booted.set(true);
  }

  #syncFromMap(): void {
    const list: WorkspaceMeta[] = [];
    this.#map.forEach((meta) => list.push(meta));
    list.sort((a, b) => a.createdAt - b.createdAt);
    this.workspaces.set(list);
  }

  #write(meta: WorkspaceMeta): void {
    // Structured-clone a plain object into the CRDT map (writes immediately).
    this.#map.set(meta.id, { ...meta, terminal: { ...meta.terminal } });
  }

  create(title: string): string {
    const id = `ws_${crypto.randomUUID()}`;
    const now = Date.now();
    const meta: WorkspaceMeta = {
      id,
      title,
      status: 'idle',
      createdAt: now,
      lastActiveAt: now,
      terminal: defaultTerminalConfig(),
    };
    this.#write(meta);
    return id;
  }

  rename(id: string, title: string): void {
    const meta = this.#map.get(id);
    if (!meta) return;
    this.#write({ ...meta, title });
  }

  setStatus(id: string, status: WorkspaceStatus): void {
    const meta = this.#map.get(id);
    if (meta && meta.status !== status) this.#write({ ...meta, status });
  }

  patchTerminal(id: string, patch: Partial<WorkspaceMeta['terminal']>): void {
    const meta = this.#map.get(id);
    if (meta) this.#write({ ...meta, terminal: { ...meta.terminal, ...patch } });
  }

  setActive(id: string): void {
    if (this.activeId() === id) return;
    this.activeId.set(id);
    localStorage.setItem(ACTIVE_KEY, id);
    const meta = this.#map.get(id);
    if (meta) this.#write({ ...meta, lastActiveAt: Date.now() });
  }

  async remove(id: string): Promise<void> {
    const wasActive = this.activeId() === id;
    let target = this.workspaces().find((w) => w.id !== id) ?? null;
    if (wasActive && !target) {
      // Deleting the last workspace — stand up a replacement to switch onto.
      const fresh = this.create('Untitled Project');
      target = this.#map.get(fresh) ?? null;
    }

    // When deleting the ACTIVE workspace, switch the canvas onto the target
    // workspace's store before dropping the deleted one's persisted store.
    if (wasActive && target) {
      await this.canvas.ensureReady(target.id);
      this.setActive(target.id);
      this.canvas.switchTo(target.id);
    }

    this.#map.delete(id);
    this.canvas.removeWorkspace(id);
  }
}
