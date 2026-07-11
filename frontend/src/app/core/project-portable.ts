import type { PortableStateBundle } from "@ai-storm/shared";

export interface ImportableProject {
  id: string;
  title: string;
  cardCount: number;
}

export interface ParsedStateImport {
  bundle: PortableStateBundle;
  projects: ImportableProject[];
}

const UNRECOGNIZED = "Not a recognizable ai-storm state export.";

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function cardCount(document: unknown): number {
  const root = object(document);
  const records = object(root?.store);
  if (!records) return 0;
  return Object.values(records).filter((value) => {
    const record = object(value);
    return record?.typeName === "shape" && record.type === "idea-card";
  }).length;
}

/** Parse only the backend-owned v2 subset. Legacy portable-card bundles are intentionally unsupported. */
export function parseImportFile(json: string): ParsedStateImport {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error("That file is not valid JSON.");
  }
  const bundle = object(data);
  if (!bundle) throw new Error(UNRECOGNIZED);
  if (bundle.version !== 2) {
    throw new Error(`Unsupported state export version (got ${JSON.stringify(bundle.version)}, expected 2).`);
  }
  const registry = object(bundle.registry);
  const boards = object(bundle.boards);
  const histories = object(bundle.histories);
  if (
    registry?.version !== 1 ||
    !Array.isArray(registry.projects) ||
    !Array.isArray(registry.folders) ||
    !boards ||
    !histories
  )
    throw new Error(UNRECOGNIZED);
  if (registry.projects.length === 0) throw new Error("That export file contains no projects.");

  const projects = registry.projects.map((value) => {
    const project = object(value);
    if (!project || typeof project.id !== "string" || typeof project.title !== "string") throw new Error(UNRECOGNIZED);
    const board = object(boards[project.id]);
    const history = object(histories[project.id]);
    if (
      board?.version !== 1 ||
      !Object.hasOwn(board, "document") ||
      history?.version !== 1 ||
      !Array.isArray(history.runs)
    )
      throw new Error(UNRECOGNIZED);
    return { id: project.id, title: project.title, cardCount: cardCount(board.document) };
  });
  return { bundle: data as PortableStateBundle, projects };
}

/** Filesystem-safe base filename (no extension). */
export function exportFileSlug(title: string): string {
  const slug = title
    .trim()
    .replace(/[^\w-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return slug || "project";
}
