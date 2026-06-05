/**
 * `NodePtySessionBackend` — the Windows implementation of `SessionBackend`
 * (design §5.2). Windows has no tmux, so the "durable session" is an
 * in-process node-pty (ConPTY) keyed by workspaceId.
 *
 * It runs the SAME shared response-extraction rules (`ResponseExtractor`) as
 * the tmux backend; only the byte SOURCE differs. tmux hands us pre-flattened
 * `capture-pane` text; here the raw PTY byte stream is reconstructed into a
 * running transcript via `SlicingBuffer` (ANSI-stripped, CR-rewrites resolved),
 * and that transcript is fed to the extractor as successive "captures".
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
import { SlicingBuffer } from "./line-buffer.ts";
import { ResponseExtractor, getProfile, commandProfileName, type HarnessProfile } from "./extraction.ts";
import type { ResponseChunk, SessionBackend, SessionHandle, SessionSpec } from "./types.ts";

// node-pty ships as CommonJS; the default import is its module.exports.
const pty = ptyDefault as unknown as typeof import("@lydell/node-pty");

/** Pane goes quiet for this long mid-response ⇒ response complete (design §4.3.2). */
const IDLE_COMPLETE_MS = 500;
/** Fallback delay before priming if the readiness marker never appears (§4.3). */
const PRIME_FALLBACK_MS = 3_000;

interface Session {
  term: IPty | null;
  buffer: SlicingBuffer;
  extractor: ResponseExtractor;
  profile: HarnessProfile;
  /** Running transcript of completed logical lines (the "pane" we extract from). */
  transcript: string[];
  onChunk: ((chunk: ResponseChunk) => void) | null;
  onError: ((message: string) => void) | null;
  idleTimer: NodeJS.Timeout | null;
  closed: boolean;
  cols: number;
  rows: number;
  /** Priming instruction awaiting harness readiness (§4); cleared once sent. */
  pendingPrime: string | null;
  primeFallback: NodeJS.Timeout | null;
}

function defaultShell(): { shell: string; args: string[] } {
  if (process.platform === "win32") return { shell: "powershell.exe", args: [] };
  return { shell: process.env.SHELL ?? "/bin/bash", args: ["-i"] };
}

export class NodePtySessionBackend implements SessionBackend {
  readonly runtime = "process" as const;

  #sessions = new Map<string, Session>();
  /**
   * Workspaces already primed this process lifetime (extraction-contract §4.4).
   * In-memory is sufficient on Windows: a node-pty dies with the process, so
   * there is no reattach-after-restart case to defend against (§10.4).
   */
  #primed = new Set<string>();

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
    const requestedArgs = (spec.command ?? "").trim()
      ? spec.args ?? []
      : defaultShell().args;

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

    // Select the harness profile (extraction-contract §7.2): explicit spec wins,
    // else derive from the command basename ("claude" → CLAUDE_PROFILE).
    const profile = getProfile(spec.harnessProfile ?? commandProfileName(requested), (m) =>
      log.warn("extract.profile", { workspace: workspaceId, message: m }),
    );

    // Prime once per process lifetime when the profile supports the contract.
    const shouldPrime = !!spec.prime && profile.supportsIdeaContract && !this.#primed.has(workspaceId);
    if (shouldPrime) this.#primed.add(workspaceId);

    const session: Session = {
      term,
      buffer: new SlicingBuffer(),
      extractor: new ResponseExtractor(profile, {
        onWarn: (m) => log.warn("extract.anchor", { workspace: workspaceId, message: m }),
        onHeuristic: (count) => log.info("extract.heuristic", { workspace: workspaceId, count }),
        // A near-miss (the agent attempted but mangled the «IDEA» marker) is
        // worth a warning; an ordinary chat-only reply is debug-level noise.
        onDebug: (event, data) => {
          const level = typeof data.nearMisses === "number" && data.nearMisses > 0 ? "warn" : "debug";
          log[level](event, { workspace: workspaceId, ...data });
        },
      }),
      profile,
      transcript: [],
      onChunk: null,
      onError: null,
      idleTimer: null,
      closed: false,
      cols,
      rows,
      pendingPrime: shouldPrime ? spec.prime! : null,
      primeFallback: null,
    };
    this.#sessions.set(workspaceId, session);

    term.onData((chunk) => this.#onData(workspaceId, chunk));
    term.onExit(({ exitCode }) => {
      session.closed = true;
      if (session.primeFallback) clearTimeout(session.primeFallback);
      log.info("session.pty_exit", { workspace: workspaceId, code: exitCode });
    });

    // Priming (§4.5): if the readiness marker never lands, prime on a fallback
    // timer. Written raw (no beginResponse), so the READY ack never becomes a
    // response — it stays in scrollback above the first real prompt's baseline.
    if (shouldPrime) {
      session.primeFallback = setTimeout(() => this.#sendPrime(workspaceId), PRIME_FALLBACK_MS);
    }

    log.info("session.created", { workspace: workspaceId, command: launch.cmd, pid: term.pid });
    return { workspaceId, sessionId: `pty-${workspaceId}` };
  }

  /** Write the pending priming instruction once, raw (no echo-skip baseline). */
  #sendPrime(workspaceId: string): void {
    const session = this.#sessions.get(workspaceId);
    if (!session || session.closed || !session.term || !session.pendingPrime) return;
    const prime = session.pendingPrime;
    session.pendingPrime = null;
    if (session.primeFallback) {
      clearTimeout(session.primeFallback);
      session.primeFallback = null;
    }
    try {
      session.term.write(/[\r\n]$/.test(prime) ? prime : prime + "\r");
      log.info("session.primed", { workspace: workspaceId });
    } catch {
      // Terminal torn down; exit handler reports termination.
    }
  }

  async attach(
    workspaceId: string,
    onChunk: (chunk: ResponseChunk) => void,
    onError: (message: string) => void,
  ): Promise<void> {
    const session = this.#sessions.get(workspaceId);
    if (!session) {
      onError(`No session for workspace "${workspaceId}" to attach to.`);
      return;
    }
    session.onChunk = onChunk;
    session.onError = onError;
    log.info("session.attached", { workspace: workspaceId });
  }

  /** Reconstruct the transcript from the byte stream and run the extractor. */
  #onData(workspaceId: string, chunk: string): void {
    const session = this.#sessions.get(workspaceId);
    if (!session) return;
    const { lines } = session.buffer.push(chunk);
    if (lines.length > 0) session.transcript.push(...lines);

    // Priming readiness probe (§4.3): once the harness input box appears, send
    // the pending instruction. Done before extraction so the READY ack — which
    // arrives while not `responding` — is never forwarded as a response (§4.5).
    if (session.pendingPrime && session.profile.readyMarker) {
      const marker = session.profile.readyMarker;
      if (lines.some((l) => marker.test(l)) || marker.test(session.buffer.pending)) {
        this.#sendPrime(workspaceId);
      }
    }

    // Feed the running transcript (+ live partial line) as the current capture.
    const capture = [...session.transcript, session.buffer.pending].join("\n");
    const result = session.extractor.ingest(capture);
    if ((result.chat.length > 0 || result.ideas.length > 0 || result.complete) && session.onChunk) {
      session.onChunk({ workspaceId, chat: result.chat, ideas: result.ideas, complete: result.complete });
    }
    this.#armIdleTimer(workspaceId);
  }

  /** When the stream goes quiet mid-response, finalize via idle timeout. */
  #armIdleTimer(workspaceId: string): void {
    const session = this.#sessions.get(workspaceId);
    if (!session) return;
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      if (!session.extractor.responding) return;
      const fin = session.extractor.finalize();
      if ((fin.chat.length > 0 || fin.ideas.length > 0 || fin.complete) && session.onChunk) {
        session.onChunk({ workspaceId, chat: fin.chat, ideas: fin.ideas, complete: fin.complete });
      }
    }, IDLE_COMPLETE_MS);
  }

  async sendInput(workspaceId: string, data: string): Promise<void> {
    const session = this.#sessions.get(workspaceId);
    if (!session || session.closed || !session.term) return;
    // Record the input so the extractor skips its echo (design §4.3.1).
    session.extractor.beginResponse(data);
    // On a real PTY the trailing carriage return submits the line, so the raw
    // bytes are written as-is (unlike tmux, which submits with a separate Enter).
    const payload = /[\r\n]$/.test(data) ? data : data + "\r";
    try {
      session.term.write(payload);
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
    } catch {
      // ignore resize on a dead terminal
    }
    session.extractor.reanchor();
  }

  detach(workspaceId: string): void {
    const session = this.#sessions.get(workspaceId);
    if (!session) return;
    // Stop streaming to the (now gone) client but leave the PTY alive so a
    // reconnect within this process lifetime can resume (design §5.2).
    session.onChunk = null;
    session.onError = null;
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
    log.info("session.detached", { workspace: workspaceId });
  }

  async kill(workspaceId: string): Promise<void> {
    const session = this.#sessions.get(workspaceId);
    if (!session) return;
    session.closed = true;
    if (session.idleTimer) clearTimeout(session.idleTimer);
    if (session.primeFallback) clearTimeout(session.primeFallback);
    try {
      session.term?.kill();
    } catch {
      // already dead
    }
    this.#sessions.delete(workspaceId);
    this.#primed.delete(workspaceId);
    log.info("session.killed", { workspace: workspaceId });
  }
}
