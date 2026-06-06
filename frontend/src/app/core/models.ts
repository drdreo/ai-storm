/** Domain models for ai-storm workspaces (PRD §3.4). */

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
}

export interface TerminalConfig {
  /** Binary/shell to spawn; undefined → platform default shell. */
  shell?: string;
  args?: string[];
  cwd?: string;
  /** Orchestrator command for the downstream agent hook (PRD §3.6). */
  agentCommand?: string;
  agentArgs?: string[];
}

export function defaultTerminalConfig(): TerminalConfig {
  return {
    agentCommand: 'claude',
    agentArgs: [],
  };
}
