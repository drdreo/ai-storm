/**
 * Tests for the pure idea → block adapter (extraction-contract §8.2, §9).
 * No BlockSuite / DOM dependency, so it runs in the plain Node test env.
 */

import { describe, it, expect } from "vitest";
import {
  AI_PROVENANCE_BADGE,
  KIND_BACKGROUND,
  KIND_LABEL,
  decorateProvenance,
  ideaToDescriptors,
  kindBackground,
  normalizeKind,
} from "./idea-descriptors";

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

describe("decorateProvenance (#31, PD-009)", () => {
  it("prefixes an AI heading with the provenance badge", () => {
    expect(decorateProvenance("✨ Feature: Offline canvas", "ai")).toBe(
      `${AI_PROVENANCE_BADGE} ✨ Feature: Offline canvas`,
    );
  });

  it("leaves a user heading unchanged", () => {
    expect(decorateProvenance("✨ Feature: Offline canvas", "user")).toBe(
      "✨ Feature: Offline canvas",
    );
  });

  it("is idempotent — never double-prefixes an already-badged heading", () => {
    const once = decorateProvenance("Token rotation", "ai");
    expect(decorateProvenance(once, "ai")).toBe(once);
  });
});

describe("normalizeKind (#21)", () => {
  it("trims and lowercases a kind", () => {
    expect(normalizeKind("  Risk  ")).toBe("risk");
    expect(normalizeKind("FEATURE")).toBe("feature");
  });

  it("returns undefined for missing, empty, or whitespace-only input", () => {
    expect(normalizeKind(undefined)).toBeUndefined();
    expect(normalizeKind("")).toBeUndefined();
    expect(normalizeKind("   ")).toBeUndefined();
  });
});

describe("kindBackground (#21)", () => {
  it("maps a known kind (case/space-insensitive) to its palette value", () => {
    expect(kindBackground("risk")).toBe("--affine-note-background-red");
    expect(kindBackground("  Feature ")).toBe("--affine-note-background-green");
  });

  it("returns undefined for an unknown kind", () => {
    expect(kindBackground("experiment")).toBeUndefined();
  });

  it("returns undefined for a missing or blank kind", () => {
    expect(kindBackground(undefined)).toBeUndefined();
    expect(kindBackground("  ")).toBeUndefined();
  });
});

describe("KIND_LABEL ↔ KIND_BACKGROUND key parity (#21)", () => {
  it("defines the same set of known kinds in both maps", () => {
    expect(Object.keys(KIND_BACKGROUND).sort()).toEqual(Object.keys(KIND_LABEL).sort());
  });

  it("maps every known kind to a valid note-background palette string", () => {
    for (const value of Object.values(KIND_BACKGROUND)) {
      expect(value).toMatch(/^--affine-note-background-[a-z]+$/);
    }
  });
});
