/**
 * Local-only HTTP + WebSocket server (PRD §4.2), built on Hono.
 *
 * Serves the built Angular client (when present) and exposes a single
 * WebSocket endpoint at `/pty` that multiplexes all projects for one client.
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
import { harnessSetup } from "./session/priming.ts";
import { mcpRegistry } from "./mcp/registry.ts";
import { mcpRoutes } from "./mcp/endpoint.ts";
import { fsRoutes } from "./fs/routes.ts";
import { issueRoutes } from "./issues/routes.ts";
import { killAgentTree, runAgent } from "./agent/executor.ts";
import { log } from "./log.ts";
import { parseClientMessage, type ClientMessage, type PortableStateBundle, type ServerMessage } from "@ai-storm/shared";
import { encodeServerMessage } from "./ws/codec.ts";
import { StateFileError, StateStore, type StoredFolder, type StoredProject } from "./state/store.ts";

let connectionSeq = 0;

/** Ceiling on simultaneously live agent subprocesses per connection (#142). */
const MAX_AGENTS_PER_CONNECTION = 4;

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
  ".wasm": "application/wasm"
};

export interface ServerConfig {
  hostname: string;
  port: number;
  /** Absolute path to the built Angular client (dist/browser). */
  staticDir?: string;
  /** Wall-clock ceiling per agent run (`--agent-timeout-ms`, PD-022).
   *  Defaults to 10 minutes; raise it for long side-effecting hand-offs. */
  agentTimeoutMs?: number;
}

export function buildApp(config: ServerConfig, stateStore = new StateStore()) {
  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  const backend = getRuntime();

  app.get("/health", (c) => c.json({ status: "ok", os: process.platform, runtime: backend.runtime }));

  // MCP capture endpoint (mcp-idea-capture §4.1). The registry learns the
  // server's reachable origin here — before any attach can mint a launch URL —
  // and the session backends feed it tokens/attachments per session. The bind
  // stays loopback; "0.0.0.0" is normalized so a baked launch URL is dialable.
  mcpRegistry.configure(`http://${config.hostname === "0.0.0.0" ? "127.0.0.1" : config.hostname}:${config.port}`);
  mcpRegistry.configureRefAllocator(async (projectId) => (await stateStore.reserveIdeaRefs(projectId, 1))[0]);
  app.route("/mcp", mcpRoutes(mcpRegistry, stateStore));
  app.route("/api/fs", fsRoutes());
  app.route("/api/issues", issueRoutes());

  app.get(
    "/pty",
    upgradeWebSocket((c) => {
      const conn = `conn-${++connectionSeq}`;
      const origin = c.req.header("origin");
      const originOk = isOriginAllowed(origin);

      // Projects this connection attached to — detached (not killed) on close.
      const attached = new Set<string>();
      // Agent subprocesses spawned by this connection, torn down on disconnect.
      const agents = new Set<ChildProcess>();
      // State commands from one browser are ordered. This makes optimistic
      // create→patch→board-load sequences deterministic while PTY traffic stays live.
      let stateQueue = Promise.resolve();

      // `socket` is captured on open so message handlers can push to the client.
      let socket: { send: (data: string) => void; readyState: number } | null = null;
      const send = (msg: ServerMessage) => {
        if (socket && socket.readyState === 1) socket.send(encodeServerMessage(msg));
      };

      const cleanup = () => {
        // Detach (NOT kill) so durable sessions survive the disconnect (§3.5).
        for (const id of attached) backend.detach(id);
        attached.clear();
        for (const child of agents) killAgentTree(child);
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
          if (msg.type === "state-request") {
            stateQueue = stateQueue.then(
              () => dispatch(msg, backend, stateStore, conn, send, attached, agents, config),
              () => dispatch(msg, backend, stateStore, conn, send, attached, agents, config)
            );
          } else {
            void dispatch(msg, backend, stateStore, conn, send, attached, agents, config);
          }
        },
        onClose() {
          log.info("ws.close", { conn, attached: attached.size, liveAgents: agents.size });
          cleanup();
        },
        onError() {
          log.warn("ws.error", { conn });
          cleanup();
        }
      };
    })
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
  msg: ClientMessage,
  backend: SessionBackend,
  stateStore: StateStore,
  conn: string,
  send: (msg: ServerMessage) => void,
  attached: Set<string>,
  agents: Set<ChildProcess>,
  config: ServerConfig
): Promise<void> {
  switch (msg.type) {
    case "state-request": {
      try {
        // Runtime session state is intentionally not persisted in the registry:
        // probe the process-wide backend so a freshly loaded browser can tell
        // which durable sessions should be reattached.
        let data: unknown;
        if (msg.operation === "session-probe") {
          if (!msg.projectId) throw new Error("session-probe requires projectId");
          const exists = await backend.hasSession(msg.projectId);
          log.info("session.probe", { project: msg.projectId, exists, runtime: backend.runtime });
          data = { exists };
        } else {
          data = await dispatchStateRequest(msg.operation, msg.projectId, msg.payload ?? {}, stateStore);
        }
        send({ type: "state-response", requestId: msg.requestId, operation: msg.operation, ok: true, data });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error("state.request_failed", { operation: msg.operation, project: msg.projectId, message });
        send({
          type: "state-response",
          requestId: msg.requestId,
          operation: msg.operation,
          ok: false,
          error: message,
          ...(error instanceof StateFileError ? { path: error.path } : {})
        });
      }
      break;
    }
    case "attach": {
      const { projectId } = msg;
      log.info("attach.request", {
        conn,
        project: projectId,
        shell: msg.shell,
        args: (msg.args ?? []).join(" "),
        cwd: msg.cwd,
        mode: msg.mode,
        background: msg.background
      });
      try {
        // Idempotent: create the named session if absent (else reuse), then
        // (re)attach the response stream. Decoupled from input readiness —
        // the session always exists by the time `input` is processed (§3.3).
        const { harnessProfile, prime } = harnessSetup(msg.shell ?? "", msg.mode, msg.background);
        log.debug("attach.setup", {
          project: projectId,
          harnessProfile,
          mode: msg.mode,
          background: msg.background,
          prime
        });
        await backend.create({
          projectId,
          command: msg.shell ?? "",
          args: msg.args,
          cwd: msg.cwd,
          cols: msg.cols,
          rows: msg.rows,
          harnessProfile,
          prime
        });
        send({ type: "session-status", projectId, status: "created" });
        await backend.attach(
          projectId,
          // Raw PTY bytes → the browser's xterm.js terminal. base64 so the
          // control bytes of a cursor-addressed TUI survive JSON intact. This is
          // the AI's response stream; byte volume is debug-level (would flood).
          (raw) => {
            mcpRegistry.setRuntimeState(projectId, "responding");
            log.debug("ai.data", { project: projectId, bytes: raw.length });
            send({ type: "data", projectId, data: Buffer.from(raw, "utf8").toString("base64") });
          },
          // Each newly-extracted idea → the canvas (the meaningful "got a result").
          (idea) => {
            log.info("ai.idea.sent", {
              project: projectId,
              kind: idea.kind ?? "",
              title: idea.title,
              body: idea.body.slice(0, 80)
            });
            send({ type: "idea", projectId, idea });
          },
          // Each newly-extracted triage score → the canvas, updating a card (#60).
          (score) => {
            log.info("ai.score.sent", {
              project: projectId,
              ref: score.ref,
              impact: score.impact,
              effort: score.effort
            });
            send({ type: "score", projectId, score });
          },
          // Each done/reopen state change → the canvas, toggling a card's
          // completion (#167). Delivered via the MCP `mark_idea_done` tool.
          (completion) => {
            log.info("ai.completion.sent", {
              project: projectId,
              ref: completion.ref,
              done: completion.done
            });
            send({ type: "completion", projectId, completion });
          },
          // Each external-link reference → the canvas, attaching a link to a
          // card (#227). Delivered via the MCP `link_idea` tool.
          (reference) => {
            log.info("ai.reference.sent", {
              project: projectId,
              ref: reference.ref,
              url: reference.url
            });
            send({ type: "reference", projectId, reference });
          },
          (message) => {
            mcpRegistry.setRuntimeState(projectId, "error");
            log.warn("session.error", { project: projectId, message });
            send({ type: "error", projectId, message });
          }
        );
        attached.add(projectId);
        mcpRegistry.setRuntimeState(projectId, "attached");
        send({ type: "session-status", projectId, status: "attached" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        mcpRegistry.setRuntimeState(projectId, "error");
        log.error("attach.error", { project: projectId, message });
        send({ type: "error", projectId, message });
      }
      break;
    }
    case "input": {
      // Raw xterm passthrough delivers one keystroke per message; a single
      // keystroke is debug noise, but a multi-char or newline-terminated payload
      // is a real prompt/paste headed to the AI — surface that at info.
      const keystroke = msg.data.length <= 2 && !/[\r\n]/.test(msg.data);
      if (keystroke) {
        log.debug("ai.keystroke", { project: msg.projectId, bytes: msg.data.length });
      } else {
        log.debug("ai.input.sent", {
          project: msg.projectId,
          bytes: msg.data.length,
          preview: msg.data.replace(/\s+/g, " ").trim().slice(0, 80)
        });
      }
      try {
        await backend.sendInput(msg.projectId, msg.data);
      } catch (err) {
        send({
          type: "error",
          projectId: msg.projectId,
          message: err instanceof Error ? err.message : String(err)
        });
      }
      break;
    }
    case "submit": {
      // Complete prompts (notably multiline triage requests) must use the
      // backend's paste-safe submission path. Sending them as raw terminal
      // keystrokes lets embedded newlines submit partial prompts.
      log.info("ai.prompt.submit", {
        project: msg.projectId,
        bytes: msg.data.length,
        lines: msg.data.split(/\r?\n/).length,
        submit: msg.submit !== false
      });
      try {
        await backend.submitPrompt(msg.projectId, msg.data, { submit: msg.submit !== false });
      } catch (err) {
        send({
          type: "error",
          projectId: msg.projectId,
          message: err instanceof Error ? err.message : String(err)
        });
      }
      break;
    }
    case "resize":
      log.debug("resize", { project: msg.projectId, cols: msg.cols, rows: msg.rows });
      await backend.resize(msg.projectId, msg.cols, msg.rows);
      break;
    case "detach":
      log.info("detach", { project: msg.projectId });
      backend.detach(msg.projectId);
      attached.delete(msg.projectId);
      break;
    case "kill":
      log.info("kill", { project: msg.projectId });
      await backend.kill(msg.projectId);
      attached.delete(msg.projectId);
      send({ type: "session-status", projectId: msg.projectId, status: "killed" });
      break;
    case "context":
      // Inject the serialized canvas as contextual memory (PRD §3.2): submitted
      // to the harness as a full prompt (not raw keystrokes — it is multi-line).
      log.info("ai.context.inject", { project: msg.projectId, bytes: msg.document.length });
      try {
        await backend.submitPrompt(msg.projectId, msg.document);
      } catch (err) {
        send({
          type: "error",
          projectId: msg.projectId,
          message: err instanceof Error ? err.message : String(err)
        });
      }
      break;
    case "agent":
      // Concurrency ceiling (#142): each run is a full harness process; an
      // unbounded burst of `agent` messages would fork-bomb the host.
      if (agents.size >= MAX_AGENTS_PER_CONNECTION) {
        log.warn("agent.concurrency_capped", { conn, project: msg.projectId, live: agents.size });
        send({
          type: "agent-status",
          projectId: msg.projectId,
          status: "error",
          data: `Concurrent agent-run limit (${MAX_AGENTS_PER_CONNECTION}) reached; wait for a run to finish.`
        });
        break;
      }
      log.info("agent.dispatch", {
        project: msg.projectId,
        command: msg.command,
        args: (msg.args ?? []).join(" "),
        payloadBytes: msg.payload.length,
        format: msg.format ?? "",
        capabilities: (msg.capabilities ?? []).join(",")
      });
      {
        const child = runAgent(
          msg.projectId,
          {
            command: msg.command,
            args: msg.args,
            payload: msg.payload,
            cwd: msg.cwd,
            format: msg.format,
            capabilities: msg.capabilities
          },
          (status) => send({ type: "agent-status", ...status }),
          (artifacts) => send({ type: "agent-artifacts", projectId: msg.projectId, artifacts }),
          { timeoutMs: config.agentTimeoutMs }
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

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) throw new Error(`State request requires ${field}`);
  return value;
}

function requiredProjectId(projectId: string | undefined): string {
  return requiredString(projectId, "projectId");
}
function requiredObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`State request requires ${field}`);
  return value as Record<string, unknown>;
}

export async function dispatchStateRequest(
  operation: import("@ai-storm/shared").StateOperation,
  projectId: string | undefined,
  payload: Record<string, unknown>,
  store: StateStore
): Promise<unknown> {
  switch (operation) {
    case "session-probe":
      throw new Error("session-probe must be handled by the runtime dispatcher");
    case "registry-load":
      return store.readRegistry();
    case "registry-create-project": {
      const project = payload.project as Omit<StoredProject, "createdAt" | "updatedAt"> | undefined;
      if (!project || typeof project !== "object") throw new Error("State request requires project");
      await store.createProject(project);
      return store.readRegistry();
    }
    case "registry-patch-project":
      await store.updateProject(requiredProjectId(projectId), requiredObject(payload.patch, "patch"));
      return store.readRegistry();
    case "registry-delete-project":
      await store.deleteProject(requiredProjectId(projectId));
      return store.readRegistry();
    case "registry-create-folder": {
      const folder = payload.folder as StoredFolder | undefined;
      if (!folder || typeof folder !== "object") throw new Error("State request requires folder");
      await store.createFolder(folder);
      return store.readRegistry();
    }
    case "registry-patch-folder":
      await store.updateFolder(requiredString(payload.folderId, "folderId"), requiredObject(payload.patch, "patch"));
      return store.readRegistry();
    case "registry-delete-folder":
      await store.deleteFolder(requiredString(payload.folderId, "folderId"));
      return store.readRegistry();
    case "board-load": {
      const board = await store.readBoard(requiredProjectId(projectId));
      return { revision: board.revision, document: board.document };
    }
    case "board-save": {
      const expectedRevision = payload.expectedRevision;
      if (!Number.isSafeInteger(expectedRevision)) throw new Error("State request requires expectedRevision");
      if (!Object.hasOwn(payload, "document")) throw new Error("State request requires document");
      return store.writeBoard(requiredProjectId(projectId), expectedRevision as number, payload.document);
    }
    case "reserve-idea-refs": {
      const count = payload.count;
      if (!Number.isSafeInteger(count)) throw new Error("State request requires count");
      return { refs: await store.reserveIdeaRefs(requiredProjectId(projectId), count as number) };
    }
    case "history-load":
      return store.readHistory(requiredProjectId(projectId));
    case "history-append":
      return store.appendHistoryEntry(requiredProjectId(projectId), requiredObject(payload.entry, "entry"));
    case "history-update":
      return store.updateHistoryEntry(
        requiredProjectId(projectId),
        requiredString(payload.entryId, "entryId"),
        requiredObject(payload.patch, "patch")
      );
    case "history-delete":
      return store.deleteHistoryEntry(requiredProjectId(projectId), requiredString(payload.entryId, "entryId"));
    case "history-clear":
      return store.clearHistory(requiredProjectId(projectId));
    case "state-export": {
      const ids = payload.projectIds;
      if (ids !== undefined && (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")))
        throw new Error("State request requires projectIds to be strings");
      return store.exportState(ids as string[] | undefined);
    }
    case "state-import": {
      const bundle = requiredObject(payload.bundle, "bundle") as unknown as PortableStateBundle;
      const ids = payload.projectIds;
      if (ids !== undefined && (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")))
        throw new Error("State request requires projectIds to be strings");
      return store.importState(bundle, ids as string[] | undefined);
    }
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
      headers: { "content-type": MIME[ext] ?? "application/octet-stream" }
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
