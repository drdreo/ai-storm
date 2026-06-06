/**
 * Tests for the pure idea → block adapter (extraction-contract §8.2, §9).
 * No BlockSuite / DOM dependency, so it runs in the plain Node test env.
 */

import { describe, it, expect } from "vitest";
import {
  AI_PROVENANCE_BADGE,
  KIND_REGISTRY,
  KNOWN_KINDS,
  decorateProvenance,
  ideaToDescriptors,
  kindBackground,
  kindLabel,
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

describe("kindLabel (#21)", () => {
  it("returns the registry badge for a known kind (case/space-insensitive)", () => {
    expect(kindLabel("risk")).toBe("⚠ Risk");
    expect(kindLabel("  Decision ")).toBe("✅ Decision");
  });

  it("falls back to a plain #tag for an unknown kind", () => {
    expect(kindLabel("experiment")).toBe("#experiment");
  });
});

describe("KIND_REGISTRY (idea-graph §3.2 — single source of truth)", () => {
  it("has an entry for every known kind", () => {
    expect(Object.keys(KIND_REGISTRY).sort()).toEqual([...KNOWN_KINDS].sort());
  });

  it("gives every known kind a label and a valid note-background palette string", () => {
    for (const kind of KNOWN_KINDS) {
      const spec = KIND_REGISTRY[kind];
      expect(spec.label.length).toBeGreaterThan(0);
      expect(spec.background).toMatch(/^--affine-note-background-[a-z]+$/);
    }
  });
});
