/**
 * Cross-project idea gathering (#124) — the read side that lets Ctrl+K search
 * ideas in projects that aren't the mounted one.
 *
 * Only the active project has a live tldraw `Editor`; every other project's
 * board lives in its own IndexedDB store (see {@link CanvasIsland}'s
 * `persistenceKey`). tldraw persists each store as `TLDRAW_DOCUMENT_v2<key>` with
 * a `records` object store holding every record (LocalIndexedDb, pinned to tldraw
 * 5.x — the same layout {@link canvas.removeProject} deletes). We open it
 * READ-ONLY and pull the `idea-card` shape records straight out, so search sees a
 * non-mounted board without the flicker/cost of switching onto it.
 *
 * The mapping from a shape record to a {@link SearchableIdea} is shared with the
 * live-editor path (a persisted shape and a live shape carry the same `props` /
 * `meta`), so both sources yield identical result shapes.
 */
import type { BoardIdeaCard, BoardIdeaEdge, BoardIdeasSnapshot, IdeaRelation } from "@ai-storm/shared";
import type { IdeaCardMeta, Origin } from "./idea-card";
import type { SearchableIdea } from "./search";

/** tldraw's IndexedDB naming (bundled `LocalIndexedDb`, tldraw 5.x). */
const STORE_PREFIX = "TLDRAW_DOCUMENT_v2";
const PERSISTENCE_PREFIX = "ai-storm:ws:";
const RECORDS_TABLE = "records";

/** The subset of a persisted tldraw record (shape, page, or binding) we read. */
export interface PersistedShapeRecord {
  id?: string;
  typeName?: string;
  type?: string;
  /** Page name (only on `typeName === "page"` records; unused on shapes). */
  name?: string;
  /** Fractional-index sort key, present on page records — orders the pages. */
  index?: string;
  /** Top-level shape position (idea-card records) — the card's board coordinates. */
  x?: number;
  y?: number;
  /** Arrow-binding endpoints (`typeName === "binding"`): the arrow and the shape
   *  it binds to; the terminal (start/end) rides in `props`. */
  fromId?: string;
  toId?: string;
  props?: { kind?: string; title?: string; body?: string; origin?: Origin; superseded?: boolean; terminal?: string };
  meta?: IdeaCardMeta & { relation?: string };
}

/** A cheap read of a non-mounted project's board: its page names + idea count (#228). */
export interface PersistedBoardSummary {
  /** tldraw page names in document order (by fractional index). */
  pages: string[];
  /** Number of `idea-card` shapes across every page. */
  ideaCount: number;
}

/**
 * Map a persisted (or live) idea-card record to a {@link SearchableIdea}. Shared
 * by both gather paths — `props`/`meta` are identical whether the shape came from
 * the editor or straight out of IndexedDB.
 */
export function toSearchableIdea(
  projectId: string,
  projectTitle: string,
  shapeId: string,
  props: { kind?: string; title?: string; body?: string; origin?: Origin; superseded?: boolean },
  meta: IdeaCardMeta
): SearchableIdea {
  return {
    projectId,
    projectTitle,
    shapeId,
    ref: meta.ref,
    kind: props.kind ?? "",
    title: props.title ?? "",
    body: props.body ?? "",
    origin: props.origin ?? "user",
    superseded: !!props.superseded,
    starred: !!meta.starred,
    triaged: !!meta.score,
    createdAt: typeof meta.createdAt === "number" ? meta.createdAt : undefined
  };
}

function dbName(projectId: string): string {
  return `${STORE_PREFIX}${PERSISTENCE_PREFIX}${projectId}`;
}

/**
 * Whether a project's board DB already exists — so we never open (and thereby
 * CREATE) an empty store for a project that has never been mounted. Uses
 * `indexedDB.databases()` where available (Chromium — this app's target per the
 * ConPTY/Chrome stack); falls back to `true` (attempt the open) when the API is
 * missing, which at worst leaves an empty store behind.
 */
async function boardDbExists(projectId: string): Promise<boolean> {
  if (typeof indexedDB === "undefined") return false;
  if (typeof indexedDB.databases !== "function") return true;
  try {
    const names = (await indexedDB.databases()).map((d) => d.name);
    return names.includes(dbName(projectId));
  } catch {
    return true;
  }
}

function openBoardDb(projectId: string): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    let created = false;
    const request = indexedDB.open(dbName(projectId));
    // A version bump we didn't ask for means the DB didn't exist — bail rather
    // than stand up an empty store tldraw would then own.
    request.onupgradeneeded = () => {
      created = true;
    };
    request.onerror = () => resolve(null);
    request.onsuccess = () => {
      const db = request.result;
      if (created || !db.objectStoreNames.contains(RECORDS_TABLE)) {
        db.close();
        resolve(null);
        return;
      }
      resolve(db);
    };
  });
}

function readAllRecords(db: IDBDatabase): Promise<PersistedShapeRecord[]> {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(RECORDS_TABLE, "readonly");
      const request = tx.objectStore(RECORDS_TABLE).getAll();
      request.onerror = () => resolve([]);
      request.onsuccess = () => resolve((request.result as PersistedShapeRecord[]) ?? []);
    } catch {
      resolve([]);
    }
  });
}

/**
 * Read a non-mounted project's persisted idea cards as {@link SearchableIdea}s
 * (#124). Best-effort: any failure (missing DB, blocked open, older schema)
 * yields `[]` so a single unreadable board never breaks search.
 */
export async function readPersistedIdeas(projectId: string, projectTitle: string): Promise<SearchableIdea[]> {
  if (!(await boardDbExists(projectId))) return [];
  const db = await openBoardDb(projectId);
  if (!db) return [];
  try {
    const records = await readAllRecords(db);
    return records
      .filter((r) => r.typeName === "shape" && r.type === "idea-card" && typeof r.id === "string")
      .map((r) => toSearchableIdea(projectId, projectTitle, r.id!, r.props ?? {}, r.meta ?? {}));
  } finally {
    db.close();
  }
}

/**
 * Read a non-mounted project's page names + idea-card count for the project
 * catalog (#228), straight out of its persisted tldraw store — no switching
 * onto the board. Best-effort like {@link readPersistedIdeas}: a project that
 * has never been mounted (no DB yet), a blocked open, or an older schema yields
 * an empty summary rather than failing the whole catalog.
 */
export async function readPersistedBoardSummary(projectId: string): Promise<PersistedBoardSummary> {
  const empty: PersistedBoardSummary = { pages: [], ideaCount: 0 };
  if (!(await boardDbExists(projectId))) return empty;
  const db = await openBoardDb(projectId);
  if (!db) return empty;
  try {
    const records = await readAllRecords(db);
    const pages = records
      .filter((r) => r.typeName === "page" && typeof r.name === "string")
      .sort((a, b) => (a.index ?? "").localeCompare(b.index ?? ""))
      .map((r) => r.name!);
    const ideaCount = records.filter((r) => r.typeName === "shape" && r.type === "idea-card").length;
    return { pages, ideaCount };
  } finally {
    db.close();
  }
}

/**
 * Reconstruct a non-mounted project's {@link BoardIdeasSnapshot} straight from its
 * persisted tldraw store (#228) — the read side of `get_board_ideas` reading a
 * project OTHER than the active one, without switching onto it. The mounted
 * project is published live off its editor (`serializeBoardIdeasSnapshot`); this
 * covers every other project so a session can read a board it discovered via
 * `get_projects`.
 *
 * Unlike the editor path (current page only), this spans ALL of the project's
 * pages — there is no "current page" for a board no one is looking at, and every
 * idea is what a cross-project read wants. Edges are rebuilt from the persisted
 * arrow shapes + their binding records (mirroring `ideaEdges`); selection/filter
 * are empty (UI state that only exists for the mounted board). Best-effort: a
 * missing DB / older schema yields `null` (the caller then publishes nothing).
 */
export async function readPersistedBoardSnapshot(projectId: string): Promise<BoardIdeasSnapshot | null> {
  if (!(await boardDbExists(projectId))) return null;
  const db = await openBoardDb(projectId);
  if (!db) return null;
  try {
    return boardSnapshotFromRecords(await readAllRecords(db));
  } finally {
    db.close();
  }
}

/**
 * Pure record → {@link BoardIdeasSnapshot} mapping (extracted from
 * {@link readPersistedBoardSnapshot} so it is unit-testable without IndexedDB).
 * Rebuilds cards (with positions), and edges from the persisted arrow shapes +
 * their `arrow` binding records — mirroring `ideaEdges`: an arrow's `start`
 * binding is the source card, its `end` binding the target, and only arrows with
 * both endpoints on idea cards become edges.
 */
export function boardSnapshotFromRecords(records: PersistedShapeRecord[], now = Date.now()): BoardIdeasSnapshot {
  const cardRecords = records.filter(
    (r) => r.typeName === "shape" && r.type === "idea-card" && typeof r.id === "string"
  );
  const cardIds = new Set(cardRecords.map((r) => r.id!));
  const refByShape = new Map<string, string | null>();
  const cards: BoardIdeaCard[] = cardRecords.map((r) => {
    const props = r.props ?? {};
    const meta = r.meta ?? {};
    const ref = typeof meta.ref === "string" ? meta.ref : null;
    refByShape.set(r.id!, ref);
    return {
      ref,
      id: r.id!,
      kind: props.kind ?? "",
      title: props.title ?? "",
      body: props.body ?? "",
      origin: props.origin ?? "user",
      createdAt: typeof meta.createdAt === "number" ? meta.createdAt : undefined,
      starred: !!meta.starred,
      done: !!meta.done,
      superseded: !!props.superseded,
      score: meta.score,
      position: { x: typeof r.x === "number" ? r.x : 0, y: typeof r.y === "number" ? r.y : 0 }
    };
  });

  // An arrow's two binding records recover its endpoints; `connect()` binds
  // `start` to the source card and `end` to the target (see edges.ts).
  const arrowEnds = new Map<string, { from?: string; to?: string }>();
  for (const r of records) {
    if (r.typeName !== "binding" || r.type !== "arrow" || typeof r.fromId !== "string" || typeof r.toId !== "string") {
      continue;
    }
    const ends = arrowEnds.get(r.fromId) ?? {};
    if (r.props?.terminal === "start") ends.from = r.toId;
    else if (r.props?.terminal === "end") ends.to = r.toId;
    arrowEnds.set(r.fromId, ends);
  }
  const arrowRelation = new Map<string, IdeaRelation>();
  for (const r of records) {
    if (r.typeName === "shape" && r.type === "arrow" && typeof r.id === "string") {
      arrowRelation.set(r.id, r.meta?.relation === "supersedes" ? "supersedes" : "about");
    }
  }
  const edges: BoardIdeaEdge[] = [];
  for (const [arrowId, ends] of arrowEnds) {
    if (!ends.from || !ends.to || !cardIds.has(ends.from) || !cardIds.has(ends.to)) continue;
    edges.push({
      from: refByShape.get(ends.from) ?? null,
      to: refByShape.get(ends.to) ?? null,
      fromId: ends.from,
      toId: ends.to,
      relation: arrowRelation.get(arrowId) ?? "about"
    });
  }

  const firstPage = records
    .filter((r) => r.typeName === "page")
    .sort((a, b) => (a.index ?? "").localeCompare(b.index ?? ""))[0];
  return {
    version: 1,
    pageId: typeof firstPage?.id === "string" ? firstPage.id : "",
    updatedAt: now,
    cards,
    edges,
    selection: { refs: [], ids: [] }
  };
}
