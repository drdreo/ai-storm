/**
 * Wire protocol shared with the Deno backend (mirror of backend/src/protocol.ts).
 * Kept as a standalone copy so the frontend build has no cross-package import.
 */

export type ClientMessage =
  | AttachMessage
  | InputMessage
  | ResizeMessage
  | DetachMessage
  | ContextMessage
  | AgentMessage;

export interface AttachMessage {
  type: 'attach';
  workspaceId: string;
  shell?: string;
  args?: string[];
  cwd?: string;
  cols?: number;
  rows?: number;
}

export interface InputMessage {
  type: 'input';
  workspaceId: string;
  data: string;
}

export interface ResizeMessage {
  type: 'resize';
  workspaceId: string;
  cols: number;
  rows: number;
}

export interface DetachMessage {
  type: 'detach';
  workspaceId: string;
}

export interface ContextMessage {
  type: 'context';
  workspaceId: string;
  document: string;
}

export interface AgentMessage {
  type: 'agent';
  workspaceId: string;
  command: string;
  args?: string[];
  payload: string;
  cwd?: string;
}

export type ServerMessage =
  | ReadyMessage
  | DataMessage
  | ExitMessage
  | AgentStatusMessage
  | ErrorMessage;

export interface ReadyMessage {
  type: 'ready';
  workspaceId: string;
  pid: number;
}

export interface DataMessage {
  type: 'data';
  workspaceId: string;
  chunk: string;
}

export interface ExitMessage {
  type: 'exit';
  workspaceId: string;
  code: number;
}

export interface AgentStatusMessage {
  type: 'agent-status';
  workspaceId: string;
  status: 'spawned' | 'stdout' | 'stderr' | 'exit' | 'error';
  pid?: number;
  data?: string;
  code?: number;
}

export interface ErrorMessage {
  type: 'error';
  workspaceId?: string;
  message: string;
}
