import { describe, expect, it } from "vitest";
import type { Folder, ProjectMeta } from "@ai-storm/shared";
import type { PersistedBoardSummary } from "./canvas/search-index";
import { buildProjectCatalog } from "./project-catalog";

function projectMeta(overrides: Partial<ProjectMeta> & Pick<ProjectMeta, "id" | "title">): ProjectMeta {
  return {
    status: "idle",
    createdAt: 1,
    lastActiveAt: 2,
    terminal: {},
    ...overrides
  };
}

describe("buildProjectCatalog", () => {
  it("maps the registry + board summaries into the wire catalog", () => {
    const projects: ProjectMeta[] = [
      projectMeta({
        id: "ws1",
        title: "Edge caching",
        folderId: "fld1",
        color: "blue",
        status: "active",
        createdAt: 10,
        lastActiveAt: 20
      }),
      projectMeta({ id: "ws2", title: "Onboarding", createdAt: 30, lastActiveAt: 40 })
    ];
    const folders: Folder[] = [{ id: "fld1", title: "Infra", createdAt: 0 }];
    const summaries = new Map<string, PersistedBoardSummary>([
      ["ws1", { pages: ["Page 1", "Spikes"], ideaCount: 7 }],
      ["ws2", { pages: ["Page 1"], ideaCount: 0 }]
    ]);

    const catalog = buildProjectCatalog(projects, folders, "ws1", summaries, 1720000000000);

    expect(catalog).toEqual({
      version: 1,
      updatedAt: 1720000000000,
      projects: [
        {
          id: "ws1",
          title: "Edge caching",
          folder: "Infra",
          status: "active",
          color: "blue",
          active: true,
          createdAt: 10,
          lastActiveAt: 20,
          pages: ["Page 1", "Spikes"],
          ideaCount: 7
        },
        {
          id: "ws2",
          title: "Onboarding",
          status: "idle",
          active: false,
          createdAt: 30,
          lastActiveAt: 40,
          pages: ["Page 1"],
          ideaCount: 0
        }
      ]
    });
  });

  it("omits folder when the id doesn't resolve, and defaults a missing summary to empty", () => {
    const projects = [projectMeta({ id: "ws1", title: "Orphan", folderId: "gone" })];
    const catalog = buildProjectCatalog(projects, [], null, new Map());

    expect(catalog.projects[0].folder).toBeUndefined();
    expect(catalog.projects[0].active).toBe(false);
    expect(catalog.projects[0].pages).toEqual([]);
    expect(catalog.projects[0].ideaCount).toBe(0);
  });
});
