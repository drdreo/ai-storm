/**
 * Wire protocol shared between the Deno backend and the web client.
 *
 * All messages are JSON encoded and exchanged over the local-only WebSocket
 * loop described in PRD §4.2. Every message is keyed by `workspaceId` so a
 * single socket can multiplex the strictly-isolated workspaces from PRD §3.4.
 */

/** Messages sent from the web client to the backend daemon. */
export type ClientMessage =
  | AttachMessage
  | InputMessage
  | ResizeMessage
  | DetachMessage
  | ContextMessage
  | AgentMessage;

/** Spawn (or re-attach to) the PTY bound to a workspace. */
export interface AttachMessage {
  type: "attach";
  workspaceId: string;
  /** Override the shell/binary to spawn. Defaults to the platform shell. */
  shell?: string;
  /** Arguments passed to the spawned binary. */
  args?: string[];
  /** Working directory for the spawned process. */
  cwd?: string;
  cols?: number;
  rows?: number;
}

/** Forward raw keystrokes/text to the PTY stdin. */
export interface InputMessage {
  type: "input";
  workspaceId: string;
  data: string;
}

/** Inform the PTY of a new viewport size. */
export interface ResizeMessage {
  type: "resize";
  workspaceId: string;
  cols: number;
  rows: number;
}

/** Terminate and clean up a workspace's PTY (PRD §5.2 teardown). */
export interface DetachMessage {
  type: "detach";
  workspaceId: string;
}

/**
 * Inject the serialized canvas state into the terminal loop (PRD §3.2).
 * The backend writes the document to the PTY stdin as contextual memory.
 */
export interface ContextMessage {
  type: "context";
  workspaceId: string;
  document: string;
}

/** Downstream agent execution hook (PRD §3.6). */
export interface AgentMessage {
  type: "agent";
  workspaceId: string;
  /** The orchestrator command to invoke, e.g. "claude" or "aider". */
  command: string;
  /** Static arguments preceding the payload. */
  args?: string[];
  /** The extracted plain-text block contents passed as the functional arg. */
  payload: string;
  /** Working directory for the spawned agent. */
  cwd?: string;
}

/** Messages sent from the backend daemon to the web client. */
export type ServerMessage =
  | ReadyMessage
  | DataMessage
  | ExitMessage
  | AgentStatusMessage
  | ErrorMessage;

/** A PTY was spawned successfully. */
export interface ReadyMessage {
  type: "ready";
  workspaceId: string;
  pid: number;
}

/** A raw, unprocessed chunk of PTY stdout (PRD §3.3 — parsed client-side). */
export interface DataMessage {
  type: "data";
  workspaceId: string;
  chunk: string;
}

/** The PTY process exited. */
export interface ExitMessage {
  type: "exit";
  workspaceId: string;
  code: number;
}

/** Lifecycle updates for a downstream agent subprocess (PRD §3.6). */
export interface AgentStatusMessage {
  type: "agent-status";
  workspaceId: string;
  status: "spawned" | "stdout" | "stderr" | "exit" | "error";
  pid?: number;
  data?: string;
  code?: number;
}

/** A recoverable error scoped to a workspace (or the connection). */
export interface ErrorMessage {
  type: "error";
  workspaceId?: string;
  message: string;
}

export function parseClientMessage(raw: string): ClientMessage {
  const msg = JSON.parse(raw) as ClientMessage;
  if (typeof msg !== "object" || msg === null || !("type" in msg)) {
    throw new Error("Malformed message: missing `type`");
  }
  if (msg.type !== "attach" && !("workspaceId" in msg)) {
    throw new Error("Malformed message: missing `workspaceId`");
  }
  return msg;
}
