/**
 * Tests for the pure project export/import bundle (#105) — no tldraw Editor
 * involved, so it runs in the plain Node test env.
 */
import { describe, it, expect } from "vitest";
import type { ProjectMeta } from "@ai-storm/shared";
import { buildExportBundle, exportFileSlug, parseExportBundle } from "./project-portable";
import { defaultTerminalConfig } from "./models";

const meta: ProjectMeta = {
  id: "ws_1",
  title: "My Project",
  status: "idle",
  createdAt: 0,
  lastActiveAt: 0,
  terminal: defaultTerminalConfig(),
  color: "#f43f5e"
};

describe("buildExportBundle / parseExportBundle roundtrip", () => {
  it("parses a freshly-built bundle back out unchanged", () => {
    const board = {
      cards: [
        {
          ref: "a1",
          kind: "feature",
          title: "Offline-first canvas",
          body: "",
          origin: "user" as const,
          superseded: false,
          starred: true
        }
      ],
      edges: [{ from: "a1", to: "a1", relation: "about" as const }]
    };
    const bundle = buildExportBundle(meta, board);
    const parsed = parseExportBundle(JSON.stringify(bundle));
    expect(parsed).toEqual(bundle);
    expect(parsed.project.title).toBe("My Project");
    expect(parsed.project.color).toBe("#f43f5e");
  });
});

describe("parseExportBundle validation", () => {
  it("rejects non-JSON", () => {
    expect(() => parseExportBundle("not json")).toThrow(/not valid JSON/i);
  });

  it("rejects a JSON value that is not an object", () => {
    expect(() => parseExportBundle("42")).toThrow(/not a recognizable/i);
  });

  it("rejects an unsupported version", () => {
    const bundle = buildExportBundle(meta, { cards: [], edges: [] });
    const bad = { ...bundle, version: 2 };
    expect(() => parseExportBundle(JSON.stringify(bad))).toThrow(/unsupported project file version/i);
  });

  it("rejects a bundle missing project metadata", () => {
    expect(() => parseExportBundle(JSON.stringify({ version: 1, board: { cards: [], edges: [] } }))).toThrow(
      /not a recognizable/i
    );
  });

  it("rejects a bundle with a malformed board", () => {
    const bad = { version: 1, project: { title: "x", terminal: {} }, board: { cards: "nope" } };
    expect(() => parseExportBundle(JSON.stringify(bad))).toThrow(/not a recognizable/i);
  });
});

describe("exportFileSlug", () => {
  it("slugifies a title", () => {
    expect(exportFileSlug("  My Cool Project!! ")).toBe("my-cool-project");
  });

  it('falls back to "project" for an empty/symbol-only title', () => {
    expect(exportFileSlug("   ")).toBe("project");
    expect(exportFileSlug("!!!")).toBe("project");
  });
});
