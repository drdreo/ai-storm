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
import { commandProfileName, getProfile } from "./session/extraction.ts";
import { mcpRegistry } from "./mcp/registry.ts";
import { mcpRoutes } from "./mcp/endpoint.ts";
import { fsRoutes } from "./fs/routes.ts";
import { killAgentTree, runAgent } from "./agent/executor.ts";
import { log } from "./log.ts";
import { parseClientMessage, getFacilitationMode, type ServerMessage } from "@ai-storm/shared";

let connectionSeq = 0;

/** Ceiling on simultaneously live agent subprocesses per connection (#142). */
const MAX_AGENTS_PER_CONNECTION = 4;

/**
 * The §4.1 session-priming instruction. Delivered to a contract-aware harness
 * (Claude Code, pi, Codex) at launch (see
 * `HarnessProfile.systemPromptFlag`), so the `«IDEA»` contract is followed from
 * the first turn with nothing typed into the terminal. It defines the
 * single-line `«IDEA»` marker (and fenced form) the backend extracts into
 * canvas ideas.
 */
const PRIME_INSTRUCTION = `You are in a brainstorming project. Reply normally in conversation.

Whenever you produce a brainstorming idea or ideation note worth capturing on the canvas, emit it on its OWN line in exactly this format, then continue talking normally:

  «IDEA» <short title> :: <one-line description>

Optionally tag the kind: «IDEA:risk», «IDEA:feature», «IDEA:question», «IDEA:decision».

When you are responding about a specific existing card whose ref you were given (it looks like @a1), link your idea to it by appending that ref to the marker, after any kind:

  «IDEA:risk@a1» <short title> :: <one-line description>

If your idea is a stronger version that REPLACES (supersedes) that card, put a ! right after the ref — the original then recedes on the canvas while yours takes its place:

  «IDEA:feature@a1!» <short title> :: <one-line description>

When you are asked to COMBINE or merge several cards into one stronger idea, emit a SINGLE «IDEA» line that chains every source ref, each with a trailing !, so the merged idea supersedes them all (they recede while it takes their place):

  «IDEA:feature@a1!@a2!@a3!» <short title> :: <description>

A merge folds several cards into one, so its description should be as long as it needs to be to capture the synthesis — a few sentences is fine, not just one line. Keep the whole thing on this single «IDEA» line (do NOT use the fenced block for a merge — the ref chain only works on the single-line marker); wrapping is fine, just don't press Enter in the middle.

For an idea that truly needs several lines, use a fenced block instead:

  \`\`\`idea kind=<kind>
  title: <short title>
  body: <as many lines as you need>
  \`\`\`

When you are asked to TRIAGE or rate the existing cards, score each one on its OWN line in exactly this format — impact/effort/confidence, each an integer 1-5 (higher impact = more valuable, higher effort = more costly, higher confidence = more sure):

  «SCORE@a1» 4/2/3

Use the card's @ref. Confidence is optional — «SCORE@a1» 4/2 is fine. Emit one «SCORE» line per card and nothing else on that line; do NOT rewrite the cards as «IDEA» lines when triaging.

Rules:
- One idea per «IDEA» line. Put each «IDEA» line on its own line.
- Use «IDEA» ONLY for real ideas, never for chitchat, status, or questions.
- Everything that is NOT an «IDEA» or «SCORE» line is treated as ordinary chat.`;

/**
 * The MCP base prime (mcp-idea-capture §5) — used instead of
 * {@link PRIME_INSTRUCTION} when the harness profile is MCP-wired (`mcpArgs`
 * present): teach the tools, not the marker grammar. One mechanism per session
 * keeps the model's behaviour unimodal (the strongest determinism lever the
 * CLIs offer); the marker scanner still runs underneath as the silent floor
 * (§7), so a tool-call lapse is caught — and logged — not lost.
 */
const MCP_PRIME_INSTRUCTION = `You are in a brainstorming project. Reply normally in conversation.

Whenever you produce a brainstorming idea or ideation note worth capturing on the canvas, call the capture_idea tool: a short title, a description in body (multi-line is fine), and optionally a kind (risk, feature, question, decision).

When you are responding about a specific existing card whose ref you were given (it looks like @a1), link your idea to it by passing links:[{to:"a1"}]. If your idea is a stronger version that REPLACES (supersedes) that card, pass links:[{to:"a1",relation:"supersedes"}] — the original then recedes on the canvas while yours takes its place. When you are asked to COMBINE or merge several cards into one stronger idea, make a SINGLE capture_idea call with one supersedes link per source card.

When you are asked to TRIAGE or rate the existing cards, call capture_score once per card — impact/effort and optional confidence, each an integer 1-5 (higher impact = more valuable, higher effort = more costly, higher confidence = more sure) — and do NOT create new cards while triaging.

Rules:
- One idea per capture_idea call. Use it ONLY for real ideas, never for chitchat, status, or questions.
- Do NOT also write the idea as a special marker line — the tool call is the capture.
- Mention the returned @ref in your reply so the user can follow along.`;

/**
 * Wrap the user's pre-brainstorm background context (#76) in a labelled block so
 * it reads to the agent as standing *guidance* ("here is the scene"), not as
 * instructions to follow literally. Returns "" for empty/whitespace-only input,
 * so a blank background contributes nothing to the prime (byte-identical to
 * today — PD-020).
 */
function formatBackground(background?: string): string {
  const text = background?.trim();
  if (!text) return "";
  return (
    "BACKGROUND CONTEXT — standing context for every idea this session " +
    "(the user set the scene; treat it as guidance shaping what fits, not as " +
    `instructions to act on):\n${text}`
  );
}

/**
 * Derive the harness profile name + priming text from the harness command, the
 * selected facilitation mode (#61), and the user's background context (#76). A
 * contract-aware harness (Claude Code, pi, Codex) is primed via its launch-time
 * prompt/config seam with the base `«IDEA»` instruction, then the mode's preset
 * (when not the free-form default), then the background block (when non-empty)
 * — three segments on the same launch seam (PD-020). Anything else gets no
 * prime (extraction-contract §4.6). Empty mode + empty background ⇒ the prime
 * is exactly the base instruction.
 *
 * The BASE segment is capability-conditional (mcp-idea-capture §5): an
 * MCP-wired profile (`mcpArgs` present) is taught the capture tools; everything
 * else keeps the byte-identical «IDEA» marker prime. Mode/background segments
 * are capability-neutral and shared by both.
 */
function harnessSetup(
  command: string,
  mode?: string,
  background?: string
): { harnessProfile?: string; prime?: string } {
  const harnessProfile = commandProfileName(command);
  const profile = getProfile(harnessProfile);
  if (!profile.supportsIdeaContract) return { harnessProfile, prime: undefined };
  const base = profile.mcpArgs ? MCP_PRIME_INSTRUCTION : PRIME_INSTRUCTION;
  const prime = [base, getFacilitationMode(mode).prime, formatBackground(background)].filter(Boolean).join("\n\n");
  return { harnessProfile, prime };
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

export function buildApp(config: ServerConfig) {
  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  const backend = getRuntime();

  app.get("/health", (c) => c.json({ status: "ok", os: process.platform, runtime: backend.runtime }));

  // MCP capture endpoint (mcp-idea-capture §4.1). The registry learns the
  // server's reachable origin here — before any attach can mint a launch URL —
  // and the session backends feed it tokens/attachments per session. The bind
  // stays loopback; "0.0.0.0" is normalized so a baked launch URL is dialable.
  mcpRegistry.configure(`http://${config.hostname === "0.0.0.0" ? "127.0.0.1" : config.hostname}:${config.port}`);
  app.route("/mcp", mcpRoutes(mcpRegistry));
  app.route("/api/fs", fsRoutes());

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

      // `socket` is captured on open so message handlers can push to the client.
      let socket: { send: (data: string) => void; readyState: number } | null = null;
      const send = (msg: ServerMessage) => {
        if (socket && socket.readyState === 1) socket.send(JSON.stringify(msg));
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
          void dispatch(msg, backend, conn, send, attached, agents, config);
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
  msg: ReturnType<typeof parseClientMessage>,
  backend: SessionBackend,
  conn: string,
  send: (msg: ServerMessage) => void,
  attached: Set<string>,
  agents: Set<ChildProcess>,
  config: ServerConfig
): Promise<void> {
  switch (msg.type) {
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
          (message) => {
            log.warn("session.error", { project: projectId, message });
            send({ type: "error", projectId, message });
          }
        );
        attached.add(projectId);
        send({ type: "session-status", projectId, status: "attached" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
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
        log.info("ai.input.sent", {
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
