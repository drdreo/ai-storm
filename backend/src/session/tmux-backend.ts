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
import { writeFileSync, unlinkSync, watch, type FSWatcher } from "node:fs";
import { open } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { log } from "../log.ts";
import { sanitize } from "./ansi.ts";
import { IdeaScanner, ScoreScanner, getProfile, commandProfileName, type HarnessProfile } from "./extraction.ts";
import { tokenizeCommand, hasFlag } from "../pty/resolve.ts";
import type { Idea, Score, SessionBackend, SessionHandle, SessionSpec } from "./types.ts";

const execFileAsync = promisify(execFile);
const TMUX_TIMEOUT_MS = 5_000;
const SESSION_PREFIX = "ai-storm-";

/** Scrollback window captured each poll — generous so fast output isn't lost. */
const CAPTURE_LINES = 2000;
/**
 * Cadence of the `capture-pane` idea scan. The conversation display does NOT
 * depend on this poll — raw bytes stream live via `pipe-pane` — so a steady,
 * low-cost cadence is enough to catch newly-rendered `«IDEA»` markers.
 */
const IDEA_POLL_MS = 400;

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
  scanner: IdeaScanner;
  /** Triage scanner (#60): `«SCORE@ref»` markers off the same capture. */
  scoreScanner: ScoreScanner;
  onIdea: (idea: Idea) => void;
  onScore: (score: Score) => void;
  onError: (message: string) => void;
  timer: NodeJS.Timeout | null;
  lastCapture: string;
  stopped: boolean;
  // ── Raw byte stream (`pipe-pane` → file → onData), for the xterm.js terminal ──
  onData: (raw: string) => void;
  /** Temp file tmux's `pipe-pane` appends the pane's raw output to. */
  rawFile: string | null;
  /** Byte offset already forwarded from {@link rawFile}. */
  rawOffset: number;
  /** Watches {@link rawFile} for appended output. */
  rawWatcher: FSWatcher | null;
  /** Decodes raw bytes into strings across multibyte boundaries. */
  rawDecoder: StringDecoder;
  /** True while a read of {@link rawFile} is in flight (serializes reads). */
  rawReading: boolean;
}

/** Run a tmux command, returning trimmed stdout. Uses execFile (no shell). */
async function defaultTmux(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("tmux", args, {
    timeout: TMUX_TIMEOUT_MS,
    windowsHide: true,
  });
  return stdout.trimEnd();
}

/** Per-session config captured at `create()` and read back at `attach()`. */
interface SessionConfig {
  profile: HarnessProfile;
  cols: number;
}

/**
 * Injectable seams for testing. The real backend shells out to `tmux` and uses
 * a wall-clock sleep; the priming idempotency tests substitute a fake tmux + an
 * instant sleep so the §9 case-8 matrix runs without a tmux server (and fast).
 */
export interface TmuxBackendOptions {
  tmux?: (...args: string[]) => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
}

export class TmuxSessionBackend implements SessionBackend {
  readonly runtime = "tmux" as const;

  #pollers = new Map<string, Poller>();
  /** Profile + pane width per workspace, set at `create()`, used by `attach()`. */
  #configs = new Map<string, SessionConfig>();
  readonly #tmux: (...args: string[]) => Promise<string>;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(opts: TmuxBackendOptions = {}) {
    this.#tmux = opts.tmux ?? defaultTmux;
    this.#sleep = opts.sleep ?? ((ms) => sleep(ms));
  }

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
      out = await this.#tmux("list-sessions", "-F", "#{session_name}");
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
      await this.#tmux("has-session", "-t", this.#target(workspaceId));
      return true;
    } catch {
      return false;
    }
  }

  async create(spec: SessionSpec): Promise<SessionHandle> {
    const { workspaceId } = spec;
    assertValidWorkspaceId(workspaceId);
    const sessionName = this.#sessionName(workspaceId);

    // The harness field may carry inline args ("claude --model=opus"); split
    // off the executable so the profile is keyed on the binary alone and the
    // rest become leading args (quote-aware: a quoted path stays one token).
    const rawCommand = (spec.command ?? "").trim();
    const tokens = tokenizeCommand(rawCommand);
    const command = tokens[0] ?? "";
    const inlineArgs = tokens.slice(1);
    // Select the harness profile from the command basename (e.g. "claude" →
    // CLAUDE_PROFILE), stored so `attach()` builds the extractor with it (§7.2).
    const profileName = spec.harnessProfile ?? commandProfileName(command);
    const profile = getProfile(profileName, (m) =>
      log.warn("extract.profile", { workspace: workspaceId, message: m }),
    );
    const cols = spec.cols ?? 120;
    this.#configs.set(workspaceId, { profile, cols });

    if (await this.hasSession(workspaceId)) {
      // Idempotent: an existing durable session is reused as-is (design §3.3).
      // Priming is baked into the launch command (system-prompt flag), so a
      // reused session is already primed — nothing to (re)do here.
      log.info("session.reuse", { workspace: workspaceId, session: sessionName });
      return { workspaceId, sessionId: sessionName };
    }

    // Prime via the harness's system-prompt flag — the «IDEA» contract becomes
    // part of the system prompt at launch, followed from the first turn with
    // nothing typed into the pane (no readiness/ack/echo dance).
    const primeArgs = profile.systemPromptFlag && spec.prime ? [profile.systemPromptFlag, spec.prime] : [];

    // Default to the profile's preferred model (e.g. claude → haiku) unless the
    // caller already passed the model flag explicitly in the harness args.
    const specArgs = [...inlineArgs, ...(spec.args ?? [])];
    const modelArgs =
      profile.modelFlag && profile.defaultModel && !hasFlag(specArgs, profile.modelFlag)
        ? [profile.modelFlag, profile.defaultModel]
        : [];
    const args = [...specArgs, ...modelArgs, ...primeArgs];
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

    const rows = spec.rows ?? 32;

    await this.#tmux(
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
      await this.#tmux("set-option", "-t", this.#target(workspaceId), "status", "off");
    } catch (err) {
      try {
        await this.#tmux("kill-session", "-t", this.#target(workspaceId));
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
    onData: (raw: string) => void,
    onIdea: (idea: Idea) => void,
    onScore: (score: Score) => void,
    onError: (message: string) => void,
  ): Promise<void> {
    assertValidWorkspaceId(workspaceId);
    // Idempotent reattach: stop any prior poller for this workspace first.
    this.detach(workspaceId);

    const poller: Poller = {
      scanner: new IdeaScanner({
        // A near-miss (the agent attempted but mangled the «IDEA» marker) is
        // worth a warning; an ordinary scan is debug-level noise.
        onDebug: (event, data) => {
          const level = typeof data.nearMisses === "number" && data.nearMisses > 0 ? "warn" : "debug";
          log[level](event, { workspace: workspaceId, ...data });
        },
      }),
      scoreScanner: new ScoreScanner(),
      onIdea,
      onScore,
      onError,
      timer: null,
      lastCapture: "",
      stopped: false,
      onData,
      rawFile: null,
      rawOffset: 0,
      rawWatcher: null,
      rawDecoder: new StringDecoder("utf8"),
      rawReading: false,
    };
    this.#pollers.set(workspaceId, poller);

    // SEED the scanner with the current pane and DISCARD the result so ideas
    // already on screen are never re-emitted: this suppresses the echoed priming
    // instruction's example «IDEA» line AND, on reattach to a running session,
    // the ideas the canvas already holds (a fresh scanner has an empty dedupe
    // set, so without this every visible idea would be re-sent on reconnect).
    try {
      poller.lastCapture = await this.#capture(workspaceId);
      poller.scanner.scan(poller.lastCapture, true);
      // Seed the score scanner too, so scores already on screen (a reattach) and
      // any echoed example «SCORE» line are not re-emitted.
      poller.scoreScanner.scan(poller.lastCapture);
    } catch {
      // Session may not exist yet; the poll loop reports it on the next tick.
    }

    // Begin streaming raw pane bytes to the client (the xterm.js terminal).
    await this.#startRawStream(workspaceId, poller);

    log.info("session.attached", { workspace: workspaceId });
    this.#scheduleTick(workspaceId, IDEA_POLL_MS);
  }

  #scheduleTick(workspaceId: string, delay: number): void {
    const poller = this.#pollers.get(workspaceId);
    if (!poller || poller.stopped) return;
    poller.timer = setTimeout(() => void this.#tick(workspaceId), delay);
  }

  /** Poll `capture-pane` and emit any newly-rendered ideas (display is separate). */
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
      // Transient error; retry on the same cadence.
      this.#scheduleTick(workspaceId, IDEA_POLL_MS);
      return;
    }
    if (poller.stopped) return;
    poller.lastCapture = capture;

    for (const idea of poller.scanner.scan(capture)) {
      log.info("idea.extracted", {
        workspace: workspaceId,
        kind: idea.kind ?? "",
        title: idea.title,
        body: idea.body.slice(0, 120),
      });
      poller.onIdea(idea);
    }

    for (const score of poller.scoreScanner.scan(capture)) {
      log.info("score.extracted", {
        workspace: workspaceId,
        ref: score.ref,
        impact: score.impact,
        effort: score.effort,
      });
      poller.onScore(score);
    }

    this.#scheduleTick(workspaceId, IDEA_POLL_MS);
  }

  /**
   * Tee the pane's raw output to a temp file via `tmux pipe-pane` and forward
   * appended bytes to the client — the faithful (AO-style) terminal stream. We
   * append to a regular file and tail it (rather than a FIFO) so reads never
   * block on the writer and a transient reader gap just leaves bytes on disk.
   */
  async #startRawStream(workspaceId: string, poller: Poller): Promise<void> {
    const file = join(tmpdir(), `ai-storm-pipe-${workspaceId}-${randomUUID().slice(0, 8)}.raw`);
    try {
      writeFileSync(file, "", { encoding: "utf-8", mode: 0o600 });
      poller.rawFile = file;
      poller.rawOffset = 0;
      // `cat >> file` appends this pane's raw stdout (escape sequences intact).
      await this.#tmux("pipe-pane", "-t", this.#target(workspaceId), `cat >> ${shellEscape(file)}`);
      poller.rawWatcher = watch(file, () => void this.#drainRaw(workspaceId));
      // Drain once immediately in case bytes landed before the watcher attached.
      void this.#drainRaw(workspaceId);
    } catch (err) {
      log.warn("pipe.start_failed", {
        workspace: workspaceId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Read everything appended to the pipe file since the last read; forward it. */
  async #drainRaw(workspaceId: string): Promise<void> {
    const poller = this.#pollers.get(workspaceId);
    if (!poller || poller.stopped || !poller.rawFile || poller.rawReading) return;
    poller.rawReading = true;
    try {
      const handle = await open(poller.rawFile, "r");
      try {
        for (;;) {
          const buf = Buffer.allocUnsafe(64 * 1024);
          const { bytesRead } = await handle.read(buf, 0, buf.length, poller.rawOffset);
          if (bytesRead <= 0) break;
          poller.rawOffset += bytesRead;
          const text = poller.rawDecoder.write(buf.subarray(0, bytesRead));
          if (text && !poller.stopped) poller.onData(text);
        }
      } finally {
        await handle.close();
      }
    } catch {
      // File vanished / unreadable — the session is tearing down; ignore.
    } finally {
      poller.rawReading = false;
    }
  }

  /** Stop teeing the pane and remove the pipe file. */
  #stopRawStream(workspaceId: string, poller: Poller): void {
    if (poller.rawWatcher) {
      try {
        poller.rawWatcher.close();
      } catch {
        /* already closed */
      }
      poller.rawWatcher = null;
    }
    // `pipe-pane` with no command toggles the pipe off.
    void this.#tmux("pipe-pane", "-t", this.#target(workspaceId)).catch(() => {});
    if (poller.rawFile) {
      try {
        unlinkSync(poller.rawFile);
      } catch {
        /* best-effort cleanup */
      }
      poller.rawFile = null;
    }
  }

  /** `capture-pane -p` already flattens the screen and drops escapes; sanitize
   *  removes any residual control bytes (design §4.3 step 3). `-J` joins
   *  reflow-wrapped lines back into one logical line so a wrapped «IDEA» is a
   *  single line for the contract parser (extraction-contract §5.4). */
  async #capture(workspaceId: string): Promise<string> {
    const raw = await this.#tmux(
      "capture-pane",
      "-t",
      this.#target(workspaceId),
      "-p",
      "-J",
      "-S",
      `-${CAPTURE_LINES}`,
    );
    return sanitize(raw);
  }

  async sendInput(workspaceId: string, data: string): Promise<void> {
    assertValidWorkspaceId(workspaceId);
    if (data.length === 0) return;
    // Raw passthrough: forward the xterm.js keystrokes (printable bytes, control
    // codes, the submitting carriage return) literally. `-l` stops tmux
    // interpreting them as key NAMES ("Enter"/"C-c"); the bytes reach the pane
    // exactly as typed, which is what an interactive terminal needs.
    try {
      await this.#tmux("send-keys", "-t", this.#target(workspaceId), "-l", data);
    } catch (err) {
      log.warn("send.failed", {
        workspace: workspaceId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Submit a full prompt programmatically (priming / context injection): clear
   * the input line, deliver the text (paste buffer for multi-line/long, literal
   * for short), then submit with a delayed Enter so the harness's line
   * discipline sees a settled line. NOT used for interactive keystrokes.
   */
  async submitPrompt(workspaceId: string, data: string): Promise<void> {
    assertValidWorkspaceId(workspaceId);
    const target = this.#target(workspaceId);
    // tmux submits with a separate Enter, so strip any trailing newline here.
    const text = data.replace(/[\r\n]+$/, "");

    // 1) Clear any partial input first. AO's session-creation path
    //    (runtime-tmux/index.ts) uses `C-u` (readline kill-line) for this, NOT
    //    the `Escape` shown in AO's older tmux.ts: against a readline harness
    //    (python, bash, claude) a lone Escape begins a meta/escape sequence and,
    //    within readline's ~500ms keyseq-timeout, swallows the literal text we
    //    send next — verified to drop input on tmux 3.6b. `C-u` clears the line
    //    without that side effect.
    await this.#tmux("send-keys", "-t", target, "C-u");
    await this.#sleep(100);

    const heavy = text.includes("\n") || text.length > 200;
    if (heavy) {
      // 2) Long/multiline → tmux paste buffer so newlines don't prematurely
      //    submit and large prompts don't overflow (AO tmux.ts:97).
      const bufferName = `ai-storm-${randomUUID().slice(0, 8)}`;
      const tmpPath = join(tmpdir(), `ai-storm-send-${bufferName}.txt`);
      writeFileSync(tmpPath, text, { encoding: "utf-8", mode: 0o600 });
      try {
        await this.#tmux("load-buffer", "-b", bufferName, tmpPath);
        await this.#tmux("paste-buffer", "-b", bufferName, "-t", target, "-d");
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
      await this.#tmux("send-keys", "-t", target, "-l", text);
    }

    // 4) Enter is sent separately, after a delay, so the harness's line
    //    discipline sees a settled line before submit (AO tmux.ts:118).
    await this.#sleep(heavy ? 1000 : 300);
    await this.#tmux("send-keys", "-t", target, "Enter");
  }

  async resize(workspaceId: string, cols: number, rows: number): Promise<void> {
    assertValidWorkspaceId(workspaceId);
    try {
      await this.#tmux("resize-window", "-t", this.#target(workspaceId), "-x", String(cols), "-y", String(rows));
    } catch {
      // Resize is best-effort; a transient failure is non-fatal.
    }
    const config = this.#configs.get(workspaceId);
    if (config) config.cols = cols;
  }

  detach(workspaceId: string): void {
    const poller = this.#pollers.get(workspaceId);
    if (!poller) return;
    poller.stopped = true;
    if (poller.timer) clearTimeout(poller.timer);
    this.#stopRawStream(workspaceId, poller);
    this.#pollers.delete(workspaceId);
    log.info("session.detached", { workspace: workspaceId });
    // The tmux session is intentionally left alive (PRD §3.5).
  }

  async kill(workspaceId: string): Promise<void> {
    assertValidWorkspaceId(workspaceId);
    this.detach(workspaceId);
    this.#configs.delete(workspaceId);
    try {
      await this.#tmux("kill-session", "-t", this.#target(workspaceId));
      log.info("session.killed", { workspace: workspaceId });
    } catch {
      // Session may already be gone — that's fine.
    }
  }
}
