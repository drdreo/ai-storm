/**
 * Full-text idea search (#124): keyword ranking + the structured facet filters.
 * Pure module, so this exercises the whole behaviour with no editor/DOM.
 */
import { describe, it, expect } from "vitest";
import {
  searchIdeas,
  matchesIdeaFilter,
  hasActiveIdeaFilter,
  EMPTY_IDEA_SEARCH_FILTER,
  type SearchableIdea,
  type IdeaSearchFilter
} from "./search";

function idea(over: Partial<SearchableIdea>): SearchableIdea {
  return {
    projectId: "ws1",
    projectTitle: "Project",
    shapeId: "shape:1",
    ref: "a1",
    kind: "",
    title: "Untitled",
    body: "",
    origin: "user",
    superseded: false,
    starred: false,
    triaged: false,
    createdAt: undefined,
    ...over
  };
}

function filter(over: Partial<IdeaSearchFilter> = {}): IdeaSearchFilter {
  return { ...EMPTY_IDEA_SEARCH_FILTER, kinds: new Set(over.kinds ?? []), ...over };
}

describe("searchIdeas keyword ranking", () => {
  const ideas = [
    idea({ ref: "a1", title: "Offline sync", body: "queue writes while disconnected" }),
    idea({ ref: "a2", title: "Search bar", body: "add offline search across the canvas" }),
    idea({ ref: "a3", title: "Dark mode", body: "theme toggle" })
  ];

  it("returns only ideas matching every token (AND semantics)", () => {
    const results = searchIdeas(ideas, "offline sync", filter());
    expect(results.map((r) => r.idea.ref)).toEqual(["a1"]);
  });

  it("ranks a title hit above a body hit for the same token", () => {
    const results = searchIdeas(ideas, "offline", filter());
    // a1 matches in the title; a2 only in the body → a1 first.
    expect(results.map((r) => r.idea.ref)).toEqual(["a1", "a2"]);
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it("is case-insensitive", () => {
    expect(searchIdeas(ideas, "DARK", filter()).map((r) => r.idea.ref)).toEqual(["a3"]);
  });

  it("matches on kind and project name", () => {
    const tagged = [idea({ ref: "a4", kind: "risk", title: "Data loss", projectTitle: "Payments" })];
    expect(searchIdeas(tagged, "risk", filter())).toHaveLength(1);
    expect(searchIdeas(tagged, "payments", filter())).toHaveLength(1);
  });

  it("returns nothing when a token matches no field", () => {
    expect(searchIdeas(ideas, "offline zzz", filter())).toEqual([]);
  });

  it("honours the result limit", () => {
    const many = Array.from({ length: 30 }, (_, i) => idea({ ref: `a${i}`, title: `sync ${i}` }));
    expect(searchIdeas(many, "sync", filter(), 5)).toHaveLength(5);
  });
});

describe("blank query", () => {
  it("returns the filtered set newest-first", () => {
    const ideas = [
      idea({ ref: "old", createdAt: 100 }),
      idea({ ref: "new", createdAt: 300 }),
      idea({ ref: "mid", createdAt: 200 })
    ];
    expect(searchIdeas(ideas, "", filter()).map((r) => r.idea.ref)).toEqual(["new", "mid", "old"]);
  });
});

describe("matchesIdeaFilter facets", () => {
  it("filters by kind (normalized)", () => {
    const f = filter({ kinds: new Set(["risk"]) });
    expect(matchesIdeaFilter(idea({ kind: "Risk" }), f)).toBe(true);
    expect(matchesIdeaFilter(idea({ kind: "feature" }), f)).toBe(false);
    expect(matchesIdeaFilter(idea({ kind: "" }), f)).toBe(false);
  });

  it("filters by provenance", () => {
    expect(matchesIdeaFilter(idea({ origin: "ai" }), filter({ origin: "ai" }))).toBe(true);
    expect(matchesIdeaFilter(idea({ origin: "user" }), filter({ origin: "ai" }))).toBe(false);
  });

  it("filters by marked and triaged metadata", () => {
    expect(matchesIdeaFilter(idea({ starred: false }), filter({ markedOnly: true }))).toBe(false);
    expect(matchesIdeaFilter(idea({ triaged: true }), filter({ triagedOnly: true }))).toBe(true);
  });

  it("drops superseded ghosts when excluded", () => {
    expect(matchesIdeaFilter(idea({ superseded: true }), filter({ includeSuperseded: false }))).toBe(false);
    expect(matchesIdeaFilter(idea({ superseded: true }), filter({ includeSuperseded: true }))).toBe(true);
  });

  it("filters by creation date, excluding unknown-date ideas", () => {
    const f = filter({ createdAfter: 500 });
    expect(matchesIdeaFilter(idea({ createdAt: 800 }), f)).toBe(true);
    expect(matchesIdeaFilter(idea({ createdAt: 200 }), f)).toBe(false);
    expect(matchesIdeaFilter(idea({ createdAt: undefined }), f)).toBe(false);
  });
});

describe("hasActiveIdeaFilter", () => {
  it("is false for the empty filter and true once any facet is set", () => {
    expect(hasActiveIdeaFilter(filter())).toBe(false);
    expect(hasActiveIdeaFilter(filter({ origin: "ai" }))).toBe(true);
    expect(hasActiveIdeaFilter(filter({ kinds: new Set(["risk"]) }))).toBe(true);
    expect(hasActiveIdeaFilter(filter({ includeSuperseded: false }))).toBe(true);
    expect(hasActiveIdeaFilter(filter({ createdAfter: 1 }))).toBe(true);
  });
});
