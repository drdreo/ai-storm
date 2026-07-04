/**
 * Workspace domain model (PRD §3.4) — shared so the backend can eventually
 * type `workspaceId`-bearing structures against the same shape the frontend
 * persists, instead of the frontend being the sole owner of a cross-cutting
 * concept.
 */

export type WorkspaceStatus = "idle" | "active" | "streaming" | "error";

/** Metadata describing a single isolated project workspace. */
export interface WorkspaceMeta {
  id: string;
  title: string;
  status: WorkspaceStatus;
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
