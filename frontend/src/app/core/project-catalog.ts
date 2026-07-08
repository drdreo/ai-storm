/**
 * Workspace project catalog (#228) — the read side that lets a terminal AI
 * attached to one project discover which OTHER projects exist.
 *
 * `get_board_ideas` is deliberately project-scoped ("it never reads other
 * projects"), so an agent can't spam itself with unrelated boards. But to decide
 * whether a referenced project is worth pulling in, it first needs to see the
 * directory: titles, sidebar folders, status, and a cheap read of each board
 * (its tldraw page names + idea count). This module turns the frontend-owned
 * project registry into that {@link ProjectCatalog}; the backend has no
 * knowledge of projects, so the browser publishes it (project.store), and the
 * MCP `get_projects` tool returns it verbatim.
 *
 * Pure and unit-testable: it takes the project store state plus a per-project
 * board summary map (built off the persisted tldraw stores by
 * `canvas.collectBoardSummaries`) and returns the wire shape. No tldraw editor
 * or IndexedDB access here.
 */
import type { Folder, ProjectCatalog, ProjectMeta } from "@ai-storm/shared";
import type { PersistedBoardSummary } from "./canvas/search-index";

const EMPTY_SUMMARY: PersistedBoardSummary = { pages: [], ideaCount: 0 };

/**
 * Build the workspace-wide {@link ProjectCatalog} from the project registry and
 * a per-project board summary map. Projects are emitted in the store's given
 * order (the sidebar order); folder ids are resolved to their titles so the
 * catalog is self-describing without a separate folder list.
 */
export function buildProjectCatalog(
  projects: readonly ProjectMeta[],
  folders: readonly Folder[],
  activeId: string | null,
  summaries: Map<string, PersistedBoardSummary>,
  now = Date.now()
): ProjectCatalog {
  const folderTitle = new Map(folders.map((f) => [f.id, f.title]));
  return {
    version: 1,
    updatedAt: now,
    projects: projects.map((meta) => {
      const summary = summaries.get(meta.id) ?? EMPTY_SUMMARY;
      return {
        id: meta.id,
        title: meta.title,
        ...(meta.folderId && folderTitle.has(meta.folderId) ? { folder: folderTitle.get(meta.folderId)! } : {}),
        status: meta.status,
        ...(meta.color ? { color: meta.color } : {}),
        active: meta.id === activeId,
        createdAt: meta.createdAt,
        lastActiveAt: meta.lastActiveAt,
        pages: summary.pages,
        ideaCount: summary.ideaCount
      };
    })
  };
}
