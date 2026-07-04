/**
 * Integration test for focus mode (#131): exercises the real `focusedCardIds` +
 * `applyFilter` against a minimal fake tldraw `Editor` (just the handful of
 * methods those modules call) rather than mocking the modules themselves — so
 * the actual cluster-selection and opacity/lock logic is what's under test.
 * Scenario mirrors the real board: focus a card, only its connected cluster
 * stays visible; exit focus, everything comes back.
 */

import { describe, it, expect } from "vitest";
import type { Editor, TLShapeId } from "tldraw";
import { focusedCardIds } from "./focus";
import { applyFilter, EMPTY_FILTER } from "./filter";

interface FakeShape {
  id: string;
  type: string;
  x: number;
  y: number;
  props: Record<string, unknown>;
  meta: Record<string, unknown>;
  opacity: number;
  isLocked: boolean;
}

/** A card factory matching the `idea-card` shape's default props. */
function ideaCard(id: string): FakeShape {
  return {
    id,
    type: "idea-card",
    x: 0,
    y: 0,
    props: { w: 250, h: 132, kind: "", title: id, body: "", origin: "user", superseded: false, color: "blue" },
    meta: {},
    opacity: 1,
    isLocked: false
  };
}

/** A bare arrow shape — bindings to its idea-card endpoints are added via `addArrow`. */
function arrow(id: string): FakeShape {
  return {
    id,
    type: "arrow",
    x: 0,
    y: 0,
    props: {},
    meta: {},
    opacity: 1,
    isLocked: false
  };
}

/** The narrow slice of tldraw's `Editor` that `focus.ts`/`filter.ts` actually call. */
class FakeEditor {
  private shapes = new Map<string, FakeShape>();
  private arrowBindings = new Map<string, { toId: string; props: { terminal: "start" | "end" } }[]>();

  addCard(shape: FakeShape) {
    this.shapes.set(shape.id, shape);
  }

  /** Bind an arrow's start/end terminals to two card ids, as `connect()` does. */
  addArrow(shape: FakeShape, fromCardId: string, toCardId: string) {
    this.shapes.set(shape.id, shape);
    this.arrowBindings.set(shape.id, [
      { toId: fromCardId, props: { terminal: "start" } },
      { toId: toCardId, props: { terminal: "end" } }
    ]);
  }

  getCurrentPageShapes() {
    return [...this.shapes.values()];
  }

  getBindingsFromShape(shape: FakeShape) {
    return this.arrowBindings.get(shape.id) ?? [];
  }

  updateShapes(updates: Partial<FakeShape>[]) {
    for (const u of updates) {
      const shape = this.shapes.get(u.id as string);
      if (shape) Object.assign(shape, u);
    }
  }

  run(fn: () => void) {
    fn();
  }

  get(id: string) {
    return this.shapes.get(id)!;
  }
}

function id(s: string): TLShapeId {
  return s as TLShapeId;
}

describe("focus mode (#131)", () => {
  it("shows only the focused card's cluster, then restores everything on exit", () => {
    const editor = new FakeEditor();
    editor.addCard(ideaCard("idea"));
    editor.addCard(ideaCard("r1"));
    editor.addCard(ideaCard("loose"));
    editor.addArrow(arrow("arrow1"), "r1", "idea");

    const asEditor = editor as unknown as Editor;

    // Focus on "idea": its connected cluster (idea + r1) should be the only
    // thing kept, "loose" (no edges) falls outside it.
    const focusIds = focusedCardIds(asEditor, new Set([id("idea")]));
    expect(focusIds).toEqual(new Set([id("idea"), id("r1")]));

    applyFilter(asEditor, EMPTY_FILTER, focusIds);

    expect(editor.get("idea")).toMatchObject({ opacity: 1, isLocked: false });
    expect(editor.get("r1")).toMatchObject({ opacity: 1, isLocked: false });
    expect(editor.get("loose")).toMatchObject({ opacity: 0, isLocked: true });
    // The arrow binds two visible cards, so it stays visible too.
    expect(editor.get("arrow1")).toMatchObject({ opacity: 1, isLocked: false });

    // Exit focus mode: applying the filter with no focus set restores everything.
    applyFilter(asEditor, EMPTY_FILTER, null);

    expect(editor.get("idea")).toMatchObject({ opacity: 1, isLocked: false });
    expect(editor.get("r1")).toMatchObject({ opacity: 1, isLocked: false });
    expect(editor.get("loose")).toMatchObject({ opacity: 1, isLocked: false });
    expect(editor.get("arrow1")).toMatchObject({ opacity: 1, isLocked: false });
  });

  it("dims an arrow that touches a card hidden by the facet filter (not just focus)", () => {
    const editor = new FakeEditor();
    const risky = ideaCard("risky");
    risky.props.kind = "risk";
    editor.addCard(ideaCard("idea"));
    editor.addCard(risky);
    editor.addArrow(arrow("arrow1"), "idea", "risky");

    const asEditor = editor as unknown as Editor;
    applyFilter(asEditor, { ...EMPTY_FILTER, hiddenKinds: new Set(["risk"]) }, null);

    expect(editor.get("idea")).toMatchObject({ opacity: 1, isLocked: false });
    expect(editor.get("risky")).toMatchObject({ opacity: 0, isLocked: true });
    expect(editor.get("arrow1")).toMatchObject({ opacity: 0, isLocked: true });
  });

  it("returns null (show everything) for an empty selection", () => {
    const editor = new FakeEditor();
    editor.addCard(ideaCard("idea"));
    const asEditor = editor as unknown as Editor;

    expect(focusedCardIds(asEditor, new Set())).toBeNull();
  });
});
