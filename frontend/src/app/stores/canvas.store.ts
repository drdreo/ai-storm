import type { AgentArtifact, Completion, Idea, Reference, Score } from "@ai-storm/shared";
import type { Editor, TLShapeId } from "tldraw";
import { create } from "zustand";
import { backend } from "./backend.store";
import {
  applyIdeas as islandApplyIdeas,
  applyScore as islandApplyScore,
  applyCompletion as islandApplyCompletion,
  applyIssueLinks as islandApplyIssueLinks,
  applyReference as islandApplyReference,
  type CanvasBridge,
  collectBoard,
  exportBoard as islandExportBoard,
  exportTldrawPages as islandExportTldrawPages,
  importBoard as islandImportBoard,
  importTldrawPages as islandImportTldrawPages,
  selectedText,
  serializeBoardIdeasSnapshot,
  serializeEditor,
  serializeForHandoff,
  serializeForTriage
} from "../core/canvas-island";
import { boardFacets, type BoardFacets, type BoardFilter, EMPTY_FILTER } from "../core/canvas/filter";
import { allIdeaCards, type IdeaCardMeta, ideaCards } from "../core/canvas/idea-card";
import { createUserIdea } from "../core/canvas/idea-tool";
import {
  arrangeMindMap as layoutArrangeMindMap,
  arrangePriorityGrid as layoutArrangePriorityGrid
} from "../core/canvas/layout";
import type { SearchableIdea } from "../core/canvas/search";
import { readPersistedIdeas, toSearchableIdea } from "../core/canvas/search-index";
import type { PromptIntent, ReferencedIdea } from "../core/prompt-framing";
import { type BoardStats, computeBoardStats } from "../core/board-stats.ts";
import { type ConvergentSummary, summarizeBoard } from "../core/summarize.ts";
import type { PortableBoard, TldrawPage } from "../core/project-portable";

/**
 * tldraw canvas controller (PRD §3.1, §3.3, §3.6) — the imperative seam over the
 * React {@link CanvasIsland} that holds the tldraw `Editor`.
 *
 * This replaces the old Angular `CanvasService` facade. With React there is no
 * `createRoot`/`render` plumbing here: `CanvasPane` renders `<CanvasIsland>`
 * directly (keyed by project id), and this module just holds the live editor
 * handle so the framework-agnostic ingestion/agent stores — which run *outside*
 * the component tree — can drive the canvas. The reactive surface (`ready`,
 * `ideasTick`) is a tiny Zustand store the canvas toolbar subscribes to; the
 * tldraw store itself is not reactive, so `ideasTick` is the recompute trigger
 * for the kind-filter chips (#21).
 *
 * Background ingestion: a project whose session is streaming but which is NOT
 * the mounted one has no live editor, so its ideas are queued and drained when
 * it next mounts (single-user v0; full background persistence is the
 * backend-snapshot ticket).
 */

interface CanvasState {
  /** True once the canvas is initialized (parity with the old CRDT-boot flag). */
  ready: boolean;
  /**
   * Monotonic counter bumped whenever the mounted canvas gains cards (a fresh
   * `applyIdeas`, or a project mounting with persisted cards). The toolbar's
   * kind-filter chips recompute against it (#21).
   */
  ideasTick: number;
}

export const useCanvasStore = create<CanvasState>(() => ({
  ready: false,
  ideasTick: 0
}));

// ---- Imperative singleton state (lives outside React) ----------------------

let editor: Editor | null = null;
/** Project id the mounted editor currently shows (guards background applies). */
let activeId: string | null = null;
/** Ideas streamed to a non-mounted project, drained on its next mount. */
const pending = new Map<string, Idea[]>();
/** Resolvers waiting on a given project's editor to mount (export/import #105). */
const mountWaiters = new Map<string, Array<() => void>>();
/** Fired when a card verb (#13 Discuss / #15 expand/challenge/find-risks) is picked. */
let cardVerbHandler: ((text: string, intent: PromptIntent, sourceRefs: readonly string[]) => void) | null = null;
/** Fired when "Reference in terminal" (#194) is picked on selected cards. */
let referenceHandler: ((cards: readonly ReferencedIdea[]) => void) | null = null;
/** Fired when "Create GitHub issue" (#125) is picked on selected cards. */
let createIssueHandler: (() => void) | null = null;
let filterController: {
  get(): BoardFilter;
  set(filter: BoardFilter): void;
} | null = null;
let snapshotTimer: number | null = null;

function bumpIdeasTick(): void {
  useCanvasStore.setState((s) => ({ ideasTick: s.ideasTick + 1 }));
}

function publishBoardSnapshot(): void {
  if (!editor || !activeId) return;
  backend.send({
    type: "board-snapshot",
    projectId: activeId,
    snapshot: serializeBoardIdeasSnapshot(
      editor,
      filterController?.get() as unknown as Record<string, unknown> | undefined
    )
  });
}

function scheduleBoardSnapshot(): void {
  if (snapshotTimer !== null) clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(() => {
    snapshotTimer = null;
    publishBoardSnapshot();
  }, 100) as unknown as number;
}

function publishBoardSnapshotFor(projectId: string): boolean {
  if (!editor || projectId !== activeId) return false;
  publishBoardSnapshot();
  return true;
}

function onEditorMount(ed: Editor): void {
  editor = ed;
  // Drain any ideas that streamed in while this project was unmounted.
  const queued = activeId ? pending.get(activeId) : undefined;
  if (queued?.length) {
    pending.delete(activeId!);
    islandApplyIdeas(ed, queued);
  }
  // Recompute the kind-filter chips against the now-loaded store (covers a
  // reload restoring persisted cards, not just freshly-drained ones).
  bumpIdeasTick();

  // Wake anyone waiting on this project's editor (export/import #105).
  const waiters = activeId ? mountWaiters.get(activeId) : undefined;
  if (waiters?.length) {
    mountWaiters.delete(activeId!);
    waiters.forEach((resolve) => resolve());
  }
  scheduleBoardSnapshot();
}

export const canvas = {
  /**
   * A single stable bridge identity handed to React for the app's lifetime.
   * `CanvasPane` passes this into `<CanvasIsland>`; `onEditorMount` wires the
   * live editor back into this controller.
   */
  bridge: {
    onEditorMount: (ed: Editor) => onEditorMount(ed),
    onBoardChanged: () => scheduleBoardSnapshot(),
    onCardVerb: (text, intent, sourceRefs) => cardVerbHandler?.(text, intent, sourceRefs),
    onReferenceIdeas: (cards) => referenceHandler?.(cards),
    onCreateIssue: () => createIssueHandler?.(),
    onFilterMount: (controller) => {
      filterController = {
        get: controller.get,
        set: (filter) => {
          controller.set(filter);
          scheduleBoardSnapshot();
        }
      };
      scheduleBoardSnapshot();
      return () => {
        if (filterController?.get === controller.get) filterController = null;
      };
    }
  } as CanvasBridge,

  /** No CRDT collection to stand up — just flip ready (parity with old boot). */
  async init(): Promise<void> {
    useCanvasStore.setState({ ready: true });
  },

  /** tldraw owns store loading; nothing to pre-rehydrate (parity shim). */
  async ensureReady(_projectId: string): Promise<void> {
    /* tldraw owns store loading; nothing to pre-rehydrate. */
  },

  /**
   * Hot-switch the bound project (PRD §3.4). `CanvasPane` remounts
   * `<CanvasIsland>` by changing its `key`/`persistenceKey`; this drops the old
   * editor handle so background applies queue until the new editor mounts. A
   * switch to the already-active project is a no-op (keeps the live editor).
   */
  switchTo(projectId: string): void {
    if (projectId === activeId) return;
    activeId = projectId;
    editor = null;
  },

  /**
   * Render a batch of extracted ideas as cards + typed edges. Applied straight
   * to the live editor when the target project is the mounted one; otherwise
   * queued and drained when that project next mounts.
   */
  applyIdeas(projectId: string, ideas: Idea[]): void {
    if (ideas.length === 0) return;
    if (editor && projectId === activeId) {
      islandApplyIdeas(editor, ideas);
      bumpIdeasTick();
      scheduleBoardSnapshot();
    } else {
      const q = pending.get(projectId) ?? [];
      q.push(...ideas);
      pending.set(projectId, q);
    }
  },

  /**
   * Ref-annotated serialization of the board for an AI triage pass (#60), or `''`
   * if this project isn't the mounted one. The agent scores each `@ref` and
   * replies with `«SCORE@ref»` lines that flow back through {@link applyScore}.
   */
  serializeForTriage(projectId: string): string {
    if (!editor || projectId !== activeId) return "";
    return serializeForTriage(editor);
  },

  /**
   * Lifecycle-aware serialization of the selection — or the whole board — for the
   * spec/PRD hand-off (#89, PD-015), or `''` if this project isn't the mounted
   * one. Superseded ghosts are excluded and keep-marks (#59) flagged with ★; the
   * agent turns this into a generated spec artifact via {@link agent.generateSpec}.
   */
  serializeForHandoff(projectId: string, opts: { withRefs?: boolean } = {}): string {
    if (!editor || projectId !== activeId) return "";
    return serializeForHandoff(editor, opts);
  },

  /** Apply an extracted triage score to its target card's meta (#60). */
  applyScore(projectId: string, score: Score): void {
    if (editor && projectId === activeId) {
      islandApplyScore(editor, score);
      scheduleBoardSnapshot();
    }
  },

  /** Apply a done/reopen change to its target card's meta (#167). */
  applyCompletion(projectId: string, completion: Completion): void {
    if (editor && projectId === activeId) {
      islandApplyCompletion(editor, completion);
      scheduleBoardSnapshot();
    }
  },

  /** Stamp created-issue links back onto their source cards' meta (#125). */
  applyIssueLinks(projectId: string, artifacts: readonly AgentArtifact[]): void {
    if (editor && projectId === activeId) {
      islandApplyIssueLinks(editor, artifacts);
      scheduleBoardSnapshot();
    }
  },

  /** Attach an external-link reference to its target card's meta (#227). */
  applyReference(projectId: string, reference: Reference): void {
    if (editor && projectId === activeId) {
      islandApplyReference(editor, reference);
      scheduleBoardSnapshot();
    }
  },

  /**
   * Summarize the active board into a convergent summary (#28, PD-015) — a pure,
   * on-demand *reading* of the canvas (themes → decisions → open questions →
   * highlights). Returns `null` when the target project isn't the mounted one
   * (no live editor to read). No canvas mutation, no agent round-trip.
   */
  summarize(projectId: string): ConvergentSummary | null {
    if (!editor || projectId !== activeId) return null;
    return summarizeBoard(collectBoard(editor));
  },

  /**
   * Read the active board into headline stats + a generation timeline (#129/#99)
   * — a pure, on-demand *reading* of the canvas, like {@link summarize}. Returns
   * `null` when the target project isn't the mounted one (no live editor). No
   * canvas mutation, no agent round-trip.
   */
  boardStats(projectId: string): BoardStats | null {
    if (!editor || projectId !== activeId) return null;
    return computeBoardStats(collectBoard(editor));
  },

  /** Serialize the project canvas to normalized markdown (PRD §3.2). */
  serializeToText(projectId: string): string {
    if (!editor || projectId !== activeId) return "";
    return serializeEditor(editor);
  },

  /** Push the mounted project's current board read model to the backend MCP registry (#196). */
  publishBoardSnapshot(projectId: string): boolean {
    return publishBoardSnapshotFor(projectId);
  },

  /** Plain text of the current selection — or the whole canvas (PRD §3.6). */
  getSelectedText(): string {
    return editor ? selectedText(editor) : "";
  },

  /** Create a user-origin idea card at the visible board center (#31/#96). */
  createIdea(projectId: string): boolean {
    if (!editor || projectId !== activeId) return false;
    createUserIdea(editor, editor.getViewportPageBounds().center);
    bumpIdeasTick();
    scheduleBoardSnapshot();
    return true;
  },

  /** Run the existing organic mind-map arrangement from the command palette (#16/#96). */
  arrangeMindMap(projectId: string): boolean {
    if (!editor || projectId !== activeId || ideaCards(editor).length === 0) return false;
    layoutArrangeMindMap(editor);
    scheduleBoardSnapshot();
    return true;
  },

  /** Run the existing impact/effort grid arrangement from the command palette (#60/#96). */
  arrangePriorityGrid(projectId: string): boolean {
    if (!editor || projectId !== activeId || ideaCards(editor).length === 0) return false;
    layoutArrangePriorityGrid(editor);
    scheduleBoardSnapshot();
    return true;
  },

  /** Live board facts used to explain disabled palette actions (#96). */
  boardCommandState(projectId: string): {
    mounted: boolean;
    cardCount: number;
    facets: BoardFacets;
    filter: BoardFilter;
  } {
    if (!editor || projectId !== activeId) {
      return {
        mounted: false,
        cardCount: 0,
        facets: {
          kinds: [],
          hasAi: false,
          hasUser: false,
          hasMarked: false,
          hasSuperseded: false,
          hasTriaged: false
        },
        filter: EMPTY_FILTER
      };
    }
    return {
      mounted: true,
      cardCount: ideaCards(editor).length,
      facets: boardFacets(editor),
      filter: filterController?.get() ?? EMPTY_FILTER
    };
  },

  /**
   * Resolve once `projectId`'s editor is the mounted one (export/import #105) —
   * used to await a `setActive` + `switchTo` before reading/writing its board.
   */
  waitForMount(projectId: string): Promise<void> {
    if (editor && projectId === activeId) return Promise.resolve();
    return new Promise((resolve) => {
      const waiters = mountWaiters.get(projectId) ?? [];
      waiters.push(resolve);
      mountWaiters.set(projectId, waiters);
    });
  },

  /** Snapshot the mounted board into its portable JSON form (#105), or `null` if unmounted. */
  exportBoard(projectId: string): PortableBoard | null {
    if (!editor || projectId !== activeId) return null;
    return islandExportBoard(editor);
  },

  /** Render an imported board onto the mounted (normally empty) canvas (#105). */
  importBoard(projectId: string, board: PortableBoard): boolean {
    if (!editor || projectId !== activeId) return false;
    islandImportBoard(editor, board);
    bumpIdeasTick();
    scheduleBoardSnapshot();
    return true;
  },

  /**
   * Wait until tldraw's local IndexedDB persistence for the mounted editor has
   * flushed. tldraw throttles persists (350ms) and *drops* its pending diff
   * queue when the editor unmounts, so any flow that writes a board and then
   * immediately switches projects (the sequential import walk) must flush
   * first or the writes are silently lost. tldraw doesn't expose a public
   * flush; this drives the `window.tlsync` handle its local sync client
   * registers for debugging (tldraw pinned at ^5.1.0).
   */
  async flushPersistence(): Promise<void> {
    interface TlSyncClient {
      isPersisting: boolean;
      shouldDoFullDBWrite: boolean;
      diffQueue: unknown[];
      scheduledPersistTimeout: unknown;
      persistIfNeeded(): void;
    }
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const tlsync = (window as { tlsync?: TlSyncClient }).tlsync;
      if (!tlsync) return;
      if (
        !tlsync.isPersisting &&
        !tlsync.shouldDoFullDBWrite &&
        tlsync.diffQueue.length === 0 &&
        !tlsync.scheduledPersistTimeout
      ) {
        return;
      }
      tlsync.persistIfNeeded();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  },

  /** Full-fidelity tldraw snapshot of every mounted page (names, shapes, assets), or `undefined` if unmounted. */
  async exportTldraw(projectId: string): Promise<TldrawPage[] | undefined> {
    if (!editor || projectId !== activeId) return undefined;
    return islandExportTldrawPages(editor);
  },

  /** Restore a full-fidelity tldraw snapshot onto the mounted (normally empty) canvas. */
  importTldraw(projectId: string, pages: TldrawPage[]): boolean {
    if (!editor || projectId !== activeId) return false;
    islandImportTldrawPages(editor, pages);
    bumpIdeasTick();
    scheduleBoardSnapshot();
    return true;
  },

  /**
   * Gather idea cards across ALL projects for full-text search (#124). The
   * mounted project is read live off its editor (freshest); every other
   * project is read read-only from its persisted tldraw store, so search spans
   * boards without switching onto each one. Best-effort per project — an
   * unreadable board contributes nothing rather than failing the whole gather.
   */
  async collectSearchIdeas(projects: readonly { id: string; title: string }[]): Promise<SearchableIdea[]> {
    const results = await Promise.all(
      projects.map(async ({ id, title }) => {
        if (editor && id === activeId) {
          // All pages, not just the open one — parity with the persisted path.
          return allIdeaCards(editor).map((c) => toSearchableIdea(id, title, c.id, c.props, c.meta as IdeaCardMeta));
        }
        return readPersistedIdeas(id, title);
      })
    );
    return results.flat();
  },

  /**
   * Reveal a card on the mounted board (#124): select it and pan/zoom the camera
   * to frame it. Requires the target project to be the mounted one — cross-
   * project navigation switches first (see {@link project.revealIdea}). The
   * target is the stable tldraw shape id; returns false when the project isn't
   * mounted or the shape no longer exists (e.g. deleted since the index gather).
   */
  focusIdea(projectId: string, shapeId: string): boolean {
    if (!editor || projectId !== activeId) return false;
    const id = shapeId as TLShapeId;
    if (!editor.getShape(id)) return false;
    // The card may live on a different tldraw page (boards-within-a-project);
    // switch there first or the select/zoom below would frame the wrong page.
    const pageId = editor.getAncestorPageId(id);
    if (pageId && pageId !== editor.getCurrentPageId()) editor.setCurrentPage(pageId);
    editor.select(id);
    const bounds = editor.getShapePageBounds(id);
    if (bounds) editor.zoomToBounds(bounds, { targetZoom: 1, animation: { duration: 300 }, inset: 128 });
    return true;
  },

  /** Update the active board filter through the same atom used by the tldraw menu (#21/#96). */
  patchFilter(projectId: string, patch: Partial<BoardFilter>): boolean {
    if (!editor || projectId !== activeId || !filterController) return false;
    filterController.set({ ...filterController.get(), ...patch });
    scheduleBoardSnapshot();
    return true;
  },

  /** Register the card-verb sink (#13/#15/#62) — see {@link CanvasIsland}'s verb bar. */
  onCardVerb(cb: (text: string, intent: PromptIntent, sourceRefs: readonly string[]) => void): void {
    cardVerbHandler = cb;
  },

  /** Register the reference-in-terminal sink (#194) — see the context menu / verb bar. */
  onReferenceIdeas(cb: (cards: readonly ReferencedIdea[]) => void): void {
    referenceHandler = cb;
  },

  /** Register the create-issue sink (#125) — see the context menu's "Create GitHub issue". */
  onCreateIssue(cb: () => void): void {
    createIssueHandler = cb;
  },

  /** Tear down a deleted project's canvas state and its persisted store. */
  removeProject(projectId: string): void {
    pending.delete(projectId);
    // tldraw's local sync names the IndexedDB database
    // `TLDRAW_DOCUMENT_v2<persistenceKey>` (LocalIndexedDb, pinned to tldraw 5.x);
    // deleting it discards the board for good. Best-effort: never block deletion.
    try {
      indexedDB.deleteDatabase(`TLDRAW_DOCUMENT_v2ai-storm:ws:${projectId}`);
    } catch {
      /* ignore */
    }
  }
};
