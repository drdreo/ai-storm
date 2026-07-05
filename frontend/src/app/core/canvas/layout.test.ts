/**
 * Unit tests for the triage write-paths in `layout.ts` (#135): the score/completion
 * sinks and the multi-select mark toggles. These are the self-contained actions
 * (no board re-flow / zoom), exercised against a minimal fake tldraw `Editor` so
 * the real ref resolution, meta-merge, and group-toggle logic run for real.
 */
import { describe, it, expect } from "vitest";
import type { Editor } from "tldraw";
import type { Score, Completion } from "@ai-storm/shared";
import { applyScore, applyCompletion, markSelected, markSelectedDone } from "./layout";

interface FakeShape {
  id: string;
  type: string;
  x: number;
  y: number;
  rotation: number;
  props: Record<string, unknown>;
  meta: Record<string, unknown>;
}

/** The narrow slice of tldraw's `Editor` these actions call. */
class FakeEditor {
  shapes = new Map<string, FakeShape>();
  private selected = new Set<string>();

  addCard(id: string, meta: Record<string, unknown> = {}, ref = id): FakeShape {
    const shape: FakeShape = {
      id,
      type: "idea-card",
      x: 0,
      y: 0,
      rotation: 0,
      props: { w: 250, h: 132, kind: "", title: id, body: "", origin: "user", superseded: false, color: "blue" },
      meta: { ref, ...meta }
    };
    this.shapes.set(id, shape);
    return shape;
  }

  select(...ids: string[]): void {
    this.selected = new Set(ids);
  }

  getCurrentPageShapes(): FakeShape[] {
    return [...this.shapes.values()];
  }

  getSelectedShapes(): FakeShape[] {
    return [...this.selected].map((id) => this.shapes.get(id)!).filter(Boolean);
  }

  getShape(id: string): FakeShape | undefined {
    return this.shapes.get(id);
  }

  updateShape(update: { id: string; meta?: Record<string, unknown>; props?: Record<string, unknown> }): void {
    const shape = this.shapes.get(update.id);
    if (!shape) return;
    if (update.meta) shape.meta = update.meta;
    if (update.props) shape.props = { ...shape.props, ...update.props };
  }

  updateShapes(updates: { id: string; meta?: Record<string, unknown> }[]): void {
    for (const u of updates) this.updateShape(u);
  }

  run(fn: () => void): void {
    fn();
  }
}

/** A fresh fake editor implementing the slice of `Editor` these actions call. */
function e(): FakeEditor {
  return new FakeEditor();
}

/** Cast the fake to `Editor` for a call into the module under test. */
const as = (ed: FakeEditor) => ed as unknown as Editor;

describe("applyScore", () => {
  it("stamps impact/effort onto the targeted card's meta", () => {
    const ed = e();
    ed.addCard("a1");
    const score: Score = { ref: "a1", impact: 4, effort: 2 };
    applyScore(as(ed), score);
    expect(ed.getShape("a1")!.meta.score).toEqual({ impact: 4, effort: 2 });
  });

  it("includes confidence only when it is a number", () => {
    const ed = e();
    ed.addCard("a1");
    applyScore(as(ed), { ref: "a1", impact: 1, effort: 1, confidence: 0.5 } as Score);
    expect(ed.getShape("a1")!.meta.score).toEqual({ impact: 1, effort: 1, confidence: 0.5 });
  });

  it("preserves other meta fields when scoring", () => {
    const ed = e();
    ed.addCard("a1", { starred: true });
    applyScore(as(ed), { ref: "a1", impact: 3, effort: 3 });
    const meta = ed.getShape("a1")!.meta;
    expect(meta.starred).toBe(true);
    expect(meta.ref).toBe("a1");
  });

  it("ignores a score for an unknown ref", () => {
    const ed = e();
    ed.addCard("a1");
    applyScore(as(ed), { ref: "nope", impact: 5, effort: 5 });
    expect(ed.getShape("a1")!.meta.score).toBeUndefined();
  });
});

describe("applyCompletion", () => {
  it("stamps done onto the targeted card", () => {
    const ed = e();
    ed.addCard("a1");
    applyCompletion(as(ed), { ref: "a1", done: true } as Completion);
    expect(ed.getShape("a1")!.meta.done).toBe(true);
  });

  it("can reopen a done card", () => {
    const ed = e();
    ed.addCard("a1", { done: true });
    applyCompletion(as(ed), { ref: "a1", done: false });
    expect(ed.getShape("a1")!.meta.done).toBe(false);
  });

  it("ignores a completion for an unknown ref", () => {
    const ed = e();
    ed.addCard("a1", { done: false });
    applyCompletion(as(ed), { ref: "ghost", done: true });
    expect(ed.getShape("a1")!.meta.done).toBe(false);
  });
});

describe("markSelected", () => {
  it("stars all selected cards when none are starred", () => {
    const ed = e();
    ed.addCard("a1");
    ed.addCard("a2");
    ed.select("a1", "a2");
    markSelected(as(ed));
    expect(ed.getShape("a1")!.meta.starred).toBe(true);
    expect(ed.getShape("a2")!.meta.starred).toBe(true);
  });

  it("clears the group when every selected card is already starred", () => {
    const ed = e();
    ed.addCard("a1", { starred: true });
    ed.addCard("a2", { starred: true });
    ed.select("a1", "a2");
    markSelected(as(ed));
    expect(ed.getShape("a1")!.meta.starred).toBe(false);
    expect(ed.getShape("a2")!.meta.starred).toBe(false);
  });

  it("stars all when the selection is mixed (not all starred)", () => {
    const ed = e();
    ed.addCard("a1", { starred: true });
    ed.addCard("a2");
    ed.select("a1", "a2");
    markSelected(as(ed));
    expect(ed.getShape("a1")!.meta.starred).toBe(true);
    expect(ed.getShape("a2")!.meta.starred).toBe(true);
  });

  it("is a no-op when nothing is selected", () => {
    const ed = e();
    ed.addCard("a1");
    markSelected(as(ed));
    expect(ed.getShape("a1")!.meta.starred).toBeUndefined();
  });

  it("ignores non-idea-card shapes in the selection", () => {
    const ed = e();
    ed.addCard("a1");
    const arrow = ed.addCard("arrow1");
    arrow.type = "arrow";
    ed.select("a1", "arrow1");
    markSelected(as(ed));
    expect(ed.getShape("a1")!.meta.starred).toBe(true);
  });
});

describe("markSelectedDone", () => {
  it("marks all selected cards done when none are done", () => {
    const ed = e();
    ed.addCard("a1");
    ed.addCard("a2");
    ed.select("a1", "a2");
    markSelectedDone(as(ed));
    expect(ed.getShape("a1")!.meta.done).toBe(true);
    expect(ed.getShape("a2")!.meta.done).toBe(true);
  });

  it("reopens the group when every selected card is already done", () => {
    const ed = e();
    ed.addCard("a1", { done: true });
    ed.addCard("a2", { done: true });
    ed.select("a1", "a2");
    markSelectedDone(as(ed));
    expect(ed.getShape("a1")!.meta.done).toBe(false);
    expect(ed.getShape("a2")!.meta.done).toBe(false);
  });

  it("is a no-op when nothing is selected", () => {
    const ed = e();
    ed.addCard("a1");
    markSelectedDone(as(ed));
    expect(ed.getShape("a1")!.meta.done).toBeUndefined();
  });
});
