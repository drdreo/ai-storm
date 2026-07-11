import type { AgentArtifact, Completion, CreateIdeaInput, Reference, Score } from "@ai-storm/shared";
import {
  createTLStore,
  defaultBindingUtils,
  defaultShapeUtils,
  getSnapshot,
  loadSnapshot,
  type Editor,
  type TLShapeId,
  type TLStore
} from "tldraw";
import { create } from "zustand";
import { backend, useBackendStore } from "./backend.store";
import {
  applyIdeas as islandApplyIdeas,
  applyScore as islandApplyScore,
  applyCompletion as islandApplyCompletion,
  applyIssueLinks as islandApplyIssueLinks,
  applyReference as islandApplyReference,
  type CanvasBridge,
  collectBoard,
  selectedText,
  serializeEditor,
  serializeForHandoff,
  serializeForTriage
} from "../core/canvas-island";
import { boardFacets, type BoardFacets, type BoardFilter, EMPTY_FILTER } from "../core/canvas/filter";
import { allIdeaCards, type IdeaCardMeta, ideaCards } from "../core/canvas/idea-card";
import { createUserIdea, setIdeaRefAllocator } from "../core/canvas/idea-tool";
import { IdeaCardShapeUtil } from "../core/canvas/idea-card";
import {
  arrangeMindMap as layoutArrangeMindMap,
  arrangePriorityGrid as layoutArrangePriorityGrid
} from "../core/canvas/layout";
import type { SearchableIdea } from "../core/canvas/search";
import { toSearchableIdea } from "../core/canvas/search-index";
import type { PromptIntent, ReferencedIdea } from "../core/prompt-framing";
import { type BoardStats, computeBoardStats } from "../core/board-stats.ts";
import { type ConvergentSummary, summarizeBoard } from "../core/summarize.ts";

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
  /** True once the canvas controller can load backend documents. */
  ready: boolean;
  activeStore: TLStore | null;
  loadState: "idle" | "loading" | "ready" | "error";
  error: string | null;
  recoveryPath: string | null;
  notice: string | null;
  unsaved: boolean;
  /**
   * Monotonic counter bumped whenever the mounted canvas gains cards (a fresh
   * `applyIdeas`, or a project mounting with persisted cards). The toolbar's
   * kind-filter chips recompute against it (#21).
   */
  ideasTick: number;
}

export const useCanvasStore = create<CanvasState>(() => ({
  ready: false,
  activeStore: null,
  loadState: "idle",
  error: null,
  recoveryPath: null,
  notice: null,
  unsaved: false,
  ideasTick: 0
}));

// ---- Imperative singleton state (lives outside React) ----------------------

let editor: Editor | null = null;
/** Project id the mounted editor currently shows (guards background applies). */
let activeId: string | null = null;
/** Ideas streamed to a non-mounted project, drained on its next mount. */
const pending = new Map<string, CreateIdeaInput[]>();
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
type BoardDocumentSnapshot = ReturnType<typeof getSnapshot>["document"];
interface LoadedBoard {
  revision: number;
  document: BoardDocumentSnapshot | null;
}
const stores = new Map<string, TLStore>();
const refPools = new Map<string, string[]>();
const refPoolRefills = new Set<string>();
const revisions = new Map<string, number>();
interface ProjectSaveState {
  queued: BoardDocumentSnapshot | null;
  inFlight: Promise<boolean> | null;
  debounceTimer: number | null;
  maxTimer: number | null;
  error: string | null;
  recoveryPath: string | null;
}
const saveStates = new Map<string, ProjectSaveState>();
const pendingRefRepairs = new Map<string, Set<string>>();
const refRepairsInFlight = new Set<string>();
let suppressSaves = false;

function sessionKey(projectId: string): string {
  return `ai-storm:ui:${projectId}`;
}

function projectSaveState(projectId: string): ProjectSaveState {
  let state = saveStates.get(projectId);
  if (!state) {
    state = {
      queued: null,
      inFlight: null,
      debounceTimer: null,
      maxTimer: null,
      error: null,
      recoveryPath: null
    };
    saveStates.set(projectId, state);
  }
  return state;
}

function syncActiveSaveUi(projectId: string): void {
  if (activeId !== projectId) return;
  const state = projectSaveState(projectId);
  useCanvasStore.setState({
    unsaved: !!state.queued || !!state.inFlight,
    error: state.error,
    recoveryPath: state.recoveryPath
  });
}

function setProjectError(projectId: string, error: unknown): void {
  const state = projectSaveState(projectId);
  state.error = error instanceof Error ? error.message : String(error);
  state.recoveryPath = (error as Error & { path?: string }).path ?? `projects/${projectId}/board.json`;
  syncActiveSaveUi(projectId);
}

async function reserveCanonicalRefs(projectId: string, count: number): Promise<string[]> {
  const pool = refPools.get(projectId);
  const refs = pool?.splice(0, count) ?? [];
  if (refs.length < count) {
    refs.push(
      ...(
        await backend.request<{ refs: string[] }>("reserve-idea-refs", {
          projectId,
          payload: { count: count - refs.length }
        })
      ).refs
    );
  }
  refillRefPool(projectId);
  return refs;
}

function refillRefPool(projectId: string): void {
  const pool = refPools.get(projectId);
  if (!pool || pool.length >= 16 || refPoolRefills.has(projectId)) return;
  refPoolRefills.add(projectId);
  void backend
    .request<{ refs: string[] }>("reserve-idea-refs", { projectId, payload: { count: 32 } })
    .then(({ refs }) => pool.push(...refs))
    .catch((error) => setProjectError(projectId, error))
    .finally(() => refPoolRefills.delete(projectId));
}

function installRefGuard(projectId: string, store: TLStore): void {
  store.sideEffects.registerBeforeCreateHandler("shape", (record) => {
    if (record.type !== "idea-card") return record;
    const meta = record.meta as IdeaCardMeta;
    const duplicate =
      !!meta.ref &&
      store
        .allRecords()
        .some(
          (existing) => existing.typeName === "shape" && existing.id !== record.id && existing.meta.ref === meta.ref
        );
    if (meta.ref && !duplicate) return record;
    const ref = refPools.get(projectId)?.shift();
    if (!ref) return record;
    refillRefPool(projectId);
    return { ...record, meta: { ...record.meta, ref } };
  });

  // A synchronous before-create hook cannot await the backend. If a paste is
  // larger than the reserved pool, repair those overflow cards immediately and
  // hold their board save until every card has a canonical ref.
  store.sideEffects.registerAfterCreateHandler("shape", (record) => {
    if (record.type !== "idea-card" || (record.meta as IdeaCardMeta).ref) return;
    let repairs = pendingRefRepairs.get(projectId);
    if (!repairs) {
      repairs = new Set();
      pendingRefRepairs.set(projectId, repairs);
    }
    repairs.add(record.id);
    void repairMissingRefs(projectId, store);
  });
}

async function repairMissingRefs(projectId: string, store: TLStore): Promise<void> {
  const pending = pendingRefRepairs.get(projectId);
  if (!pending?.size || refRepairsInFlight.has(projectId)) return;
  refRepairsInFlight.add(projectId);
  const ids = [...pending];
  let repaired = false;
  try {
    const refs = await reserveCanonicalRefs(projectId, ids.length);
    ids.forEach((id, index) => {
      const current = store.get(id as TLShapeId);
      if (current?.typeName === "shape" && current.type === "idea-card") {
        store.put([{ ...current, meta: { ...current.meta, ref: refs[index] } }]);
      }
      pending.delete(id);
    });
    if (pending.size === 0) pendingRefRepairs.delete(projectId);
    repaired = true;
    queueStoreDocument(projectId, store);
  } catch (error) {
    // Keep the ids queued; reconnect retries before any board flush.
    setProjectError(projectId, error);
  } finally {
    refRepairsInFlight.delete(projectId);
    if (repaired && pending.size > 0) void repairMissingRefs(projectId, store);
  }
}

function buildStore(
  projectId: string,
  board: LoadedBoard,
  options: { refs?: string[]; register?: boolean; restoreSession?: boolean } = {}
): TLStore {
  const store = createTLStore({
    shapeUtils: [...defaultShapeUtils, IdeaCardShapeUtil],
    bindingUtils: [...defaultBindingUtils]
  });
  try {
    const rawSession = options.restoreSession === false ? null : localStorage.getItem(sessionKey(projectId));
    const session = rawSession ? JSON.parse(rawSession) : undefined;
    if (board.document || session) loadSnapshot(store, { document: board.document ?? undefined, session });
  } catch (error) {
    const wrapped = new Error(
      `Unable to migrate or validate board ${projectId}: ${error instanceof Error ? error.message : String(error)}`
    );
    (wrapped as Error & { path?: string }).path = `projects/${projectId}/board.json`;
    throw wrapped;
  }
  if (options.register !== false) {
    refPools.set(projectId, options.refs ?? []);
    installRefGuard(projectId, store);
    stores.set(projectId, store);
    revisions.set(projectId, board.revision);
  }
  return store;
}

async function loadProject(projectId: string): Promise<TLStore> {
  if (activeId === projectId) useCanvasStore.setState({ loadState: "loading", error: null, recoveryPath: null });
  try {
    const board = await backend.request<LoadedBoard>("board-load", { projectId });
    const { refs } = await backend.request<{ refs: string[] }>("reserve-idea-refs", {
      projectId,
      payload: { count: 32 }
    });
    const store = buildStore(projectId, board, { refs });
    if (activeId === projectId) {
      useCanvasStore.setState({ activeStore: store, loadState: "ready", notice: null });
      syncActiveSaveUi(projectId);
    }
    return store;
  } catch (error) {
    if (activeId === projectId) {
      const path = (error as Error & { path?: string }).path ?? `projects/${projectId}/board.json`;
      useCanvasStore.setState({
        loadState: "error",
        error: error instanceof Error ? error.message : String(error),
        recoveryPath: path
      });
    }
    throw error;
  }
}

async function loadSearchStore(projectId: string): Promise<TLStore> {
  const board = await backend.request<LoadedBoard>("board-load", { projectId });
  return buildStore(projectId, board, { register: false, restoreSession: false });
}

function clearSaveTimers(state: ProjectSaveState): void {
  if (state.debounceTimer !== null) clearTimeout(state.debounceTimer);
  if (state.maxTimer !== null) clearTimeout(state.maxTimer);
  state.debounceTimer = state.maxTimer = null;
}

async function saveQueued(projectId: string): Promise<boolean> {
  const state = projectSaveState(projectId);
  clearSaveTimers(state);
  if (state.inFlight) return false;
  if (!state.queued) return true;
  const document = state.queued;
  state.queued = null;
  syncActiveSaveUi(projectId);
  const expectedRevision = revisions.get(projectId) ?? 0;
  state.inFlight = backend
    .request<{ ok: boolean; board?: { revision: number }; conflict?: LoadedBoard }>("board-save", {
      projectId,
      payload: { expectedRevision, document }
    })
    .then((result) => {
      if (result.ok && result.board) {
        revisions.set(projectId, result.board.revision);
        state.error = state.recoveryPath = null;
        return true;
      }
      if (result.conflict) {
        revisions.set(projectId, result.conflict.revision);
        state.queued = null;
        state.error = state.recoveryPath = null;
        const store = stores.get(projectId);
        if (store) {
          suppressSaves = true;
          try {
            loadSnapshot(store, { document: result.conflict.document ?? undefined });
          } finally {
            suppressSaves = false;
          }
        }
        if (activeId === projectId) {
          bumpIdeasTick();
          useCanvasStore.setState({
            notice:
              "The backend board changed while you were offline. Local unsaved edits were discarded and the latest board was loaded."
          });
        }
        return true;
      }
      return false;
    })
    .catch((error) => {
      // A newer queued snapshot already contains these edits; otherwise restore
      // this attempt so reconnect/switching can retry the same project later.
      if (!state.queued) state.queued = document;
      setProjectError(projectId, error);
      return false;
    })
    .finally(() => {
      state.inFlight = null;
      syncActiveSaveUi(projectId);
      if (state.queued && useBackendStore.getState().state === "open") scheduleSave(projectId);
    });
  syncActiveSaveUi(projectId);
  return state.inFlight;
}

function scheduleSave(projectId: string): void {
  const state = projectSaveState(projectId);
  syncActiveSaveUi(projectId);
  if (state.debounceTimer !== null) clearTimeout(state.debounceTimer);
  state.debounceTimer = setTimeout(() => void saveQueued(projectId), 500) as unknown as number;
  if (state.maxTimer === null) {
    state.maxTimer = setTimeout(() => void saveQueued(projectId), 2000) as unknown as number;
  }
}

function saveLocalSession(): void {
  if (!editor || !activeId) return;
  try {
    localStorage.setItem(sessionKey(activeId), JSON.stringify(getSnapshot(editor.store).session));
  } catch {
    /* browser-only best effort */
  }
}

function queueStoreDocument(projectId: string, store: TLStore): void {
  if (suppressSaves) return;
  const state = projectSaveState(projectId);
  state.queued = getSnapshot(store).document;
  syncActiveSaveUi(projectId);
  if (!pendingRefRepairs.get(projectId)?.size) scheduleSave(projectId);
}

function queueDocumentSave(): void {
  if (!editor || !activeId) return;
  queueStoreDocument(activeId, editor.store);
  saveLocalSession();
}

async function flushProjectPersistence(projectId: string): Promise<void> {
  const state = projectSaveState(projectId);
  clearSaveTimers(state);
  while (state.queued || state.inFlight) {
    if (state.inFlight) {
      const saved = await state.inFlight;
      if (!saved && state.queued) return;
    } else if (!(await saveQueued(projectId))) {
      return;
    }
  }
}

async function reconcileProject(projectId: string): Promise<void> {
  const state = projectSaveState(projectId);
  if (!state.queued || pendingRefRepairs.get(projectId)?.size) return;
  try {
    const latest = await backend.request<LoadedBoard>("board-load", { projectId });
    if (latest.revision === revisions.get(projectId)) {
      await flushProjectPersistence(projectId);
      return;
    }
    state.queued = null;
    state.error = state.recoveryPath = null;
    revisions.set(projectId, latest.revision);
    const store = stores.get(projectId);
    if (store) {
      suppressSaves = true;
      try {
        loadSnapshot(store, { document: latest.document ?? undefined });
      } finally {
        suppressSaves = false;
      }
    }
    if (activeId === projectId) {
      bumpIdeasTick();
      useCanvasStore.setState({
        notice:
          "The backend board changed while you were offline. Local unsaved edits were discarded and the latest board was loaded."
      });
    }
    syncActiveSaveUi(projectId);
  } catch {
    /* retain this project's in-memory recovery snapshot */
  }
}

async function reconcileOnReconnect(): Promise<void> {
  await Promise.all(
    [...pendingRefRepairs.keys()].map(async (projectId) => {
      const store = stores.get(projectId);
      if (store) await repairMissingRefs(projectId, store);
    })
  );
  await Promise.all([...saveStates.entries()].filter(([, state]) => state.queued).map(([id]) => reconcileProject(id)));
}

function bumpIdeasTick(): void {
  useCanvasStore.setState((s) => ({ ideasTick: s.ideasTick + 1 }));
}

function onEditorMount(ed: Editor): void {
  editor = ed;
  // Drain any ideas that streamed in while this project was unmounted.
  const queued = activeId ? pending.get(activeId) : undefined;
  if (queued?.length) {
    pending.delete(activeId!);
    islandApplyIdeas(ed, queued);
    queueDocumentSave();
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
}

backend.onOpen(() => void reconcileOnReconnect());
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    for (const projectId of saveStates.keys()) void saveQueued(projectId);
  });
}

export const canvas = {
  /**
   * A single stable bridge identity handed to React for the app's lifetime.
   * `CanvasPane` passes this into `<CanvasIsland>`; `onEditorMount` wires the
   * live editor back into this controller.
   */
  bridge: {
    onEditorMount: (ed: Editor) => onEditorMount(ed),
    onBoardChanged: () => {
      queueDocumentSave();
    },
    onSessionChanged: () => saveLocalSession(),
    onCardVerb: (text, intent, sourceRefs) => cardVerbHandler?.(text, intent, sourceRefs),
    onReferenceIdeas: (cards) => referenceHandler?.(cards),
    onCreateIssue: () => createIssueHandler?.(),
    onFilterMount: (controller) => {
      filterController = {
        get: controller.get,
        set: (filter) => controller.set(filter)
      };
      return () => {
        if (filterController?.get === controller.get) filterController = null;
      };
    }
  } as CanvasBridge,

  async init(): Promise<void> {
    setIdeaRefAllocator(async () => {
      if (!activeId) throw new Error("No active project");
      return (await reserveCanonicalRefs(activeId, 1))[0];
    });
    useCanvasStore.setState({ ready: true });
  },

  async ensureReady(projectId: string): Promise<void> {
    if (!stores.has(projectId)) await loadProject(projectId);
  },

  dismissNotice(): void {
    useCanvasStore.setState({ notice: null });
  },

  retryLoad(projectId: string): Promise<void> {
    stores.delete(projectId);
    refPools.delete(projectId);
    return loadProject(projectId).then(() => undefined);
  },

  downloadRecovery(projectId: string): void {
    const store = stores.get(projectId);
    if (!store) return;
    const blob = new Blob([JSON.stringify(getSnapshot(store).document, null, 2)], { type: "application/json" });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = `${projectId}-recovery.json`;
    anchor.click();
    URL.revokeObjectURL(href);
  },

  /**
   * Hot-switch the bound project (PRD §3.4). `CanvasPane` remounts
   * `<CanvasIsland>` by changing its `key`/backend-loaded store; this drops the old
   * editor handle so background applies queue until the new editor mounts. A
   * switch to the already-active project is a no-op (keeps the live editor).
   */
  switchTo(projectId: string): void {
    if (projectId === activeId) return;
    const previousId = activeId;
    if (previousId) void flushProjectPersistence(previousId);
    activeId = projectId;
    editor = null;
    const store = stores.get(projectId);
    const saveState = projectSaveState(projectId);
    useCanvasStore.setState({
      activeStore: store ?? null,
      loadState: store ? "ready" : "loading",
      unsaved: !!saveState.queued || !!saveState.inFlight,
      error: saveState.error,
      recoveryPath: saveState.recoveryPath,
      notice: null
    });
    if (!store) void loadProject(projectId);
  },

  /**
   * Render a batch of extracted ideas as cards + typed edges. Applied straight
   * to the live editor when the target project is the mounted one; otherwise
   * queued and drained when that project next mounts.
   */
  applyIdeas(projectId: string, ideas: CreateIdeaInput[]): void {
    if (ideas.length === 0) return;
    void (async () => {
      const missing = ideas.filter((idea) => !idea.ref).length;
      const refs = missing ? await reserveCanonicalRefs(projectId, missing) : [];
      let index = 0;
      const canonical = ideas.map((idea) => (idea.ref ? idea : { ...idea, id: refs[index++] }));
      if (editor && projectId === activeId) {
        islandApplyIdeas(editor, canonical);
        bumpIdeasTick();
      } else {
        const q = pending.get(projectId) ?? [];
        q.push(...canonical);
        pending.set(projectId, q);
      }
    })();
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
    }
  },

  /** Apply a done/reopen change to its target card's meta (#167). */
  applyCompletion(projectId: string, completion: Completion): void {
    if (editor && projectId === activeId) {
      islandApplyCompletion(editor, completion);
    }
  },

  /** Stamp created-issue links back onto their source cards' meta (#125). */
  applyIssueLinks(projectId: string, artifacts: readonly AgentArtifact[]): void {
    if (editor && projectId === activeId) {
      islandApplyIssueLinks(editor, artifacts);
    }
  },

  /** Attach an external-link reference to its target card's meta (#227). */
  applyReference(projectId: string, reference: Reference): void {
    if (editor && projectId === activeId) {
      islandApplyReference(editor, reference);
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

  /** Plain text of the current selection — or the whole canvas (PRD §3.6). */
  getSelectedText(): string {
    return editor ? selectedText(editor) : "";
  },

  /** Create a user-origin idea card at the visible board center (#31/#96). */
  createIdea(projectId: string): boolean {
    if (!editor || projectId !== activeId) return false;
    createUserIdea(editor, editor.getViewportPageBounds().center);
    bumpIdeasTick();
    return true;
  },

  /** Run the existing organic mind-map arrangement from the command palette (#16/#96). */
  arrangeMindMap(projectId: string): boolean {
    if (!editor || projectId !== activeId || ideaCards(editor).length === 0) return false;
    layoutArrangeMindMap(editor);
    return true;
  },

  /** Run the existing impact/effort grid arrangement from the command palette (#60/#96). */
  arrangePriorityGrid(projectId: string): boolean {
    if (!editor || projectId !== activeId || ideaCards(editor).length === 0) return false;
    layoutArrangePriorityGrid(editor);
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

  /** Flush the coalesced backend board write before an export/import completes. */
  async flushPersistence(): Promise<void> {
    if (activeId) await flushProjectPersistence(activeId);
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
        try {
          const store = stores.get(id) ?? (await loadSearchStore(id));
          return store
            .allRecords()
            .filter((record) => record.typeName === "shape" && (record as { type?: string }).type === "idea-card")
            .map((record) => {
              const shape = record as unknown as {
                id: string;
                props: Parameters<typeof toSearchableIdea>[3];
                meta: IdeaCardMeta;
              };
              return toSearchableIdea(id, title, shape.id, shape.props, shape.meta ?? {});
            });
        } catch {
          return [];
        }
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
    stores.delete(projectId);
    refPools.delete(projectId);
    revisions.delete(projectId);
    pendingRefRepairs.delete(projectId);
    refRepairsInFlight.delete(projectId);
    const saveState = saveStates.get(projectId);
    if (saveState) clearSaveTimers(saveState);
    saveStates.delete(projectId);
    localStorage.removeItem(sessionKey(projectId));
  }
};
