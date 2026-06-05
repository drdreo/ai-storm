/**
 * Tests for the pure idea → block adapter (extraction-contract §8.2, §9).
 * No BlockSuite / DOM dependency, so it runs in the plain Node test env.
 */

import { describe, it, expect } from "vitest";
import { ideaToDescriptors } from "./idea-descriptors";

describe("ideaToDescriptors", () => {
  it("maps a bare idea to a single decorated heading", () => {
    expect(ideaToDescriptors({ title: "Offline-first canvas", body: "" })).toEqual([
      { type: "heading", level: 3, text: "Offline-first canvas" },
    ]);
  });

  it("maps title + one-line body to heading + paragraph", () => {
    expect(
      ideaToDescriptors({ title: "Offline-first canvas", body: "cache CRDT ops in IndexedDB" }),
    ).toEqual([
      { type: "heading", level: 3, text: "Offline-first canvas" },
      { type: "paragraph", text: "cache CRDT ops in IndexedDB" },
    ]);
  });

  it("decorates the heading for a known kind", () => {
    expect(ideaToDescriptors({ title: "Token rotation", body: "may break sessions", kind: "risk" })[0]).toEqual(
      { type: "heading", level: 3, text: "⚠ Risk: Token rotation" },
    );
  });

  it("renders an unknown kind as a plain #tag", () => {
    expect(ideaToDescriptors({ title: "Spike", body: "", kind: "experiment" })[0]).toEqual({
      type: "heading",
      level: 3,
      text: "#experiment: Spike",
    });
  });

  it("routes a multi-line (fenced) body through MarkdownBlockParser into child blocks", () => {
    const descriptors = ideaToDescriptors({
      title: "Event-sourced history",
      body: "- append-only log\n- time-travel scrub",
      kind: "decision",
    });
    expect(descriptors).toEqual([
      { type: "heading", level: 3, text: "✅ Decision: Event-sourced history" },
      { type: "bulleted", text: "append-only log" },
      { type: "bulleted", text: "time-travel scrub" },
    ]);
  });
});
