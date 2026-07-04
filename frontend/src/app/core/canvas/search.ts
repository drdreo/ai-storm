/**
 * Full-text idea search (#124) — the pure model behind the Ctrl+K "Ideas" group.
 *
 * Deliberately tldraw-free (like {@link ./filter} and {@link ../idea-descriptors})
 * so it is Node-unit-testable in isolation: it takes a flat list of
 * {@link SearchableIdea}s — gathered from the live editor AND every other
 * project's persisted board (see {@link ../../stores/canvas.store}) — a query
 * string, and a structured {@link IdeaSearchFilter}, and returns ranked results.
 *
 * Keyword matching is AND-over-tokens (every whitespace-separated token must hit
 * some field) with a field-weighted score, so a title hit outranks a body hit and
 * an exact title-prefix wins outright. The structured filters (kind / provenance /
 * mark / triage / lifecycle / date) narrow the candidate set *before* scoring, so
 * they compose with the keyword query rather than fighting it.
 */
import { normalizeKind } from "../idea-descriptors";
import type { Origin } from "./idea-card";

/**
 * One idea flattened into the shape the search index reads. Sourced from either
 * the mounted editor's cards (fresh) or a non-mounted project's persisted
 * tldraw store, so a result always knows which project to open and which card
 * (`ref`) to reveal.
 */
export interface SearchableIdea {
  projectId: string;
  projectTitle: string;
  /**
   * The tldraw shape id — stable across reloads (it's the persisted record key),
   * so it's the reliable handle {@link canvas.focusIdea} navigates by, even for a
   * user card that never earned a short `ref`.
   */
  shapeId: string;
  /** Stable short ref (`a1`, `i3`, …) when the card has one — shown, not navigated by. */
  ref?: string;
  /** Raw kind (unnormalized); may be blank for a kindless idea. */
  kind: string;
  title: string;
  body: string;
  origin: Origin;
  superseded: boolean;
  starred: boolean;
  /** Carries an AI triage score (#60). */
  triaged: boolean;
  /** Epoch ms the card was created, when known (#124 stamps new cards; legacy cards lack it). */
  createdAt?: number;
}

/**
 * The structured facets a search can be narrowed by (#124 acceptance: kind / date
 * / provenance / metadata). An idea passes iff it satisfies EVERY active facet —
 * they compose (AND), exactly like {@link BoardFilter}.
 */
export interface IdeaSearchFilter {
  /** Normalized kinds to include. Empty ⇒ every kind. */
  kinds: ReadonlySet<string>;
  /** Provenance: everything, or only AI / only user ideas. */
  origin: "all" | Origin;
  /** Only marked (starred) ideas (#29). */
  markedOnly: boolean;
  /** Only AI-triaged ideas (#60). */
  triagedOnly: boolean;
  /** Include superseded ghosts (#20). Off ⇒ they drop out. */
  includeSuperseded: boolean;
  /**
   * Only ideas created at/after this epoch-ms bound. An idea with an UNKNOWN
   * `createdAt` (legacy card) is excluded while this is set — narrowing to
   * "recent" means the user wants ideas we can confirm are recent.
   */
  createdAfter?: number;
}

/** The no-op filter — every idea passes. */
export const EMPTY_IDEA_SEARCH_FILTER: IdeaSearchFilter = {
  kinds: new Set(),
  origin: "all",
  markedOnly: false,
  triagedOnly: false,
  includeSuperseded: true,
  createdAfter: undefined
};

/** A scored search hit — the idea plus its relevance score (higher is better). */
export interface IdeaSearchResult {
  idea: SearchableIdea;
  score: number;
}

/** Whether `filter` has any facet narrowing the candidate set. */
export function hasActiveIdeaFilter(filter: IdeaSearchFilter): boolean {
  return (
    filter.kinds.size > 0 ||
    filter.origin !== "all" ||
    filter.markedOnly ||
    filter.triagedOnly ||
    !filter.includeSuperseded ||
    filter.createdAfter !== undefined
  );
}

/** Whether an idea survives every active facet of `filter`. Pure. */
export function matchesIdeaFilter(idea: SearchableIdea, filter: IdeaSearchFilter): boolean {
  if (filter.kinds.size > 0) {
    const k = normalizeKind(idea.kind);
    if (!k || !filter.kinds.has(k)) return false;
  }
  if (filter.origin !== "all" && idea.origin !== filter.origin) return false;
  if (filter.markedOnly && !idea.starred) return false;
  if (filter.triagedOnly && !idea.triaged) return false;
  if (!filter.includeSuperseded && idea.superseded) return false;
  if (filter.createdAfter !== undefined) {
    if (idea.createdAt === undefined || idea.createdAt < filter.createdAfter) return false;
  }
  return true;
}

// Field weights: a title hit is worth far more than a body hit, and the kind /
// project name sit in between (a "risk" or a project-name search is meaningful
// but weaker than a title match).
const WEIGHT_TITLE = 8;
const WEIGHT_KIND = 4;
const WEIGHT_PROJECT = 3;
const WEIGHT_BODY = 2;
/** Bonus when the whole query is a prefix of the title (an exact-ish hit). */
const PREFIX_BONUS = 6;

function tokenize(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Score one idea against the pre-tokenized query. AND semantics: returns 0 unless
 * EVERY token hits at least one field. Each token contributes the weight of the
 * strongest field it matches, so more precise hits rank higher. Pure.
 */
function scoreIdea(idea: SearchableIdea, tokens: string[]): number {
  const title = idea.title.toLowerCase();
  const kind = idea.kind.toLowerCase();
  const project = idea.projectTitle.toLowerCase();
  const body = idea.body.toLowerCase();

  let score = 0;
  for (const token of tokens) {
    let best = 0;
    if (title.includes(token)) best = WEIGHT_TITLE;
    else if (kind.includes(token)) best = WEIGHT_KIND;
    else if (project.includes(token)) best = WEIGHT_PROJECT;
    else if (body.includes(token)) best = WEIGHT_BODY;
    if (best === 0) return 0; // an unmatched token disqualifies the idea
    score += best;
  }
  if (title.startsWith(tokens.join(" "))) score += PREFIX_BONUS;
  return score;
}

/**
 * Rank `ideas` for `query` under `filter` (#124). Structured facets narrow first;
 * then, if the query is non-empty, ideas are keyword-scored and only positive hits
 * survive (sorted best-first). With a blank query the filtered set is returned
 * as-is, newest-first (so the "Ideas" group can preview recent work). Ties break
 * by recency, then title, for a stable order. `limit` caps the returned results.
 */
export function searchIdeas(
  ideas: readonly SearchableIdea[],
  query: string,
  filter: IdeaSearchFilter,
  limit = 20
): IdeaSearchResult[] {
  const tokens = tokenize(query);
  const candidates = ideas.filter((idea) => matchesIdeaFilter(idea, filter));

  const scored: IdeaSearchResult[] = [];
  for (const idea of candidates) {
    if (tokens.length === 0) {
      scored.push({ idea, score: 0 });
      continue;
    }
    const score = scoreIdea(idea, tokens);
    if (score > 0) scored.push({ idea, score });
  }

  scored.sort(
    (a, b) =>
      b.score - a.score || (b.idea.createdAt ?? 0) - (a.idea.createdAt ?? 0) || a.idea.title.localeCompare(b.idea.title)
  );
  return scored.slice(0, limit);
}
