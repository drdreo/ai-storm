import { describe, expect, it } from "vitest";
import { deriveBoardIdeas } from "./board-reader.ts";

function page(id: string, name: string, index: string) {
  return { id, typeName: "page", name, index };
}
function card(id: string, parentId: string, ref: string, x: number, y: number) {
  return {
    id,
    typeName: "shape",
    type: "idea-card",
    parentId,
    x,
    y,
    props: { kind: "feature", title: `Title ${ref}`, body: "Body", origin: "ai", superseded: ref === "i1" },
    meta: { ref, starred: true, done: false, createdAt: 123, score: { impact: 4, effort: 2 } }
  };
}
function arrow(id: string, parentId: string, relation: string) {
  return { id, typeName: "shape", type: "arrow", parentId, meta: { relation }, props: {} };
}
function binding(id: string, fromId: string, toId: string, terminal: "start" | "end") {
  return { id, typeName: "binding", type: "arrow", fromId, toId, props: { terminal } };
}

describe("deriveBoardIdeas", () => {
  it("extracts known cards and typed edges per page while ignoring arbitrary shapes", () => {
    const records = [
      page("page:2", "Second", "b2"),
      page("page:1", "First", "a1"),
      { id: "group:1", typeName: "shape", type: "group", parentId: "page:1", props: {} },
      card("shape:a", "group:1", "i1", 100, 50),
      card("shape:b", "page:1", "i2", 0, 10),
      card("shape:c", "page:2", "i3", 5, 5),
      { id: "shape:free", typeName: "shape", type: "geo", parentId: "page:1", props: { text: "preserve me" } },
      arrow("shape:arrow1", "page:1", "supersedes"),
      binding("binding:1", "shape:arrow1", "shape:a", "start"),
      binding("binding:2", "shape:arrow1", "shape:b", "end"),
      // Cross-page and half-bound arrows are not normalized as valid idea edges.
      arrow("shape:arrow2", "page:1", "about"),
      binding("binding:3", "shape:arrow2", "shape:a", "start"),
      binding("binding:4", "shape:arrow2", "shape:c", "end")
    ];
    const document = {
      store: Object.fromEntries(records.map((record) => [record.id, record])),
      schema: { schemaVersion: 2 }
    };

    const result = deriveBoardIdeas({ revision: 9, document });
    expect(result.version).toBe(1);
    expect(result.revision).toBe(9);
    expect(result.pages.map((item) => item.pageId)).toEqual(["page:1", "page:2"]);
    expect(result.pages[0].name).toBe("First");
    expect(result.pages[0].cards.map((item) => item.ref)).toEqual(["i2", "i1"]);
    expect(result.pages[0].cards[1]).toMatchObject({
      id: "shape:a",
      title: "Title i1",
      origin: "ai",
      starred: true,
      superseded: true,
      score: { impact: 4, effort: 2 },
      position: { x: 100, y: 50 }
    });
    expect(result.pages[0].edges).toEqual([
      { from: "i1", to: "i2", fromId: "shape:a", toId: "shape:b", relation: "supersedes" }
    ]);
    expect(result.pages[1].cards.map((item) => item.ref)).toEqual(["i3"]);
  });

  it("is defensive around null, malformed, and array-based documents", () => {
    expect(deriveBoardIdeas({ revision: 0, document: null })).toEqual({ version: 1, revision: 0, pages: [] });
    expect(
      deriveBoardIdeas({
        revision: 1,
        document: {
          records: [page("page:1", "Page", "a"), { ...card("shape:x", "page:1", "i1", 0, 0), props: null }]
        }
      }).pages[0].cards[0]
    ).toMatchObject({ ref: "i1", title: "", origin: "user" });
  });
});
