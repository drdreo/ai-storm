/**
 * `NodePtySessionBackend` — the Windows implementation of `SessionBackend`
 * (design §5.2). Windows has no tmux, so the "durable session" is an
 * in-process node-pty (ConPTY) keyed by workspaceId.
 *
 * It streams the raw PTY bytes straight to the client (rendered by xterm.js)
 * and, in parallel, feeds them to a headless `TerminalScreen` whose rendered
 * snapshot is scanned for `«IDEA»` markers by the SAME shared `IdeaScanner` the
 * tmux backend uses — only the byte SOURCE differs.
 *
 * WINDOWS PERSISTENCE GAP (design §10.4): unlike a detached tmux session, an
 * in-process node-pty dies when this backend process exits. True PRD §3.5
 * cross-restart durability is therefore POSIX-only for now. AO bridges this on
 * Windows with a detached named-pipe relay helper, which we can adopt later;
 * until then `reconcile()` is a no-op and a backend restart loses Windows
 * sessions (the harness must be relaunched).
 */

import ptyDefault from "@lydell/node-pty";
import type { IPty } from "@lydell/node-pty";
import { log } from "../log.ts";
import { resolveLaunch, LaunchNotFoundError } from "../pty/resolve.ts";
import { TerminalScreen } from "./screen.ts";
import {
  IdeaScanner,
  ScoreScanner,
  getProfile,
  commandProfileName,
  launchArgsForProfile,
  type HarnessProfile,
} from "./extraction.ts";
import type { Idea, Score, SessionBackend, SessionHandle, SessionSpec } from "./types.ts";

// node-pty ships as CommonJS; the default import is its module.exports.
const pty = ptyDefault as unknown as typeof import("@lydell/node-pty");

interface Session {
  term: IPty | null;
  /** Headless VT screen: applies ConPTY's cursor-addressed paint stream so we
   *  can read back a rendered capture (the Windows `capture-pane -p` analog),
   *  scanned for ideas. The browser xterm.js renders the same byte stream. */
  screen: TerminalScreen;
  scanner: IdeaScanner;
  /** Triage scanner (#60): pulls `«SCORE@ref»` markers off the same rendered buffer. */
  scoreScanner: ScoreScanner;
  profile: HarnessProfile;
  onData: ((raw: string) => void) | null;
  onIdea: ((idea: Idea) => void) | null;
  onScore: ((score: Score) => void) | null;
  onError: ((message: string) => void) | null;
  closed: boolean;
  cols: number;
  rows: number;
}

function defaultShell(): { shell: string; args: string[] } {
  if (process.platform === "win32") return { shell: "powershell.exe", args: [] };
  return { shell: process.env.SHELL ?? "/bin/bash", args: ["-i"] };
}

export class NodePtySessionBackend implements SessionBackend {
  readonly runtime = "process" as const;

  #sessions = new Map<string, Session>();

  async preflight(): Promise<void> {
    // node-pty is a hard dependency that is already loaded above; nothing to probe.
  }

  /** No cross-restart persistence on Windows (design §10.4). */
  async reconcile(): Promise<string[]> {
    return [];
  }

  async hasSession(workspaceId: string): Promise<boolean> {
    const s = this.#sessions.get(workspaceId);
    return !!s && !s.closed && s.term !== null;
  }

  async create(spec: SessionSpec): Promise<SessionHandle> {
    const { workspaceId } = spec;
    if (await this.hasSession(workspaceId)) {
      // Idempotent: reuse the live PTY.
      return { workspaceId, sessionId: `pty-${workspaceId}` };
    }

    const requested = (spec.command ?? "").trim() || defaultShell().shell;
    const baseArgs = (spec.command ?? "").trim() ? spec.args ?? [] : defaultShell().args;

    // Select the harness profile (extraction-contract §7.2): explicit spec wins,
    // else derive from the command basename ("claude" → CLAUDE_PROFILE).
    const profile = getProfile(spec.harnessProfile ?? commandProfileName(requested), (m) =>
      log.warn("extract.profile", { workspace: workspaceId, message: m }),
    );

    // Add profile-level launch args: defaults (e.g. codex --no-alt-screen),
    // model default (if any), and the system/developer prompt injection seam.
    const requestedArgs = launchArgsForProfile(profile, baseArgs, spec.prime);

    let launch;
    try {
      launch = resolveLaunch(requested, requestedArgs);
    } catch (err) {
      const message =
        err instanceof LaunchNotFoundError
          ? err.message
          : `Failed to resolve "${requested}": ` + (err instanceof Error ? err.message : String(err));
      throw new Error(message, { cause: err });
    }

    const cols = spec.cols ?? 120;
    const rows = spec.rows ?? 32;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") env[k] = v;
    Object.assign(env, spec.env, {
      TERM: spec.env?.TERM ?? "xterm-256color",
      COLORTERM: "truecolor",
      FORCE_COLOR: spec.env?.FORCE_COLOR ?? "1",
    });

    const term = pty.spawn(launch.cmd, launch.args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd: spec.cwd ?? process.cwd(),
      env,
    });

    const session: Session = {
      term,
      screen: new TerminalScreen(cols, rows),
      scanner: new IdeaScanner({
        // A near-miss (the agent attempted but mangled the «IDEA» marker) is
        // worth a warning; an ordinary scan is debug-level noise.
        onDebug: (event, data) => {
          const level = typeof data.nearMisses === "number" && data.nearMisses > 0 ? "warn" : "debug";
          log[level](event, { workspace: workspaceId, ...data });
        },
      }),
      scoreScanner: new ScoreScanner(),
      profile,
      onData: null,
      onIdea: null,
      onScore: null,
      onError: null,
      closed: false,
      cols,
      rows,
    };
    this.#sessions.set(workspaceId, session);

    term.onData((chunk) => {
      this.#onData(workspaceId, chunk).catch((err) =>
        log.warn("pty.ondata_error", {
          workspace: workspaceId,
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    });
    term.onExit(({ exitCode }) => {
      session.closed = true;
      log.info("session.pty_exit", { workspace: workspaceId, code: exitCode });
    });

    log.info("session.created", { workspace: workspaceId, command: launch.cmd, pid: term.pid });
    return { workspaceId, sessionId: `pty-${workspaceId}` };
  }

  /**
   * Submit a complete prompt programmatically (priming / context injection). On
   * a real PTY a trailing carriage return submits the line, so the text is
   * written with one appended if absent.
   */
  async submitPrompt(workspaceId: string, text: string): Promise<void> {
    const session = this.#sessions.get(workspaceId);
    if (!session || session.closed || !session.term) return;
    try {
      session.term.write(/[\r\n]$/.test(text) ? text : text + "\r");
    } catch {
      // Terminal torn down; exit handler reports termination.
    }
  }

  async attach(
    workspaceId: string,
    onData: (raw: string) => void,
    onIdea: (idea: Idea) => void,
    onScore: (score: Score) => void,
    onError: (message: string) => void,
  ): Promise<void> {
    const session = this.#sessions.get(workspaceId);
    if (!session) {
      onError(`No session for workspace "${workspaceId}" to attach to.`);
      return;
    }
    session.onData = onData;
    session.onIdea = onIdea;
    session.onScore = onScore;
    session.onError = onError;
    log.info("session.attached", { workspace: workspaceId });
  }

  /**
   * Per PTY chunk: forward the raw bytes to the client (xterm.js renders them),
   * apply them to the headless screen, then scan the rendered buffer for ideas.
   */
  async #onData(workspaceId: string, chunk: string): Promise<void> {
    const session = this.#sessions.get(workspaceId);
    if (!session) return;

    // 1) Raw bytes → the browser terminal, verbatim.
    if (session.onData) session.onData(chunk);

    // 2) Render the bytes so the idea scan sees flattened text.
    await session.screen.write(chunk);

    // 3) Scan the FULL buffer (scrollback + viewport) so an «IDEA» line that
    //    scrolled off between chunks is still caught; session-scoped dedupe
    //    makes the re-scan of still-visible lines idempotent.
    if (session.profile.supportsIdeaContract) {
      const snapshot = session.screen.snapshotAll();
      for (const idea of session.scanner.scan(snapshot)) {
        log.info("idea.extracted", {
          workspace: workspaceId,
          kind: idea.kind ?? "",
          title: idea.title,
          body: idea.body.slice(0, 120),
        });
        session.onIdea?.(idea);
      }
      // Triage scores (#60) come off the same rendered buffer.
      for (const score of session.scoreScanner.scan(snapshot)) {
        log.info("score.extracted", {
          workspace: workspaceId,
          ref: score.ref,
          impact: score.impact,
          effort: score.effort,
        });
        session.onScore?.(score);
      }
    }
  }

  async sendInput(workspaceId: string, data: string): Promise<void> {
    const session = this.#sessions.get(workspaceId);
    if (!session || session.closed || !session.term) return;
    // Raw passthrough: xterm.js sends the exact keystrokes (incl. the carriage
    // return that submits a line), so the bytes are written through unchanged.
    try {
      session.term.write(data);
    } catch {
      // Terminal torn down; exit handler reports termination.
    }
  }

  async resize(workspaceId: string, cols: number, rows: number): Promise<void> {
    const session = this.#sessions.get(workspaceId);
    if (!session || session.closed || !session.term) return;
    session.cols = cols;
    session.rows = rows;
    try {
      session.term.resize(cols, rows);
      session.screen.resize(cols, rows);
    } catch {
      // ignore resize on a dead terminal
    }
  }

  detach(workspaceId: string): void {
    const session = this.#sessions.get(workspaceId);
    if (!session) return;
    // Stop streaming to the (now gone) client but leave the PTY alive so a
    // reconnect within this process lifetime can resume (design §5.2).
    session.onData = null;
    session.onIdea = null;
    session.onScore = null;
    session.onError = null;
    log.info("session.detached", { workspace: workspaceId });
  }

  async kill(workspaceId: string): Promise<void> {
    const session = this.#sessions.get(workspaceId);
    if (!session) return;
    // Skip `term.kill()` if the PTY has already exited (onExit set `closed`):
    // node-pty's Windows kill queries the console process list and throws on an
    // already-dead process inside a promise tick (see main.ts guard). The
    // process-level handler is the real safety net; this just avoids tripping it.
    const alreadyExited = session.closed;
    session.closed = true;
    if (!alreadyExited) {
      try {
        session.term?.kill();
      } catch {
        // already dead
      }
    }
    this.#sessions.delete(workspaceId);
    log.info("session.killed", { workspace: workspaceId });
  }
}
