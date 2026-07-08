import { describe, expect, it } from "vitest";
import { boardSnapshotFromRecords, type PersistedShapeRecord } from "./search-index";

/** Persisted tldraw records mirroring what the store holds for two linked cards. */
function fixture(): PersistedShapeRecord[] {
  return [
    { typeName: "page", id: "page:main", name: "Page 1", index: "a1" },
    {
      typeName: "shape",
      type: "idea-card",
      id: "shape:a",
      x: 10,
      y: 20,
      props: { kind: "feature", title: "Edge cache", body: "serve from CDN", origin: "ai", superseded: false },
      meta: { ref: "i1", starred: true, done: false }
    },
    {
      typeName: "shape",
      type: "idea-card",
      id: "shape:b",
      x: 200,
      y: 40,
      props: { kind: "risk", title: "Token leak", body: "", origin: "user", superseded: false },
      meta: { ref: "i2" }
    },
    // A supersedes arrow from shape:a → shape:b, described by two bindings.
    { typeName: "shape", type: "arrow", id: "shape:arrow", meta: { relation: "supersedes" } },
    {
      typeName: "binding",
      type: "arrow",
      id: "binding:1",
      fromId: "shape:arrow",
      toId: "shape:a",
      props: { terminal: "start" }
    },
    {
      typeName: "binding",
      type: "arrow",
      id: "binding:2",
      fromId: "shape:arrow",
      toId: "shape:b",
      props: { terminal: "end" }
    }
  ];
}

describe("boardSnapshotFromRecords", () => {
  it("reconstructs cards (with positions) and a typed edge from the persisted records", () => {
    const snapshot = boardSnapshotFromRecords(fixture(), 1720000000000);

    expect(snapshot).toMatchObject({
      version: 1,
      pageId: "page:main",
      updatedAt: 1720000000000,
      selection: { refs: [], ids: [] }
    });
    expect(snapshot.cards).toEqual([
      {
        ref: "i1",
        id: "shape:a",
        kind: "feature",
        title: "Edge cache",
        body: "serve from CDN",
        origin: "ai",
        createdAt: undefined,
        starred: true,
        done: false,
        superseded: false,
        score: undefined,
        position: { x: 10, y: 20 }
      },
      {
        ref: "i2",
        id: "shape:b",
        kind: "risk",
        title: "Token leak",
        body: "",
        origin: "user",
        createdAt: undefined,
        starred: false,
        done: false,
        superseded: false,
        score: undefined,
        position: { x: 200, y: 40 }
      }
    ]);
    expect(snapshot.edges).toEqual([
      { from: "i1", to: "i2", fromId: "shape:a", toId: "shape:b", relation: "supersedes" }
    ]);
  });

  it("drops arrows whose endpoints aren't both idea cards, and defaults relation to about", () => {
    const records: PersistedShapeRecord[] = [
      { typeName: "shape", type: "idea-card", id: "shape:a", x: 0, y: 0, props: { title: "A" }, meta: { ref: "i1" } },
      // Arrow with only a start binding (mid-drag / dangling) → no edge.
      { typeName: "shape", type: "arrow", id: "shape:dangling" },
      { typeName: "binding", type: "arrow", fromId: "shape:dangling", toId: "shape:a", props: { terminal: "start" } }
    ];
    const snapshot = boardSnapshotFromRecords(records, 1);
    expect(snapshot.cards.map((c) => c.ref)).toEqual(["i1"]);
    expect(snapshot.edges).toEqual([]);
  });

  it("returns an empty-but-valid snapshot when there are no records", () => {
    expect(boardSnapshotFromRecords([], 5)).toEqual({
      version: 1,
      pageId: "",
      updatedAt: 5,
      cards: [],
      edges: [],
      selection: { refs: [], ids: [] }
    });
  });
});
