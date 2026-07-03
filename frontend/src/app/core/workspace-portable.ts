/**
 * Workspace export/import bundle (#105) — a portable, ref-keyed JSON snapshot of a
 * workspace's metadata and board, independent of the browser profile. The board
 * itself is described by {@link PortableBoard} (see `canvas/portable.ts` for the
 * editor-facing read/write side); this module owns the bundle envelope, its
 * validation, and the filename convention, so it stays pure and unit-testable
 * (no tldraw `Editor` involved).
 */
import type { TerminalConfig, WorkspaceMeta } from "./models";

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

export interface WorkspaceExportBundle {
  version: 1;
  exportedAt: number;
  workspace: {
    title: string;
    color?: string;
    terminal: TerminalConfig;
  };
  board: PortableBoard;
}

const CURRENT_VERSION = 1;

/** Wrap a workspace's meta + board into the portable envelope. */
export function buildExportBundle(meta: WorkspaceMeta, board: PortableBoard): WorkspaceExportBundle {
  return {
    version: CURRENT_VERSION,
    exportedAt: Date.now(),
    workspace: { title: meta.title, color: meta.color, terminal: { ...meta.terminal } },
    board
  };
}

/**
 * Parse and validate a workspace export file (acceptance criterion: invalid or
 * incompatible files show clear errors). Throws a descriptive `Error` — never
 * returns a partially-valid bundle.
 */
export function parseExportBundle(json: string): WorkspaceExportBundle {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error("That file is not valid JSON.");
  }
  if (!data || typeof data !== "object") {
    throw new Error("Not a recognizable ai-storm workspace file.");
  }
  const bundle = data as Record<string, unknown>;
  if (bundle.version !== CURRENT_VERSION) {
    throw new Error(
      `Unsupported workspace file version (got ${JSON.stringify(bundle.version)}, expected ${CURRENT_VERSION}).`
    );
  }
  const ws = bundle.workspace as Record<string, unknown> | undefined;
  if (!ws || typeof ws.title !== "string" || !ws.terminal || typeof ws.terminal !== "object") {
    throw new Error("Not a recognizable ai-storm workspace file.");
  }
  const board = bundle.board as Record<string, unknown> | undefined;
  if (!board || !Array.isArray(board.cards) || !Array.isArray(board.edges)) {
    throw new Error("Not a recognizable ai-storm workspace file.");
  }
  return bundle as unknown as WorkspaceExportBundle;
}

/** Filesystem-safe base filename (no extension) for a workspace export. */
export function exportFileSlug(title: string): string {
  const slug = title
    .trim()
    .replace(/[^\w-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return slug || "workspace";
}
