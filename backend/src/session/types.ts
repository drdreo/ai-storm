/**
 * The `SessionBackend` abstraction (design §5).
 *
 * One interface, two implementations: `TmuxSessionBackend` on POSIX (durable,
 * connection-independent tmux sessions) and `NodePtySessionBackend` on Windows
 * (in-process node-pty). Both stream the raw PTY bytes (rendered by xterm.js in
 * the browser) and, alongside, the ideas extracted server-side from the §3
 * contract — see `docs/design/ai-response-extraction-contract.md`.
 */

import type { Idea, Score } from "@ai-storm/shared";

export type { Idea, Score };

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
  /**
   * Optional harness profile name selecting prompt/chrome rules + the idea
   * contract (extraction-contract §5). E.g. "claude" → the claude profile.
   */
  harnessProfile?: string;
  /**
   * Optional session-priming instruction sent once as the first message when a
   * session is freshly created (extraction-contract §4). Absent for harnesses
   * that don't support the idea contract (a bare shell is never primed).
   */
  prime?: string;
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
   * Begin (or resume) streaming this workspace's session. `onData` receives the
   * raw PTY bytes (for the xterm.js terminal); `onIdea` receives each newly-seen
   * extracted idea (a new card); `onScore` receives each newly-seen triage score
   * (#60) updating an existing card.
   */
  attach(
    workspaceId: string,
    onData: (raw: string) => void,
    onIdea: (idea: Idea) => void,
    onScore: (score: Score) => void,
    onError: (message: string) => void,
  ): Promise<void>;

  /**
   * Forward RAW keystrokes to the session's PTY, verbatim — the xterm.js
   * terminal sends these as the user types (printable bytes, control codes, the
   * carriage return that submits a line). No line editing or Enter synthesis.
   */
  sendInput(workspaceId: string, data: string): Promise<void>;

  /**
   * Submit a complete prompt PROGRAMMATICALLY (priming, canvas-context
   * injection) — clears any partial input, delivers the (possibly multi-line)
   * text, then submits it. Distinct from {@link sendInput} because a real
   * terminal's keystrokes must NOT be line-edited or auto-submitted.
   */
  submitPrompt(workspaceId: string, text: string): Promise<void>;

  /** Inform the session of a new viewport size (cols/rows). */
  resize(workspaceId: string, cols: number, rows: number): Promise<void>;

  /** Stop extracting for this workspace but LEAVE the session alive (refresh/disconnect). */
  detach(workspaceId: string): void;

  /** Terminate and clean up the session (PRD §5.2 teardown). */
  kill(workspaceId: string): Promise<void>;
}
