/**
 * Wire protocol shared between the Node backend and the web client.
 *
 * Canonical single source of truth: both `ai-storm-backend` and
 * `ai-storm-frontend` import this module via the `@ai-storm/shared` project
 * dependency. There is no longer a hand-maintained frontend mirror.
 *
 * All messages are JSON encoded and exchanged over the local-only WebSocket
 * loop described in PRD §4.2. Every message is keyed by `projectId` so a
 * single socket can multiplex the strictly-isolated projects from PRD §3.4.
 *
 * The backend hosts each project's AI harness inside a durable, named,
 * connection-independent session (tmux on POSIX, an in-process node-pty on
 * Windows — see `docs/design/ai-session-layer.md`). It streams two independent
 * surfaces per project:
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
export * from "./project.js";

/** Messages sent from the web client to the backend daemon. */
export type ClientMessage =
  | AttachMessage
  | InputMessage
  | ResizeMessage
  | DetachMessage
  | KillMessage
  | ContextMessage
  | BoardSnapshotMessage
  | AgentMessage
  | StateRequestMessage;

/** Backend-owned durable state operations. Mutations are intentionally granular;
 * board-save is the sole whole-document write. `requestId` correlates an ack. */
export type StateOperation =
  | "registry-load"
  | "registry-create-project"
  | "registry-patch-project"
  | "registry-delete-project"
  | "registry-create-folder"
  | "registry-patch-folder"
  | "registry-delete-folder"
  | "board-load"
  | "board-save"
  | "reserve-idea-refs"
  | "history-load"
  | "history-append"
  | "history-update"
  | "history-delete"
  | "history-clear";

const STATE_OPERATIONS: ReadonlySet<string> = new Set<StateOperation>([
  "registry-load",
  "registry-create-project",
  "registry-patch-project",
  "registry-delete-project",
  "registry-create-folder",
  "registry-patch-folder",
  "registry-delete-folder",
  "board-load",
  "board-save",
  "reserve-idea-refs",
  "history-load",
  "history-append",
  "history-update",
  "history-delete",
  "history-clear"
]);

export interface StateRequestMessage {
  type: "state-request";
  requestId: string;
  operation: StateOperation;
  projectId?: string;
  /** Operation-specific payload. The backend validates required fields. */
  payload?: Record<string, unknown>;
}

/**
 * Ensure the durable session for a project exists and start streaming its
 * extracted responses to this client. Idempotent (PRD §3.5): if the session is
 * already running (e.g. after a browser refresh or backend restart), the
 * backend re-attaches the response stream instead of respawning the harness.
 */
export interface AttachMessage {
  type: "attach";
  projectId: string;
  /**
   * The interactive harness command to host, e.g. "claude" or "codex". Optional; defaults
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

/** Send a prompt to the project's session (delivered to the harness stdin). */
export interface InputMessage {
  type: "input";
  projectId: string;
  data: string;
}

/** Inform the session of a new viewport size; re-anchors extraction width. */
export interface ResizeMessage {
  type: "resize";
  projectId: string;
  cols: number;
  rows: number;
}

/**
 * Stop streaming responses for a project but LEAVE the durable session alive
 * (browser refresh, socket loss, project hot-switch). The session can be
 * reattached later (PRD §3.5).
 */
export interface DetachMessage {
  type: "detach";
  projectId: string;
}

/** Terminate and clean up a project's session entirely (PRD §5.2 teardown). */
export interface KillMessage {
  type: "kill";
  projectId: string;
}

/**
 * Inject the serialized canvas state into the session loop (PRD §3.2).
 * The backend feeds the document to the harness as contextual memory.
 */
export interface ContextMessage {
  type: "context";
  projectId: string;
  document: string;
}

export interface BoardIdeaCard {
  ref: string | null;
  id: string;
  kind: string;
  title: string;
  body: string;
  origin: "ai" | "user";
  createdAt?: number;
  starred: boolean;
  done: boolean;
  superseded: boolean;
  score?: { impact: number; effort: number; confidence?: number };
  position: { x: number; y: number };
}

export interface BoardIdeaEdge {
  from: string | null;
  to: string | null;
  fromId: string;
  toId: string;
  relation: IdeaRelation;
}

export interface BoardIdeasSnapshot {
  version: 1;
  pageId: string;
  updatedAt: number;
  cards: BoardIdeaCard[];
  edges: BoardIdeaEdge[];
  selection: { refs: string[]; ids: string[] };
  filter?: Record<string, unknown>;
}

/**
 * Browser-published active-board read model for MCP read tools (#196). The
 * backend cannot inspect tldraw directly, so the mounted canvas sends the
 * normalized current-page idea state for its own project/session route.
 */
export interface BoardSnapshotMessage {
  type: "board-snapshot";
  projectId: string;
  snapshot: BoardIdeasSnapshot;
}

/**
 * The output format of a spec hand-off (#110/#120) — how the board is converged
 * into a generated artifact. Canonical home: shared, so the frontend framing and
 * the backend run metadata speak the same union.
 */
export type SpecFormat = "prd" | "plan" | "issues" | "tasks";

/**
 * A named, backend-vetted permission a client may request for one agent run
 * (#120). The client never sends raw argv for this — it asks for a capability
 * by name, and the backend maps it to a hardcoded, command-specific flag (see
 * `backend/src/agent/capabilities.ts`). Only `create-issues` exists today: it
 * scopes `gh issue create` permission to the single run that opted in, instead
 * of the user baking it into the project's global agent args.
 */
export type AgentCapability = "create-issues";

/** Downstream agent execution hook (PRD §3.6). */
export interface AgentMessage {
  type: "agent";
  projectId: string;
  /** The orchestrator command to invoke, e.g. "claude" or "aider". */
  command: string;
  /** Static arguments preceding the payload. */
  args?: string[];
  /** The extracted plain-text block contents passed as the functional arg. */
  payload: string;
  /** Working directory for the spawned agent. */
  cwd?: string;
  /**
   * Which hand-off format the payload was framed as (#120). Run metadata, not
   * behaviour: it labels backend logs and is echoed back on the `spawned`
   * status so any attached client can label the run without local state.
   */
  format?: SpecFormat;
  /** Named per-run capabilities the client requests (#120). */
  capabilities?: AgentCapability[];
}

/** Messages sent from the backend daemon to the web client. */
export type ServerMessage =
  | SessionStatusMessage
  | DataMessage
  | IdeaMessage
  | ScoreMessage
  | CompletionMessage
  | ReferenceMessage
  | ExitMessage
  | AgentStatusMessage
  | AgentArtifactsMessage
  | StateResponseMessage
  | ErrorMessage;

/** Acknowledgment for one backend state request. Storage failures include the
 * affected path when available; board conflicts return the latest revision and document. */
export interface StateResponseMessage {
  type: "state-response";
  requestId: string;
  operation: StateOperation;
  ok: boolean;
  data?: unknown;
  error?: string;
  path?: string;
}

/** Lifecycle of a durable session, decoupled from a specific connection. */
export interface SessionStatusMessage {
  type: "session-status";
  projectId: string;
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
  projectId: string;
  score: Score;
}

/**
 * A completion-state change for one EXISTING card (#167). Like a {@link Score} it
 * *updates* a card already on the board rather than creating one: it targets the
 * card's short ref (idea-graph §4) and flips whether the idea is marked done.
 * `done` is explicit (not a bare "mark done" event) so the same channel toggles a
 * card back to open — the agent, or a user un-checking it, needs both directions.
 */
export interface Completion {
  /** Short ref of the card whose completion state is changing (idea-graph §4). */
  ref: string;
  /** True marks the idea done/complete; false reopens it. */
  done: boolean;
}

/**
 * A single completion-state change destined to update an existing card on the
 * canvas (#167). Emitted by the MCP `mark_idea_done` tool (the agent marking an
 * idea complete); the manual context-menu path writes `meta.done` directly on the
 * client and never round-trips through here. Applied last-write-wins per ref.
 */
export interface CompletionMessage {
  type: "completion";
  projectId: string;
  completion: Completion;
}

/**
 * An external-link reference attached to one EXISTING card (#227). Like a
 * {@link Score} or {@link Completion} it *updates* a card already on the board
 * rather than creating one: it targets the card's short ref (idea-graph §4) and
 * carries a plain external URL — Figma, a Google Doc, a spec, any web link — so
 * the reference concept generalizes past the first-class GitHub/Linear issue
 * links (#125). `label` is the optional display text (Confluence-style
 * "text → url"); absent, the canvas derives one from the URL's host.
 */
export interface Reference {
  /** Short ref of the card the reference is attached to (idea-graph §4). */
  ref: string;
  /** The external URL (http/https). */
  url: string;
  /** Optional display text; the canvas falls back to the URL's host when absent. */
  label?: string;
}

/**
 * A single external-link reference destined to be attached to an existing card
 * on the canvas (#227). Emitted by the MCP `link_idea` tool (the agent hanging
 * a reference URL off a card); the manual inline editor writes `meta.links`
 * directly on the client and never round-trips through here. Applied additively
 * per ref (deduped by URL, last write wins the label), like the issue links (#125).
 */
export interface ReferenceMessage {
  type: "reference";
  projectId: string;
  reference: Reference;
}

/**
 * Raw PTY output for a project's session — streamed to the browser's xterm.js
 * terminal verbatim (the conversation surface). `data` is base64-encoded so the
 * control bytes of a cursor-addressed TUI survive JSON transport unchanged; the
 * client decodes it and writes the bytes straight into the terminal.
 */
export interface DataMessage {
  type: "data";
  projectId: string;
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
  projectId: string;
  idea: Idea;
}

/** The durable session ended unexpectedly (e.g. killed externally). */
export interface ExitMessage {
  type: "exit";
  projectId: string;
  code: number;
}

/** Lifecycle updates for a downstream agent subprocess (PRD §3.6). */
export interface AgentStatusMessage {
  type: "agent-status";
  projectId: string;
  status: "spawned" | "stdout" | "stderr" | "exit" | "error";
  pid?: number;
  data?: string;
  code?: number;
  /**
   * Echoed on `spawned` when the run carried a {@link SpecFormat} (#120), so a
   * client attaching mid-run (refresh, second tab) can label the run without
   * relying on its own dispatch-time memory.
   */
  format?: SpecFormat;
}

/**
 * A structured artifact a finished agent run produced (#120). Only GitHub
 * issues exist today: the created-issues summary the `issues` + `create-issues`
 * run prints is parsed server-side into `{ title, url }` pairs so the client
 * can render link chips instead of scraping markdown.
 */
export interface AgentArtifact {
  kind: "github-issue";
  title: string;
  url: string;
  /**
   * Short refs of the source cards this issue was created from (#125), parsed
   * from the run's summary table when the hand-off payload was ref-annotated.
   * The client uses them to stamp the created issue's link back onto the
   * originating cards. Absent when the run carried no refs.
   */
  refs?: string[];
}

/**
 * Structured artifacts extracted from a completed agent run (#120). Emitted at
 * most once, on exit of a run that opted into a side-effecting capability;
 * empty artifact lists are not sent.
 */
export interface AgentArtifactsMessage {
  type: "agent-artifacts";
  projectId: string;
  artifacts: AgentArtifact[];
}

/** A recoverable error scoped to a project (or the connection). */
export interface ErrorMessage {
  type: "error";
  projectId?: string;
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

function requireOptionalString(msg: Record<string, unknown>, field: string, type: string): void {
  if (msg[field] !== undefined && typeof msg[field] !== "string") {
    throw new Error(`Malformed \`${type}\` message: \`${field}\` must be a string when present`);
  }
}

function requireOptionalStringArray(msg: Record<string, unknown>, field: string, type: string): void {
  const v = msg[field];
  if (v === undefined) return;
  if (!Array.isArray(v) || v.some((e) => typeof e !== "string")) {
    throw new Error(`Malformed \`${type}\` message: \`${field}\` must be an array of strings when present`);
  }
}

export function parseClientMessage(raw: string): ClientMessage {
  const msg = JSON.parse(raw) as ClientMessage;
  if (typeof msg !== "object" || msg === null || !("type" in msg)) {
    throw new Error("Malformed message: missing `type`");
  }
  if (msg.type !== "attach" && msg.type !== "state-request" && !("projectId" in msg)) {
    throw new Error("Malformed message: missing `projectId`");
  }

  // Per-type field validation so malformed payloads are rejected here with a
  // clear error instead of reaching the session backend as `undefined`.
  const m = msg as unknown as Record<string, unknown>;
  switch (msg.type) {
    case "attach":
      requireString(m, "projectId", "attach");
      requireOptionalString(m, "shell", "attach");
      requireOptionalStringArray(m, "args", "attach");
      requireOptionalString(m, "cwd", "attach");
      requireOptionalString(m, "mode", "attach");
      requireOptionalString(m, "background", "attach");
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
      // projectId checked above; nothing else required.
      break;
    case "context":
      requireString(m, "document", "context");
      break;
    case "board-snapshot":
      if (typeof m.snapshot !== "object" || m.snapshot === null) {
        throw new Error("Malformed `board-snapshot` message: `snapshot` must be an object");
      }
      break;
    case "state-request":
      requireString(m, "requestId", "state-request");
      requireString(m, "operation", "state-request");
      if (!STATE_OPERATIONS.has(m.operation as string))
        throw new Error("Malformed `state-request` message: unknown operation");
      if (m.projectId !== undefined) requireString(m, "projectId", "state-request");
      if (
        m.payload !== undefined &&
        (typeof m.payload !== "object" || m.payload === null || Array.isArray(m.payload))
      ) {
        throw new Error("Malformed `state-request` message: `payload` must be an object");
      }
      break;
    case "agent":
      requireString(m, "command", "agent");
      requireString(m, "payload", "agent");
      // Optional launch fields feed a subprocess spawn (#142): reject shape
      // surprises here (an args entry that is an object, a non-string cwd)
      // instead of letting them reach the spawn layer.
      requireOptionalStringArray(m, "args", "agent");
      requireOptionalStringArray(m, "capabilities", "agent");
      requireOptionalString(m, "cwd", "agent");
      requireOptionalString(m, "format", "agent");
      break;
    default:
      throw new Error(`Malformed message: unknown type \`${(msg as { type: string }).type}\``);
  }
  return msg;
}
