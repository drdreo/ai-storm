/**
 * Unit tests for `applyIdeas` (#135), the one AI write-path that renders extracted
 * {@link Idea}s as cards + typed edges. Runs against a minimal fake tldraw
 * `Editor` implementing only what `ingest.ts` (and its `idea-card` helpers) call —
 * so the real ref-minting, link resolution, grid/anchor placement, and supersede
 * ghosting are what's under test, not a mock of them.
 */
import { describe, it, expect } from "vitest";
import type { Editor } from "tldraw";
import type { Idea } from "@ai-storm/shared";
import { applyIdeas } from "./ingest";

interface FakeShape {
  id: string;
  type: string;
  x: number;
  y: number;
  props: Record<string, unknown>;
  meta: Record<string, unknown>;
}

interface FakeBinding {
  type: string;
  fromId: string;
  toId: string;
  props: { terminal: "start" | "end"; [k: string]: unknown };
}

/** The narrow slice of tldraw's `Editor` that `applyIdeas` actually calls. */
class FakeEditor {
  shapes = new Map<string, FakeShape>();
  bindings: FakeBinding[] = [];

  getCurrentPageShapes(): FakeShape[] {
    return [...this.shapes.values()];
  }

  getShape(id: string): FakeShape | undefined {
    return this.shapes.get(id);
  }

  createShape(shape: Partial<FakeShape> & { id: string; type: string }): void {
    this.shapes.set(shape.id, {
      x: 0,
      y: 0,
      props: {},
      meta: {},
      ...shape
    } as FakeShape);
  }

  createBinding(binding: FakeBinding): void {
    this.bindings.push(binding);
  }

  updateShape(update: { id: string; props?: Record<string, unknown>; meta?: Record<string, unknown> }): void {
    const shape = this.shapes.get(update.id);
    if (!shape) return;
    if (update.props) shape.props = { ...shape.props, ...update.props };
    if (update.meta) shape.meta = { ...shape.meta, ...update.meta };
  }

  run(fn: () => void): void {
    fn();
  }

  /** Every idea-card currently on the board. */
  cards(): FakeShape[] {
    return this.getCurrentPageShapes().filter((s) => s.type === "idea-card");
  }

  /** The arrow shapes (typed edges) created by `connect`. */
  arrows(): FakeShape[] {
    return this.getCurrentPageShapes().filter((s) => s.type === "arrow");
  }
}

function editor(): FakeEditor {
  return new FakeEditor();
}

/** Drive the real `applyIdeas` against the fake, which implements its used surface. */
const apply = (e: FakeEditor, ideas: Idea[]) => applyIdeas(e as unknown as Editor, ideas);

describe("applyIdeas", () => {
  it("is a no-op for an empty batch", () => {
    const e = editor();
    apply(e, []);
    expect(e.cards()).toHaveLength(0);
    expect(e.arrows()).toHaveLength(0);
  });

  it("creates an AI-origin card per idea with kind-tinted color and a minted ref", () => {
    const e = editor();
    apply(e, [{ title: "First", body: "b1", kind: "problem" }]);

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
    expect(card.meta.ref).toBe("a1");
    expect(typeof card.meta.createdAt).toBe("number");
  });

  it("mints sequential a<n> refs across a batch", () => {
    const e = editor();
    apply(e, [
      { title: "A", body: "" },
      { title: "B", body: "" },
      { title: "C", body: "" }
    ]);
    expect(e.cards().map((c) => c.meta.ref)).toEqual(["a1", "a2", "a3"]);
  });

  it("continues the ref sequence from persisted cards across calls", () => {
    const e = editor();
    apply(e, [{ title: "A", body: "" }]);
    apply(e, [{ title: "B", body: "" }]);
    // The second call must not reuse a1 — it reads the persisted max.
    expect(e.cards().map((c) => c.meta.ref)).toEqual(["a1", "a2"]);
  });

  it("honours a producer-stamped id (MCP i<n>) without perturbing the a<n> mint", () => {
    const e = editor();
    apply(e, [
      { id: "i7", title: "MCP card", body: "" },
      { title: "canvas card", body: "" }
    ]);
    const refs = e.cards().map((c) => c.meta.ref);
    // The stamped ref is kept as-is; the disjoint a-mint still starts at a1.
    expect(refs).toEqual(["i7", "a1"]);
  });

  it("anchors a linked card beside its resolved target and draws a relation arrow", () => {
    const e = editor();
    apply(e, [
      { id: "i1", title: "Target", body: "" },
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
    expect(e.bindings.filter((b) => b.fromId === arrows[0].id)).toHaveLength(2);
  });

  it("ghosts the target of a supersedes link and styles the arrow red/dashed", () => {
    const e = editor();
    apply(e, [
      { id: "i1", title: "Old", body: "" },
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
    const e = editor();
    apply(e, [
      { title: "Parent", body: "" }, // becomes a1
      { title: "Child", body: "", links: [{ to: "a1" }] }
    ]);
    expect(e.arrows()).toHaveLength(1);
    const child = e.cards().find((c) => c.props.title === "Child")!;
    const parent = e.cards().find((c) => c.props.title === "Parent")!;
    expect(child.x).toBeGreaterThan(parent.x);
  });

  it("drops an unresolved link and lands the card on the grid", () => {
    const e = editor();
    apply(e, [{ title: "Orphan", body: "", links: [{ to: "does-not-exist" }] }]);
    expect(e.arrows()).toHaveLength(0);
    expect(e.cards()).toHaveLength(1);
  });

  it("connects every resolved link of a merge, not just the first", () => {
    const e = editor();
    apply(e, [
      { id: "i1", title: "A", body: "" },
      { id: "i2", title: "B", body: "" },
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
});
