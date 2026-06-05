/**
 * Local-only HTTP + WebSocket server (PRD §4.2), built on Hono.
 *
 * Serves the built Angular client (when present) and exposes a single
 * WebSocket endpoint at `/pty` that multiplexes all workspaces for one client.
 * Bound to 127.0.0.1 so the loop never leaves the local sandbox.
 */

import { Hono } from "hono";
import { createNodeWebSocket } from "@hono/node-ws";
import type { ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { PtyManager } from "./pty/manager.ts";
import { runAgent } from "./agent/executor.ts";
import { log } from "./log.ts";
import { parseClientMessage, type ServerMessage } from "@ai-storm/shared";

let connectionSeq = 0;

/**
 * A browser-originated cross-site WebSocket connection could spawn arbitrary
 * local processes via `attach`/`agent`, so the `/pty` upgrade only accepts
 * connections whose `Origin` is a loopback host (or absent — non-browser
 * clients such as the smoke test and CLI tools send no Origin header).
 */
function isOriginAllowed(origin: string | undefined): boolean {
  // Non-browser clients (node WebSocket, CLI tools) send no Origin header.
  if (!origin) return true;
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return false;
  }
  // `new URL` strips the brackets from an IPv6 host, leaving the bare address.
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

export interface ServerConfig {
  hostname: string;
  port: number;
  /** Absolute path to the built Angular client (dist/browser). */
  staticDir?: string;
}

export function buildApp(config: ServerConfig) {
  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  app.get("/health", (c) => c.json({ status: "ok", os: process.platform }));

  app.get(
    "/pty",
    upgradeWebSocket((c) => {
      const manager = new PtyManager();
      const conn = `conn-${++connectionSeq}`;
      const origin = c.req.header("origin");
      const originOk = isOriginAllowed(origin);

      // Agent subprocesses spawned by this connection, tracked so a client
      // disconnect tears them down instead of orphaning them.
      const agents = new Set<ChildProcess>();

      // `socket` is captured on open so message handlers can push to the client.
      let socket: { send: (data: string) => void; readyState: number } | null = null;
      const send = (msg: ServerMessage) => {
        if (socket && socket.readyState === 1) socket.send(JSON.stringify(msg));
      };

      const cleanup = () => {
        manager.detachAll();
        for (const child of agents) {
          try {
            child.kill();
          } catch {
            // already exited
          }
        }
        agents.clear();
      };

      return {
        onOpen(_evt, ws) {
          socket = ws as unknown as typeof socket;
          if (!originOk) {
            log.warn("ws.rejected_origin", { conn, origin });
            try {
              ws.close(1008, "origin not allowed");
            } catch {
              // socket already closing
            }
            socket = null;
            return;
          }
          log.info("ws.open", { conn });
        },
        onMessage(evt) {
          if (!originOk) return;
          let msg;
          try {
            msg = parseClientMessage(String(evt.data));
          } catch (err) {
            const m = err instanceof Error ? err.message : String(err);
            log.warn("ws.bad_message", { conn, error: m });
            send({ type: "error", message: m });
            return;
          }
          dispatch(msg, manager, conn, send, agents);
        },
        onClose() {
          log.info("ws.close", { conn, liveSessions: manager.size, liveAgents: agents.size });
          cleanup();
        },
        onError() {
          log.warn("ws.error", { conn });
          cleanup();
        },
      };
    }),
  );

  if (config.staticDir) {
    const root = config.staticDir;
    app.get("/*", async (c) => {
      const res = await serveStatic(c.req.path, root);
      return res ?? c.text("Not found", 404);
    });
  } else {
    app.get("/", (c) => c.text("ai-storm backend running. Connect via /pty."));
  }

  return { app, injectWebSocket };
}

function dispatch(
  msg: ReturnType<typeof parseClientMessage>,
  manager: PtyManager,
  conn: string,
  send: (msg: ServerMessage) => void,
  agents: Set<ChildProcess>,
): void {
  switch (msg.type) {
    case "attach": {
      const { workspaceId } = msg;
      log.info("attach.request", {
        conn,
        workspace: workspaceId,
        shell: msg.shell,
        args: (msg.args ?? []).join(" "),
        cwd: msg.cwd,
      });
      let bytesOut = 0;
      manager
        .attach(
          workspaceId,
          { shell: msg.shell, args: msg.args, cwd: msg.cwd, cols: msg.cols, rows: msg.rows },
          (chunk) => {
            bytesOut += chunk.length;
            log.debug("pty.data", { workspace: workspaceId, bytes: chunk.length, totalOut: bytesOut });
            send({ type: "data", workspaceId, chunk });
          },
          (code) => {
            log.info("pty.exit", { workspace: workspaceId, code, totalOut: bytesOut });
            send({ type: "exit", workspaceId, code });
          },
          (message) => {
            log.error("attach.error", { workspace: workspaceId, message });
            send({ type: "error", workspaceId, message });
          },
        )
        .then((pid) => {
          if (pid !== null) {
            log.info("attach.ready", { workspace: workspaceId, pid });
            send({ type: "ready", workspaceId, pid });
          }
        });
      break;
    }
    case "input":
      log.debug("input", { workspace: msg.workspaceId, bytes: msg.data.length });
      if (!manager.write(msg.workspaceId, msg.data)) {
        log.warn("input.dropped", { workspace: msg.workspaceId, reason: "no live session" });
      }
      break;
    case "resize":
      log.debug("resize", { workspace: msg.workspaceId, cols: msg.cols, rows: msg.rows });
      manager.resize(msg.workspaceId, msg.cols, msg.rows);
      break;
    case "detach":
      log.info("detach", { workspace: msg.workspaceId });
      manager.detach(msg.workspaceId);
      break;
    case "context":
      log.debug("context.inject", { workspace: msg.workspaceId, bytes: msg.document.length });
      manager.write(msg.workspaceId, msg.document);
      break;
    case "agent":
      log.info("agent.dispatch", {
        workspace: msg.workspaceId,
        command: msg.command,
        args: (msg.args ?? []).join(" "),
        payloadBytes: msg.payload.length,
      });
      {
        const child = runAgent(
          msg.workspaceId,
          { command: msg.command, args: msg.args, payload: msg.payload, cwd: msg.cwd },
          (status) => send({ type: "agent-status", ...status }),
        );
        // Track for connection-scoped teardown; drop once it exits on its own.
        if (child) {
          agents.add(child);
          child.once("close", () => agents.delete(child));
        }
      }
      break;
  }
}

async function serveStatic(pathname: string, staticDir: string): Promise<Response | null> {
  let rel = decodeURIComponent(pathname);
  if (rel === "/" || rel === "") rel = "/index.html";
  // Resolve within the static root and block traversal. Compare against the
  // root with a trailing separator so a sibling like `…/dist-secret` cannot
  // satisfy a bare `startsWith(…/dist)` check; allow the exact root itself.
  const root = normalize(staticDir);
  const filePath = normalize(join(staticDir, rel));
  if (filePath !== root && !filePath.startsWith(root + sep)) {
    return new Response("Forbidden", { status: 403 });
  }

  try {
    const file = await readFile(filePath);
    const ext = extname(filePath).toLowerCase();
    return new Response(new Uint8Array(file), {
      headers: { "content-type": MIME[ext] ?? "application/octet-stream" },
    });
  } catch {
    // SPA fallback — let the Angular router resolve client-side routes.
    try {
      const index = await readFile(join(staticDir, "index.html"));
      return new Response(new Uint8Array(index), { headers: { "content-type": MIME[".html"] } });
    } catch {
      return null;
    }
  }
}
