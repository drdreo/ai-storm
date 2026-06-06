import { Injectable, signal } from '@angular/core';
import { createRoot, type Root } from 'react-dom/client';
import { createElement } from 'react';
import type { Editor } from 'tldraw';
import type { Idea } from '@ai-storm/shared';
import type { PromptIntent } from './prompt-framing';
import {
  CanvasIsland,
  type CanvasBridge,
  applyIdeas,
  serializeEditor,
  selectedText,
  kindsPresent,
  setKindVisible,
} from './canvas-island';

/**
 * tldraw canvas integration (PRD §3.1, §3.3, §3.6) — the Angular-facing facade
 * over the React {@link CanvasIsland} that holds the tldraw `Editor`.
 *
 * One `<Tldraw>` is mounted at a time, keyed by the active workspace id; its
 * store is persisted per-workspace to IndexedDB via `persistenceKey` (PD-001,
 * local-first; survives reload). Hot-switching (PRD §3.4) remounts the island
 * onto the next workspace's store. There is no document/page view (PD-011) and
 * no CRDT collection — tldraw owns persistence — so the old BlockSuite seam
 * (`setMode`, `setDocTitle`, doc seeding, the `ai-storm:*` Y.Maps) is gone; the
 * shape props/`meta` carry kind/origin/lifecycle/ref natively.
 *
 * Background ingestion: a workspace whose session is streaming but which is NOT
 * the mounted one has no live editor, so its ideas are queued and drained when
 * it next mounts. (A never-opened background workspace therefore persists its
 * ideas only once viewed — acceptable for single-user v0; full background
 * persistence is the backend-snapshot ticket.)
 */
@Injectable({ providedIn: 'root' })
export class CanvasService {
  /** True once the canvas is initialized (parity with the old CRDT-boot flag). */
  readonly ready = signal(false);

  /**
   * Monotonic counter bumped whenever the mounted canvas gains cards (a fresh
   * `applyIdeas`, or a workspace mounting with persisted cards). The toolbar's
   * kind-filter chips recompute against it (#21) — the tldraw store is not an
   * Angular signal, so this is the reactive trigger.
   */
  readonly #ideasTick = signal(0);
  readonly ideasTick = this.#ideasTick.asReadonly();

  #root: Root | null = null;
  #editor: Editor | null = null;
  /** Workspace id the mounted editor currently shows (guards background applies). */
  #activeId: string | null = null;
  /** Ideas streamed to a non-mounted workspace, drained on its next mount. */
  #pending = new Map<string, Idea[]>();
  /** Fired when a card verb (#13 Discuss / #15 expand/challenge/find-risks) is picked. */
  #cardVerbHandler:
    | ((text: string, intent: PromptIntent, sourceRef?: string) => void)
    | null = null;

  /** A single stable bridge identity handed to React for the app's lifetime. */
  readonly #bridge: CanvasBridge = {
    onEditorMount: (editor) => this.#onEditorMount(editor),
    onCardVerb: (text, intent, sourceRef) => this.#cardVerbHandler?.(text, intent, sourceRef),
  };

  /** No CRDT collection to stand up — just flip ready (parity with the old boot). */
  async init(): Promise<void> {
    this.ready.set(true);
  }

  /**
   * Resolve once the workspace's canvas is usable. tldraw loads its own store
   * from IndexedDB on mount and renders a loading state until synced, so there
   * is nothing to await here (the old impl had to gate on async CRDT rehydrate).
   */
  async ensureReady(_workspaceId: string): Promise<void> {
    /* tldraw owns store loading; nothing to pre-rehydrate. */
  }

  /**
   * Mount the React island into a host element, bound to a workspace's store.
   * Idempotent: the consumer's mount effect re-fires on every registry write
   * (status, lastActiveAt, …), so re-mounting the SAME workspace must be a no-op
   * — otherwise it would drop the live editor handle without remounting tldraw
   * (the `key` is unchanged), stranding `#editor` at `null` and queueing every
   * idea forever. Only an actual workspace change re-renders (see {@link switchTo}).
   */
  mount(host: HTMLElement, workspaceId: string): void {
    if (!this.#root) this.#root = createRoot(host);
    this.switchTo(workspaceId);
  }

  /**
   * Hot-switch the bound workspace (PRD §3.4): remount `<Tldraw>` onto the next
   * workspace's persisted store by changing its `key`/`persistenceKey`. The old
   * editor handle is dropped immediately; the new one arrives via `onMount`. A
   * switch to the already-active workspace is a no-op (keeps the live editor).
   */
  switchTo(workspaceId: string): void {
    if (workspaceId === this.#activeId) return;
    this.#activeId = workspaceId;
    this.#editor = null;
    if (this.#root) this.#render(workspaceId);
  }

  #render(workspaceId: string): void {
    this.#root?.render(createElement(CanvasIsland, { workspaceId, bridge: this.#bridge }));
  }

  #onEditorMount(editor: Editor): void {
    this.#editor = editor;
    // Drain any ideas that streamed in while this workspace was unmounted.
    const queued = this.#activeId ? this.#pending.get(this.#activeId) : undefined;
    if (queued?.length) {
      this.#pending.delete(this.#activeId!);
      applyIdeas(editor, queued);
    }
    // Recompute the kind-filter chips against the now-loaded store (covers a
    // reload restoring persisted cards, not just freshly-drained ones).
    this.#ideasTick.update((n) => n + 1);
  }

  /**
   * Render a batch of extracted ideas as cards + typed edges. Applied straight
   * to the live editor when the target workspace is the mounted one; otherwise
   * queued and drained when that workspace next mounts (see class doc).
   */
  applyIdeas(workspaceId: string, ideas: Idea[]): void {
    if (ideas.length === 0) return;
    if (this.#editor && workspaceId === this.#activeId) {
      applyIdeas(this.#editor, ideas);
      this.#ideasTick.update((n) => n + 1);
    } else {
      const q = this.#pending.get(workspaceId) ?? [];
      q.push(...ideas);
      this.#pending.set(workspaceId, q);
    }
  }

  /** Serialize the workspace canvas to normalized markdown (PRD §3.2). */
  serializeToText(workspaceId: string): string {
    if (!this.#editor || workspaceId !== this.#activeId) return '';
    return serializeEditor(this.#editor);
  }

  /** Plain text of the current selection — or the whole canvas (PRD §3.6). */
  getSelectedText(): string {
    return this.#editor ? selectedText(this.#editor) : '';
  }

  /** Distinct kinds present on the active workspace canvas (#21). */
  kindsPresent(workspaceId: string): string[] {
    if (!this.#editor || workspaceId !== this.#activeId) return [];
    return kindsPresent(this.#editor);
  }

  /** Show/hide every card of a kind on the canvas (#21). */
  setKindVisible(workspaceId: string, kind: string, visible: boolean): void {
    if (!this.#editor || workspaceId !== this.#activeId) return;
    setKindVisible(this.#editor, kind, visible);
  }

  /** Register the card-verb sink (#13/#15) — see {@link CanvasIsland}'s verb bar. */
  onCardVerb(cb: (text: string, intent: PromptIntent, sourceRef?: string) => void): void {
    this.#cardVerbHandler = cb;
  }

  /** Tear down a deleted workspace's canvas state and its persisted store. */
  removeWorkspace(workspaceId: string): void {
    this.#pending.delete(workspaceId);
    // tldraw's local sync names the IndexedDB database
    // `TLDRAW_DOCUMENT_v2<persistenceKey>` (LocalIndexedDb, pinned to tldraw 5.x);
    // deleting it discards the board for good. Best-effort: never block deletion.
    try {
      indexedDB.deleteDatabase(`TLDRAW_DOCUMENT_v2ai-storm:ws:${workspaceId}`);
    } catch {
      /* ignore */
    }
  }

  /** Full teardown (app shutdown / memory safety PRD §5.2). */
  dispose(): void {
    this.#root?.unmount();
    this.#root = null;
    this.#editor = null;
    this.#activeId = null;
    this.#pending.clear();
  }
}
