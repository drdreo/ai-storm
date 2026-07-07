/**
 * Tests for the pure project export/import bundle (#105) — no tldraw Editor
 * involved, so it runs in the plain Node test env.
 */
import { describe, it, expect } from "vitest";
import type { ProjectMeta } from "@ai-storm/shared";
import {
  buildExportBundle,
  buildFullExportBundle,
  exportFileSlug,
  exportProjectEntry,
  parseExportBundle,
  parseImportFile
} from "./project-portable";
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

describe("whole-state export (buildFullExportBundle / parseImportFile)", () => {
  const board = { cards: [], edges: [] };

  it("round-trips a multi-project bundle, preserving folder titles", () => {
    const bundle = buildFullExportBundle([
      exportProjectEntry(meta, board, "Research"),
      exportProjectEntry({ ...meta, id: "ws_2", title: "Other" }, board)
    ]);
    const entries = parseImportFile(JSON.stringify(bundle));
    expect(entries.map((e) => e.title)).toEqual(["My Project", "Other"]);
    expect(entries[0].folder).toBe("Research");
    expect(entries[1].folder).toBeUndefined();
  });

  it("strips the local cwd from each entry's terminal config", () => {
    const entry = exportProjectEntry({ ...meta, terminal: { ...meta.terminal, cwd: "C:\\local" } }, board);
    expect(entry.terminal.cwd).toBeUndefined();
  });

  it("normalizes a single-project bundle to a one-entry list", () => {
    const single = buildExportBundle(meta, board);
    const entries = parseImportFile(JSON.stringify(single));
    expect(entries).toHaveLength(1);
    expect(entries[0].title).toBe("My Project");
    expect(entries[0].color).toBe("#f43f5e");
    expect(entries[0].board).toEqual(board);
  });

  it("rejects an unsupported version on a whole-state bundle", () => {
    const bad = { ...buildFullExportBundle([exportProjectEntry(meta, board)]), version: 2 };
    expect(() => parseImportFile(JSON.stringify(bad))).toThrow(/unsupported project file version/i);
  });

  it("rejects a whole-state bundle with no projects", () => {
    expect(() => parseImportFile(JSON.stringify(buildFullExportBundle([])))).toThrow(/contains no projects/i);
  });

  it("rejects a whole-state bundle with a malformed entry", () => {
    const bad = { version: 1, exportedAt: 0, projects: [{ title: "x", terminal: {}, board: { cards: "nope" } }] };
    expect(() => parseImportFile(JSON.stringify(bad))).toThrow(/not a recognizable/i);
  });

  it("round-trips the optional full-fidelity tldraw pages and rejects malformed ones", () => {
    const content = { shapes: [], bindings: [], rootShapeIds: [], assets: [], schema: { schemaVersion: 2 } } as never;
    const tldraw = [
      { name: "TODO", content },
      { name: "Done" } // empty page — name still round-trips
    ];
    const bundle = buildFullExportBundle([exportProjectEntry(meta, board, undefined, tldraw)]);
    expect(parseImportFile(JSON.stringify(bundle))[0].tldraw).toEqual(tldraw);

    for (const bad of [{ shapes: "nope" }, [{ content }], [{ name: "x", content: { shapes: "nope" } }]]) {
      const mangled = { ...bundle, projects: [{ ...bundle.projects[0], tldraw: bad }] };
      expect(() => parseImportFile(JSON.stringify(mangled))).toThrow(/not a recognizable/i);
    }
  });

  it("rejects non-JSON and non-object values", () => {
    expect(() => parseImportFile("not json")).toThrow(/not valid JSON/i);
    expect(() => parseImportFile("42")).toThrow(/not a recognizable/i);
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
