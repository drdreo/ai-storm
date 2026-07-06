#!/usr/bin/env node
/**
 * `ai-storm` — the desktop-grade launcher (issue #216).
 *
 * One command replaces the two-terminal pnpm workflow: `ai-storm` (or
 * `ai-storm start`) preflights the machine, installs/builds on first run,
 * starts the backend daemon detached with the built client served on the same
 * origin, resolves port conflicts, opens the browser, and captures logs to a
 * per-user state directory. `stop`/`restart`/`status`/`logs`/`doctor`/`update`
 * round out the lifecycle.
 *
 * Dependency-free on purpose: it runs straight off a fresh clone (before any
 * `pnpm install`) using only Node built-ins, via Node's native type stripping
 * — the same mechanism the backend already relies on.
 */

import { readFileSync, statSync, watchFile, unwatchFile } from "node:fs";
import { join } from "node:path";
import { parseCliArgs, type CliOptions } from "../src/args.ts";
import {
  DEFAULT_PORT,
  ensureBuilt,
  findRunningInstance,
  isPidAlive,
  looksLikeAiStorm,
  openBrowser,
  pickPort,
  probeHealth,
  readDaemonState,
  readLogTail,
  startDaemon,
  stopDaemon,
  clearDaemonState
} from "../src/daemon.ts";
import { hardFailures, runChecks } from "../src/doctor.ts";
import { backendLogFile, repoRoot } from "../src/paths.ts";
import { updateCheckout } from "../src/update.ts";
import { color, fail, info, mark } from "../src/ui.ts";

const HELP = `${color.bold("ai-storm")} — local-first AI brainstorming canvas

Usage: ai-storm [command] [options]

Commands:
  start        Start the daemon and open the app (default command)
  stop         Stop the daemon (durable tmux sessions survive on POSIX)
  restart      Stop, then start again
  status       Show daemon state, port and health
  logs         Print the backend log (see --follow)
  doctor       Check Node, pnpm, tmux and AI-harness prerequisites
  update       Pull the latest version, rebuild, restart if running
  help         Show this help

Options:
  --port <n>       Preferred port (default ${DEFAULT_PORT}, or $AI_STORM_PORT)
  --no-open        Don't open the browser after start
  --foreground     Run attached to this terminal instead of as a daemon
  -f, --follow     Stream the log file (logs)
  -n, --lines <n>  Trailing log lines to print (logs, default 50)
  --json           Machine-readable output (status)
`;

function preferredPort(opts: CliOptions): number {
  if (opts.port !== undefined) return opts.port;
  const env = Number(process.env.AI_STORM_PORT);
  return Number.isInteger(env) && env > 0 ? env : DEFAULT_PORT;
}

function preflightOrDie(): void {
  const failures = hardFailures(runChecks());
  if (failures.length === 0) return;
  for (const f of failures) console.error(`${mark.fail} ${color.bold(f.name)}: ${f.detail}`);
  fail("Preflight failed — fix the issue(s) above, or run `ai-storm doctor` for the full report.");
}

async function cmdStart(opts: CliOptions): Promise<void> {
  const preferred = preferredPort(opts);

  const running = await findRunningInstance(preferred);
  if (running) {
    const url = `http://127.0.0.1:${running.port}`;
    info(
      `${mark.ok} ai-storm is already running at ${color.cyan(url)}${running.supervised ? "" : color.dim(" (started outside the launcher)")}`
    );
    if (!opts.noOpen) openBrowser(url);
    return;
  }

  preflightOrDie();
  ensureBuilt();

  const port = await pickPort(preferred);
  if (port !== preferred) {
    info(`${mark.warn} Port ${preferred} is in use by another app — using ${color.bold(String(port))} instead.`);
  }

  info(`Starting the ai-storm daemon on port ${port}…`);
  const state = await startDaemon({ port, foreground: opts.foreground });
  const url = `http://127.0.0.1:${port}`;
  info(`${mark.ok} Running at ${color.cyan(url)}  ${color.dim(`(pid ${state.pid})`)}`);
  info(color.dim(`  logs: ${state.logFile}`));
  if (!opts.foreground) info(color.dim("  stop with: ai-storm stop"));
  if (!opts.noOpen) openBrowser(url);

  if (opts.foreground) {
    // Stay attached until the child dies; Ctrl-C reaches it via the shared
    // terminal. Clean the state record on the way out.
    await new Promise<void>((resolve) => {
      const poll = setInterval(() => {
        if (!isPidAlive(state.pid)) {
          clearInterval(poll);
          clearDaemonState();
          resolve();
        }
      }, 500);
    });
  }
}

async function cmdStop(): Promise<void> {
  const stopped = await stopDaemon();
  if (stopped) {
    info(`${mark.ok} Daemon stopped.`);
    if (process.platform !== "win32") {
      info(color.dim("  Durable brainstorm sessions stay alive in tmux and reattach on next start."));
    }
  } else {
    info("No supervised daemon is running.");
  }
}

async function cmdStatus(opts: CliOptions): Promise<void> {
  const state = readDaemonState();
  const alive = state !== null && isPidAlive(state.pid);
  const health = alive ? await probeHealth(state.port) : null;
  const healthy = looksLikeAiStorm(health);

  if (opts.json) {
    info(JSON.stringify({ running: alive, healthy, ...state }, null, 2));
    return;
  }
  if (!state || !alive) {
    info("ai-storm is not running (no supervised daemon).");
    const unmanaged = await probeHealth(DEFAULT_PORT);
    if (looksLikeAiStorm(unmanaged)) {
      info(`${mark.warn} …but an unsupervised backend answers on port ${DEFAULT_PORT} (started manually?).`);
    }
    return;
  }
  info(
    `${healthy ? mark.ok : mark.warn} pid ${state.pid} on ${color.cyan(`http://127.0.0.1:${state.port}`)} — ${healthy ? "healthy" : "running but not answering /health"}`
  );
  info(color.dim(`  started: ${state.startedAt}`));
  info(color.dim(`  logs:    ${state.logFile}`));
}

function cmdLogs(opts: CliOptions): void {
  const logFile = backendLogFile();
  info(color.dim(logFile));
  const tail = readLogTail(logFile, opts.lines);
  if (tail) info(tail);
  else if (!opts.follow) info(color.dim("(log file is empty or does not exist yet)"));

  if (opts.follow) {
    let offset = 0;
    try {
      offset = statSync(logFile).size;
    } catch {
      // File appears once the daemon first writes; start from 0 then.
    }
    watchFile(logFile, { interval: 500 }, (curr) => {
      if (curr.size < offset) offset = 0; // rotated/truncated
      if (curr.size > offset) {
        const buf = readFileSync(logFile);
        process.stdout.write(buf.subarray(offset));
        offset = curr.size;
      }
    });
    process.on("SIGINT", () => {
      unwatchFile(logFile);
      process.exit(0);
    });
  }
}

function cmdDoctor(): void {
  const checks = runChecks();
  info(color.bold("ai-storm doctor\n"));
  for (const c of checks) {
    const icon = c.level === "ok" ? mark.ok : c.level === "warn" ? mark.warn : mark.fail;
    info(`${icon} ${c.name.padEnd(16)} ${c.detail}`);
  }
  const fails = hardFailures(checks);
  info("");
  if (fails.length > 0) {
    fail(`${fails.length} blocking issue(s) found — ai-storm cannot start until they are fixed.`);
  }
  info(`${mark.ok} Ready to brainstorm. Run ${color.bold("ai-storm")} to start.`);
}

async function cmdUpdate(opts: CliOptions): Promise<void> {
  const wasRunning = (await findRunningInstance(preferredPort(opts))) !== null;
  const changed = updateCheckout();
  if (changed && wasRunning) {
    info("Restarting the daemon on the new version…");
    await stopDaemon();
    await cmdStart({ ...opts, noOpen: true });
  }
}

function cmdVersion(): void {
  const pkg = JSON.parse(readFileSync(join(repoRoot(), "package.json"), "utf8"));
  info(`ai-storm v${pkg.version}`);
}

async function main(): Promise<void> {
  let opts: CliOptions;
  try {
    opts = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  try {
    switch (opts.command) {
      case "start":
        await cmdStart(opts);
        break;
      case "stop":
        await cmdStop();
        break;
      case "restart":
        await stopDaemon();
        await cmdStart(opts);
        break;
      case "status":
        await cmdStatus(opts);
        break;
      case "logs":
        cmdLogs(opts);
        break;
      case "doctor":
        cmdDoctor();
        break;
      case "update":
        await cmdUpdate(opts);
        break;
      case "version":
        cmdVersion();
        break;
      case "help":
        info(HELP);
        break;
    }
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

await main();
