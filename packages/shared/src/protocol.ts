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

export * from "./modes.js";

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
  /**
   * Facilitation mode id (#61) — selects the priming preset appended to the base
   * `«IDEA»` contract. Optional; defaults to the free-form mode (base contract
   * only). See `modes.ts`.
   */
  mode?: string;
  /**
   * Pre-brainstorm background context (#76) — freeform user-authored priming that
   * "sets the scene" for every idea the agent generates this session (audience,
   * domain, constraints). Baked into the launch system-prompt as a third priming
   * segment beside the base contract and the facilitation `mode`, so it is LOCKED
   * while the session is attached (edit ⇒ Stop & Start; PD-020). Optional; empty
   * or absent contributes nothing — the prime is byte-identical to today.
   */
  background?: string;
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
  | ScoreMessage
  | ExitMessage
  | AgentStatusMessage
  | ErrorMessage;

/** Lifecycle of a durable session, decoupled from a specific connection. */
export interface SessionStatusMessage {
  type: "session-status";
  workspaceId: string;
  status: "created" | "attached" | "idle" | "responding" | "killed";
}

/**
 * The relationship an {@link IdeaLink} edge carries (idea-graph design §2.3).
 * `'about'` is the generic default — "this card is about that card"; the source
 * card's `kind` carries the flavour (a risk-of edge is just a `kind: 'risk'`
 * card with an `about` link). `'supersedes'` is the one structural relation that
 * isn't derivable from the source's kind — the card replaces its target
 * (decision capture / lifecycle, #22/#20). Extensible, but deliberately tiny.
 */
export type IdeaRelation = "about" | "supersedes";

/** A typed edge from one idea to another card (idea-graph design §3.1). */
export interface IdeaLink {
  /** Short ref of the target card this idea links to (see idea-graph §4). */
  to: string;
  /** Defaults to `'about'`; `'supersedes'` means this card replaces the target. */
  relation?: IdeaRelation;
}

/**
 * A single extracted brainstorming idea destined for the canvas.
 *
 * `id`/`links` are additive (idea-graph design §3.1) and OPTIONAL — nothing that
 * produces today's `{title, body, kind}` breaks. They are dormant until the
 * idea-graph consumers (#40/#19/#22/#16) turn them on; until then the frontend
 * ignores `links` and mints its own card identity.
 */
export interface Idea {
  /** Short title — the card heading. */
  title: string;
  /** One-line (or, for fenced ideas, multi-line) description — the card body. */
  body: string;
  /** Optional kind/tag, e.g. "risk" | "feature" | "question" | "decision" | "heuristic". */
  kind?: string;
  /** This idea's own short ref, when the agent stamped one (fenced `id:`). Usually
   *  minted by the canvas at card creation instead (idea-graph §4). */
  id?: string;
  /** 0..n edges to other cards (idea-graph §3.1). A verb-spawned idea usually
   *  carries one (its originating edge) or none. */
  links?: IdeaLink[];
}

/**
 * Canonical identity key for an {@link Idea} — the key the backend scanner uses
 * to track which ideas it has already emitted this session, so a marker the
 * terminal re-renders every frame is sent to the canvas exactly once (#38).
 *
 * Identity is ANCHORED ON THE TITLE (plus the distinguishing kind + links) and
 * deliberately EXCLUDES the body. The title is the stable heading; the body is
 * the volatile description — a long one re-wraps as the pane resizes (and the
 * agent may re-stream it), which would make the same idea look "new" and defeat
 * the dedupe. Anchoring on the title sidesteps that drift. The trade-off,
 * accepted deliberately: two ideas that share a title (same kind, same links)
 * are treated as one.
 *
 * `kind` + `links` stay in the key so a same-titled risk vs. feature, or an idea
 * pointed at a different card, stay distinct (idea-graph design §5.1; links are
 * order-independent). The title's whitespace is normalized for safety; the
 * idea's own `id` is excluded (identity is what the idea is about, not the ref a
 * producer minted).
 */
export function ideaIdentityKey(idea: Idea): string {
  const norm = (s: string): string => s.replace(/\s+/g, " ").trim();
  const links = (idea.links ?? [])
    .map((l) => `${l.to}:${l.relation ?? "about"}`)
    .sort()
    .join(",");
  // U+0001 separates the fields — it never occurs in rendered terminal text.
  return [norm(idea.title), (idea.kind ?? "").trim(), links].join("");
}

/**
 * An AI triage score for one EXISTING card (#60). Unlike an {@link Idea} (which
 * creates a card), a score *updates* a card already on the board: it targets the
 * card's short ref (idea-graph §4) and carries the agent's impact / effort /
 * confidence rating on a 1..5 scale. Extracted from the `«SCORE@ref»` marker the
 * agent emits when asked to triage the board, and applied to the card's `meta`
 * (driving the 2×2 prioritization layout, #60). `confidence` is optional — the
 * agent may rate only impact × effort.
 */
export interface Score {
  /** Short ref of the card being scored (idea-graph §4). */
  ref: string;
  /** 1..5, higher = more impactful. */
  impact: number;
  /** 1..5, higher = more effort. */
  effort: number;
  /** 1..5, higher = more confident; omitted when the agent didn't rate it. */
  confidence?: number;
}

/**
 * A single triage score extracted from the `«SCORE@ref»` contract (#60),
 * destined to update an existing card on the canvas. Emitted one at a time as
 * each marker line completes; the backend dedupes a given `(ref, values)` within
 * a session so a re-rendered line is delivered once, while a *re-triage* that
 * changes a card's score passes through as a fresh update.
 */
export interface ScoreMessage {
  type: "score";
  workspaceId: string;
  score: Score;
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
