import { create } from "zustand";
import type { Editor, TLShapeId } from "tldraw";
import type { Idea, Score } from "@ai-storm/shared";
import type { PromptIntent } from "../core/prompt-framing";
import {
  type CanvasBridge,
  applyIdeas as islandApplyIdeas,
  serializeEditor,
  serializeForTriage,
  serializeForHandoff,
  applyScore as islandApplyScore,
  selectedText,
  collectBoard,
  exportBoard as islandExportBoard,
  importBoard as islandImportBoard
} from "../core/canvas-island";
import type { PortableBoard } from "../core/workspace-portable";
import { synthesizeBoard, type ConvergentSummary } from "../core/synthesis";
import { createUserIdea } from "../core/canvas/idea-tool";
import {
  arrangeMindMap as layoutArrangeMindMap,
  arrangePriorityGrid as layoutArrangePriorityGrid
} from "../core/canvas/layout";
import { boardFacets, EMPTY_FILTER, type BoardFacets, type BoardFilter } from "../core/canvas/filter";
import { ideaCards, type IdeaCardMeta } from "../core/canvas/idea-card";
import type { SearchableIdea } from "../core/canvas/search";
import { readPersistedIdeas, toSearchableIdea } from "../core/canvas/search-index";

/**
 * tldraw canvas controller (PRD §3.1, §3.3, §3.6) — the imperative seam over the
 * React {@link CanvasIsland} that holds the tldraw `Editor`.
 *
 * This replaces the old Angular `CanvasService` facade. With React there is no
 * `createRoot`/`render` plumbing here: `CanvasPane` renders `<CanvasIsland>`
 * directly (keyed by workspace id), and this module just holds the live editor
 * handle so the framework-agnostic ingestion/agent stores — which run *outside*
 * the component tree — can drive the canvas. The reactive surface (`ready`,
 * `ideasTick`) is a tiny Zustand store the canvas toolbar subscribes to; the
 * tldraw store itself is not reactive, so `ideasTick` is the recompute trigger
 * for the kind-filter chips (#21).
 *
 * Background ingestion: a workspace whose session is streaming but which is NOT
 * the mounted one has no live editor, so its ideas are queued and drained when
 * it next mounts (single-user v0; full background persistence is the
 * backend-snapshot ticket).
 */

interface CanvasState {
  /** True once the canvas is initialized (parity with the old CRDT-boot flag). */
  ready: boolean;
  /**
   * Monotonic counter bumped whenever the mounted canvas gains cards (a fresh
   * `applyIdeas`, or a workspace mounting with persisted cards). The toolbar's
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
/** Workspace id the mounted editor currently shows (guards background applies). */
let activeId: string | null = null;
/** Ideas streamed to a non-mounted workspace, drained on its next mount. */
const pending = new Map<string, Idea[]>();
/** Resolvers waiting on a given workspace's editor to mount (export/import #105). */
const mountWaiters = new Map<string, Array<() => void>>();
/** Fired when a card verb (#13 Discuss / #15 expand/challenge/find-risks) is picked. */
let cardVerbHandler: ((text: string, intent: PromptIntent, sourceRefs: readonly string[]) => void) | null = null;
let filterController: {
  get(): BoardFilter;
  set(filter: BoardFilter): void;
} | null = null;

function bumpIdeasTick(): void {
  useCanvasStore.setState((s) => ({ ideasTick: s.ideasTick + 1 }));
}

function onEditorMount(ed: Editor): void {
  editor = ed;
  // Drain any ideas that streamed in while this workspace was unmounted.
  const queued = activeId ? pending.get(activeId) : undefined;
  if (queued?.length) {
    pending.delete(activeId!);
    islandApplyIdeas(ed, queued);
  }
  // Recompute the kind-filter chips against the now-loaded store (covers a
  // reload restoring persisted cards, not just freshly-drained ones).
  bumpIdeasTick();

  // Wake anyone waiting on this workspace's editor (export/import #105).
  const waiters = activeId ? mountWaiters.get(activeId) : undefined;
  if (waiters?.length) {
    mountWaiters.delete(activeId!);
    waiters.forEach((resolve) => resolve());
  }
}

export const canvas = {
  /**
   * A single stable bridge identity handed to React for the app's lifetime.
   * `CanvasPane` passes this into `<CanvasIsland>`; `onEditorMount` wires the
   * live editor back into this controller.
   */
  bridge: {
    onEditorMount: (ed: Editor) => onEditorMount(ed),
    onCardVerb: (text, intent, sourceRefs) => cardVerbHandler?.(text, intent, sourceRefs),
    onFilterMount: (controller) => {
      filterController = controller;
      return () => {
        if (filterController === controller) filterController = null;
      };
    }
  } as CanvasBridge,

  /** No CRDT collection to stand up — just flip ready (parity with old boot). */
  async init(): Promise<void> {
    useCanvasStore.setState({ ready: true });
  },

  /** tldraw owns store loading; nothing to pre-rehydrate (parity shim). */
  async ensureReady(_workspaceId: string): Promise<void> {
    /* tldraw owns store loading; nothing to pre-rehydrate. */
  },

  /**
   * Hot-switch the bound workspace (PRD §3.4). `CanvasPane` remounts
   * `<CanvasIsland>` by changing its `key`/`persistenceKey`; this drops the old
   * editor handle so background applies queue until the new editor mounts. A
   * switch to the already-active workspace is a no-op (keeps the live editor).
   */
  switchTo(workspaceId: string): void {
    if (workspaceId === activeId) return;
    activeId = workspaceId;
    editor = null;
  },

  /**
   * Render a batch of extracted ideas as cards + typed edges. Applied straight
   * to the live editor when the target workspace is the mounted one; otherwise
   * queued and drained when that workspace next mounts.
   */
  applyIdeas(workspaceId: string, ideas: Idea[]): void {
    if (ideas.length === 0) return;
    if (editor && workspaceId === activeId) {
      islandApplyIdeas(editor, ideas);
      bumpIdeasTick();
    } else {
      const q = pending.get(workspaceId) ?? [];
      q.push(...ideas);
      pending.set(workspaceId, q);
    }
  },

  /**
   * Ref-annotated serialization of the board for an AI triage pass (#60), or `''`
   * if this workspace isn't the mounted one. The agent scores each `@ref` and
   * replies with `«SCORE@ref»` lines that flow back through {@link applyScore}.
   */
  serializeForTriage(workspaceId: string): string {
    if (!editor || workspaceId !== activeId) return "";
    return serializeForTriage(editor);
  },

  /**
   * Lifecycle-aware serialization of the selection — or the whole board — for the
   * spec/PRD hand-off (#89, PD-015), or `''` if this workspace isn't the mounted
   * one. Superseded ghosts are excluded and keep-marks (#59) flagged with ★; the
   * agent turns this into a generated spec artifact via {@link agent.generateSpec}.
   */
  serializeForHandoff(workspaceId: string): string {
    if (!editor || workspaceId !== activeId) return "";
    return serializeForHandoff(editor);
  },

  /** Apply an extracted triage score to its target card's meta (#60). */
  applyScore(workspaceId: string, score: Score): void {
    if (editor && workspaceId === activeId) islandApplyScore(editor, score);
  },

  /**
   * Synthesize the active board into a convergent summary (#28, PD-015) — a pure,
   * on-demand *reading* of the canvas (themes → decisions → open questions →
   * highlights). Returns `null` when the target workspace isn't the mounted one
   * (no live editor to read). No canvas mutation, no agent round-trip.
   */
  synthesize(workspaceId: string): ConvergentSummary | null {
    if (!editor || workspaceId !== activeId) return null;
    return synthesizeBoard(collectBoard(editor));
  },

  /** Serialize the workspace canvas to normalized markdown (PRD §3.2). */
  serializeToText(workspaceId: string): string {
    if (!editor || workspaceId !== activeId) return "";
    return serializeEditor(editor);
  },

  /** Plain text of the current selection — or the whole canvas (PRD §3.6). */
  getSelectedText(): string {
    return editor ? selectedText(editor) : "";
  },

  /** Create a user-origin idea card at the visible board center (#31/#96). */
  createIdea(workspaceId: string): boolean {
    if (!editor || workspaceId !== activeId) return false;
    createUserIdea(editor, editor.getViewportPageBounds().center);
    bumpIdeasTick();
    return true;
  },

  /** Run the existing organic mind-map arrangement from the command palette (#16/#96). */
  arrangeMindMap(workspaceId: string): boolean {
    if (!editor || workspaceId !== activeId || ideaCards(editor).length === 0) return false;
    layoutArrangeMindMap(editor);
    return true;
  },

  /** Run the existing impact/effort grid arrangement from the command palette (#60/#96). */
  arrangePriorityGrid(workspaceId: string): boolean {
    if (!editor || workspaceId !== activeId || ideaCards(editor).length === 0) return false;
    layoutArrangePriorityGrid(editor);
    return true;
  },

  /** Live board facts used to explain disabled palette actions (#96). */
  boardCommandState(workspaceId: string): {
    mounted: boolean;
    cardCount: number;
    facets: BoardFacets;
    filter: BoardFilter;
  } {
    if (!editor || workspaceId !== activeId) {
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
   * Resolve once `workspaceId`'s editor is the mounted one (export/import #105) —
   * used to await a `setActive` + `switchTo` before reading/writing its board.
   */
  waitForMount(workspaceId: string): Promise<void> {
    if (editor && workspaceId === activeId) return Promise.resolve();
    return new Promise((resolve) => {
      const waiters = mountWaiters.get(workspaceId) ?? [];
      waiters.push(resolve);
      mountWaiters.set(workspaceId, waiters);
    });
  },

  /** Snapshot the mounted board into its portable JSON form (#105), or `null` if unmounted. */
  exportBoard(workspaceId: string): PortableBoard | null {
    if (!editor || workspaceId !== activeId) return null;
    return islandExportBoard(editor);
  },

  /** Render an imported board onto the mounted (normally empty) canvas (#105). */
  importBoard(workspaceId: string, board: PortableBoard): boolean {
    if (!editor || workspaceId !== activeId) return false;
    islandImportBoard(editor, board);
    bumpIdeasTick();
    return true;
  },

  /**
   * Gather idea cards across ALL workspaces for full-text search (#124). The
   * mounted workspace is read live off its editor (freshest); every other
   * workspace is read read-only from its persisted tldraw store, so search spans
   * boards without switching onto each one. Best-effort per workspace — an
   * unreadable board contributes nothing rather than failing the whole gather.
   */
  async collectSearchIdeas(workspaces: readonly { id: string; title: string }[]): Promise<SearchableIdea[]> {
    const results = await Promise.all(
      workspaces.map(async ({ id, title }) => {
        if (editor && id === activeId) {
          return ideaCards(editor).map((c) =>
            toSearchableIdea(id, title, c.id, c.props, c.meta as IdeaCardMeta)
          );
        }
        return readPersistedIdeas(id, title);
      })
    );
    return results.flat();
  },

  /**
   * Reveal a card on the mounted board (#124): select it and pan/zoom the camera
   * to frame it. Requires the target workspace to be the mounted one — cross-
   * workspace navigation switches first (see {@link workspace.revealIdea}). The
   * target is the stable tldraw shape id; returns false when the workspace isn't
   * mounted or the shape no longer exists (e.g. deleted since the index gather).
   */
  focusIdea(workspaceId: string, shapeId: string): boolean {
    if (!editor || workspaceId !== activeId) return false;
    const id = shapeId as TLShapeId;
    if (!editor.getShape(id)) return false;
    editor.select(id);
    const bounds = editor.getShapePageBounds(id);
    if (bounds) editor.zoomToBounds(bounds, { targetZoom: 1, animation: { duration: 300 }, inset: 128 });
    return true;
  },

  /** Update the active board filter through the same atom used by the tldraw menu (#21/#96). */
  patchFilter(workspaceId: string, patch: Partial<BoardFilter>): boolean {
    if (!editor || workspaceId !== activeId || !filterController) return false;
    filterController.set({ ...filterController.get(), ...patch });
    return true;
  },

  /** Register the card-verb sink (#13/#15/#62) — see {@link CanvasIsland}'s verb bar. */
  onCardVerb(cb: (text: string, intent: PromptIntent, sourceRefs: readonly string[]) => void): void {
    cardVerbHandler = cb;
  },

  /** Tear down a deleted workspace's canvas state and its persisted store. */
  removeWorkspace(workspaceId: string): void {
    pending.delete(workspaceId);
    // tldraw's local sync names the IndexedDB database
    // `TLDRAW_DOCUMENT_v2<persistenceKey>` (LocalIndexedDb, pinned to tldraw 5.x);
    // deleting it discards the board for good. Best-effort: never block deletion.
    try {
      indexedDB.deleteDatabase(`TLDRAW_DOCUMENT_v2ai-storm:ws:${workspaceId}`);
    } catch {
      /* ignore */
    }
  }
};
