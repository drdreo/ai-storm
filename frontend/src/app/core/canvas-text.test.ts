/**
 * Tests for the pure idea-card → markdown serializer (replaces the BlockSuite
 * block-walk `serializeToText`/`getSelectedText` produced). No tldraw/DOM
 * dependency, so it runs in the plain Node test env.
 */

import { describe, it, expect } from "vitest";
import { cardToText, serializeCards } from "./canvas-text";

describe("cardToText", () => {
  it("emits a decorated heading + body for a kinded card", () => {
    expect(cardToText({ kind: "risk", title: "Token leak", body: "races the reattach" })).toBe(
      "### ⚠ Risk: Token leak\n\nraces the reattach",
    );
  });

  it("emits a bare heading when the body is empty or whitespace", () => {
    expect(cardToText({ kind: "feature", title: "Offline canvas", body: "" })).toBe(
      "### ✨ Feature: Offline canvas",
    );
    expect(cardToText({ kind: "", title: "Plain note", body: "   " })).toBe("### Plain note");
  });

  it("renders an unknown kind as a #tag and a kindless card as a bare title", () => {
    expect(cardToText({ kind: "experiment", title: "Spike", body: "" })).toBe(
      "### #experiment: Spike",
    );
    expect(cardToText({ kind: "", title: "My own note", body: "see if Yjs helps" })).toBe(
      "### My own note\n\nsee if Yjs helps",
    );
  });
});

describe("serializeCards", () => {
  it("joins cards into one markdown document separated by blank lines", () => {
    expect(
      serializeCards([
        { kind: "feature", title: "Offline-first canvas", body: "cache CRDT ops" },
        { kind: "risk", title: "Token leak", body: "" },
      ]),
    ).toBe("### ✨ Feature: Offline-first canvas\n\ncache CRDT ops\n\n### ⚠ Risk: Token leak");
  });

  it("returns an empty string for no cards", () => {
    expect(serializeCards([])).toBe("");
  });
});
