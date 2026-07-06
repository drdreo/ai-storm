import { describe, expect, it } from "vitest";
import { EditorFake, arrowShape, ideaCardShape } from "../../../testing";
import { serializeBoardIdeasSnapshot, serializeSelectedIdeas, serializeSelectedIdeasJson } from "./serialize";

describe("serializeSelectedIdeas", () => {
  it("returns null when the selection contains no idea cards", () => {
    const e = new EditorFake();
    e.addShape(arrowShape("arrow:1"));
    e.select("arrow:1");

    expect(serializeSelectedIdeas(e.asEditor())).toBeNull();
    expect(serializeSelectedIdeasJson(e.asEditor())).toBeNull();
  });

  it("serializes one selected card and mints a missing ref", () => {
    const e = new EditorFake();
    e.addShape(
      ideaCardShape("shape:1", {
        props: { kind: "feature", title: "Copy JSON", body: "Use normalized payload", origin: "user" },
        meta: { createdAt: 1720000000000 }
      })
    );
    e.select("shape:1");

    expect(serializeSelectedIdeas(e.asEditor())).toEqual({
      version: 1,
      cards: [
        {
          ref: "a1",
          id: "shape:1",
          kind: "feature",
          title: "Copy JSON",
          body: "Use normalized payload",
          origin: "user",
          createdAt: 1720000000000,
          starred: false,
          done: false,
          superseded: false,
          score: undefined
        }
      ],
      edges: []
    });
    expect(e.get("shape:1").meta.ref).toBe("a1");
  });

  it("serializes selected cards in reading order with marked lifecycle and score metadata", () => {
    const e = new EditorFake();
    e.addShape(
      ideaCardShape("shape:later", {
        x: 300,
        y: 100,
        props: { title: "Second", body: "B", origin: "ai", superseded: true },
        meta: { ref: "i2", done: true, score: { impact: 5, effort: 2, confidence: 4 } }
      })
    );
    e.addShape(
      ideaCardShape("shape:first", {
        x: 50,
        y: 20,
        props: { title: "First", body: "A" },
        meta: { ref: "i1", starred: true }
      })
    );
    e.select("shape:later", "shape:first");

    const payload = serializeSelectedIdeas(e.asEditor());

    expect(payload?.cards.map((card) => card.ref)).toEqual(["i1", "i2"]);
    expect(payload?.cards[0]).toMatchObject({ title: "First", starred: true, done: false, superseded: false });
    expect(payload?.cards[1]).toMatchObject({
      title: "Second",
      origin: "ai",
      starred: false,
      done: true,
      superseded: true,
      score: { impact: 5, effort: 2, confidence: 4 }
    });
  });

  it("includes relation edges whose endpoints are both selected cards", () => {
    const e = new EditorFake();
    e.addShape(ideaCardShape("shape:a", { meta: { ref: "a1" } }));
    e.addShape(ideaCardShape("shape:b", { meta: { ref: "a2" } }));
    e.addShape(ideaCardShape("shape:c", { meta: { ref: "a3" } }));
    e.addArrow(arrowShape("arrow:selected", { meta: { relation: "supersedes" } }), "shape:a", "shape:b");
    e.addArrow(arrowShape("arrow:external", { meta: { relation: "about" } }), "shape:b", "shape:c");
    e.select("shape:a", "shape:b");

    expect(serializeSelectedIdeas(e.asEditor())?.edges).toEqual([
      {
        from: "a1",
        to: "a2",
        fromId: "shape:a",
        toId: "shape:b",
        relation: "supersedes"
      }
    ]);
  });

  it("ignores non-idea shapes in a mixed selection", () => {
    const e = new EditorFake();
    e.addShape(ideaCardShape("shape:card", { meta: { ref: "a1" } }));
    e.addShape(arrowShape("arrow:1"));
    e.select("shape:card", "arrow:1");

    expect(serializeSelectedIdeas(e.asEditor())?.cards.map((card) => card.id)).toEqual(["shape:card"]);
  });

  it("returns compact JSON without raw tldraw props or clipboard data", () => {
    const e = new EditorFake();
    e.addShape(ideaCardShape("shape:card", { props: { title: "Plain data", body: "No shape blob" } }));
    e.select("shape:card");

    const json = serializeSelectedIdeasJson(e.asEditor());

    expect(json).not.toContain("props");
    expect(json).not.toContain("base64");
    expect(JSON.parse(json!)).toMatchObject({ version: 1, cards: [{ title: "Plain data" }] });
  });
});

describe("serializeBoardIdeasSnapshot", () => {
  it("serializes the active page's cards, edges, selection, filter, and positions", () => {
    const e = new EditorFake();
    e.addShape(
      ideaCardShape("shape:b", {
        x: 200,
        y: 100,
        props: { title: "Second", kind: "risk", body: "B", origin: "ai" },
        meta: { ref: "i2", done: true, score: { impact: 3, effort: 2 } }
      })
    );
    e.addShape(
      ideaCardShape("shape:a", {
        x: 20,
        y: 10,
        props: { title: "First", body: "A" },
        meta: { starred: true, createdAt: 1720000000000 }
      })
    );
    e.addArrow(arrowShape("arrow:1", { meta: { relation: "about" } }), "shape:a", "shape:b");
    e.select("shape:a");

    const payload = serializeBoardIdeasSnapshot(e.asEditor(), { kind: "risk" }, 1720000001234);

    expect(payload).toMatchObject({
      version: 1,
      pageId: "page:current",
      updatedAt: 1720000001234,
      selection: { refs: ["a1"], ids: ["shape:a"] },
      filter: { kind: "risk" }
    });
    expect(payload.cards.map((card) => card.ref)).toEqual(["a1", "i2"]);
    expect(payload.cards[0]).toMatchObject({
      title: "First",
      starred: true,
      createdAt: 1720000000000,
      position: { x: 20, y: 10 }
    });
    expect(payload.cards[1]).toMatchObject({
      title: "Second",
      kind: "risk",
      origin: "ai",
      done: true,
      score: { impact: 3, effort: 2 }
    });
    expect(payload.edges).toEqual([
      {
        from: "a1",
        to: "i2",
        fromId: "shape:a",
        toId: "shape:b",
        relation: "about"
      }
    ]);
    expect(e.get("shape:a").meta.ref).toBe("a1");
  });
});
