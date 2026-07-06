/**
 * Daemon lifecycle for the ai-storm launcher (#216): spawn the backend
 * detached with its output captured to a log file, supervise it through a
 * pidfile-style state record, resolve port conflicts, and open the browser.
 *
 * The backend itself is untouched — it is still `node backend/src/main.ts`,
 * here launched with `--static frontend/dist` so one process serves both the
 * API/WebSocket and the built client on the same origin (the frontend already
 * dials `location.host/pty`, so no build-time URL wiring is needed).
 */

import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import {
  backendEntry,
  backendLogFile,
  daemonStateFile,
  frontendDistDir,
  logsDir,
  repoRoot,
  stateDir
} from "./paths.ts";
import { color, info } from "./ui.ts";

/** What `daemon.json` records about the supervised process. */
export interface DaemonState {
  pid: number;
  port: number;
  startedAt: string;
  logFile: string;
  root: string;
}

/** Shape of the backend's `/health` response (backend/src/server.ts). */
export interface HealthPayload {
  status: string;
  os: string;
  runtime: string;
}

export const DEFAULT_PORT = 8787;
/** How far past the preferred port the conflict scan walks. */
const PORT_SCAN_RANGE = 20;
const HEALTH_TIMEOUT_MS = 1500;
const STARTUP_DEADLINE_MS = 30_000;
/** Rotate the backend log once it crosses this size (single .1 generation). */
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;

// ---------------------------------------------------------------------------
// State file

export function readDaemonState(): DaemonState | null {
  try {
    const raw = JSON.parse(readFileSync(daemonStateFile(), "utf8"));
    if (typeof raw?.pid === "number" && typeof raw?.port === "number") return raw as DaemonState;
  } catch {
    // Missing or corrupt — treated as "no supervised daemon".
  }
  return null;
}

export function writeDaemonState(state: DaemonState): void {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(daemonStateFile(), JSON.stringify(state, null, 2) + "\n");
}

export function clearDaemonState(): void {
  rmSync(daemonStateFile(), { force: true });
}

export function isPidAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission/existence check without delivering.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Health + ports

/**
 * `true` when a health payload identifies an ai-storm backend — used to tell
 * "our daemon on this port" apart from an unrelated service squatting on it.
 */
export function looksLikeAiStorm(body: unknown): body is HealthPayload {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as HealthPayload).status === "ok" &&
    typeof (body as HealthPayload).runtime === "string"
  );
}

/** Probe `/health` on a port; null when unreachable or not JSON. */
export async function probeHealth(port: number): Promise<unknown | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS)
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Bind-test a loopback port. Resolves `true` when it is free to listen on. */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", () => resolve(false));
    probe.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      probe.close(() => resolve(true));
    });
  });
}

/**
 * Resolve the port to start on. If the preferred port is busy with something
 * that is NOT ai-storm, walk forward until a free port is found (§port
 * conflict handling in #216). An ai-storm already on the preferred port is
 * reported by the caller via `findRunningInstance` before this is reached.
 */
export async function pickPort(preferred: number): Promise<number> {
  for (let port = preferred; port <= preferred + PORT_SCAN_RANGE; port++) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(
    `No free port found between ${preferred} and ${preferred + PORT_SCAN_RANGE}. ` +
      `Pass --port to choose one explicitly.`
  );
}

/**
 * Locate an already-running backend: first the supervised one recorded in
 * daemon.json, then an unsupervised one answering on the preferred port
 * (e.g. started manually via `pnpm start:backend`).
 */
export async function findRunningInstance(
  preferredPort: number
): Promise<{ port: number; supervised: boolean } | null> {
  const state = readDaemonState();
  if (state && isPidAlive(state.pid) && looksLikeAiStorm(await probeHealth(state.port))) {
    return { port: state.port, supervised: true };
  }
  if (state) clearDaemonState(); // stale record — the process is gone
  if (looksLikeAiStorm(await probeHealth(preferredPort))) {
    return { port: preferredPort, supervised: false };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Build bootstrap

/** Run a package-manager/build step attached to the terminal; throw on failure. */
function run(cmd: string, args: string[], cwd: string): void {
  info(color.dim(`  $ ${cmd} ${args.join(" ")}`));
  const res = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  if (res.status !== 0) {
    throw new Error(`\`${cmd} ${args.join(" ")}\` failed with exit code ${res.status ?? "unknown"}`);
  }
}

/**
 * Make the checkout runnable: install workspace dependencies when
 * node_modules is missing and produce the client bundle when frontend/dist
 * is missing. Idempotent and quiet when everything is already in place.
 */
export function ensureBuilt(root: string = repoRoot()): void {
  if (!existsSync(join(root, "node_modules"))) {
    info("Installing dependencies (first run)…");
    run("pnpm", ["install"], root);
  }
  const distIndex = join(frontendDistDir(root), "index.html");
  if (!existsSync(distIndex)) {
    info("Building the client bundle (first run)…");
    run("pnpm", ["build"], root);
  }
  if (!existsSync(distIndex)) {
    throw new Error(`Client build did not produce ${distIndex}`);
  }
}

// ---------------------------------------------------------------------------
// Start / stop

function rotateLogIfLarge(logFile: string): void {
  try {
    if (statSync(logFile).size > LOG_ROTATE_BYTES) {
      renameSync(logFile, logFile + ".1");
    }
  } catch {
    // No previous log — nothing to rotate.
  }
}

export interface StartOptions {
  port: number;
  foreground: boolean;
}

/**
 * Spawn the backend and wait until `/health` answers. Returns the state
 * record of the now-live daemon. In foreground mode the child inherits this
 * terminal and the promise only resolves once it is healthy (the process
 * keeps running until Ctrl-C).
 */
export async function startDaemon(opts: StartOptions): Promise<DaemonState> {
  const root = repoRoot();
  const logFile = backendLogFile();
  mkdirSync(logsDir(), { recursive: true });
  rotateLogIfLarge(logFile);

  const args = [
    backendEntry(root),
    "--static",
    frontendDistDir(root),
    "--port",
    String(opts.port),
    "--host",
    "127.0.0.1"
  ];

  let child;
  if (opts.foreground) {
    child = spawn(process.execPath, args, { cwd: root, stdio: "inherit" });
  } else {
    const out = openSync(logFile, "a");
    child = spawn(process.execPath, args, {
      cwd: root,
      detached: process.platform !== "win32",
      stdio: ["ignore", out, out],
      windowsHide: true
    });
    closeSync(out);
  }

  if (child.pid === undefined) throw new Error("Failed to spawn the backend process");
  const state: DaemonState = {
    pid: child.pid,
    port: opts.port,
    startedAt: new Date().toISOString(),
    logFile,
    root
  };

  let exited = false;
  child.once("exit", () => {
    exited = true;
  });

  // Poll /health until the daemon answers or the startup deadline passes.
  const deadline = Date.now() + STARTUP_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (exited) break;
    if (looksLikeAiStorm(await probeHealth(opts.port))) {
      writeDaemonState(state);
      if (!opts.foreground) child.unref();
      return state;
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  // Startup failed — surface the log tail so the user sees why.
  if (!exited) {
    try {
      process.kill(child.pid);
    } catch {
      // already gone
    }
  }
  const tail = opts.foreground ? "" : readLogTail(logFile, 30);
  throw new Error(
    `Backend did not become healthy on port ${opts.port} within ${STARTUP_DEADLINE_MS / 1000}s.` +
      (tail ? `\n\nLast log lines (${logFile}):\n${tail}` : "")
  );
}

/**
 * Stop the supervised daemon. Returns `false` when nothing was running.
 * On POSIX the durable tmux sessions intentionally survive (PRD §3.5) — the
 * next start reconciles and re-exposes them.
 */
export async function stopDaemon(): Promise<boolean> {
  const state = readDaemonState();
  if (!state || !isPidAlive(state.pid)) {
    clearDaemonState();
    return false;
  }

  if (process.platform === "win32") {
    // `/T` kills the tree — on Windows PTY children die with the daemon anyway.
    spawnSync("taskkill", ["/pid", String(state.pid), "/T", "/F"], { windowsHide: true });
  } else {
    process.kill(state.pid, "SIGTERM");
    const deadline = Date.now() + 5000;
    while (isPidAlive(state.pid) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (isPidAlive(state.pid)) process.kill(state.pid, "SIGKILL");
  }
  clearDaemonState();
  return true;
}

// ---------------------------------------------------------------------------
// Logs + browser

export function readLogTail(logFile: string, lines: number): string {
  try {
    const content = readFileSync(logFile, "utf8");
    return content
      .split("\n")
      .slice(-(lines + 1))
      .join("\n")
      .trimEnd();
  } catch {
    return "";
  }
}

/** Open the default browser at `url` — best effort, never throws. */
export function openBrowser(url: string): void {
  try {
    if (process.platform === "darwin") {
      spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    } else if (process.platform === "win32") {
      // `start` is a cmd builtin; the empty string is the window title slot.
      spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true, windowsHide: true }).unref();
    } else {
      spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
    }
  } catch {
    info(color.dim(`Could not open a browser automatically — visit ${url}`));
  }
}
