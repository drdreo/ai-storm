/**
 * The `SessionBackend` abstraction (design §5).
 *
 * One interface, two implementations: `TmuxSessionBackend` on POSIX (durable,
 * connection-independent tmux sessions) and `NodePtySessionBackend` on Windows
 * (in-process node-pty). Both extract clean responses server-side and never
 * expose the raw terminal — callers receive `ResponseChunk`s, not bytes.
 */

/** Identifies a durable, connection-independent agent session. */
export interface SessionHandle {
  workspaceId: string;
  /** e.g. "ai-storm-<workspaceId>" on tmux; an internal id on Windows. */
  sessionId: string;
}

export interface SessionSpec {
  workspaceId: string;
  /** Harness binary, e.g. "claude". Harness-agnostic; never a headless flag. */
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  /** Optional harness profile name selecting prompt/chrome rules (design §4.3). */
  harnessProfile?: string;
}

/** A single extracted response chunk (clean text), backend-produced. */
export interface ResponseChunk {
  workspaceId: string;
  /** Newly-finalized clean lines, ready for MarkdownBlockParser. */
  lines: string[];
  /** True once idle/prompt-return marks this response complete. */
  complete: boolean;
}

export interface SessionBackend {
  /** The runtime name, for diagnostics: "tmux" | "process". */
  readonly runtime: "tmux" | "process";

  /**
   * Probe that the runtime's prerequisites are present (e.g. `tmux` on PATH).
   * Throws with a clear, actionable message if not (design §9).
   */
  preflight(): Promise<void>;

  /**
   * Reconcile durable sessions that outlived a previous backend process and
   * re-expose them (PRD §3.5). On tmux this enumerates `ai-storm-*` sessions;
   * on Windows it is a no-op (node-pty sessions die with the process — §10.4).
   */
  reconcile(): Promise<string[]>;

  /** Idempotent: create the named session if absent, else no-op. Returns handle. */
  create(spec: SessionSpec): Promise<SessionHandle>;

  /** True if a durable session for this workspace currently exists. */
  hasSession(workspaceId: string): Promise<boolean>;

  /**
   * Begin (or resume) extracting responses; invokes onChunk per finalized batch.
   * Replaces raw-byte streaming — callers never see the raw terminal.
   */
  attach(
    workspaceId: string,
    onChunk: (chunk: ResponseChunk) => void,
    onError: (message: string) => void,
  ): Promise<void>;

  /** Send a prompt to the session (Escape→clear→literal/paste→delayed Enter, §2.3). */
  sendInput(workspaceId: string, data: string): Promise<void>;

  /** Inform the session of a new viewport; re-anchors extraction width (§4 reflow). */
  resize(workspaceId: string, cols: number, rows: number): Promise<void>;

  /** Stop extracting for this workspace but LEAVE the session alive (refresh/disconnect). */
  detach(workspaceId: string): void;

  /** Terminate and clean up the session (PRD §5.2 teardown). */
  kill(workspaceId: string): Promise<void>;
}
