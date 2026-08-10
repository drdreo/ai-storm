import { describe, expect, it } from "vitest";
import { EditorFake, arrowShape, ideaCardShape } from "../../../testing";
import {
  collectHandoffScope,
  serializeForHandoff,
  serializeSelectedIdeas,
  serializeSelectedIdeasJson
} from "./serialize";

describe("collectHandoffScope (#225)", () => {
  it("hands off only the selected idea cards", () => {
    const e = new EditorFake();
    e.addShape(ideaCardShape("shape:first", { x: 0, props: { title: "First" } }));
    e.addShape(ideaCardShape("shape:second", { x: 100, props: { title: "Second" } }));
    e.addShape(ideaCardShape("shape:third", { x: 200, props: { title: "Third" } }));
    e.select("shape:first", "shape:third");

    const scope = collectHandoffScope(e.asEditor());

    expect(scope.source).toBe("selection");
    expect(scope.cardCount).toBe(2);
    expect(scope.text).toContain("First");
    expect(scope.text).toContain("Third");
    expect(scope.text).not.toContain("Second");
    expect(serializeForHandoff(e.asEditor())).toBe(scope.text);
  });

  it("falls back to the whole board and excludes superseded cards", () => {
    const e = new EditorFake();
    e.addShape(ideaCardShape("shape:active", { props: { title: "Active" } }));
    e.addShape(ideaCardShape("shape:ghost", { props: { title: "Superseded", superseded: true } }));

    const scope = collectHandoffScope(e.asEditor());

    expect(scope).toMatchObject({ source: "board", cardCount: 1 });
    expect(scope.text).toContain("Active");
    expect(scope.text).not.toContain("Superseded");
  });

  it("includes a superseded card when the user explicitly selects it", () => {
    const e = new EditorFake();
    e.addShape(ideaCardShape("shape:ghost", { props: { title: "Wanted ghost", superseded: true } }));
    e.addShape(ideaCardShape("shape:other", { props: { title: "Other" } }));
    e.select("shape:ghost");

    const scope = collectHandoffScope(e.asEditor());

    expect(scope).toMatchObject({ source: "selection", cardCount: 1 });
    expect(scope.text).toContain("Wanted ghost");
    expect(scope.text).not.toContain("Other");
  });

  it("ignores non-card shapes in a mixed selection", () => {
    const e = new EditorFake();
    e.addShape(ideaCardShape("shape:card", { props: { title: "Selected card" } }));
    e.addShape(ideaCardShape("shape:other", { props: { title: "Other card" } }));
    e.addShape(arrowShape("arrow:1"));
    e.select("shape:card", "arrow:1");

    const scope = collectHandoffScope(e.asEditor());

    expect(scope).toMatchObject({ source: "selection", cardCount: 1 });
    expect(scope.text).toContain("Selected card");
    expect(scope.text).not.toContain("Other card");
  });
});

describe("serializeSelectedIdeas", () => {
  it("returns null when the selection contains no idea cards", () => {
    const e = new EditorFake();
    e.addShape(arrowShape("arrow:1"));
    e.select("arrow:1");

    expect(serializeSelectedIdeas(e.asEditor())).toBeNull();
    expect(serializeSelectedIdeasJson(e.asEditor())).toBeNull();
  });

  it("omits a malformed legacy card without a canonical ref", () => {
    const e = new EditorFake();
    e.addShape(
      ideaCardShape("shape:1", {
        props: { kind: "feature", title: "Copy JSON", body: "Use normalized payload", origin: "user" },
        meta: { createdAt: 1720000000000 }
      })
    );
    e.select("shape:1");

    expect(serializeSelectedIdeas(e.asEditor())).toEqual({ version: 2, cards: [], edges: [] });
    expect(e.get("shape:1").meta.ref).toBeUndefined();
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
      origin: "agent",
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
        id: "arrow:selected",
        pageId: "page:current",
        from: "a1",
        to: "a2",
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
    e.addShape(
      ideaCardShape("shape:card", { props: { title: "Plain data", body: "No shape blob" }, meta: { ref: "i1" } })
    );
    e.select("shape:card");

    const json = serializeSelectedIdeasJson(e.asEditor());

    expect(json).not.toContain("props");
    expect(json).not.toContain("base64");
    expect(JSON.parse(json!)).toMatchObject({ version: 2, cards: [{ title: "Plain data" }] });
  });
});
