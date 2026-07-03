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
  isTriageableKind,
  kindColor,
  kindLabel,
  normalizeKind
} from "./idea-descriptors";

describe("ideaToDescriptors", () => {
  it("maps a bare idea to a single decorated heading", () => {
    expect(ideaToDescriptors({ title: "Offline-first canvas", body: "" })).toEqual([
      { type: "heading", level: 3, text: "Offline-first canvas" }
    ]);
  });

  it("maps title + one-line body to heading + paragraph", () => {
    expect(ideaToDescriptors({ title: "Offline-first canvas", body: "cache CRDT ops in IndexedDB" })).toEqual([
      { type: "heading", level: 3, text: "Offline-first canvas" },
      { type: "paragraph", text: "cache CRDT ops in IndexedDB" }
    ]);
  });

  it("decorates the heading for a known kind", () => {
    expect(ideaToDescriptors({ title: "Token rotation", body: "may break sessions", kind: "risk" })[0]).toEqual({
      type: "heading",
      level: 3,
      text: "⚠ Risk: Token rotation"
    });
  });

  it("renders an unknown kind as a plain #tag", () => {
    expect(ideaToDescriptors({ title: "Spike", body: "", kind: "experiment" })[0]).toEqual({
      type: "heading",
      level: 3,
      text: "#experiment: Spike"
    });
  });

  it("routes a multi-line (fenced) body through MarkdownBlockParser into child blocks", () => {
    const descriptors = ideaToDescriptors({
      title: "Event-sourced history",
      body: "- append-only log\n- time-travel scrub",
      kind: "decision"
    });
    expect(descriptors).toEqual([
      { type: "heading", level: 3, text: "✅ Decision: Event-sourced history" },
      { type: "bulleted", text: "append-only log" },
      { type: "bulleted", text: "time-travel scrub" }
    ]);
  });
});

describe("decorateProvenance (#31, PD-009)", () => {
  it("prefixes an AI heading with the provenance badge", () => {
    expect(decorateProvenance("✨ Feature: Offline canvas", "ai")).toBe(
      `${AI_PROVENANCE_BADGE} ✨ Feature: Offline canvas`
    );
  });

  it("leaves a user heading unchanged", () => {
    expect(decorateProvenance("✨ Feature: Offline canvas", "user")).toBe("✨ Feature: Offline canvas");
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

describe("kindColor (#21)", () => {
  it("maps a known kind (case/space-insensitive) to its tldraw palette color", () => {
    expect(kindColor("risk")).toBe("red");
    expect(kindColor("  Feature ")).toBe("green");
  });

  it("returns undefined for an unknown kind", () => {
    expect(kindColor("experiment")).toBeUndefined();
  });

  it("returns undefined for a missing or blank kind", () => {
    expect(kindColor(undefined)).toBeUndefined();
    expect(kindColor("  ")).toBeUndefined();
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

  it("gives every known kind a label and a tldraw palette color-style name", () => {
    // The tldraw default palette names a card's `color` StyleProp may take.
    const TLDRAW_COLORS = new Set([
      "black",
      "grey",
      "light-violet",
      "violet",
      "blue",
      "light-blue",
      "yellow",
      "orange",
      "green",
      "light-green",
      "light-red",
      "red",
      "white"
    ]);
    for (const kind of KNOWN_KINDS) {
      const spec = KIND_REGISTRY[kind];
      expect(spec.label.length).toBeGreaterThan(0);
      expect(TLDRAW_COLORS.has(spec.color)).toBe(true);
    }
  });
});

describe("isTriageableKind (#60)", () => {
  it("rates actionable ideas (feature/decision/todo/heuristic/kindless)", () => {
    for (const k of ["feature", "decision", "todo", "heuristic", "", undefined]) {
      expect(isTriageableKind(k)).toBe(true);
    }
  });

  it("skips commentary kinds (risk/question), case/space-insensitively", () => {
    expect(isTriageableKind("risk")).toBe(false);
    expect(isTriageableKind("question")).toBe(false);
    expect(isTriageableKind("  RISK ")).toBe(false);
  });
});
