/**
 * Unit tests for `applyIdeas` (#135), the one AI write-path that renders extracted
 * {@link CreateIdeaInput}s as cards + typed edges. Runs against the shared {@link EditorFake}
 * so the real ref-minting, link resolution, grid/anchor placement, and supersede
 * ghosting are what's under test, not a mock of them.
 */
import { describe, it, expect } from "vitest";
import type { CreateIdeaInput } from "@ai-storm/shared";
import { EditorFake } from "../../../testing";
import { CARD_H, CARD_W } from "./idea-card";
import { applyIdeas as applyCanonicalIdeas } from "./ingest";

/** Unit seam mirroring canvas.store's backend reservation before ingestion. */
function applyIdeas(editor: ReturnType<EditorFake["asEditor"]>, ideas: CreateIdeaInput[]): void {
  let next =
    [
      ...editor.getCurrentPageShapes().map((shape) => (shape.type === "idea-card" ? String(shape.meta.ref ?? "") : "")),
      ...ideas.map((idea) => idea.ref ?? "")
    ].reduce((max, ref) => {
      const match = /^i(\d+)$/.exec(ref);
      return match ? Math.max(max, Number(match[1])) : max;
    }, 0) + 1;
  applyCanonicalIdeas(
    editor,
    ideas.map((idea) => (idea.ref ? idea : { ...idea, ref: `i${next++}` }))
  );
}

describe("applyIdeas", () => {
  it("is a no-op for an empty batch", () => {
    const e = new EditorFake();
    applyIdeas(e.asEditor(), []);
    expect(e.cards()).toHaveLength(0);
    expect(e.arrows()).toHaveLength(0);
  });

  it("creates an AI-origin card per idea with kind-tinted color and a minted ref", () => {
    const e = new EditorFake();
    applyIdeas(e.asEditor(), [{ title: "First", body: "b1", kind: "problem" }]);

    const cards = e.cards();
    expect(cards).toHaveLength(1);
    const card = cards[0];
    expect(card.props.title).toBe("First");
    expect(card.props.body).toBe("b1");
    expect(card.props.origin).toBe("ai");
    expect(card.props.superseded).toBe(false);
    // A kindless AI card would default to blue; a known kind sets its own tint.
    expect(card.props.color).toBeTruthy();
    // Canvas-minted ref starts at a1.
    expect(card.meta.ref).toBe("i1");
    expect(typeof card.meta.createdAt).toBe("number");
  });

  it("mints sequential i<n> refs across a batch", () => {
    const e = new EditorFake();
    applyIdeas(e.asEditor(), [
      { title: "A", body: "" },
      { title: "B", body: "" },
      { title: "C", body: "" }
    ]);
    expect(e.cards().map((c) => c.meta.ref)).toEqual(["i1", "i2", "i3"]);
  });

  it("continues the ref sequence from persisted cards across calls", () => {
    const e = new EditorFake();
    applyIdeas(e.asEditor(), [{ title: "A", body: "" }]);
    applyIdeas(e.asEditor(), [{ title: "B", body: "" }]);
    // The second call must not reuse a1 — it reads the persisted max.
    expect(e.cards().map((c) => c.meta.ref)).toEqual(["i1", "i2"]);
  });

  it("honours producer-stamped canonical ids", () => {
    const e = new EditorFake();
    applyIdeas(e.asEditor(), [
      { ref: "i7", title: "MCP card", body: "" },
      { title: "canvas card", body: "" }
    ]);
    const refs = e.cards().map((c) => c.meta.ref);
    expect(refs).toEqual(["i7", "i8"]);
  });

  it("refuses a canonical id that collides with a card already on the board", () => {
    const e = new EditorFake();
    applyIdeas(e.asEditor(), [{ ref: "i1", title: "Original", body: "" }]);
    applyIdeas(e.asEditor(), [{ ref: "i1", title: "Impostor", body: "" }]);
    expect(e.cards().map((card) => card.props.title)).toEqual(["Original"]);
  });

  it("refuses duplicate canonical ids within the same batch", () => {
    const e = new EditorFake();
    applyIdeas(e.asEditor(), [
      { ref: "i1", title: "First", body: "" },
      { ref: "i1", title: "Second", body: "" }
    ]);
    expect(e.cards().map((c) => c.meta.ref)).toEqual(["i1"]);
  });

  it("anchors a linked card beside its resolved target and draws a relation arrow", () => {
    const e = new EditorFake();
    applyIdeas(e.asEditor(), [
      { ref: "i1", title: "Target", body: "" },
      { title: "Child", body: "", links: [{ to: "i1", relation: "about" }] }
    ]);

    const child = e.cards().find((c) => c.props.title === "Child")!;
    const target = e.cards().find((c) => c.props.title === "Target")!;
    // Child is placed to the right of its target, not on the grid.
    expect(child.x).toBeGreaterThan(target.x);

    const arrows = e.arrows();
    expect(arrows).toHaveLength(1);
    expect(arrows[0].meta.relation).toBe("about");
    // Two bindings (start + end) wire the arrow to both cards.
    expect(e.getBindingsFromShape(arrows[0])).toHaveLength(2);
  });

  it("ghosts the target of a supersedes link and styles the arrow red/dashed", () => {
    const e = new EditorFake();
    applyIdeas(e.asEditor(), [
      { ref: "i1", title: "Old", body: "" },
      { title: "New", body: "", links: [{ to: "i1", relation: "supersedes" }] }
    ]);

    const old = e.cards().find((c) => c.props.title === "Old")!;
    expect(old.props.superseded).toBe(true);

    const arrow = e.arrows()[0];
    expect(arrow.props.color).toBe("red");
    expect(arrow.props.dash).toBe("dashed");
    expect(arrow.meta.relation).toBe("supersedes");
  });

  it("resolves links against cards minted earlier in the same batch", () => {
    const e = new EditorFake();
    applyIdeas(e.asEditor(), [
      { title: "Parent", body: "" }, // becomes a1
      { title: "Child", body: "", links: [{ to: "i1" }] }
    ]);
    expect(e.arrows()).toHaveLength(1);
    const child = e.cards().find((c) => c.props.title === "Child")!;
    const parent = e.cards().find((c) => c.props.title === "Parent")!;
    expect(child.x).toBeGreaterThan(parent.x);
  });

  it("drops an unresolved link and lands the card on the grid", () => {
    const e = new EditorFake();
    applyIdeas(e.asEditor(), [{ title: "Orphan", body: "", links: [{ to: "does-not-exist" }] }]);
    expect(e.arrows()).toHaveLength(0);
    expect(e.cards()).toHaveLength(1);
  });

  it("connects every resolved link of a merge, not just the first", () => {
    const e = new EditorFake();
    applyIdeas(e.asEditor(), [
      { ref: "i1", title: "A", body: "" },
      { ref: "i2", title: "B", body: "" },
      {
        title: "Merged",
        body: "",
        links: [
          { to: "i1", relation: "supersedes" },
          { to: "i2", relation: "supersedes" }
        ]
      }
    ]);
    expect(e.arrows()).toHaveLength(2);
    // Both originals are ghosted.
    expect(e.cards().filter((c) => c.props.superseded).length).toBe(2);
  });

  it("sizes created cards from their initial content", () => {
    const e = new EditorFake();
    applyIdeas(e.asEditor(), [
      {
        title: "A deliberately long title that should make the idea card wider than the default card",
        body: Array.from({ length: 10 }, (_, i) => `Detailed body line ${i + 1} with enough text to need room.`).join(
          "\n"
        )
      }
    ]);

    const card = e.cards()[0];
    expect(card.props.w).toBeGreaterThan(CARD_W);
    expect(card.props.h).toBeGreaterThan(CARD_H);
  });
});
