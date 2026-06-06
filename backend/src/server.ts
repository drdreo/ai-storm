/**
 * Local-only HTTP + WebSocket server (PRD §4.2), built on Hono.
 *
 * Serves the built Angular client (when present) and exposes a single
 * WebSocket endpoint at `/pty` that multiplexes all workspaces for one client.
 * Bound to 127.0.0.1 so the loop never leaves the local sandbox.
 *
 * Sessions are owned by a process-wide `SessionBackend` (tmux on POSIX, node-pty
 * on Windows), NOT by the WebSocket connection. A client disconnect *detaches*
 * the response stream but leaves the durable session alive (PRD §3.5); explicit
 * teardown happens via a `kill` message.
 */

import { Hono } from "hono";
import { createNodeWebSocket } from "@hono/node-ws";
import type { ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { getRuntime } from "./session/runtime.ts";
import type { SessionBackend } from "./session/types.ts";
import { commandProfileName, getProfile } from "./session/extraction.ts";
import { runAgent } from "./agent/executor.ts";
import { log } from "./log.ts";
import { parseClientMessage, type ServerMessage } from "@ai-storm/shared";

let connectionSeq = 0;

/**
 * The §4.1 session-priming instruction. Delivered to a contract-aware harness
 * (claude) as an APPENDED SYSTEM PROMPT at launch (see `HarnessProfile.
 * systemPromptFlag`), so the `«IDEA»` contract is followed from the first turn
 * with nothing typed into the terminal. It defines the single-line `«IDEA»`
 * marker (and fenced form) the backend extracts into canvas ideas.
 */
const PRIME_INSTRUCTION = `You are in a brainstorming workspace. Reply normally in conversation.

Whenever you produce a brainstorming idea or ideation note worth capturing on the canvas, emit it on its OWN line in exactly this format, then continue talking normally:

  «IDEA» <short title> :: <one-line description>

Optionally tag the kind: «IDEA:risk», «IDEA:challenge», «IDEA:feature», «IDEA:question», «IDEA:decision». Use «IDEA:challenge» for a counter-argument or objection to an existing idea.

When you are responding about a specific existing card whose ref you were given (it looks like @a1), link your idea to it by appending that ref to the marker, after any kind:

  «IDEA:risk@a1» <short title> :: <one-line description>

For an idea that truly needs several lines, use a fenced block instead:

  \`\`\`idea kind=<kind>
  title: <short title>
  body: <as many lines as you need>
  \`\`\`

Rules:
- One idea per «IDEA» line. Put each «IDEA» line on its own line.
- Use «IDEA» ONLY for real ideas, never for chitchat, status, or questions.
- Everything that is NOT an «IDEA» line is treated as ordinary chat.`;

/**
 * Derive the harness profile name + priming text from the harness command. A
 * contract-aware harness (claude) is primed via its system-prompt flag; anything
 * else gets no prime (extraction-contract §4.6).
 */
function harnessSetup(command: string): { harnessProfile?: string; prime?: string } {
  const harnessProfile = commandProfileName(command);
  const supportsContract = getProfile(harnessProfile).supportsIdeaContract;
  return { harnessProfile, prime: supportsContract ? PRIME_INSTRUCTION : undefined };
}

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
  const backend = getRuntime();

  app.get("/health", (c) => c.json({ status: "ok", os: process.platform, runtime: backend.runtime }));

  app.get(
    "/pty",
    upgradeWebSocket((c) => {
      const conn = `conn-${++connectionSeq}`;
      const origin = c.req.header("origin");
      const originOk = isOriginAllowed(origin);

      // Workspaces this connection attached to — detached (not killed) on close.
      const attached = new Set<string>();
      // Agent subprocesses spawned by this connection, torn down on disconnect.
      const agents = new Set<ChildProcess>();

      // `socket` is captured on open so message handlers can push to the client.
      let socket: { send: (data: string) => void; readyState: number } | null = null;
      const send = (msg: ServerMessage) => {
        if (socket && socket.readyState === 1) socket.send(JSON.stringify(msg));
      };

      const cleanup = () => {
        // Detach (NOT kill) so durable sessions survive the disconnect (§3.5).
        for (const id of attached) backend.detach(id);
        attached.clear();
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
            log.debug("ws.message", { conn, message: String(evt.data).slice(0, 100) });
            msg = parseClientMessage(String(evt.data));
          } catch (err) {
            const m = err instanceof Error ? err.message : String(err);
            log.warn("ws.bad_message", { conn, error: m });
            send({ type: "error", message: m });
            return;
          }
          void dispatch(msg, backend, conn, send, attached, agents);
        },
        onClose() {
          log.info("ws.close", { conn, attached: attached.size, liveAgents: agents.size });
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

async function dispatch(
  msg: ReturnType<typeof parseClientMessage>,
  backend: SessionBackend,
  conn: string,
  send: (msg: ServerMessage) => void,
  attached: Set<string>,
  agents: Set<ChildProcess>,
): Promise<void> {
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
      try {
        // Idempotent: create the named session if absent (else reuse), then
        // (re)attach the response stream. Decoupled from input readiness —
        // the session always exists by the time `input` is processed (§3.3).
        const { harnessProfile, prime } = harnessSetup(msg.shell ?? "");
        log.debug("attach.setup", { workspace: workspaceId, harnessProfile, prime });
        await backend.create({
          workspaceId,
          command: msg.shell ?? "",
          args: msg.args,
          cwd: msg.cwd,
          cols: msg.cols,
          rows: msg.rows,
          harnessProfile,
          prime,
        });
        send({ type: "session-status", workspaceId, status: "created" });
        await backend.attach(
          workspaceId,
          // Raw PTY bytes → the browser's xterm.js terminal. base64 so the
          // control bytes of a cursor-addressed TUI survive JSON intact.
          (raw) => {
            send({ type: "data", workspaceId, data: Buffer.from(raw, "utf8").toString("base64") });
          },
          // Each newly-extracted idea → the canvas.
          (idea) => {
            log.info("idea", { workspace: workspaceId, kind: idea.kind ?? "", title: idea.title });
            send({ type: "idea", workspaceId, idea });
          },
          (message) => {
            log.warn("session.error", { workspace: workspaceId, message });
            send({ type: "error", workspaceId, message });
          },
        );
        attached.add(workspaceId);
        send({ type: "session-status", workspaceId, status: "attached" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error("attach.error", { workspace: workspaceId, message });
        send({ type: "error", workspaceId, message });
      }
      break;
    }
    case "input":
      log.debug("input", { workspace: msg.workspaceId, bytes: msg.data.length });
      try {
        await backend.sendInput(msg.workspaceId, msg.data);
      } catch (err) {
        send({ type: "error", workspaceId: msg.workspaceId, message: err instanceof Error ? err.message : String(err) });
      }
      break;
    case "resize":
      log.debug("resize", { workspace: msg.workspaceId, cols: msg.cols, rows: msg.rows });
      await backend.resize(msg.workspaceId, msg.cols, msg.rows);
      break;
    case "detach":
      log.info("detach", { workspace: msg.workspaceId });
      backend.detach(msg.workspaceId);
      attached.delete(msg.workspaceId);
      break;
    case "kill":
      log.info("kill", { workspace: msg.workspaceId });
      await backend.kill(msg.workspaceId);
      attached.delete(msg.workspaceId);
      send({ type: "session-status", workspaceId: msg.workspaceId, status: "killed" });
      break;
    case "context":
      // Inject the serialized canvas as contextual memory (PRD §3.2): submitted
      // to the harness as a full prompt (not raw keystrokes — it is multi-line).
      log.debug("context.inject", { workspace: msg.workspaceId, bytes: msg.document.length });
      try {
        await backend.submitPrompt(msg.workspaceId, msg.document);
      } catch (err) {
        send({ type: "error", workspaceId: msg.workspaceId, message: err instanceof Error ? err.message : String(err) });
      }
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
