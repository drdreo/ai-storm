import type { IdeaCard, IdeaEdge, IdeaPage } from "@ai-storm/shared";
import type { BoardDocument } from "./store.ts";

interface TldrawRecord {
  id?: unknown;
  typeName?: unknown;
  type?: unknown;
  parentId?: unknown;
  index?: unknown;
  x?: unknown;
  y?: unknown;
  name?: unknown;
  props?: unknown;
  meta?: unknown;
  fromId?: unknown;
  toId?: unknown;
}

export interface NormalizedBoardIdeas {
  version: 1;
  revision: number;
  pages: IdeaPage[];
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Accept current tldraw snapshots and tolerate older map/array store encodings. */
function recordsFrom(document: unknown): TldrawRecord[] {
  const root = object(document);
  if (!root) return [];
  const candidate = root.store ?? root.records ?? document;
  if (Array.isArray(candidate)) return candidate.filter((record) => object(record)) as TldrawRecord[];
  const store = object(candidate);
  return store ? (Object.values(store).filter((record) => object(record)) as TldrawRecord[]) : [];
}

function string(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function number(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function issueFrom(value: unknown): IdeaCard["issue"] {
  const issue = object(value);
  if (
    !issue ||
    (issue.provider !== "github" && issue.provider !== "linear") ||
    typeof issue.key !== "string" ||
    typeof issue.url !== "string"
  )
    return undefined;
  return {
    provider: issue.provider,
    key: issue.key,
    url: issue.url,
    ...(typeof issue.title === "string" ? { title: issue.title } : {})
  };
}

function linksFrom(value: unknown): IdeaCard["links"] {
  if (!Array.isArray(value)) return undefined;
  const links = value.flatMap((candidate) => {
    const link = object(candidate);
    if (!link || typeof link.url !== "string") return [];
    return [{ url: link.url, ...(typeof link.label === "string" ? { label: link.label } : {}) }];
  });
  return links.length ? links : undefined;
}

function scoreFrom(value: unknown): IdeaCard["score"] {
  const score = object(value);
  if (!score || typeof score.impact !== "number" || typeof score.effort !== "number") return undefined;
  return {
    impact: score.impact,
    effort: score.effort,
    confidence: typeof score.confidence === "number" ? score.confidence : undefined
  };
}

/**
 * Derive the read-only MCP projection without interpreting or modifying the
 * canonical document. Unknown records and arbitrary shapes are simply ignored.
 */
export function deriveBoardIdeas(board: Pick<BoardDocument, "revision" | "document">): NormalizedBoardIdeas {
  const records = recordsFrom(board.document);
  const byId = new Map<string, TldrawRecord>();
  for (const record of records) if (typeof record.id === "string") byId.set(record.id, record);

  const pageRecords = records
    .filter((record) => record.typeName === "page" && typeof record.id === "string")
    .sort((a, b) => string(a.index).localeCompare(string(b.index)));
  const pageIds = new Set(pageRecords.map((page) => page.id as string));

  const pageOf = (record: TldrawRecord): string | undefined => {
    let parent = typeof record.parentId === "string" ? record.parentId : undefined;
    const seen = new Set<string>();
    while (parent && !seen.has(parent)) {
      if (pageIds.has(parent)) return parent;
      seen.add(parent);
      const ancestor = byId.get(parent);
      parent = ancestor && typeof ancestor.parentId === "string" ? ancestor.parentId : undefined;
    }
    return undefined;
  };

  const cardsByPage = new Map<string, IdeaCard[]>();
  const cardPage = new Map<string, string>();
  const refs = new Map<string, string>();
  for (const record of records) {
    if (record.typeName !== "shape" || record.type !== "idea-card" || typeof record.id !== "string") continue;
    const pageId = pageOf(record);
    if (!pageId) continue;
    const props = object(record.props) ?? {};
    const meta = object(record.meta) ?? {};
    // Canonical cards are addressable. A malformed raw card without a ref stays
    // in the authoritative tldraw document but is not exposed as an IdeaCard.
    if (typeof meta.ref !== "string" || !meta.ref) continue;
    const card: IdeaCard = {
      id: record.id,
      ref: meta.ref,
      pageId,
      kind: string(props.kind),
      color: typeof props.color === "string" ? props.color : undefined,
      title: string(props.title),
      body: string(props.body),
      origin: props.origin === "ai" ? "agent" : "user",
      createdAt: typeof meta.createdAt === "number" ? meta.createdAt : undefined,
      editedByUser: meta.editedByUser === true,
      issue: issueFrom(meta.issue),
      links: linksFrom(meta.links),
      starred: meta.starred === true,
      done: meta.done === true,
      superseded: props.superseded === true,
      score: scoreFrom(meta.score),
      position: { x: number(record.x), y: number(record.y) }
    };
    const cards = cardsByPage.get(pageId) ?? [];
    cards.push(card);
    cardsByPage.set(pageId, cards);
    cardPage.set(record.id, pageId);
    refs.set(record.id, card.ref);
  }

  const bindingsByArrow = new Map<string, { start?: string; end?: string }>();
  for (const record of records) {
    if (record.typeName !== "binding" || record.type !== "arrow") continue;
    if (typeof record.fromId !== "string" || typeof record.toId !== "string") continue;
    const terminal = object(record.props)?.terminal;
    if (terminal !== "start" && terminal !== "end") continue;
    const endpoints = bindingsByArrow.get(record.fromId) ?? {};
    endpoints[terminal] = record.toId;
    bindingsByArrow.set(record.fromId, endpoints);
  }

  const edgesByPage = new Map<string, IdeaEdge[]>();
  for (const record of records) {
    if (record.typeName !== "shape" || record.type !== "arrow" || typeof record.id !== "string") continue;
    const endpoints = bindingsByArrow.get(record.id);
    if (!endpoints?.start || !endpoints.end) continue;
    const pageId = cardPage.get(endpoints.start);
    if (!pageId || cardPage.get(endpoints.end) !== pageId) continue;
    const from = refs.get(endpoints.start);
    const to = refs.get(endpoints.end);
    if (!from || !to) continue;
    const relation = object(record.meta)?.relation === "supersedes" ? "supersedes" : "about";
    const edges = edgesByPage.get(pageId) ?? [];
    edges.push({ id: record.id, pageId, from, to, relation });
    edgesByPage.set(pageId, edges);
  }

  return {
    version: 1,
    revision: board.revision,
    pages: pageRecords.map((page) => {
      const id = page.id as string;
      const cards = cardsByPage.get(id) ?? [];
      cards.sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x || a.id.localeCompare(b.id));
      return {
        id,
        name: string(object(page.props)?.name, string(page.name, "Page")),
        cards,
        edges: edgesByPage.get(id) ?? []
      };
    })
  };
}
