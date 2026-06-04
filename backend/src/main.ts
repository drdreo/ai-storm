/**
 * ai-storm backend daemon entry point (PRD §4.2). Node.js + Hono + node-pty.
 *
 * Run:    pnpm start
 * Trace:  pnpm trace            (loads OTLP exporter via --import ./src/otel.ts)
 * Serve the built client too:  pnpm start -- --static ../frontend/dist/browser
 */

import { serve } from "@hono/node-server";
import { buildApp, type ServerConfig } from "./server.ts";
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
const { app, injectWebSocket } = buildApp(config);

const server = serve({ fetch: app.fetch, hostname: config.hostname, port: config.port }, () => {
  log.info("backend.listening", {
    url: `ws://${config.hostname}:${config.port}/pty`,
    static: config.staticDir,
  });
});

injectWebSocket(server);
