/**
 * Wire protocol shared between the Node backend and the web client.
 *
 * Canonical single source of truth: both `ai-storm-backend` and
 * `ai-storm-frontend` import this module via the `@ai-storm/shared` workspace
 * dependency. There is no longer a hand-maintained frontend mirror.
 *
 * All messages are JSON encoded and exchanged over the local-only WebSocket
 * loop described in PRD §4.2. Every message is keyed by `workspaceId` so a
 * single socket can multiplex the strictly-isolated workspaces from PRD §3.4.
 *
 * The backend hosts each workspace's AI harness inside a durable, named,
 * connection-independent session (tmux on POSIX, an in-process node-pty on
 * Windows — see `docs/design/ai-session-layer.md`). It streams two independent
 * surfaces per workspace:
 *  - `data` — the raw PTY byte stream, rendered by xterm.js in the browser, so
 *    the conversation surface is a real terminal (display is xterm's job, not
 *    ours). Bytes are base64-encoded to survive control characters intact.
 *  - `idea` — brainstorming ideas extracted server-side from the `«IDEA»` /
 *    ` ```idea ` contract (`docs/design/ai-response-extraction-contract.md`),
 *    emitted one at a time as each marker line/fence completes.
 *
 * The fragile chat/chrome extraction (per-version chrome regexes, echo
 * anchoring, response-completion detection) is gone: the terminal renders
 * itself, and only the robust, contract-defined idea scan remains.
 */

/** Messages sent from the web client to the backend daemon. */
export type ClientMessage =
  | AttachMessage
  | InputMessage
  | ResizeMessage
  | DetachMessage
  | KillMessage
  | ContextMessage
  | AgentMessage;

/**
 * Ensure the durable session for a workspace exists and start streaming its
 * extracted responses to this client. Idempotent (PRD §3.5): if the session is
 * already running (e.g. after a browser refresh or backend restart), the
 * backend re-attaches the response stream instead of respawning the harness.
 */
export interface AttachMessage {
  type: "attach";
  workspaceId: string;
  /**
   * The interactive harness command to host, e.g. "claude". Optional; defaults
   * to the configured harness. Never a headless/print flag — the real
   * interactive CLI is always driven (design §1, hard constraints).
   */
  shell?: string;
  /** Arguments passed to the harness command. */
  args?: string[];
  /** Working directory for the session. */
  cwd?: string;
  cols?: number;
  rows?: number;
}

/** Send a prompt to the workspace's session (delivered to the harness stdin). */
export interface InputMessage {
  type: "input";
  workspaceId: string;
  data: string;
}

/** Inform the session of a new viewport size; re-anchors extraction width. */
export interface ResizeMessage {
  type: "resize";
  workspaceId: string;
  cols: number;
  rows: number;
}

/**
 * Stop streaming responses for a workspace but LEAVE the durable session alive
 * (browser refresh, socket loss, workspace hot-switch). The session can be
 * reattached later (PRD §3.5).
 */
export interface DetachMessage {
  type: "detach";
  workspaceId: string;
}

/** Terminate and clean up a workspace's session entirely (PRD §5.2 teardown). */
export interface KillMessage {
  type: "kill";
  workspaceId: string;
}

/**
 * Inject the serialized canvas state into the session loop (PRD §3.2).
 * The backend feeds the document to the harness as contextual memory.
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
  | SessionStatusMessage
  | DataMessage
  | IdeaMessage
  | ExitMessage
  | AgentStatusMessage
  | ErrorMessage;

/** Lifecycle of a durable session, decoupled from a specific connection. */
export interface SessionStatusMessage {
  type: "session-status";
  workspaceId: string;
  status: "created" | "attached" | "idle" | "responding" | "killed";
}

/** A single extracted brainstorming idea destined for the canvas. */
export interface Idea {
  /** Short title — the card heading. */
  title: string;
  /** One-line (or, for fenced ideas, multi-line) description — the card body. */
  body: string;
  /** Optional kind/tag, e.g. "risk" | "feature" | "question" | "decision" | "heuristic". */
  kind?: string;
}

/**
 * Raw PTY output for a workspace's session — streamed to the browser's xterm.js
 * terminal verbatim (the conversation surface). `data` is base64-encoded so the
 * control bytes of a cursor-addressed TUI survive JSON transport unchanged; the
 * client decodes it and writes the bytes straight into the terminal.
 */
export interface DataMessage {
  type: "data";
  workspaceId: string;
  /** Base64-encoded raw PTY bytes. */
  data: string;
}

/**
 * A single brainstorming idea extracted from the harness output via the §3
 * contract, destined for the canvas. Emitted one at a time as each `«IDEA»`
 * line / ` ```idea ` fence completes; the backend dedupes within a session so
 * a re-rendered marker is never delivered twice.
 */
export interface IdeaMessage {
  type: "idea";
  workspaceId: string;
  idea: Idea;
}

/** The durable session ended unexpectedly (e.g. killed externally). */
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

function requireString(msg: Record<string, unknown>, field: string, type: string): void {
  if (typeof msg[field] !== "string") {
    throw new Error(`Malformed \`${type}\` message: \`${field}\` must be a string`);
  }
}

function requireNumber(msg: Record<string, unknown>, field: string, type: string): void {
  if (typeof msg[field] !== "number" || !Number.isFinite(msg[field] as number)) {
    throw new Error(`Malformed \`${type}\` message: \`${field}\` must be a number`);
  }
}

export function parseClientMessage(raw: string): ClientMessage {
  const msg = JSON.parse(raw) as ClientMessage;
  if (typeof msg !== "object" || msg === null || !("type" in msg)) {
    throw new Error("Malformed message: missing `type`");
  }
  if (msg.type !== "attach" && !("workspaceId" in msg)) {
    throw new Error("Malformed message: missing `workspaceId`");
  }

  // Per-type field validation so malformed payloads are rejected here with a
  // clear error instead of reaching the session backend as `undefined`.
  const m = msg as unknown as Record<string, unknown>;
  switch (msg.type) {
    case "attach":
      requireString(m, "workspaceId", "attach");
      break;
    case "input":
      requireString(m, "data", "input");
      break;
    case "resize":
      requireNumber(m, "cols", "resize");
      requireNumber(m, "rows", "resize");
      break;
    case "detach":
    case "kill":
      // workspaceId checked above; nothing else required.
      break;
    case "context":
      requireString(m, "document", "context");
      break;
    case "agent":
      requireString(m, "command", "agent");
      requireString(m, "payload", "agent");
      break;
    default:
      throw new Error(`Malformed message: unknown type \`${(msg as { type: string }).type}\``);
  }
  return msg;
}
