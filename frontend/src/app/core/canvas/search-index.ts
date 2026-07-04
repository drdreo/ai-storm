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
import type { IdeaCardMeta, Origin } from "./idea-card";
import type { SearchableIdea } from "./search";

/** tldraw's IndexedDB naming (bundled `LocalIndexedDb`, tldraw 5.x). */
const STORE_PREFIX = "TLDRAW_DOCUMENT_v2";
const PERSISTENCE_PREFIX = "ai-storm:ws:";
const RECORDS_TABLE = "records";

/** The subset of a persisted tldraw shape record we read. */
interface PersistedShapeRecord {
  id?: string;
  typeName?: string;
  type?: string;
  props?: { kind?: string; title?: string; body?: string; origin?: Origin; superseded?: boolean };
  meta?: IdeaCardMeta;
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
