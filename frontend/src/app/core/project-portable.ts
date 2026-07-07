/**
 * Project export/import bundle (#105) — a portable, ref-keyed JSON snapshot of a
 * project's metadata and board, independent of the browser profile. The board
 * itself is described by {@link PortableBoard} (see `canvas/portable.ts` for the
 * editor-facing read/write side); this module owns the bundle envelope, its
 * validation, and the filename convention, so it stays pure and unit-testable
 * (no tldraw `Editor` involved).
 */
import type { TLContent } from "tldraw";
import type { TerminalConfig, ProjectMeta } from "@ai-storm/shared";

export interface PortableCard {
  ref: string;
  kind: string;
  title: string;
  body: string;
  origin: "ai" | "user";
  superseded: boolean;
  starred: boolean;
}

export interface PortableEdge {
  from: string;
  to: string;
  relation: "about" | "supersedes";
}

export interface PortableBoard {
  cards: PortableCard[];
  edges: PortableEdge[];
}

export interface ProjectExportBundle {
  version: 1;
  exportedAt: number;
  project: {
    title: string;
    color?: string;
    terminal: TerminalConfig;
  };
  board: PortableBoard;
  /** Full-fidelity tldraw page snapshot (all shapes, positions, assets). */
  tldraw?: TLContent;
}

/** One project inside a whole-state export: its portable meta plus its board. */
export interface ExportedProject {
  title: string;
  color?: string;
  terminal: TerminalConfig;
  /** Sidebar folder title (folders are matched/recreated by title on import). */
  folder?: string;
  board: PortableBoard;
  /**
   * Full-fidelity tldraw page snapshot (all shapes, positions, assets).
   * Preferred on import when present; `board` is the validated fallback for
   * files that lack it (or whose snapshot fails to restore).
   */
  tldraw?: TLContent;
}

/** Whole-state export: every project (with board) in one file. */
export interface FullExportBundle {
  version: 1;
  exportedAt: number;
  projects: ExportedProject[];
}

const CURRENT_VERSION = 1;

/**
 * Portable copy of a project's terminal config. `cwd` (#152) is a local
 * filesystem path — meaningless (or worse, wrong) on whatever machine imports
 * the bundle, so it's dropped rather than round-tripped.
 */
function portableTerminal(terminal: TerminalConfig): TerminalConfig {
  const { cwd: _cwd, ...rest } = terminal;
  return rest;
}

/** Portable entry for one project — the building block of both bundle kinds. */
export function exportProjectEntry(
  meta: ProjectMeta,
  board: PortableBoard,
  folder?: string,
  tldraw?: TLContent
): ExportedProject {
  return { title: meta.title, color: meta.color, terminal: portableTerminal(meta.terminal), folder, board, tldraw };
}

/** Wrap a project's meta + board into the portable envelope. */
export function buildExportBundle(meta: ProjectMeta, board: PortableBoard, tldraw?: TLContent): ProjectExportBundle {
  return {
    version: CURRENT_VERSION,
    exportedAt: Date.now(),
    project: { title: meta.title, color: meta.color, terminal: portableTerminal(meta.terminal) },
    board,
    tldraw
  };
}

/** Wrap every project's portable entry into the whole-state envelope. */
export function buildFullExportBundle(projects: ExportedProject[]): FullExportBundle {
  return { version: CURRENT_VERSION, exportedAt: Date.now(), projects };
}

const UNRECOGNIZED = "Not a recognizable ai-storm project file.";

function isValidBoard(board: unknown): boolean {
  const b = board as Record<string, unknown> | undefined;
  return !!b && typeof b === "object" && Array.isArray(b.cards) && Array.isArray(b.edges);
}

/**
 * The optional full-fidelity snapshot is tldraw's own format — only its outer
 * shell is checked here (tldraw validates/migrates the rest on import).
 */
function isValidTldraw(content: unknown): boolean {
  if (content === undefined) return true;
  const c = content as Record<string, unknown> | undefined;
  return !!c && typeof c === "object" && Array.isArray(c.shapes) && !!c.schema && typeof c.schema === "object";
}

function assertVersion(bundle: Record<string, unknown>): void {
  if (bundle.version !== CURRENT_VERSION) {
    throw new Error(
      `Unsupported project file version (got ${JSON.stringify(bundle.version)}, expected ${CURRENT_VERSION}).`
    );
  }
}

/**
 * Parse and validate a project export file (acceptance criterion: invalid or
 * incompatible files show clear errors). Throws a descriptive `Error` — never
 * returns a partially-valid bundle.
 */
export function parseExportBundle(json: string): ProjectExportBundle {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error("That file is not valid JSON.");
  }
  if (!data || typeof data !== "object") {
    throw new Error(UNRECOGNIZED);
  }
  const bundle = data as Record<string, unknown>;
  assertVersion(bundle);
  const ws = bundle.project as Record<string, unknown> | undefined;
  if (!ws || typeof ws.title !== "string" || !ws.terminal || typeof ws.terminal !== "object") {
    throw new Error(UNRECOGNIZED);
  }
  if (!isValidBoard(bundle.board) || !isValidTldraw(bundle.tldraw)) {
    throw new Error(UNRECOGNIZED);
  }
  return bundle as unknown as ProjectExportBundle;
}

/**
 * Parse either kind of export file — a single-project bundle or a whole-state
 * bundle — into a normalized list of importable project entries. Throws a
 * descriptive `Error` on anything invalid; never returns a partial list.
 */
export function parseImportFile(json: string): ExportedProject[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error("That file is not valid JSON.");
  }
  if (!data || typeof data !== "object") {
    throw new Error(UNRECOGNIZED);
  }
  const bundle = data as Record<string, unknown>;
  if (!Array.isArray(bundle.projects)) {
    // Single-project bundle — normalize to a one-entry list.
    const single = parseExportBundle(json);
    return [{ ...single.project, board: single.board, tldraw: single.tldraw }];
  }
  assertVersion(bundle);
  if (bundle.projects.length === 0) {
    throw new Error("That export file contains no projects.");
  }
  for (const entry of bundle.projects as Record<string, unknown>[]) {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.title !== "string" ||
      !entry.terminal ||
      typeof entry.terminal !== "object" ||
      !isValidBoard(entry.board) ||
      !isValidTldraw(entry.tldraw)
    ) {
      throw new Error(UNRECOGNIZED);
    }
  }
  return bundle.projects as unknown as ExportedProject[];
}

/** Filesystem-safe base filename (no extension) for a project export. */
export function exportFileSlug(title: string): string {
  const slug = title
    .trim()
    .replace(/[^\w-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return slug || "project";
}
