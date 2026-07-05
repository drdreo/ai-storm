/**
 * Unit tests for the triage write-paths in `layout.ts` (#135): the score/completion
 * sinks and the multi-select mark toggles. These are the self-contained actions
 * (no board re-flow / zoom), exercised against the shared {@link EditorFake} so the
 * real ref resolution, meta-merge, and group-toggle logic run for real.
 */
import { describe, it, expect } from "vitest";
import type { Score, Completion } from "@ai-storm/shared";
import { EditorFake, ideaCardShape } from "../../../testing";
import { applyScore, applyCompletion, markSelected, markSelectedDone } from "./layout";

/** Seed a card whose ref defaults to its id, with optional extra meta. */
function seedCard(e: EditorFake, id: string, meta: Record<string, unknown> = {}): void {
  e.addShape(ideaCardShape(id, { meta: { ref: id, ...meta } }));
}

describe("applyScore", () => {
  it("stamps impact/effort onto the targeted card's meta", () => {
    const e = new EditorFake();
    seedCard(e, "a1");
    const score: Score = { ref: "a1", impact: 4, effort: 2 };
    applyScore(e.asEditor(), score);
    expect(e.get("a1").meta.score).toEqual({ impact: 4, effort: 2 });
  });

  it("includes confidence only when it is a number", () => {
    const e = new EditorFake();
    seedCard(e, "a1");
    applyScore(e.asEditor(), { ref: "a1", impact: 1, effort: 1, confidence: 0.5 } as Score);
    expect(e.get("a1").meta.score).toEqual({ impact: 1, effort: 1, confidence: 0.5 });
  });

  it("preserves other meta fields when scoring", () => {
    const e = new EditorFake();
    seedCard(e, "a1", { starred: true });
    applyScore(e.asEditor(), { ref: "a1", impact: 3, effort: 3 });
    const meta = e.get("a1").meta;
    expect(meta.starred).toBe(true);
    expect(meta.ref).toBe("a1");
  });

  it("ignores a score for an unknown ref", () => {
    const e = new EditorFake();
    seedCard(e, "a1");
    applyScore(e.asEditor(), { ref: "nope", impact: 5, effort: 5 });
    expect(e.get("a1").meta.score).toBeUndefined();
  });
});

describe("applyCompletion", () => {
  it("stamps done onto the targeted card", () => {
    const e = new EditorFake();
    seedCard(e, "a1");
    applyCompletion(e.asEditor(), { ref: "a1", done: true } as Completion);
    expect(e.get("a1").meta.done).toBe(true);
  });

  it("can reopen a done card", () => {
    const e = new EditorFake();
    seedCard(e, "a1", { done: true });
    applyCompletion(e.asEditor(), { ref: "a1", done: false });
    expect(e.get("a1").meta.done).toBe(false);
  });

  it("ignores a completion for an unknown ref", () => {
    const e = new EditorFake();
    seedCard(e, "a1", { done: false });
    applyCompletion(e.asEditor(), { ref: "ghost", done: true });
    expect(e.get("a1").meta.done).toBe(false);
  });
});

describe("markSelected", () => {
  it("stars all selected cards when none are starred", () => {
    const e = new EditorFake();
    seedCard(e, "a1");
    seedCard(e, "a2");
    e.select("a1", "a2");
    markSelected(e.asEditor());
    expect(e.get("a1").meta.starred).toBe(true);
    expect(e.get("a2").meta.starred).toBe(true);
  });

  it("clears the group when every selected card is already starred", () => {
    const e = new EditorFake();
    seedCard(e, "a1", { starred: true });
    seedCard(e, "a2", { starred: true });
    e.select("a1", "a2");
    markSelected(e.asEditor());
    expect(e.get("a1").meta.starred).toBe(false);
    expect(e.get("a2").meta.starred).toBe(false);
  });

  it("stars all when the selection is mixed (not all starred)", () => {
    const e = new EditorFake();
    seedCard(e, "a1", { starred: true });
    seedCard(e, "a2");
    e.select("a1", "a2");
    markSelected(e.asEditor());
    expect(e.get("a1").meta.starred).toBe(true);
    expect(e.get("a2").meta.starred).toBe(true);
  });

  it("is a no-op when nothing is selected", () => {
    const e = new EditorFake();
    seedCard(e, "a1");
    markSelected(e.asEditor());
    expect(e.get("a1").meta.starred).toBeUndefined();
  });

  it("ignores non-idea-card shapes in the selection", () => {
    const e = new EditorFake();
    seedCard(e, "a1");
    e.addShape(ideaCardShape("arrow1", { type: "arrow" }));
    e.select("a1", "arrow1");
    markSelected(e.asEditor());
    expect(e.get("a1").meta.starred).toBe(true);
  });
});

describe("markSelectedDone", () => {
  it("marks all selected cards done when none are done", () => {
    const e = new EditorFake();
    seedCard(e, "a1");
    seedCard(e, "a2");
    e.select("a1", "a2");
    markSelectedDone(e.asEditor());
    expect(e.get("a1").meta.done).toBe(true);
    expect(e.get("a2").meta.done).toBe(true);
  });

  it("reopens the group when every selected card is already done", () => {
    const e = new EditorFake();
    seedCard(e, "a1", { done: true });
    seedCard(e, "a2", { done: true });
    e.select("a1", "a2");
    markSelectedDone(e.asEditor());
    expect(e.get("a1").meta.done).toBe(false);
    expect(e.get("a2").meta.done).toBe(false);
  });

  it("is a no-op when nothing is selected", () => {
    const e = new EditorFake();
    seedCard(e, "a1");
    markSelectedDone(e.asEditor());
    expect(e.get("a1").meta.done).toBeUndefined();
  });
});
