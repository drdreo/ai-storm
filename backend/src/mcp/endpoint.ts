/**
 * The MCP capture endpoint — `POST /mcp/:projectId/:token` (mcp-idea-capture
 * design §§3–4): a minimal, sessionless MCP server over the Streamable HTTP
 * transport, exposing the two capture tools (`capture_idea`, `capture_score`)
 * so the agent delivers ideas as schema-validated JSON tool calls instead of
 * marker lines rendered through a terminal (§1/§2).
 *
 * Hand-rolled against MCP protocol revision 2025-03-26 (the revision that
 * introduced Streamable HTTP). The surface is deliberately the sessionless
 * minimum — `initialize`, `notifications/*` (accepted + ignored), `tools/list`,
 * `tools/call`, `ping` — so no SDK dependency is warranted (§12.6: if a harness
 * ever requires the full session lifecycle, the growth is contained here).
 * Spec-permitted simplifications:
 *  - Every response with a body is `application/json`, never SSE: Streamable
 *    HTTP allows plain JSON when the response is a single message.
 *  - Notifications/responses POSTed by the client → `202 Accepted`, no body.
 *  - No `Mcp-Session-Id` (sessionless), no GET stream (`405`), no batching
 *    (single-message bodies only; JSON-RPC batch arrays are rejected — the
 *    pinned harnesses don't send them, and rev 2025-06-18 removed batching).
 *
 * Validation is hand-rolled in the `parseClientMessage` style (the backend has
 * no zod). A tool-level validation failure returns a RESULT with
 * `isError: true` and a descriptive message — per MCP, that is what the model
 * gets to read and retry on (§2: "validation is self-correcting"); JSON-RPC
 * errors are reserved for protocol-level faults (unknown method/tool, bad
 * envelope). Auth failures return a bare 404 before anything is parsed.
 */

import { Hono } from "hono";
import type { Completion, CreateIdeaInput, IdeaLink, Reference, Score } from "@ai-storm/shared";
import { log } from "../log.ts";
import type { McpSession, McpSessionRegistry } from "./registry.ts";
import { deriveBoardIdeas } from "../state/board-reader.ts";
import { StateFileError, type StateStore } from "../state/store.ts";

/** Protocol revision implemented (and the fallback offer in negotiation). */
const PROTOCOL_VERSION = "2025-03-26";
/** Revisions we can speak verbatim — echo the client's ask when it's one of
 *  these (the surface used here is identical across all three). */
const KNOWN_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);

const SERVER_INFO = { name: "ai-storm", version: "3.0.0" };

// ── Tool schemas (§3) — the JSON Schema mirror of the parse functions below ──

/** `kind` charset — same grammar as the marker's `«IDEA:kind»` tag. */
const KIND_PATTERN = /^[a-z][\w-]*$/;
/** Ref charset — the marker grammar's injection guard, applied to tool input too (§10). */
const REF_PATTERN = /^[\w-]+$/;
const PROJECT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Exported for the pi-extension parity test (extraction.test.ts): the
 *  generated pi extension must register every tool this endpoint dispatches. */
export const TOOLS = [
  {
    name: "capture_idea",
    description:
      "Capture a brainstorming idea onto the canvas as a card. Call this whenever you produce " +
      "an idea worth keeping — instead of writing it as a special marker line in your reply. " +
      "Returns the card's @ref so you can link follow-up ideas to it.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          minLength: 1,
          maxLength: 120,
          description: "The card heading — short, stable."
        },
        body: {
          type: "string",
          maxLength: 2000,
          default: "",
          description: "Description; multi-line welcome."
        },
        kind: {
          type: "string",
          pattern: KIND_PATTERN.source,
          description: "Optional kind tag: risk | feature | question | decision | …"
        },
        links: {
          type: "array",
          maxItems: 8,
          default: [],
          description: "Edges to existing cards by their short @ref.",
          items: {
            type: "object",
            properties: {
              to: {
                type: "string",
                pattern: REF_PATTERN.source,
                description: 'Short ref of an existing card (@a1 → "a1").'
              },
              relation: {
                type: "string",
                enum: ["about", "supersedes"],
                default: "about",
                description: '"supersedes" when this idea replaces the target card.'
              }
            },
            required: ["to"],
            additionalProperties: false
          }
        }
      },
      required: ["title"],
      additionalProperties: false
    }
  },
  {
    name: "capture_score",
    description:
      "Rate an existing canvas card for triage. Call once per card when asked to triage; " +
      "never create new cards while triaging.",
    inputSchema: {
      type: "object",
      properties: {
        ref: {
          type: "string",
          pattern: REF_PATTERN.source,
          description: "The card's @ref (required — a score needs a target)."
        },
        impact: { type: "integer", minimum: 1, maximum: 5 },
        effort: { type: "integer", minimum: 1, maximum: 5 },
        confidence: { type: "integer", minimum: 1, maximum: 5 }
      },
      required: ["ref", "impact", "effort"],
      additionalProperties: false
    }
  },
  {
    name: "mark_idea_done",
    description:
      "Mark an existing canvas card as done/complete (or reopen it). Call this when an idea has " +
      "been acted on, decided, or otherwise finished, so the board reflects workflow progress. " +
      "Targets the card by its @ref; pass done:false to reopen a card marked done by mistake.",
    inputSchema: {
      type: "object",
      properties: {
        ref: {
          type: "string",
          pattern: REF_PATTERN.source,
          description: "The card's @ref (required — a completion needs a target)."
        },
        done: {
          type: "boolean",
          default: true,
          description: "true marks the card done (default); false reopens it."
        }
      },
      required: ["ref"],
      additionalProperties: false
    }
  },
  {
    name: "link_idea",
    description:
      "Attach an external reference link to an existing canvas card — a Figma file, a Google Doc, a " +
      "spec, a design, any web URL. Use this to hang supporting material off an idea so it renders as a " +
      "clickable chip on the card. Targets the card by its @ref; pass an optional label for the display text.",
    inputSchema: {
      type: "object",
      properties: {
        ref: {
          type: "string",
          pattern: REF_PATTERN.source,
          description: "The card's @ref (required — a link needs a target card)."
        },
        url: {
          type: "string",
          maxLength: 2048,
          description: "The external URL (must start with http:// or https://)."
        },
        label: {
          type: "string",
          maxLength: 120,
          description: "Optional display text for the link; the card falls back to the URL's host when omitted."
        }
      },
      required: ["ref", "url"],
      additionalProperties: false
    }
  },
  {
    name: "get_board_ideas",
    description:
      "Read every page of a project's durable canvas board without requiring an attached browser. " +
      "Pass a project id returned by get_projects. Returns normalized idea cards and typed edges only.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: {
          type: "string",
          pattern: PROJECT_ID_PATTERN.source,
          description: "The project id returned by get_projects."
        }
      },
      required: ["projectId"],
      additionalProperties: false
    }
  },
  {
    name: "get_projects",
    description:
      "List all brainstorming projects from the durable backend registry. Returns discovery metadata, " +
      "runtime status, page names, and idea counts, but never terminal configuration or board contents.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  }
] as const;

/** Tool names the endpoint dispatches — the single source both the guard and the
 *  `tools/call` switch below read, so adding a tool can't drift them apart. */
const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

// ── Tool-argument parsing (hand-rolled, protocol.ts style) ──
// Each parse throws an Error whose message is written FOR THE MODEL: it comes
// back as an `isError` tool result, and a clear "what's wrong + what to do"
// is the retry loop that makes the channel self-correcting (§2).

function parseCaptureIdea(args: Record<string, unknown>): CreateIdeaInput {
  const { title, body, kind, links } = args;
  if (typeof title !== "string" || title.trim().length === 0) {
    throw new Error("`title` is required and must be a non-empty string (the card heading).");
  }
  if (title.length > 120) {
    throw new Error(`\`title\` is too long (${title.length} chars; max 120). Move detail into \`body\`.`);
  }
  if (body !== undefined && typeof body !== "string") {
    throw new Error("`body` must be a string when present.");
  }
  if (typeof body === "string" && body.length > 2000) {
    throw new Error(`\`body\` is too long (${body.length} chars; max 2000). Trim the description.`);
  }
  if (kind !== undefined && (typeof kind !== "string" || !KIND_PATTERN.test(kind))) {
    throw new Error("`kind` must be a lowercase tag matching ^[a-z][\\w-]*$ (e.g. risk, feature, question, decision).");
  }
  const parsedLinks: IdeaLink[] = [];
  if (links !== undefined) {
    if (!Array.isArray(links)) throw new Error("`links` must be an array of {to, relation?} objects.");
    if (links.length > 8) throw new Error(`Too many links (${links.length}; max 8).`);
    for (const link of links) {
      if (typeof link !== "object" || link === null) {
        throw new Error('Each link must be an object like {to: "a1"}.');
      }
      const { to, relation } = link as Record<string, unknown>;
      if (typeof to !== "string" || !REF_PATTERN.test(to)) {
        throw new Error('Each link needs `to`: an existing card\'s short ref (e.g. "a1" for @a1).');
      }
      if (relation !== undefined && relation !== "about" && relation !== "supersedes") {
        throw new Error('`relation` must be "about" or "supersedes" (default "about").');
      }
      // Relation is stored explicitly (default applied) so a tool-captured idea
      // is deep-equal to its `scanIdeas` marker twin — same identity, same wire
      // shape (§3.1 mapping table; guarded by the marker-parity tests).
      parsedLinks.push({ to, relation: relation === "supersedes" ? "supersedes" : "about" });
    }
  }
  const idea: CreateIdeaInput = { title, body: typeof body === "string" ? body : "" };
  if (typeof kind === "string") idea.kind = kind;
  if (parsedLinks.length > 0) idea.links = parsedLinks;
  return idea;
}

function parseScoreValue(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 5) {
    throw new Error(`\`${field}\` must be an integer from 1 to 5.`);
  }
  return value;
}

function parseCaptureScore(args: Record<string, unknown>): Score {
  const { ref, impact, effort, confidence } = args;
  if (typeof ref !== "string" || !REF_PATTERN.test(ref)) {
    throw new Error('`ref` is required: the card\'s short ref (e.g. "a1" for @a1).');
  }
  const score: Score = {
    ref,
    impact: parseScoreValue(impact, "impact"),
    effort: parseScoreValue(effort, "effort")
  };
  if (confidence !== undefined) score.confidence = parseScoreValue(confidence, "confidence");
  return score;
}

function parseMarkDone(args: Record<string, unknown>): Completion {
  const { ref, done } = args;
  if (typeof ref !== "string" || !REF_PATTERN.test(ref)) {
    throw new Error('`ref` is required: the card\'s short ref (e.g. "a1" for @a1).');
  }
  if (done !== undefined && typeof done !== "boolean") {
    throw new Error("`done` must be a boolean when present (true marks done, false reopens; default true).");
  }
  // `done` defaults to true — the tool's whole point is marking complete; the
  // explicit false is the deliberate reopen path.
  return { ref, done: done === undefined ? true : done };
}

function parseLinkReference(args: Record<string, unknown>): Reference {
  const { ref, url, label } = args;
  if (typeof ref !== "string" || !REF_PATTERN.test(ref)) {
    throw new Error('`ref` is required: the card\'s short ref (e.g. "a1" for @a1).');
  }
  if (typeof url !== "string" || url.trim().length === 0) {
    throw new Error("`url` is required and must be a non-empty string (the external link).");
  }
  const trimmed = url.trim();
  if (trimmed.length > 2048) {
    throw new Error(`\`url\` is too long (${trimmed.length} chars; max 2048).`);
  }
  // Only http(s): the chip is a real anchor opened in a new tab, so a
  // `javascript:`/`data:` scheme is both useless here and a needless footgun.
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("`url` must be an absolute http(s) URL, e.g. https://figma.com/file/….");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("`url` must use the http or https scheme.");
  }
  if (label !== undefined && typeof label !== "string") {
    throw new Error("`label` must be a string when present.");
  }
  if (typeof label === "string" && label.length > 120) {
    throw new Error(`\`label\` is too long (${label.length} chars; max 120).`);
  }
  const reference: Reference = { ref, url: trimmed };
  const trimmedLabel = typeof label === "string" ? label.trim() : "";
  if (trimmedLabel.length > 0) reference.label = trimmedLabel;
  return reference;
}

// ── JSON-RPC plumbing ──

type RpcId = string | number | null;

function rpcResult(id: RpcId, result: unknown) {
  return { jsonrpc: "2.0" as const, id, result };
}

function rpcError(id: RpcId, code: number, message: string) {
  return { jsonrpc: "2.0" as const, id, error: { code, message } };
}

/** A successful tool result: one text content block the model reads. */
function toolText(id: RpcId, text: string) {
  return rpcResult(id, { content: [{ type: "text", text }] });
}

/** A tool-level failure: `isError` result, NOT a JSON-RPC error — the model
 *  sees the text and retries with corrected arguments (§2). */
function toolError(id: RpcId, text: string) {
  return rpcResult(id, { content: [{ type: "text", text }], isError: true });
}

function logReadFailure(tool: "get_projects" | "get_board_ideas", error: unknown, projectId?: string): void {
  const cause = error instanceof Error ? error.cause : undefined;
  log.warn("mcp.read_failed", {
    tool,
    project: projectId,
    message: error instanceof Error ? error.message : String(error),
    path: error instanceof StateFileError ? error.path : undefined,
    cause: cause instanceof Error ? cause.message : cause === undefined ? undefined : String(cause)
  });
}

function initializeResult(params: Record<string, unknown> | undefined) {
  const requested = typeof params?.protocolVersion === "string" ? params.protocolVersion : undefined;
  return {
    // Negotiation per spec: echo the client's revision when we speak it,
    // otherwise counter-offer ours (the client then decides to proceed or not).
    protocolVersion: requested && KNOWN_VERSIONS.has(requested) ? requested : PROTOCOL_VERSION,
    capabilities: { tools: {} },
    serverInfo: SERVER_INFO
  };
}

/**
 * `tools/call` — the actual capture path (§6):
 * validate → dedupe via the session's shared sink → mint `i<n>` → emit through
 * the same callbacks the scanner feeds → return the ref to the model.
 */
async function handleToolCall(
  id: RpcId,
  params: Record<string, unknown> | undefined,
  projectId: string,
  session: McpSession,
  registry: McpSessionRegistry,
  stateStore: StateStore
) {
  const name = params?.name;
  const args = (params?.arguments ?? {}) as Record<string, unknown>;
  if (typeof name !== "string" || !TOOL_NAMES.has(name)) {
    return rpcError(id, -32602, `Unknown tool: ${String(name)}`);
  }
  // Durable read tools answer independently of browser attachment. Authenticate
  // via the route token, then authorize target ids against the registry so an
  // orphan directory can never be read as a deleted project.
  if (name === "get_projects") {
    try {
      const state = await stateStore.readRegistry();
      const folders = new Map(state.folders.map((folder) => [folder.id, folder.title]));
      const projects = await Promise.all(
        state.projects.map(async (project) => {
          const metadata = {
            id: project.id,
            title: project.title,
            ...(project.folderId && folders.has(project.folderId) ? { folder: folders.get(project.folderId) } : {}),
            createdAt: project.createdAt,
            updatedAt: project.updatedAt,
            status: registry.runtimeStatus(project.id)
          };
          try {
            const board = deriveBoardIdeas(await stateStore.readBoard(project.id));
            return {
              ...metadata,
              pages: board.pages.map((page) => page.name),
              ideaCount: board.pages.reduce((count, page) => count + page.cards.length, 0)
            };
          } catch (error) {
            // The registry remains authoritative during corruption and delete
            // races. Preserve complete discovery while degrading only this
            // project's board-derived metadata.
            logReadFailure("get_projects", error, project.id);
            return { ...metadata, status: "error" as const, pages: [], ideaCount: 0 };
          }
        })
      );
      return toolText(id, JSON.stringify({ version: 1, revision: state.revision, projects }));
    } catch (error) {
      logReadFailure("get_projects", error);
      return toolError(id, "Unable to read the project registry.");
    }
  }
  if (name === "get_board_ideas") {
    const targetId = args.projectId;
    if (typeof targetId !== "string" || !PROJECT_ID_PATTERN.test(targetId)) {
      return toolError(id, "`projectId` is required and must be an id returned by get_projects.");
    }
    try {
      const state = await stateStore.readRegistry();
      if (!state.projects.some((project) => project.id === targetId)) return toolError(id, "Project not found");
      return toolText(id, JSON.stringify(deriveBoardIdeas(await stateStore.readBoard(targetId))));
    } catch (error) {
      logReadFailure("get_board_ideas", error, targetId);
      return toolError(id, "Unable to read the requested project board.");
    }
  }

  const attachment = session.attachment;
  if (!attachment) {
    // Token is valid but no client is attached (detached durable session):
    // nothing to emit through. Tool error rather than 404 — the model should
    // know the capture was NOT delivered.
    return toolError(id, "Session not attached — no live canvas connection; nothing was captured.");
  }
  try {
    if (name === "capture_idea") {
      const idea = parseCaptureIdea(args);
      // Shared dedupe BEFORE minting (§6): if the scanner (or an earlier tool
      // call) already delivered this identity, emit nothing and don't burn a
      // ref. The agent calling the tool *and* echoing a marker line lands once.
      if (!attachment.ideaSink.offer(idea)) {
        return toolText(id, "Already captured — an identical idea is on the canvas; nothing was added.");
      }
      const ref = await session.mintRef();
      idea.ref = ref; // the canvas honours CreateIdeaInput.ref as the card's meta.ref (§3.3)
      log.info("idea.captured", {
        project: projectId,
        ref,
        kind: idea.kind ?? "",
        title: idea.title
      });
      attachment.onIdea(idea);
      return toolText(id, `Captured as @${ref}. Link follow-up ideas to it with links:[{to:"${ref}"}].`);
    }
    if (name === "capture_score") {
      const score = parseCaptureScore(args);
      // Same-tuple dedupe; a RE-triage (changed rating) is a new tuple and flows
      // through — the deliberate ScoreSink carry-over (§6).
      if (attachment.scoreSink.offer(score)) {
        log.info("score.captured", {
          project: projectId,
          ref: score.ref,
          impact: score.impact,
          effort: score.effort
        });
        attachment.onScore(score);
      }
      return toolText(id, `Scored @${score.ref}.`);
    }
    if (name === "link_idea") {
      // No sink: a reference is a discrete attach, not a re-rendered marker, so
      // it always flows through; the canvas dedupes by URL per card (#227).
      const reference = parseLinkReference(args);
      log.info("idea.reference", { project: projectId, ref: reference.ref, url: reference.url });
      attachment.onReference(reference);
      return toolText(id, `Linked ${reference.url} to @${reference.ref}.`);
    }
    // mark_idea_done — no sink: a completion is a discrete state change, not a
    // re-rendered marker, so it always flows through (idempotent on the canvas).
    const completion = parseMarkDone(args);
    log.info("idea.completion", { project: projectId, ref: completion.ref, done: completion.done });
    attachment.onCompletion(completion);
    return toolText(id, completion.done ? `Marked @${completion.ref} done.` : `Reopened @${completion.ref}.`);
  } catch (err) {
    return toolError(id, err instanceof Error ? err.message : String(err));
  }
}

/** Context passed to every registered JSON-RPC method handler. */
interface MethodContext {
  id: RpcId;
  params: Record<string, unknown> | undefined;
  projectId: string;
  session: McpSession;
}

/** The sessionless surface (§9/§11): `initialize`, `ping`, `tools/list`, `tools/call`. */
const METHOD_HANDLERS: Record<string, (ctx: MethodContext) => unknown> = {
  initialize: ({ id, params }) => rpcResult(id, initializeResult(params)),
  ping: ({ id }) => rpcResult(id, {}),
  "tools/list": ({ id }) => rpcResult(id, { tools: TOOLS })
};

/**
 * Build the `/mcp` sub-app. Mounted by `buildApp` with the process-wide
 * registry; tests mount it with private registries and drive it via
 * `app.request()` — no real server or harness needed (§9).
 */
export function mcpRoutes(registry: McpSessionRegistry, stateStore: StateStore): Hono {
  const app = new Hono();

  // No server-initiated stream in sessionless mode — 405 per Streamable HTTP.
  app.get("/:projectId/:token", (c) => c.text("Method Not Allowed", 405));

  app.post("/:projectId/:token", async (c) => {
    const { projectId, token } = c.req.param();
    // Auth first, before any body is parsed: wrong/missing token and unknown
    // project are the same bare 404 (no information leak — §4.1). Browser
    // cross-site POSTs are additionally fenced by CORS (a JSON POST needs a
    // preflight we never approve) and by the unguessable token itself.
    const session = registry.resolve(projectId, token);
    if (!session) return c.text("Not found", 404);

    let msg: unknown;
    try {
      msg = await c.req.json();
    } catch {
      return c.json(rpcError(null, -32700, "Parse error: body must be a JSON-RPC message"), 400);
    }
    if (Array.isArray(msg)) {
      return c.json(rpcError(null, -32600, "Batch requests are not supported"), 400);
    }
    if (typeof msg !== "object" || msg === null) {
      return c.json(rpcError(null, -32600, "Invalid request: expected a JSON-RPC object"), 400);
    }
    const { id, method, params } = msg as {
      id?: RpcId;
      method?: unknown;
      params?: Record<string, unknown>;
    };

    // Client-to-server notifications (`notifications/initialized`, cancels) and
    // stray responses carry no id → accept + ignore with 202 (spec).
    if (id === undefined || id === null) return c.body(null, 202);
    if (typeof method !== "string") {
      return c.json(rpcError(id, -32600, "Invalid request: missing `method`"), 400);
    }

    if (method === "tools/call") {
      return c.json(await handleToolCall(id, params, projectId, session, registry, stateStore));
    }
    const handler = METHOD_HANDLERS[method];
    if (!handler) return c.json(rpcError(id, -32601, `Method not found: ${method}`));
    return c.json(await handler({ id, params, projectId, session }));
  });

  return app;
}
