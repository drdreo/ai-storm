/**
 * ai-storm backend daemon entry point (PRD §4.2).
 *
 * Run with least-privilege Deno permissions:
 *   deno run \
 *     --allow-net=127.0.0.1 \
 *     --allow-run \
 *     --allow-read=./dist \
 *     --allow-env \
 *     main.ts
 *
 * The `--allow-run` and `--allow-read` grants are deliberately the only
 * file-system / subprocess capabilities, satisfying the restricted local
 * sandbox requirement of PRD §4.2.
 */

import { createServer } from "./src/server.ts";

function parseArgs(): { hostname: string; port: number; staticDir?: string } {
  const env = Deno.env.toObject();
  let port = Number(env.AI_STORM_PORT ?? 8787);
  let hostname = env.AI_STORM_HOST ?? "127.0.0.1";
  let staticDir = env.AI_STORM_STATIC;

  for (let i = 0; i < Deno.args.length; i++) {
    const arg = Deno.args[i];
    if (arg === "--port") port = Number(Deno.args[++i]);
    else if (arg === "--host") hostname = Deno.args[++i];
    else if (arg === "--static") staticDir = Deno.args[++i];
  }

  return { hostname, port, staticDir };
}

if (import.meta.main) {
  const config = parseArgs();
  createServer(config);
  console.log(
    `ai-storm backend listening on ws://${config.hostname}:${config.port}/pty` +
      (config.staticDir ? ` (serving ${config.staticDir})` : ""),
  );
}
