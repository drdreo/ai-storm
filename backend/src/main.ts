/**
 * ai-storm backend daemon entry point (PRD §4.2). Node.js + Hono + node-pty.
 *
 * Run:    pnpm start
 * Trace:  pnpm trace            (loads OTLP exporter via --import ./src/otel.ts)
 * Serve the built client too:  pnpm start -- --static ../frontend/dist/browser
 */

import { serve } from "@hono/node-server";
import { buildApp, type ServerConfig } from "./server.ts";
import { getRuntime } from "./session/runtime.ts";
import { log } from "./log.ts";

function parseArgs(): ServerConfig {
  const env = process.env;
  let port = Number(env.AI_STORM_PORT ?? 8787);
  let hostname = env.AI_STORM_HOST ?? "127.0.0.1";
  let staticDir = env.AI_STORM_STATIC;
  let agentTimeoutMs: number | undefined;

  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port") port = Number(args[++i]);
    else if (args[i] === "--host") hostname = args[++i];
    else if (args[i] === "--static") staticDir = args[++i];
    else if (args[i] === "--agent-timeout-ms") agentTimeoutMs = Number(args[++i]);
  }
  return { hostname, port, staticDir, agentTimeoutMs };
}

const config = parseArgs();

// Resilience guard for a known @lydell/node-pty Windows teardown bug: its
// `kill()` does `_getConsoleProcessList().then(list => list.forEach(...))` with
// NO `.catch`, and when the forked console-list agent resolves `undefined`
// (the harness process already exited — the exact stop→restart flow used to
// switch facilitation modes, #61), `undefined.forEach` throws inside a promise
// tick. That surfaces as an unhandled rejection which, left alone, terminates
// the whole daemon and every other project's durable session. The fault fires
// asynchronously inside node-pty, so a try/catch at the call site can't catch
// it — only a process-level handler can. We log and keep running rather than
// die; the underlying PTY is already gone, only its handle cleanup is skipped.
process.on("unhandledRejection", (reason) => {
  log.error("backend.unhandled_rejection", {
    message: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined
  });
});
process.on("uncaughtException", (err) => {
  log.error("backend.uncaught_exception", { message: err.message, stack: err.stack });
});

// Probe the session runtime up front so a missing prerequisite (e.g. tmux on
// POSIX) surfaces a clear error at startup rather than on first attach (§9).
const backend = getRuntime();
try {
  await backend.preflight();
} catch (err) {
  log.error("backend.preflight_failed", {
    message: err instanceof Error ? err.message : String(err)
  });
  process.exit(1);
}

// Boot reconciliation (PRD §3.5): re-expose durable sessions that outlived a
// previous backend process so a project `attach` resumes without respawning.
const survivors = await backend.reconcile();
if (survivors.length > 0) {
  log.info("backend.sessions_recovered", { count: survivors.length });
}

const { app, injectWebSocket } = buildApp(config);

const server = serve({ fetch: app.fetch, hostname: config.hostname, port: config.port }, () => {
  log.info("backend.listening", {
    url: `ws://${config.hostname}:${config.port}/pty`,
    runtime: backend.runtime,
    static: config.staticDir
  });
});

injectWebSocket(server);
