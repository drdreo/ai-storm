import { Injectable, signal } from '@angular/core';
import { DocCollection, Schema, Text, type Doc } from '@blocksuite/store';
import { AffineSchemas, NoteBackgroundColor } from '@blocksuite/blocks';
import { AffineEditorContainer } from '@blocksuite/presets';
import { effects as blocksEffects } from '@blocksuite/blocks/effects';
import { effects as presetsEffects } from '@blocksuite/presets/effects';
import { IndexeddbPersistence } from 'y-indexeddb';
import type { Idea } from '@ai-storm/shared';
import type { BlockDescriptor } from './markdown-block-parser';
import {
  decorateProvenance,
  ideaToDescriptors,
  kindBackground,
  normalizeKind,
  type NoteOrigin,
} from './idea-descriptors';
import { shouldSeedDoc } from './canvas-seed';
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
 * Top-level `Y.Map<NoteOrigin>` key on a workspace's subdoc (`doc.spaceDoc`)
 * recording which notes the AI created (#31, PD-009). Namespaced so it can't
 * collide with the maps BlockSuite manages on the same space doc; it persists
 * with the block content via the subdoc's IndexedDB store, so provenance
 * survives reload. Absence of an id ⇒ user-origin (we never tag user edits).
 */
const PROVENANCE_MAP_KEY = 'ai-storm:provenance';

/**
 * Subtle background tint applied to AI-created notes (#31, PD-009) so they read
 * as distinct from user notes (which keep the default white). A valid value
 * from BlockSuite's note palette — an invalid `background` is silently dropped.
 */
const AI_NOTE_BACKGROUND = NoteBackgroundColor.Blue;

/**
 * Top-level `Y.Map<string>` key on a workspace's subdoc (`doc.spaceDoc`)
 * recording each AI-created note's normalized `kind` (#21). Mirrors the
 * provenance map exactly — namespaced so it can't collide with BlockSuite's own
 * maps, and persisted with the block content via the subdoc's IndexedDB store so
 * kinds survive reload. Absence of an id ⇒ the note has no recorded kind.
 */
const KIND_MAP_KEY = 'ai-storm:kind';

/**
 * Note `displayMode` values driving kind visibility filtering (#21). `'both'`
 * shows the note in both the page (doc) and edgeless (Canvas) views; `'doc'`
 * hides it from the edgeless surface only — values confirmed against
 * `@blocksuite/affine-model` `NoteDisplayMode` (both|doc|edgeless).
 */
const DISPLAY_MODE_VISIBLE = 'both';
const DISPLAY_MODE_EDGELESS_HIDDEN = 'doc';

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

  /**
   * Monotonic counter bumped whenever {@link applyIdeas} mutates a workspace's
   * canvas (#21). Read-only to consumers; the canvas toolbar reads it so its
   * kind-filter chips recompute reactively as new AI cards land (the underlying
   * Y.Maps are not Angular signals, so this is the reactive trigger).
   */
  readonly #ideasTick = signal(0);
  readonly ideasTick = this.#ideasTick.asReadonly();

  #schema = new Schema();
  #collection!: DocCollection;
  #persistence!: IndexeddbPersistence;
  /** Per-workspace subdoc persistence — the layer that actually saves blocks. */
  #subdocPersistence = new Map<string, IndexeddbPersistence>();
  #editor: AffineEditorContainer | null = null;
  #mountedHost: HTMLElement | null = null;
  /** Id of the doc the editor should currently show — guards hot-switch races. */
  #targetDocId: string | null = null;
  /** Cached note-block id per workspace doc, the append target for §3.3. */
  #noteIds = new Map<string, string>();
  /** Count of idea cards created per workspace, for non-overlapping tiling. */
  #noteCounts = new Map<string, number>();
  /** Disposers for the reverse title observers (editor edits → sidebar name). */
  #titleObservers = new Map<string, () => void>();
  /** Fired when a doc's page-title is edited from inside the editor. */
  #onTitleChange: ((workspaceId: string, title: string) => void) | null = null;

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

  /**
   * Ensure a workspace's doc exists AND has finished rehydrating, awaiting its
   * subdoc store sync and seeding it if (and only if) the store came back empty.
   * Boot awaits this for the workspace it shows first, so the editor binds to an
   * already-rooted doc — avoiding the connect-time race of appending the editor
   * against a still-loading doc in a stray microtask.
   */
  async ensureReady(workspaceId: string): Promise<void> {
    const doc = this.ensureDoc(workspaceId);
    const persistence = this.#subdocPersistence.get(workspaceId);
    if (persistence && !persistence.synced) await persistence.whenSynced;
    this.#seedIfEmpty(workspaceId, doc, persistence);
  }

  hasDoc(workspaceId: string): boolean {
    return this.#collection.getDoc(workspaceId) !== null;
  }

  /**
   * Return the workspace's Doc and bind its per-subdoc persistence. The doc is
   * NEVER seeded synchronously: its block tree may be empty right now simply
   * because its IndexedDB store has not applied its updates yet, and seeding
   * then would clobber content about to rehydrate (the reload data-loss bug).
   * Seeding is always deferred until the subdoc store has synced and is gated on
   * the *actual* content at that point (see {@link shouldSeedDoc}) — so it is
   * safe even if the doc was created fresh vs. restored.
   */
  ensureDoc(workspaceId: string): Doc {
    let doc = this.#collection.getDoc(workspaceId);
    if (!doc) {
      try {
        doc = this.#collection.createDoc({ id: workspaceId });
      } catch {
        // Rare rehydrate race: the docMeta loaded but its BlockCollection was
        // not instantiated when we first looked. createDoc rejects the
        // duplicate; re-fetch the now-resolvable doc instead of seeding anew.
        doc = this.#collection.getDoc(workspaceId);
        if (!doc) throw new Error(`canvas: unable to resolve doc ${workspaceId}`);
      }
    }
    if (!doc.ready) doc.load();
    this.#ensureSubdocPersisted(workspaceId, doc);
    this.#cacheNoteId(workspaceId, doc);
    return doc;
  }

  /**
   * Bind a dedicated IndexedDB store to this workspace's Yjs subdoc — the only
   * layer that actually persists block content (the root provider does not save
   * subdocs). Once the store has fully synced we seed the doc only if it came
   * back genuinely empty; a doc that rehydrated with content is left untouched.
   */
  #ensureSubdocPersisted(workspaceId: string, doc: Doc): void {
    if (this.#subdocPersistence.has(workspaceId)) return;
    const subdoc = doc.spaceDoc;
    const persistence = new IndexeddbPersistence(subdoc.guid, subdoc);
    this.#subdocPersistence.set(workspaceId, persistence);
    void persistence.whenSynced.then(() => this.#seedIfEmpty(workspaceId, doc, persistence));
  }

  /** Seed page/surface/note/paragraph iff the subdoc synced empty (§3.5). */
  #seedIfEmpty(workspaceId: string, doc: Doc, persistence: IndexeddbPersistence | undefined): void {
    if (shouldSeedDoc({ hasRoot: !!doc.root, synced: persistence?.synced ?? false })) {
      this.#seedBlocks(workspaceId, doc);
    } else {
      this.#cacheNoteId(workspaceId, doc);
    }
    // Root now exists (seeded or rehydrated) — watch its title so edits made in
    // the page editor flow back to the workspace name (reverse sync).
    this.#observeTitle(workspaceId, doc);
  }

  /** Seed a fresh page/surface/note/paragraph into a verified-empty doc. */
  #seedBlocks(workspaceId: string, doc: Doc): void {
    if (doc.root) return; // already has content — never double-seed
    const pageId = doc.addBlock('affine:page', {});
    doc.addBlock('affine:surface', {}, pageId);
    const noteId = doc.addBlock('affine:note', {}, pageId);
    doc.addBlock('affine:paragraph', {}, noteId);
    this.#noteIds.set(workspaceId, noteId);
  }

  /** Cache the append-target note id (§3.3) once the doc has one. */
  #cacheNoteId(workspaceId: string, doc: Doc): void {
    if (this.#noteIds.has(workspaceId)) return;
    const note = doc.getBlocksByFlavour('affine:note')[0];
    if (note) this.#noteIds.set(workspaceId, note.id);
  }

  /** Mount the shared editor into a host element and bind it to a workspace. */
  mount(host: HTMLElement, workspaceId: string, mode: CanvasMode): void {
    const doc = this.ensureDoc(workspaceId);
    if (!this.#editor) {
      this.#editor = new AffineEditorContainer();
    }
    this.#bindWhenRooted(doc, mode, host);
  }

  /**
   * Hot-switch the bound workspace without remounting the editor element.
   * This is the sub-100ms transition of PRD §3.4 — a single DOM-resident
   * editor simply changes which CRDT doc it renders.
   */
  switchTo(workspaceId: string, mode: CanvasMode): void {
    if (!this.#editor) return;
    const doc = this.ensureDoc(workspaceId);
    this.#bindWhenRooted(doc, mode, this.#mountedHost ?? undefined);
  }

  /**
   * Bind the editor to a doc and attach it to its host, but never while the doc
   * is still root-less: the BlockSuite editor reads `doc.root`/`doc.slots` on
   * render and throws on a doc without a root. A brand-new doc is seeded
   * synchronously (root already present → binds immediately); a rehydrating doc
   * gains its root only once its subdoc store has synced, so we defer the bind
   * (and the DOM attach) until then. `#targetDocId` guards against a rapid
   * hot-switch: only the latest requested doc is ever bound.
   */
  #bindWhenRooted(doc: Doc, mode: CanvasMode, host: HTMLElement | undefined): void {
    this.#targetDocId = doc.id;
    const apply = () => {
      if (!this.#editor || this.#targetDocId !== doc.id || !doc.root) return;
      this.#editor.doc = doc;
      this.#editor.mode = mode;
      if (host && this.#mountedHost !== host) {
        this.#detachEditorDom();
        host.appendChild(this.#editor);
        this.#mountedHost = host;
      }
    };
    if (doc.root) {
      apply();
      return;
    }
    const persistence = this.#subdocPersistence.get(doc.id);
    if (persistence) void persistence.whenSynced.then(apply);
    else queueMicrotask(apply);
  }

  setMode(mode: CanvasMode): void {
    if (this.#editor) this.#editor.switchEditor(mode);
  }

  /**
   * Mirror the workspace title onto its BlockSuite doc (the `affine:page`
   * block's title + doc meta) so the editor's title field and the sidebar name
   * stay in sync on create/rename. The title `Text` is mutated in place — never
   * replaced — so the live editor binding and BlockSuite's own meta-sync
   * observer survive. Deferred until the doc has a root when its store is still
   * rehydrating (a freshly-created doc is seeded async; see {@link ensureDoc}).
   */
  setDocTitle(workspaceId: string, title: string): void {
    const doc = this.ensureDoc(workspaceId);
    const apply = () => {
      const root = doc.root as unknown as { title?: Text } | null;
      if (!root?.title) return;
      if (root.title.toString() !== title) {
        root.title.replace(0, root.title.length, title);
      }
      this.#collection.setDocMeta(workspaceId, { title });
    };
    if (doc.root) {
      apply();
      return;
    }
    const persistence = this.#subdocPersistence.get(workspaceId);
    if (persistence) void persistence.whenSynced.then(apply);
    else queueMicrotask(apply);
  }

  /** Register the reverse-sync sink: editor title edits → workspace rename. */
  onDocTitleChanged(cb: (workspaceId: string, title: string) => void): void {
    this.#onTitleChange = cb;
  }

  /**
   * Observe a doc's page-title `Text` so edits typed into the editor's title
   * field propagate back to the workspace name. Idempotent per workspace; a
   * no-op until the doc has a root. Mutations made by {@link setDocTitle} fire
   * this too, but the sink guards against writing an unchanged title, so the
   * sidebar↔editor loop terminates.
   */
  #observeTitle(workspaceId: string, doc: Doc): void {
    if (this.#titleObservers.has(workspaceId)) return;
    const root = doc.root as unknown as { title?: Text } | null;
    if (!root?.title) return;
    const yText = root.title.yText;
    const handler = () => this.#onTitleChange?.(workspaceId, root.title!.toString());
    yText.observe(handler);
    this.#titleObservers.set(workspaceId, () => yText.unobserve(handler));
  }

  /**
   * Extracted-idea target (extraction-contract §8.2, recommended path): create
   * ONE edgeless `affine:note` per idea — a card — seeded with the idea's
   * heading + body, rather than appending paragraphs to the shared note. Notes
   * are tiled left-to-right so freshly-created cards don't overlap. Runs in a
   * single transaction so the CRDT store records one batched mutation (§5.1).
   *
   * This is the ONLY programmatic note creator, so every card it makes is tagged
   * `origin: 'ai'` (#31, PD-009): given a subtle background tint, its heading
   * prefixed with the provenance badge, and its id recorded in the persisted
   * provenance map — all in the same transaction as the block writes. Notes the
   * user draws in the editor are never touched and default to user-origin.
   */
  applyIdeas(workspaceId: string, ideas: Idea[]): void {
    if (ideas.length === 0) return;
    const doc = this.ensureDoc(workspaceId);
    const pageId = doc.root?.id;
    if (!pageId) return;

    const provenance = this.#provenanceMap(doc);
    const kindMap = this.#kindMap(doc);
    doc.transact(() => {
      for (const idea of ideas) {
        const index = this.#noteCounts.get(workspaceId) ?? 0;
        this.#noteCounts.set(workspaceId, index + 1);
        // Tile cards in a simple grid on the edgeless surface.
        const col = index % 4;
        const row = Math.floor(index / 4);
        const xywh: `[${number},${number},${number},${number}]` = `[${col * 360},${row * 280},320,240]`;
        // Kind tint wins over the generic AI blue (#21); a kindless or
        // unknown-kind AI card keeps the provenance blue (#31).
        const kind = normalizeKind(idea.kind);
        const background = kindBackground(kind) ?? AI_NOTE_BACKGROUND;
        const noteId = doc.addBlock('affine:note', { xywh, background }, pageId);
        provenance.set(noteId, 'ai');
        if (kind) kindMap.set(noteId, kind);
        for (const d of ideaToDescriptors(idea)) {
          // Skip empty paragraphs so cards stay clean (blank-body ideas, blank
          // lines between markdown blocks).
          if (d.type === 'paragraph' && d.text.trim() === '') continue;
          // Prefix only the card's heading (first descriptor) with the AI badge.
          const decorated =
            d.type === 'heading' ? { ...d, text: decorateProvenance(d.text, 'ai') } : d;
          this.#appendDescriptor(doc, noteId, decorated);
        }
      }
    });
    // Signal that the kind set may have changed so filter chips recompute (#21).
    this.#ideasTick.update((n) => n + 1);
  }

  /**
   * Provenance origin of a canvas note (#31, PD-009). Returns `'ai'` iff the
   * note's id is recorded in the workspace's persisted provenance map (only
   * {@link applyIdeas} writes it); every other note — including any the user
   * drew in the editor — defaults to `'user'`. Safe before the doc exists.
   */
  noteOrigin(workspaceId: string, noteId: string): NoteOrigin {
    const doc = this.#collection.getDoc(workspaceId);
    if (!doc) return 'user';
    return this.#provenanceMap(doc).get(noteId) === 'ai' ? 'ai' : 'user';
  }

  /** The workspace subdoc's top-level provenance map (#31, PD-009). */
  #provenanceMap(doc: Doc) {
    return doc.spaceDoc.getMap<NoteOrigin>(PROVENANCE_MAP_KEY);
  }

  /** The workspace subdoc's top-level note-kind map (#21). */
  #kindMap(doc: Doc) {
    return doc.spaceDoc.getMap<string>(KIND_MAP_KEY);
  }

  /**
   * The recorded `kind` of a canvas note (#21), or `undefined` if the note has
   * none (user-drawn notes and kindless AI cards). Only {@link applyIdeas} writes
   * the kind map. Safe before the doc exists.
   */
  noteKind(workspaceId: string, noteId: string): string | undefined {
    const doc = this.#collection.getDoc(workspaceId);
    if (!doc) return undefined;
    return this.#kindMap(doc).get(noteId);
  }

  /**
   * The distinct kinds with at least one note on the workspace canvas (#21),
   * derived from the persisted kind map. Drives the toolbar's filter chips;
   * recompute it against {@link ideasTick} for reactivity. Empty before the doc
   * exists or when no kinded AI cards have been created.
   */
  kindsPresent(workspaceId: string): string[] {
    const doc = this.#collection.getDoc(workspaceId);
    if (!doc) return [];
    return [...new Set(this.#kindMap(doc).values())];
  }

  /**
   * Show or hide every note of a given `kind` on the edgeless (Canvas) surface
   * (#21) by toggling each matching note's `displayMode` between `'both'`
   * (visible) and `'doc'` (hidden from edgeless, still in the page view). The
   * kind is normalized to match how {@link applyIdeas} records it. No-op before
   * the doc exists. Runs in one transaction so the change is a single CRDT
   * mutation (§5.1).
   */
  setKindVisible(workspaceId: string, kind: string, visible: boolean): void {
    const doc = this.#collection.getDoc(workspaceId);
    if (!doc) return;
    const target = normalizeKind(kind);
    if (!target) return;
    const kindMap = this.#kindMap(doc);
    const displayMode = visible ? DISPLAY_MODE_VISIBLE : DISPLAY_MODE_EDGELESS_HIDDEN;
    doc.transact(() => {
      for (const note of doc.getBlocksByFlavour('affine:note')) {
        if (kindMap.get(note.id) === target) {
          doc.updateBlock(note.model, { displayMode });
        }
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
    this.#titleObservers.get(workspaceId)?.();
    this.#titleObservers.delete(workspaceId);
    const persistence = this.#subdocPersistence.get(workspaceId);
    this.#subdocPersistence.delete(workspaceId);

    // Dispose the doc (and clear its IndexedDB store, so no orphaned blocks
    // linger) only AFTER the editor's pending render settles. Callers switch
    // the editor onto another doc before deleting the active one; that re-render
    // is async (Lit), and the outgoing view reads its doc's meta as it tears
    // down — so the doc must survive until the switch completes, or BlockSuite
    // throws reading a removed doc's title.
    const dispose = () => {
      void persistence?.clearData();
      if (this.#collection.getDoc(workspaceId)) this.#collection.removeDoc(workspaceId);
    };
    const settled = this.#editor?.updateComplete;
    if (settled) void settled.then(dispose);
    else dispose();
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
    for (const dispose of this.#titleObservers.values()) dispose();
    this.#titleObservers.clear();
    for (const persistence of this.#subdocPersistence.values()) persistence.destroy();
    this.#subdocPersistence.clear();
    this.#persistence?.destroy();
    this.#collection?.forceStop();
  }
}
