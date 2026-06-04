/**
 * Local-only HTTP + WebSocket server (PRD §4.2).
 *
 * Serves the built Angular client (when present) and exposes a single
 * WebSocket endpoint at `/pty` that multiplexes all workspaces for one client.
 * Bound to 127.0.0.1 so the loop never leaves the local sandbox.
 */

import { PtyManager } from "./pty/manager.ts";
import { runAgent } from "./agent/executor.ts";
import {
  parseClientMessage,
  type ServerMessage,
} from "./protocol.ts";

export interface ServerConfig {
  hostname: string;
  port: number;
  /** Absolute path to the built Angular client (dist) for static serving. */
  staticDir?: string;
}

export function createServer(config: ServerConfig): Deno.HttpServer {
  return Deno.serve(
    { hostname: config.hostname, port: config.port },
    (req) => handleRequest(req, config),
  );
}

function handleRequest(req: Request, config: ServerConfig): Response | Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/pty") {
    return handleWebSocket(req);
  }

  if (url.pathname === "/health") {
    return new Response(JSON.stringify({ status: "ok", os: Deno.build.os }), {
      headers: { "content-type": "application/json" },
    });
  }

  if (config.staticDir) {
    return serveStatic(url.pathname, config.staticDir);
  }

  return new Response("ai-storm backend running. Connect via /pty.", {
    headers: { "content-type": "text/plain" },
  });
}

function handleWebSocket(req: Request): Response {
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected WebSocket upgrade", { status: 426 });
  }

  const { socket, response } = Deno.upgradeWebSocket(req);
  const manager = new PtyManager();

  const send = (msg: ServerMessage) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(msg));
    }
  };

  socket.onmessage = (event) => {
    let msg;
    try {
      msg = parseClientMessage(String(event.data));
    } catch (err) {
      send({ type: "error", message: err instanceof Error ? err.message : String(err) });
      return;
    }

    switch (msg.type) {
      case "attach": {
        const { workspaceId } = msg;
        manager.attach(
          workspaceId,
          { shell: msg.shell, args: msg.args, cwd: msg.cwd, cols: msg.cols, rows: msg.rows },
          (chunk) => send({ type: "data", workspaceId, chunk }),
          (code) => send({ type: "exit", workspaceId, code }),
        );
        const session = manager.has(workspaceId);
        if (session) {
          send({ type: "ready", workspaceId, pid: -1 });
        }
        break;
      }
      case "input":
        manager.write(msg.workspaceId, msg.data);
        break;
      case "resize":
        manager.resize(msg.workspaceId, msg.cols, msg.rows);
        break;
      case "detach":
        void manager.detach(msg.workspaceId);
        break;
      case "context":
        // Inject serialized canvas as contextual memory (PRD §3.2): write the
        // document to the PTY stdin so the agent loop sees the whiteboard state.
        manager.write(msg.workspaceId, msg.document);
        break;
      case "agent":
        runAgent(
          msg.workspaceId,
          { command: msg.command, args: msg.args, payload: msg.payload, cwd: msg.cwd },
          (status) => send({ type: "agent-status", ...status }),
        );
        break;
    }
  };

  socket.onclose = () => {
    void manager.detachAll();
  };
  socket.onerror = () => {
    void manager.detachAll();
  };

  return response;
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

async function serveStatic(pathname: string, staticDir: string): Promise<Response> {
  let rel = decodeURIComponent(pathname);
  if (rel === "/" || rel === "") rel = "/index.html";
  // Block path traversal.
  if (rel.includes("..")) return new Response("Forbidden", { status: 403 });

  const filePath = `${staticDir}${rel}`;
  try {
    const file = await Deno.readFile(filePath);
    const ext = rel.slice(rel.lastIndexOf("."));
    return new Response(file, {
      headers: { "content-type": MIME[ext] ?? "application/octet-stream" },
    });
  } catch {
    // SPA fallback — let the Angular router resolve client-side routes.
    try {
      const index = await Deno.readFile(`${staticDir}/index.html`);
      return new Response(index, { headers: { "content-type": MIME[".html"] } });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  }
}
