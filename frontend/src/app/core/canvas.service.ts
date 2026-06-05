import { Injectable, signal } from '@angular/core';
import { DocCollection, Schema, Text, type Doc } from '@blocksuite/store';
import { AffineSchemas } from '@blocksuite/blocks';
import { AffineEditorContainer } from '@blocksuite/presets';
import { effects as blocksEffects } from '@blocksuite/blocks/effects';
import { effects as presetsEffects } from '@blocksuite/presets/effects';
import { IndexeddbPersistence } from 'y-indexeddb';
import type { Idea } from '@ai-storm/shared';
import type { BlockDescriptor } from './markdown-block-parser';
import { ideaToDescriptors } from './idea-descriptors';
import type { CanvasMode } from './models';

export { ideaToDescriptors } from './idea-descriptors';

let effectsRegistered = false;
/** Register BlockSuite's Lit custom elements exactly once (framework-agnostic). */
function registerEffects(): void {
  if (effectsRegistered) return;
  blocksEffects();
  presetsEffects();
  effectsRegistered = true;
}

const IDB_ROOM = 'ai-storm-canvas';

/**
 * BlockSuite canvas integration (PRD §3.1, §3.3, §3.5, §4.1).
 *
 * Treats BlockSuite strictly as browser-native web components: a single
 * `AffineEditorContainer` instance is reused across every workspace and simply
 * rebound to a different `Doc` on switch — giving sub-100ms hot-switching
 * (PRD §3.4) with one heavy object in memory (PRD §5.2). All workspace docs
 * live in one CRDT `DocCollection` whose root Y.Doc is persisted to IndexedDB
 * (PRD §3.5). Each workspace is a distinct, isolated `Doc` within it.
 */
@Injectable({ providedIn: 'root' })
export class CanvasService {
  /** True once IndexedDB has rehydrated the CRDT store (PRD §3.5 boot). */
  readonly ready = signal(false);

  #schema = new Schema();
  #collection!: DocCollection;
  #persistence!: IndexeddbPersistence;
  #editor: AffineEditorContainer | null = null;
  #mountedHost: HTMLElement | null = null;
  /** Cached note-block id per workspace doc, the append target for §3.3. */
  #noteIds = new Map<string, string>();
  /** Count of idea cards created per workspace, for non-overlapping tiling. */
  #noteCounts = new Map<string, number>();

  async init(): Promise<void> {
    if (this.ready()) return;
    registerEffects();
    this.#schema.register(AffineSchemas);
    this.#collection = new DocCollection({ schema: this.#schema, id: IDB_ROOM });
    this.#collection.meta.initialize();
    this.#collection.start();

    // Bind CRDT binary persistence to the collection's root Y.Doc (PRD §3.5).
    this.#persistence = new IndexeddbPersistence(
      IDB_ROOM,
      this.#collection.doc as unknown as ConstructorParameters<typeof IndexeddbPersistence>[1],
    );
    await new Promise<void>((resolve) => {
      this.#persistence.once('synced', () => resolve());
    });
    this.ready.set(true);
  }

  /** Ids of all docs already present in storage (for crash recovery §3.5). */
  knownDocIds(): string[] {
    return [...this.#collection.docs.keys()];
  }

  hasDoc(workspaceId: string): boolean {
    return this.#collection.getDoc(workspaceId) !== null;
  }

  /**
   * Return the workspace's Doc, creating and seeding it (page/surface/note/
   * paragraph) on first use. Idempotent and safe after a storage rehydrate.
   */
  ensureDoc(workspaceId: string): Doc {
    const doc = this.#collection.getDoc(workspaceId) ??
      this.#collection.createDoc({ id: workspaceId });

    // load() runs the init callback exactly once (the first time the doc is
    // loaded). We seed page/surface/note/paragraph only when the doc is empty —
    // a doc rehydrated from IndexedDB already has its root, so we leave it be.
    if (!doc.ready) {
      doc.load(() => {
        if (!doc.root) {
          const pageId = doc.addBlock('affine:page', {});
          doc.addBlock('affine:surface', {}, pageId);
          const noteId = doc.addBlock('affine:note', {}, pageId);
          doc.addBlock('affine:paragraph', {}, noteId);
          this.#noteIds.set(workspaceId, noteId);
        }
      });
    }
    if (!this.#noteIds.has(workspaceId)) {
      const note = doc.getBlocksByFlavour('affine:note')[0];
      if (note) this.#noteIds.set(workspaceId, note.id);
    }
    return doc;
  }

  /** Mount the shared editor into a host element and bind it to a workspace. */
  mount(host: HTMLElement, workspaceId: string, mode: CanvasMode): void {
    const doc = this.ensureDoc(workspaceId);
    if (!this.#editor) {
      this.#editor = new AffineEditorContainer();
    }
    this.#editor.doc = doc;
    this.#editor.mode = mode;
    if (this.#mountedHost !== host) {
      this.#detachEditorDom();
      host.appendChild(this.#editor);
      this.#mountedHost = host;
    }
  }

  /**
   * Hot-switch the bound workspace without remounting the editor element.
   * This is the sub-100ms transition of PRD §3.4 — a single DOM-resident
   * editor simply changes which CRDT doc it renders.
   */
  switchTo(workspaceId: string, mode: CanvasMode): void {
    if (!this.#editor) return;
    const doc = this.ensureDoc(workspaceId);
    this.#editor.doc = doc;
    this.#editor.mode = mode;
  }

  setMode(mode: CanvasMode): void {
    if (this.#editor) this.#editor.switchEditor(mode);
  }

  /**
   * Structural Block Translation target (PRD §3.3): append translated block
   * descriptors to the workspace's note. Runs inside a single transaction so
   * the CRDT store records one batched mutation per render frame (PRD §5.1).
   */
  applyBlocks(workspaceId: string, descriptors: BlockDescriptor[]): void {
    if (descriptors.length === 0) return;
    const doc = this.ensureDoc(workspaceId);
    const noteId = this.#noteIds.get(workspaceId);
    if (!noteId) return;

    doc.transact(() => {
      for (const d of descriptors) {
        this.#appendDescriptor(doc, noteId, d);
      }
    });
  }

  /**
   * Extracted-idea target (extraction-contract §8.2, recommended path): create
   * ONE edgeless `affine:note` per idea — a card — seeded with the idea's
   * heading + body, rather than appending paragraphs to the shared note. Notes
   * are tiled left-to-right so freshly-created cards don't overlap. Runs in a
   * single transaction so the CRDT store records one batched mutation (§5.1).
   */
  applyIdeas(workspaceId: string, ideas: Idea[]): void {
    if (ideas.length === 0) return;
    const doc = this.ensureDoc(workspaceId);
    const pageId = doc.root?.id;
    if (!pageId) return;

    doc.transact(() => {
      for (const idea of ideas) {
        const index = this.#noteCounts.get(workspaceId) ?? 0;
        this.#noteCounts.set(workspaceId, index + 1);
        // Tile cards in a simple grid on the edgeless surface.
        const col = index % 4;
        const row = Math.floor(index / 4);
        const xywh: `[${number},${number},${number},${number}]` = `[${col * 360},${row * 280},320,240]`;
        const noteId = doc.addBlock('affine:note', { xywh }, pageId);
        for (const d of ideaToDescriptors(idea)) this.#appendDescriptor(doc, noteId, d);
      }
    });
  }

  #appendDescriptor(doc: Doc, noteId: string, d: BlockDescriptor): void {
    switch (d.type) {
      case 'heading':
        doc.addBlock(
          'affine:paragraph',
          { type: `h${d.level ?? 1}` as 'h1', text: new Text(d.text) },
          noteId,
        );
        break;
      case 'quote':
        doc.addBlock('affine:paragraph', { type: 'quote', text: new Text(d.text) }, noteId);
        break;
      case 'bulleted':
        doc.addBlock('affine:list', { type: 'bulleted', text: new Text(d.text) }, noteId);
        break;
      case 'numbered':
        doc.addBlock('affine:list', { type: 'numbered', text: new Text(d.text) }, noteId);
        break;
      case 'todo':
        doc.addBlock(
          'affine:list',
          { type: 'todo', checked: !!d.checked, text: new Text(d.text) },
          noteId,
        );
        break;
      case 'code':
        doc.addBlock(
          'affine:code',
          { language: d.language ?? null, text: new Text(d.text) },
          noteId,
        );
        break;
      case 'divider':
        doc.addBlock('affine:divider', {}, noteId);
        break;
      case 'paragraph':
      default:
        doc.addBlock('affine:paragraph', { type: 'text', text: new Text(d.text) }, noteId);
        break;
    }
  }

  /**
   * Contextual Document Ingestion (PRD §3.2): serialize the workspace canvas
   * into a normalized raw-text/markdown document for injection into the agent
   * loop. Walks the block tree directly — no framework lifecycle dependency.
   */
  serializeToText(workspaceId: string): string {
    const doc = this.#collection.getDoc(workspaceId);
    if (!doc?.root) return '';
    const lines: string[] = [];
    const walk = (modelId: string) => {
      const model = doc.getBlockById(modelId);
      if (!model) return;
      const line = this.#modelToLine(model);
      if (line !== null) lines.push(line);
      for (const child of model.children) walk(child.id);
    };
    walk(doc.root.id);
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  #modelToLine(model: any): string | null {
    const flavour: string = model.flavour;
    const text: string = model.text?.toString?.() ?? '';
    switch (flavour) {
      case 'affine:paragraph': {
        const t = model.type as string;
        if (t && t.startsWith('h')) return `${'#'.repeat(Number(t[1]))} ${text}`;
        if (t === 'quote') return `> ${text}`;
        return text;
      }
      case 'affine:list': {
        if (model.type === 'numbered') return `1. ${text}`;
        if (model.type === 'todo') return `- [${model.checked ? 'x' : ' '}] ${text}`;
        return `- ${text}`;
      }
      case 'affine:code':
        return `\`\`\`${model.language ?? ''}\n${text}\n\`\`\``;
      case 'affine:divider':
        return '---';
      default:
        return null;
    }
  }

  /** Plain text of the current editor selection (PRD §3.6 agent hand-off). */
  getSelectedText(): string {
    const host = this.#editor?.host;
    if (!host) return '';
    const selected = host.selection.value
      .map((sel) => (sel as { blockId?: string }).blockId)
      .filter((id): id is string => !!id);
    if (selected.length === 0) {
      // Fall back to the whole active document if nothing is selected.
      return this.#editor ? this.serializeToText(this.#editor.doc.id) : '';
    }
    const doc = this.#editor!.doc;
    const lines: string[] = [];
    for (const id of selected) {
      const model = doc.getBlockById(id);
      const line = model ? this.#modelToLine(model) : null;
      if (line !== null) lines.push(line);
    }
    return lines.join('\n').trim();
  }

  /** Tear down per-workspace canvas state when a workspace is deleted. */
  removeWorkspace(workspaceId: string): void {
    this.#noteIds.delete(workspaceId);
    this.#noteCounts.delete(workspaceId);
    if (this.#collection.getDoc(workspaceId)) {
      this.#collection.removeDoc(workspaceId);
    }
  }

  #detachEditorDom(): void {
    if (this.#editor && this.#editor.parentElement) {
      this.#editor.parentElement.removeChild(this.#editor);
    }
    this.#mountedHost = null;
  }

  /** Full teardown (app shutdown / memory safety PRD §5.2). */
  dispose(): void {
    this.#detachEditorDom();
    this.#editor = null;
    this.#persistence?.destroy();
    this.#collection?.forceStop();
  }
}
