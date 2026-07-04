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
import type { Idea, Score } from "@ai-storm/shared";
import { log } from "../log.ts";
import { resolveLaunch, LaunchNotFoundError, tokenizeCommand } from "../pty/resolve.ts";
import { ScanGate } from "./scan-gate.ts";
import { TerminalScreen } from "./screen.ts";
import {
  IdeaScanner,
  IdeaSink,
  ScoreScanner,
  ScoreSink,
  getProfile,
  commandProfileName,
  launchArgsForProfile,
  type HarnessProfile
} from "./extraction.ts";
import { MCP_SERVER_NAME, mcpRegistry, type McpSessionRegistry } from "../mcp/registry.ts";
import type { SessionBackend, SessionHandle, SessionSpec } from "./types.ts";

// node-pty ships as CommonJS; the default import is its module.exports.
const pty = ptyDefault as unknown as typeof import("@lydell/node-pty");

interface Session {
  term: IPty | null;
  /** Headless VT screen: applies ConPTY's cursor-addressed paint stream so we
   *  can read back a rendered capture (the Windows `capture-pane -p` analog),
   *  scanned for ideas. The browser xterm.js renders the same byte stream. */
  screen: TerminalScreen;
  /** Session dedupe authority for ideas — shared by every producer (the capture
   *  scanner today; the MCP `capture_idea` tool next, mcp-idea-capture §6). */
  ideaSink: IdeaSink;
  /** Session dedupe authority for scores — same sharing contract as {@link ideaSink}. */
  scoreSink: ScoreSink;
  scanner: IdeaScanner;
  /** Triage scanner (#60): pulls `«SCORE@ref»` markers off the same rendered buffer. */
  scoreScanner: ScoreScanner;
  /** WHEN-to-scan policy (scan-gate.ts): quiescence debounce + resize settle.
   *  Scanning per PTY chunk read half-painted repaint frames (mcp-idea-capture
   *  §1.1); the gate coalesces a burst into one scan of the settled screen. */
  gate: ScanGate;
  /** Screen writes currently in flight. `#onData` is async (`await
   *  screen.write`), so the gate's debounced scan callback may fire while a
   *  chunk is still being applied; it must never snapshot a half-written
   *  screen. Non-zero → the scan defers (the write's `finally` re-arms the
   *  gate, so the scan re-runs against the fully-written screen). */
  writesInFlight: number;
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
  /** MCP routing/auth registry (mcp-idea-capture §4.1). Tokens are in-memory
   *  only on Windows: the PTY dies with this process (§10.4), so there is no
   *  durable session a restored token could route to (design §4.2). */
  readonly #mcp: McpSessionRegistry;

  constructor(opts: { registry?: McpSessionRegistry } = {}) {
    this.#mcp = opts.registry ?? mcpRegistry;
  }

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

    // The harness field may carry inline args ("claude --model=opus"); split
    // them off so only the executable is resolved on PATH and the rest become
    // leading args (quote-aware, so a quoted path with spaces stays one token).
    const rawCommand = (spec.command ?? "").trim();
    const tokens = tokenizeCommand(rawCommand);
    const requested = tokens[0] || defaultShell().shell;
    const baseArgs = rawCommand ? [...tokens.slice(1), ...(spec.args ?? [])] : defaultShell().args;

    // Select the harness profile (extraction-contract §7.2): explicit spec wins,
    // else derive from the command basename ("claude" → CLAUDE_PROFILE).
    const profile = getProfile(spec.harnessProfile ?? commandProfileName(requested), (m) =>
      log.warn("extract.profile", { workspace: workspaceId, message: m })
    );

    // MCP wiring (mcp-idea-capture §4): mint the per-session token + URL so the
    // launch args can carry them. Unconfigured registry → undefined → markers.
    const mcpTarget = profile.mcpArgs ? this.#mcp.registerSession(workspaceId) : undefined;
    // Add profile-level launch args: defaults (e.g. codex --no-alt-screen),
    // model default (if any), MCP wiring, and the system-prompt injection seam.
    const requestedArgs = launchArgsForProfile(
      profile,
      baseArgs,
      spec.prime,
      mcpTarget ? { url: mcpTarget.url, serverName: MCP_SERVER_NAME } : undefined
    );

    let launch;
    try {
      launch = resolveLaunch(requested, requestedArgs);
    } catch (err) {
      // The minted token must not outlive a launch that never happened.
      this.#mcp.removeSession(workspaceId);
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
      FORCE_COLOR: spec.env?.FORCE_COLOR ?? "1"
    });

    const term = pty.spawn(launch.cmd, launch.args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd: spec.cwd ?? process.cwd(),
      env
    });

    const ideaSink = new IdeaSink();
    const scoreSink = new ScoreSink();
    const session: Session = {
      term,
      screen: new TerminalScreen(cols, rows),
      ideaSink,
      scoreSink,
      scanner: new IdeaScanner({
        sink: ideaSink,
        // Two-frame confirmation: ConPTY repaints (especially after a resize)
        // can be captured mid-paint; requiring an identical identity key in two
        // consecutive scans kills the half-painted mis-parse generically
        // (mcp-idea-capture §1.1).
        confirm: true,
        // A near-miss (the agent attempted but mangled the «IDEA» marker) is
        // worth a warning; an ordinary scan is debug-level noise.
        onDebug: (event, data) => {
          const level = typeof data.nearMisses === "number" && data.nearMisses > 0 ? "warn" : "debug";
          log[level](event, { workspace: workspaceId, ...data });
        }
      }),
      scoreScanner: new ScoreScanner(scoreSink),
      // Push-mode gate: the scan runs once output has been quiet (~175 ms),
      // with a ~500 ms cap during continuous streams and a settle window after
      // a resize. The raw byte stream to the browser is NEVER delayed — only
      // the scan is debounced.
      gate: new ScanGate({ onScan: () => this.#scanNow(workspaceId) }),
      writesInFlight: 0,
      profile,
      onData: null,
      onIdea: null,
      onScore: null,
      onError: null,
      closed: false,
      cols,
      rows
    };
    this.#sessions.set(workspaceId, session);

    term.onData((chunk) => {
      this.#onData(workspaceId, chunk).catch((err) =>
        log.warn("pty.ondata_error", {
          workspace: workspaceId,
          message: err instanceof Error ? err.message : String(err)
        })
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
    onError: (message: string) => void
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
    // Route the MCP tool path into this attachment (mcp-idea-capture §6) —
    // shared sinks, same WS callbacks. No-op for markers-only sessions.
    this.#mcp.attachSession(workspaceId, {
      ideaSink: session.ideaSink,
      scoreSink: session.scoreSink,
      onIdea,
      onScore
    });
    log.info("session.attached", { workspace: workspaceId });
  }

  /**
   * Per PTY chunk: forward the raw bytes to the client (xterm.js renders them),
   * apply them to the headless screen, then NOTE activity on the scan gate. The
   * scan itself is debounced (ScanGate): scanning after every chunk read
   * half-painted repaint frames — a chunk boundary mid-marker-line with rows
   * below already painted defeats the growing-tail hold-back (mcp-idea-capture
   * §1.1). Rendering (screen.write) stays per-chunk so the screen never lags;
   * only the SCAN waits for quiescence.
   */
  async #onData(workspaceId: string, chunk: string): Promise<void> {
    const session = this.#sessions.get(workspaceId);
    if (!session) return;

    // 1) Raw bytes → the browser terminal, verbatim and immediately.
    if (session.onData) session.onData(chunk);

    // 2) Render the bytes so the (later) scan sees flattened text. The
    //    in-flight counter lets the gate's scan callback detect a write it
    //    would otherwise race; the finally re-arms the gate either way.
    session.writesInFlight++;
    try {
      await session.screen.write(chunk);
    } finally {
      session.writesInFlight--;
      if (session.profile.supportsIdeaContract) session.gate.activity();
    }
  }

  /**
   * Gate-fired scan of the FULL buffer (scrollback + viewport) so an «IDEA»
   * line that scrolled off between scans is still caught; session-scoped
   * dedupe makes the re-scan of still-visible lines idempotent. If a screen
   * write is in flight (the cap fired mid-burst), defer: that write's
   * `finally` re-arms the gate, so the scan re-runs against a settled screen
   * instead of snapshotting half-applied bytes.
   */
  #scanNow(workspaceId: string): void {
    const session = this.#sessions.get(workspaceId);
    if (!session || session.closed) return;
    if (session.writesInFlight > 0) return; // re-armed by the pending write's finally
    if (!session.profile.supportsIdeaContract) return;

    const snapshot = session.screen.snapshotAll();
    // Scanner hit on an MCP-wired session = the primed agent lapsed back to
    // marker lines — warn so the lapse is measurable (mcp-idea-capture §6).
    const mcpWired = this.#mcp.isRegistered(workspaceId);
    for (const idea of session.scanner.scan(snapshot)) {
      log[mcpWired ? "warn" : "info"](mcpWired ? "idea.fallback_scan" : "idea.extracted", {
        workspace: workspaceId,
        kind: idea.kind ?? "",
        title: idea.title,
        body: idea.body.slice(0, 120)
      });
      session.onIdea?.(idea);
    }
    // Triage scores (#60) come off the same rendered buffer.
    for (const score of session.scoreScanner.scan(snapshot)) {
      log.info("score.extracted", {
        workspace: workspaceId,
        ref: score.ref,
        impact: score.impact,
        effort: score.effort
      });
      session.onScore?.(score);
    }

    // Two-frame confirmation needs a SECOND look: if this scan parsed
    // candidates that are not yet confirmed and the stream then stays quiet
    // (turn over → no more chunks → no more gate activity), they would stall
    // until the next output burst. Re-arm the gate once; the follow-up scan
    // re-parses the (still settled) screen and confirms them. Terminates: a
    // confirmed candidate enters the sink and stops counting as pending.
    if (session.scanner.pendingConfirmation > 0) session.gate.activity();
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
    // A resize triggers a full clear-and-repaint at the new width — the most
    // hostile window for the scan (mcp-idea-capture §1.1/§1.2). Open the
    // gate's settle window: no scan until the repaint output has been quiet
    // for the settle period. The raw byte stream is unaffected.
    session.gate.resized();
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
    // Drop any pending scan timer (no consumer); the gate stays usable — the
    // next chunk after a reattach re-arms it.
    session.gate.cancel();
    // Tool calls get "session not attached" until reattach; the token lives on.
    this.#mcp.detachSession(workspaceId);
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
    session.gate.dispose(); // never let a debounced scan fire on a dead session
    if (!alreadyExited) {
      try {
        session.term?.kill();
      } catch {
        // already dead
      }
    }
    this.#sessions.delete(workspaceId);
    // Forget the MCP routing entirely — the session's URL 404s from here on.
    this.#mcp.removeSession(workspaceId);
    log.info("session.killed", { workspace: workspaceId });
  }
}
