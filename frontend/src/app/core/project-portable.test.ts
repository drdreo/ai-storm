import { describe, expect, it } from "vitest";
import type { PortableStateBundle } from "@ai-storm/shared";
import { exportFileSlug, parseImportFile } from "./project-portable";

function bundle(): PortableStateBundle {
  const document = {
    store: {
      "shape:one": { id: "shape:one", typeName: "shape", type: "idea-card" },
      "shape:other": { id: "shape:other", typeName: "shape", type: "geo" }
    }
  };
  return {
    version: 2,
    exportedAt: 1,
    registry: {
      version: 1,
      revision: 3,
      projects: [
        { id: "p1", title: "One", terminal: {}, createdAt: 1, updatedAt: 1 },
        { id: "p2", title: "Two", terminal: {}, createdAt: 2, updatedAt: 2 }
      ],
      folders: []
    },
    boards: {
      p1: { version: 1, revision: 1, nextIdeaRef: 8, document },
      p2: { version: 1, revision: 0, nextIdeaRef: 1, document: null }
    },
    histories: {
      p1: { version: 1, revision: 1, runs: [{ id: "run1" }] },
      p2: { version: 1, revision: 0, runs: [] }
    }
  };
}

describe("backend state export parsing", () => {
  it("accepts the v2 canonical subset and derives project/card summaries", () => {
    const parsed = parseImportFile(JSON.stringify(bundle()));
    expect(parsed.bundle).toEqual(bundle());
    expect(parsed.projects).toEqual([
      { id: "p1", title: "One", cardCount: 1 },
      { id: "p2", title: "Two", cardCount: 0 }
    ]);
  });

  it("intentionally rejects legacy v1 bundles and malformed subsets", () => {
    expect(() => parseImportFile(JSON.stringify({ version: 1, projects: [] }))).toThrow(/expected 2/i);
    const missing = bundle();
    delete missing.boards.p1;
    expect(() => parseImportFile(JSON.stringify(missing))).toThrow(/not a recognizable/i);
    expect(() => parseImportFile("not json")).toThrow(/not valid JSON/i);
  });
});

describe("exportFileSlug", () => {
  it("slugifies a title and has a fallback", () => {
    expect(exportFileSlug("  My Cool Project!! ")).toBe("my-cool-project");
    expect(exportFileSlug("!!!")).toBe("project");
  });
});
