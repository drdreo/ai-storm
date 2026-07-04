/**
 * Project domain model (PRD §3.4) — shared so the backend can eventually
 * type `projectId`-bearing structures against the same shape the frontend
 * persists, instead of the frontend being the sole owner of a cross-cutting
 * concept.
 */

export type ProjectStatus = "idle" | "active" | "streaming" | "error";

/** Metadata describing a single isolated project. */
export interface ProjectMeta {
  id: string;
  title: string;
  status: ProjectStatus;
  /** Epoch ms of creation. */
  createdAt: number;
  /** Epoch ms of last activity (used for crash-recovery ordering §3.5). */
  lastActiveAt: number;
  /** Terminal binding configuration (PRD §3.4 local process bindings). */
  terminal: TerminalConfig;
  /**
   * Accent color shown in the sidebar for faster scanning (#111). One of the
   * frontend's fixed accent palette; undefined → derive a deterministic default.
   */
  color?: string;
  /**
   * Parent folder id (#128) grouping this project in the sidebar. Undefined →
   * the project sits at the sidebar's top level (ungrouped).
   */
  folderId?: string;
  /**
   * Fractional-index sort key ranking this project among its siblings in the
   * same container (its folder, or the ungrouped top level). Assigned lazily —
   * undefined sorts before keyed items, tie-broken by `createdAt`.
   */
  order?: string;
}

/**
 * A sidebar folder grouping projects for navigation as their number grows
 * (#128). Folders are pure organisational containers — they hold no canvas or
 * session state, only a title and the collapse state of their sidebar group.
 */
export interface Folder {
  id: string;
  title: string;
  /** Epoch ms of creation, used for stable ordering in the sidebar. */
  createdAt: number;
  /** Sidebar group collapse state, persisted so it survives a reload. */
  collapsed?: boolean;
  /** Fractional-index sort key ranking this folder among all folders. */
  order?: string;
}

export interface TerminalConfig {
  /** Binary/shell to spawn; undefined → platform default shell. */
  shell?: string;
  args?: string[];
  cwd?: string;
  /** Orchestrator command for the downstream agent hook (PRD §3.6). */
  agentCommand?: string;
  agentArgs?: string[];
  /**
   * Facilitation mode id (#61) — the priming preset applied when the session is
   * (re)started. Undefined → free-form default. See `modes.ts`.
   */
  mode?: string;
  /**
   * Pre-brainstorm background context (#76) — freeform "set the scene" priming
   * baked into the launch system-prompt, steering every idea this session.
   * Locked while the session is attached (edit ⇒ Stop & Start; PD-020). Undefined
   * or empty contributes nothing to the prime.
   */
  background?: string;
}
