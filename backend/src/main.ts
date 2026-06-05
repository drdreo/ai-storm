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

  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port") port = Number(args[++i]);
    else if (args[i] === "--host") hostname = args[++i];
    else if (args[i] === "--static") staticDir = args[++i];
  }
  return { hostname, port, staticDir };
}

const config = parseArgs();

// Probe the session runtime up front so a missing prerequisite (e.g. tmux on
// POSIX) surfaces a clear error at startup rather than on first attach (§9).
const backend = getRuntime();
try {
  await backend.preflight();
} catch (err) {
  log.error("backend.preflight_failed", { message: err instanceof Error ? err.message : String(err) });
  process.exit(1);
}

// Boot reconciliation (PRD §3.5): re-expose durable sessions that outlived a
// previous backend process so a workspace `attach` resumes without respawning.
const survivors = await backend.reconcile();
if (survivors.length > 0) {
  log.info("backend.sessions_recovered", { count: survivors.length });
}

const { app, injectWebSocket } = buildApp(config);

const server = serve({ fetch: app.fetch, hostname: config.hostname, port: config.port }, () => {
  log.info("backend.listening", {
    url: `ws://${config.hostname}:${config.port}/pty`,
    runtime: backend.runtime,
    static: config.staticDir,
  });
});

injectWebSocket(server);
