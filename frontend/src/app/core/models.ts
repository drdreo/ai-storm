/** Domain models for ai-storm workspaces (PRD §3.4). */

import { DEFAULT_MODE_ID } from '@ai-storm/shared';

export type WorkspaceStatus = 'idle' | 'active' | 'streaming' | 'error';

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
   * Accent color shown in the sidebar for faster scanning (#111). One of
   * {@link WORKSPACE_COLORS}; undefined → derive from {@link defaultWorkspaceColor}.
   */
  color?: string;
}

/** Fixed accent palette (Tailwind 500s) — kept small so swatches stay distinguishable. */
export const WORKSPACE_COLORS = [
  '#f43f5e', // rose
  '#f97316', // orange
  '#eab308', // yellow
  '#22c55e', // green
  '#14b8a6', // teal
  '#0ea5e9', // sky
  '#6366f1', // indigo
  '#a855f7', // purple
  '#ec4899', // pink
] as const;

/** Deterministic default accent color, stable for a given workspace id. */
export function defaultWorkspaceColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  const index = Math.abs(hash) % WORKSPACE_COLORS.length;
  return WORKSPACE_COLORS[index];
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
   * (re)started. Undefined → free-form default. See `@ai-storm/shared` modes.
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

export function defaultTerminalConfig(): TerminalConfig {
  return {
    agentCommand: 'claude',
    agentArgs: [],
    mode: DEFAULT_MODE_ID,
  };
}
