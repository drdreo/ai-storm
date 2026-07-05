/**
 * Integration test for focus mode (#131): exercises the real `focusedCardIds` +
 * `applyFilter` against the shared {@link EditorFake} (the in-memory tldraw stand-in)
 * rather than mocking the modules themselves — so the actual cluster-selection and
 * opacity/lock logic is what's under test. Scenario mirrors the real board: focus a
 * card, only its connected cluster stays visible; exit focus, everything comes back.
 */

import { describe, it, expect } from "vitest";
import type { TLShapeId } from "tldraw";
import { EditorFake, ideaCardShape, arrowShape } from "../../../testing";
import { focusedCardIds } from "./focus";
import { applyFilter, EMPTY_FILTER } from "./filter";

function id(s: string): TLShapeId {
  return s as TLShapeId;
}

describe("focus mode (#131)", () => {
  it("shows only the focused card's cluster, then restores everything on exit", () => {
    const editor = new EditorFake();
    editor.addShape(ideaCardShape("idea"));
    editor.addShape(ideaCardShape("r1"));
    editor.addShape(ideaCardShape("loose"));
    editor.addArrow(arrowShape("arrow1"), "r1", "idea");

    const asEditor = editor.asEditor();

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
    const editor = new EditorFake();
    editor.addShape(ideaCardShape("idea"));
    editor.addShape(ideaCardShape("risky", { props: { kind: "risk" } }));
    editor.addArrow(arrowShape("arrow1"), "idea", "risky");

    const asEditor = editor.asEditor();
    applyFilter(asEditor, { ...EMPTY_FILTER, hiddenKinds: new Set(["risk"]) }, null);

    expect(editor.get("idea")).toMatchObject({ opacity: 1, isLocked: false });
    expect(editor.get("risky")).toMatchObject({ opacity: 0, isLocked: true });
    expect(editor.get("arrow1")).toMatchObject({ opacity: 0, isLocked: true });
  });

  it("returns null (show everything) for an empty selection", () => {
    const editor = new EditorFake();
    editor.addShape(ideaCardShape("idea"));
    const asEditor = editor.asEditor();

    expect(focusedCardIds(asEditor, new Set())).toBeNull();
  });
});
