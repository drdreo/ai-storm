/**
 * `TmuxSessionBackend` — the POSIX implementation of `SessionBackend` (design
 * §5.1). Ports agent-orchestrator's session + transport layer (design §2,
 * Appendix A) and adds the net-new capture-pane response extractor (§4.3).
 *
 * Durability (PRD §3.5): the harness runs in a detached, named tmux session
 * (`ai-storm-<workspaceId>`) wrapped in a keep-alive interactive shell, so it
 * survives backend restarts, browser refreshes, and socket drops. `attach`
 * after a restart simply resumes polling the still-alive pane.
 *
 * Security / exact addressing: `<workspaceId>` is validated against
 * `^[a-zA-Z0-9_-]+$` before ANY tmux interpolation (the injection guard,
 * design §9). The design also calls for the exact-match `=` target prefix to
 * prevent `ws-1` matching `ws-15`; however tmux 3.6b (the verified version)
 * does NOT honor `=` consistently across subcommands — `capture-pane`,
 * `send-keys` and `set-option` reject `-t =name` ("can't find pane" / "no such
 * session"). We therefore address every session by its validated FULL name
 * (`ai-storm-<workspaceId>`). Prefix collision is a non-issue in practice: the
 * client mints workspace IDs as fixed-length `ws_<uuid>` values, so no name is
 * a prefix of another; the `^[a-zA-Z0-9_-]+$` guard remains the security
 * control. (AO's own core `tmux.ts` likewise targets by bare session name.)
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { log } from "../log.ts";
import { sanitize } from "./ansi.ts";
import { ResponseExtractor, getProfile } from "./extraction.ts";
import type { ResponseChunk, SessionBackend, SessionHandle, SessionSpec } from "./types.ts";

const execFileAsync = promisify(execFile);
const TMUX_TIMEOUT_MS = 5_000;
const SESSION_PREFIX = "ai-storm-";

/** Scrollback window captured each poll — generous so fast output isn't lost. */
const CAPTURE_LINES = 2000;
/** Poll cadence while a response is actively streaming (design §4.3.2). */
const ACTIVE_POLL_MS = 100;
/** Poll cadence while idle — near-zero CPU between responses. */
const IDLE_POLL_MS = 600;
/** Pane byte-identical for this long while responding ⇒ response complete. */
const IDLE_COMPLETE_MS = 500;

/** Only safe characters in workspace IDs — the injection guard (design §9). */
const SAFE_WORKSPACE_ID = /^[a-zA-Z0-9_-]+$/;

function assertValidWorkspaceId(id: string): void {
  if (!SAFE_WORKSPACE_ID.test(id)) {
    throw new Error(`Invalid workspaceId "${id}": must match ${SAFE_WORKSPACE_ID}`);
  }
}

/** POSIX single-quote escaping for safe interpolation into a shell command. */
function shellEscape(arg: string): string {
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

/**
 * Keep-alive shell appended after the harness launch so the pane (and thus the
 * session) survives the agent exiting (AO index.ts:49). `exec` replaces the
 * wrapping shell with the user's interactive shell.
 */
const KEEP_ALIVE_SHELL = `exec "\${SHELL:-/bin/bash}" -i`;

function withKeepAliveShell(command: string): string {
  return `${command.replace(/\n+$/, "")}\n${KEEP_ALIVE_SHELL}`;
}

/** Long launch commands go through a self-deleting script (AO index.ts:101). */
function writeLaunchScript(command: string): string {
  const scriptPath = join(tmpdir(), `ai-storm-launch-${randomUUID()}.sh`);
  const content = `#!/usr/bin/env bash\nrm -- "$0" 2>/dev/null || true\n${withKeepAliveShell(command)}\n`;
  writeFileSync(scriptPath, content, { encoding: "utf-8", mode: 0o700 });
  return `bash ${shellEscape(scriptPath)}`;
}

interface Poller {
  extractor: ResponseExtractor;
  onChunk: (chunk: ResponseChunk) => void;
  onError: (message: string) => void;
  timer: NodeJS.Timeout | null;
  lastCapture: string;
  idleSince: number | null;
  stopped: boolean;
}

/** Run a tmux command, returning trimmed stdout. Uses execFile (no shell). */
async function tmux(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("tmux", args, {
    timeout: TMUX_TIMEOUT_MS,
    windowsHide: true,
  });
  return stdout.trimEnd();
}

export class TmuxSessionBackend implements SessionBackend {
  readonly runtime = "tmux" as const;

  #pollers = new Map<string, Poller>();

  #sessionName(workspaceId: string): string {
    return `${SESSION_PREFIX}${workspaceId}`;
  }

  /**
   * tmux target for this workspace. The full, injection-guarded session name is
   * used rather than the `=name` exact-match prefix, which tmux 3.6b rejects for
   * `capture-pane`/`send-keys`/`set-option` (see the class header). Names are
   * collision-free `ai-storm-ws_<uuid>` values, so this is exact in practice.
   */
  #target(workspaceId: string): string {
    return this.#sessionName(workspaceId);
  }

  async preflight(): Promise<void> {
    try {
      await execFileAsync("tmux", ["-V"], { timeout: TMUX_TIMEOUT_MS, windowsHide: true });
    } catch {
      throw new Error(
        "tmux is required on POSIX but was not found on PATH. Install it: " +
          "sudo apt install tmux (Debian/Ubuntu), sudo dnf install tmux (Fedora), " +
          "or brew install tmux (macOS).",
      );
    }
  }

  /** Enumerate surviving `ai-storm-*` sessions and re-expose them (PRD §3.5). */
  async reconcile(): Promise<string[]> {
    let out: string;
    try {
      out = await tmux("list-sessions", "-F", "#{session_name}");
    } catch {
      return []; // no tmux server / no sessions
    }
    const workspaces = out
      .split("\n")
      .map((l) => l.trim())
      .filter((name) => name.startsWith(SESSION_PREFIX))
      .map((name) => name.slice(SESSION_PREFIX.length));
    if (workspaces.length > 0) {
      log.info("session.reconcile", { count: workspaces.length, workspaces: workspaces.join(",") });
    }
    return workspaces;
  }

  async hasSession(workspaceId: string): Promise<boolean> {
    assertValidWorkspaceId(workspaceId);
    try {
      await tmux("has-session", "-t", this.#target(workspaceId));
      return true;
    } catch {
      return false;
    }
  }

  async create(spec: SessionSpec): Promise<SessionHandle> {
    const { workspaceId } = spec;
    assertValidWorkspaceId(workspaceId);
    const sessionName = this.#sessionName(workspaceId);

    if (await this.hasSession(workspaceId)) {
      // Idempotent: an existing durable session is reused as-is (design §3.3).
      log.info("session.reuse", { workspace: workspaceId, session: sessionName });
      return { workspaceId, sessionId: sessionName };
    }

    const command = (spec.command ?? "").trim();
    const args = spec.args ?? [];
    // Build the launch command line. With no harness, the pane is just the
    // interactive keep-alive shell; otherwise the harness runs, then the
    // keep-alive shell takes over when it exits.
    const launch = command
      ? withKeepAliveShell([command, ...args].map(shellEscape).join(" "))
      : KEEP_ALIVE_SHELL;
    const shellCommand = launch.length > 200 ? writeLaunchScript(launch) : launch;

    const envArgs: string[] = [];
    for (const [key, value] of Object.entries(spec.env ?? {})) {
      envArgs.push("-e", `${key}=${value}`);
    }

    const cols = spec.cols ?? 120;
    const rows = spec.rows ?? 32;

    await tmux(
      "new-session",
      "-d",
      "-s",
      sessionName,
      "-c",
      spec.cwd ?? process.cwd(),
      "-x",
      String(cols),
      "-y",
      String(rows),
      ...envArgs,
      shellCommand,
    );

    // Hide the status bar so the green footer isn't mistaken for content.
    // Kill the session on failure so we never orphan a half-configured one.
    try {
      await tmux("set-option", "-t", this.#target(workspaceId), "status", "off");
    } catch (err) {
      try {
        await tmux("kill-session", "-t", this.#target(workspaceId));
      } catch {
        // best-effort cleanup
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to configure session "${sessionName}": ${msg}`, { cause: err });
    }

    log.info("session.created", { workspace: workspaceId, session: sessionName, command: command || "(shell)" });
    return { workspaceId, sessionId: sessionName };
  }

  async attach(
    workspaceId: string,
    onChunk: (chunk: ResponseChunk) => void,
    onError: (message: string) => void,
  ): Promise<void> {
    assertValidWorkspaceId(workspaceId);
    // Idempotent reattach: stop any prior poller for this workspace first.
    this.detach(workspaceId);

    const extractor = new ResponseExtractor(
      getProfile(undefined, (m) => log.warn("extract.profile", { workspace: workspaceId, message: m })),
      (m) => log.warn("extract.anchor", { workspace: workspaceId, message: m }),
    );
    const poller: Poller = {
      extractor,
      onChunk,
      onError,
      timer: null,
      lastCapture: "",
      idleSince: null,
      stopped: false,
    };
    this.#pollers.set(workspaceId, poller);

    // Seed the extractor with the current idle pane so a send taken immediately
    // after attach baselines off the real prompt, not an empty pane.
    try {
      poller.lastCapture = await this.#capture(workspaceId);
      extractor.ingest(poller.lastCapture);
    } catch {
      // Session may not exist yet; the poll loop reports it on the next tick.
    }

    log.info("session.attached", { workspace: workspaceId });
    this.#scheduleTick(workspaceId, IDLE_POLL_MS);
  }

  #scheduleTick(workspaceId: string, delay: number): void {
    const poller = this.#pollers.get(workspaceId);
    if (!poller || poller.stopped) return;
    poller.timer = setTimeout(() => void this.#tick(workspaceId), delay);
  }

  async #tick(workspaceId: string): Promise<void> {
    const poller = this.#pollers.get(workspaceId);
    if (!poller || poller.stopped) return;

    let capture: string;
    try {
      capture = await this.#capture(workspaceId);
    } catch {
      // Capture failed — confirm whether the session is truly gone.
      if (!(await this.hasSession(workspaceId))) {
        log.warn("session.lost", { workspace: workspaceId });
        poller.onError(`Session for workspace "${workspaceId}" is no longer alive.`);
        this.detach(workspaceId);
        return;
      }
      // Transient error; retry on the idle cadence.
      this.#scheduleTick(workspaceId, IDLE_POLL_MS);
      return;
    }
    if (poller.stopped) return;

    const changed = capture !== poller.lastCapture;
    poller.lastCapture = capture;

    const result = poller.extractor.ingest(capture);
    if (result.lines.length > 0 || result.complete) {
      poller.onChunk({ workspaceId, lines: result.lines, complete: result.complete });
    }

    // Idle-timeout completion: pane unchanged for IDLE_COMPLETE_MS mid-response.
    const now = Date.now();
    if (changed) {
      poller.idleSince = null;
    } else if (poller.idleSince === null) {
      poller.idleSince = now;
    }
    if (
      poller.extractor.responding &&
      poller.idleSince !== null &&
      now - poller.idleSince >= IDLE_COMPLETE_MS
    ) {
      const fin = poller.extractor.finalize();
      if (fin.lines.length > 0 || fin.complete) {
        poller.onChunk({ workspaceId, lines: fin.lines, complete: fin.complete });
      }
    }

    this.#scheduleTick(workspaceId, poller.extractor.responding ? ACTIVE_POLL_MS : IDLE_POLL_MS);
  }

  /** `capture-pane -p` already flattens the screen and drops escapes; sanitize
   *  removes any residual control bytes (design §4.3 step 3). */
  async #capture(workspaceId: string): Promise<string> {
    const raw = await tmux("capture-pane", "-t", this.#target(workspaceId), "-p", "-S", `-${CAPTURE_LINES}`);
    return sanitize(raw);
  }

  async sendInput(workspaceId: string, data: string): Promise<void> {
    assertValidWorkspaceId(workspaceId);
    const target = this.#target(workspaceId);
    // The frontend appends a carriage return for PTY line discipline; tmux
    // submits with a separate Enter, so strip the trailing newline here.
    const text = data.replace(/[\r\n]+$/, "");

    // Record what we sent so the extractor can skip its echo (design §4.3.1).
    // Done before any keystrokes so the baseline reflects the pre-send pane.
    const poller = this.#pollers.get(workspaceId);
    poller?.extractor.beginResponse(text);
    // Kick the poll loop onto its active cadence immediately rather than
    // waiting out the remaining idle interval, so the echo/response is captured
    // promptly after Enter (design §4.3.2 adaptive cadence).
    if (poller) {
      if (poller.timer) clearTimeout(poller.timer);
      poller.idleSince = null;
      this.#scheduleTick(workspaceId, ACTIVE_POLL_MS);
    }

    // 1) Clear any partial input first. AO's session-creation path
    //    (runtime-tmux/index.ts) uses `C-u` (readline kill-line) for this, NOT
    //    the `Escape` shown in AO's older tmux.ts: against a readline harness
    //    (python, bash, claude) a lone Escape begins a meta/escape sequence and,
    //    within readline's ~500ms keyseq-timeout, swallows the literal text we
    //    send next — verified to drop input on tmux 3.6b. `C-u` clears the line
    //    without that side effect.
    await tmux("send-keys", "-t", target, "C-u");
    await sleep(100);

    const heavy = text.includes("\n") || text.length > 200;
    if (heavy) {
      // 2) Long/multiline → tmux paste buffer so newlines don't prematurely
      //    submit and large prompts don't overflow (AO tmux.ts:97).
      const bufferName = `ai-storm-${randomUUID().slice(0, 8)}`;
      const tmpPath = join(tmpdir(), `ai-storm-send-${bufferName}.txt`);
      writeFileSync(tmpPath, text, { encoding: "utf-8", mode: 0o600 });
      try {
        await tmux("load-buffer", "-b", bufferName, tmpPath);
        await tmux("paste-buffer", "-b", bufferName, "-t", target, "-d");
      } finally {
        try {
          unlinkSync(tmpPath);
        } catch {
          /* ignore cleanup errors */
        }
      }
    } else if (text.length > 0) {
      // 3) Short single-line → literal send (-l stops tmux interpreting words
      //    like "Enter"/"C-c" as keysyms) (AO tmux.ts:113).
      await tmux("send-keys", "-t", target, "-l", text);
    }

    // 4) Enter is sent separately, after a delay, so the harness's line
    //    discipline sees a settled line before submit (AO tmux.ts:118).
    await sleep(heavy ? 1000 : 300);
    await tmux("send-keys", "-t", target, "Enter");
  }

  async resize(workspaceId: string, cols: number, rows: number): Promise<void> {
    assertValidWorkspaceId(workspaceId);
    try {
      await tmux("resize-window", "-t", this.#target(workspaceId), "-x", String(cols), "-y", String(rows));
    } catch {
      // Resize is best-effort; a transient failure is non-fatal.
    }
    // A width change reflows wrapped lines — re-anchor extraction (design §4).
    this.#pollers.get(workspaceId)?.extractor.reanchor();
  }

  detach(workspaceId: string): void {
    const poller = this.#pollers.get(workspaceId);
    if (!poller) return;
    poller.stopped = true;
    if (poller.timer) clearTimeout(poller.timer);
    this.#pollers.delete(workspaceId);
    log.info("session.detached", { workspace: workspaceId });
    // The tmux session is intentionally left alive (PRD §3.5).
  }

  async kill(workspaceId: string): Promise<void> {
    assertValidWorkspaceId(workspaceId);
    this.detach(workspaceId);
    try {
      await tmux("kill-session", "-t", this.#target(workspaceId));
      log.info("session.killed", { workspace: workspaceId });
    } catch {
      // Session may already be gone — that's fine.
    }
  }
}
