/**
 * The MCP capture endpoint — `POST /mcp/:projectId/:token` (mcp-idea-capture
 * design §§3–4): a minimal, sessionless MCP server over the Streamable HTTP
 * transport, exposing capture tools plus workflow/read tools (`capture_idea`,
 * `capture_score`, `mark_idea_done`, `link_idea`, `get_board_ideas`, and
 * `get_projects`) so the agent delivers structured actions as schema-validated
 * JSON tool calls rather than marker lines rendered through a terminal (§1/§2).
 *
 * Hand-rolled against MCP protocol revision 2026-07-28. This is a hard-cutover,
 * modern-only endpoint: there is no `initialize` handshake, protocol session,
 * GET stream, legacy HTTP+SSE lane, or version fallback. Every request carries
 * its version, client identity/capabilities, and routing metadata independently.
 * The surface is deliberately the sessionless minimum — `server/discover`,
 * `tools/list`, and `tools/call` — so no SDK dependency is warranted.
 * Every successful response is a single `application/json` result with the
 * modern `resultType` and server identity fields. The endpoint never chooses
 * SSE because none of its operations emit request-scoped notifications.
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
import {
  MCP_CLIENT_CAPABILITIES_META_KEY,
  MCP_CLIENT_INFO_META_KEY,
  MCP_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSION_META_KEY,
  MCP_SERVER_INFO_META_KEY
} from "./protocol.ts";

const SERVER_INFO = { name: "ai-storm", version: "3.0.0" };
const SERVER_CAPABILITIES = { tools: {} };
const JSON_ACCEPT = "application/json";
const SSE_ACCEPT = "text/event-stream";
const HEADER_MISMATCH = -32020;
const UNSUPPORTED_PROTOCOL_VERSION = -32022;

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

function rpcResult(id: RpcId, result: Record<string, unknown>) {
  return {
    jsonrpc: "2.0" as const,
    id,
    result: {
      ...result,
      resultType: "complete",
      _meta: {
        ...(result._meta as Record<string, unknown> | undefined),
        [MCP_SERVER_INFO_META_KEY]: SERVER_INFO
      }
    }
  };
}

function rpcError(id: RpcId, code: number, message: string, data?: unknown) {
  const error: { code: number; message: string; data?: unknown } = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0" as const, id, error };
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

/** The modern sessionless surface: discovery plus the advertised tools capability. */
const METHOD_HANDLERS: Record<string, (ctx: MethodContext) => unknown> = {
  "server/discover": ({ id }) =>
    rpcResult(id, {
      // `protocolVersion` is the compact metadata field consumed by the
      // pi-mcp-adapter endpoint probe; `supportedVersions` is the canonical
      // MCP discovery list used by pinned SDK clients.
      protocolVersion: MCP_PROTOCOL_VERSION,
      supportedVersions: [MCP_PROTOCOL_VERSION],
      capabilities: SERVER_CAPABILITIES,
      instructions: "Capture and manage ai-storm canvas ideas using the advertised tools.",
      ttlMs: 0,
      cacheScope: "private"
    }),
  "tools/list": ({ id }) => rpcResult(id, { tools: TOOLS, ttlMs: 0, cacheScope: "private" })
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function accepts(header: string | undefined, mediaType: string): boolean {
  return (
    header
      ?.split(",")
      .map((part) => part.split(";", 1)[0].trim().toLowerCase())
      .includes(mediaType) ?? false
  );
}

/** MCP is local-only; reject every browser Origin except loopback origins. */
function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const host = new URL(origin).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

/** Decode the sentinel used when an MCP routing header is not plain ASCII. */
function decodeHeaderValue(value: string): string {
  if (!value.startsWith("=?base64?") || !value.endsWith("?=")) return value;
  try {
    return Buffer.from(value.slice("=?base64?".length, -2), "base64").toString("utf8");
  } catch {
    return value;
  }
}

function unsupportedVersion(id: RpcId, requested: string) {
  return rpcError(
    id,
    UNSUPPORTED_PROTOCOL_VERSION,
    `Unsupported MCP protocol version ${requested}. Upgrade the client to MCP ${MCP_PROTOCOL_VERSION}; legacy MCP transports and initialize negotiation are not supported.`,
    { supported: [MCP_PROTOCOL_VERSION], requested }
  );
}

/**
 * Build the `/mcp` sub-app. Mounted by `buildApp` with the process-wide
 * registry; tests mount it with private registries and drive it via
 * `app.request()` — no real server or harness needed (§9).
 */
export function mcpRoutes(registry: McpSessionRegistry, stateStore: StateStore): Hono {
  const app = new Hono();

  // Streamable HTTP requires Origin validation on every incoming connection,
  // including rejected methods and browser preflights.
  app.use("/:projectId/:token", async (c, next) => {
    if (!isOriginAllowed(c.req.header("origin"))) {
      return c.json(rpcError(null, -32600, "Forbidden Origin: MCP only accepts loopback browser origins."), 403);
    }
    await next();
  });

  // MCP 2026-07-28 has no standalone GET stream or session DELETE operation.
  app.on(["GET", "PUT", "PATCH", "DELETE", "OPTIONS"], "/:projectId/:token", (c) =>
    c.json(
      rpcError(
        null,
        -32600,
        `MCP ${MCP_PROTOCOL_VERSION} is POST-only and sessionless. Upgrade legacy clients; GET streams and session teardown are not supported.`
      ),
      405
    )
  );

  app.post("/:projectId/:token", async (c) => {
    const { projectId, token } = c.req.param();
    // Auth first, before any body is parsed: wrong/missing token and unknown
    // project are the same bare 404 (no information leak — §4.1).
    const session = registry.resolve(projectId, token);
    if (!session) return c.text("Not found", 404);

    const accept = c.req.header("accept");
    if (!accepts(accept, JSON_ACCEPT) || !accepts(accept, SSE_ACCEPT)) {
      return c.json(
        rpcError(
          null,
          -32600,
          `MCP ${MCP_PROTOCOL_VERSION} requests must accept both application/json and text/event-stream; upgrade legacy clients.`
        ),
        406
      );
    }
    if (c.req.header("content-type")?.split(";", 1)[0].trim().toLowerCase() !== JSON_ACCEPT) {
      return c.json(
        rpcError(null, -32600, `MCP ${MCP_PROTOCOL_VERSION} requires Content-Type: application/json.`),
        415
      );
    }

    let msg: unknown;
    try {
      msg = await c.req.json();
    } catch {
      return c.json(rpcError(null, -32700, "Parse error: body must be a JSON-RPC message"), 400);
    }
    if (Array.isArray(msg)) {
      return c.json(rpcError(null, -32600, "Batch requests are not supported by MCP 2026-07-28"), 400);
    }
    if (!isRecord(msg) || msg.jsonrpc !== "2.0") {
      return c.json(rpcError(null, -32600, "Invalid request: expected one JSON-RPC 2.0 object"), 400);
    }

    const id = msg.id;
    const method = msg.method;
    const params = msg.params;
    if (id === undefined) {
      return c.json(
        rpcError(
          null,
          -32600,
          `Client notifications are not supported by this MCP ${MCP_PROTOCOL_VERSION} HTTP endpoint.`
        ),
        400
      );
    }
    if ((typeof id !== "string" && typeof id !== "number") || typeof method !== "string" || !isRecord(params)) {
      return c.json(rpcError(null, -32600, "Invalid request: `id`, `method`, and object `params` are required"), 400);
    }

    const meta = isRecord(params._meta) ? params._meta : undefined;
    const headerVersion = c.req.header("mcp-protocol-version");
    const bodyVersion = meta?.[MCP_PROTOCOL_VERSION_META_KEY];
    const initializeVersion = method === "initialize" ? params.protocolVersion : undefined;
    const requestedVersion =
      headerVersion ??
      (typeof bodyVersion === "string" ? bodyVersion : undefined) ??
      (typeof initializeVersion === "string" ? initializeVersion : undefined);

    // Detect old initialize clients before generic header validation so their
    // only visible failure tells them exactly how to recover.
    if (requestedVersion && requestedVersion !== MCP_PROTOCOL_VERSION) {
      return c.json(unsupportedVersion(id, requestedVersion), 400);
    }
    if (!headerVersion) {
      return c.json(
        rpcError(
          id,
          HEADER_MISMATCH,
          `Missing MCP-Protocol-Version header. This endpoint requires MCP ${MCP_PROTOCOL_VERSION}; upgrade legacy clients.`
        ),
        400
      );
    }
    // pi-mcp-adapter's metadata-only endpoint probe carries the modern
    // version/method in mandatory HTTP headers but intentionally sends empty
    // discover params. Keep that one modern probe interoperable; every actual
    // operation still requires the full per-request envelope.
    const isHeaderOnlyDiscoverProbe = method === "server/discover" && params._meta === undefined;
    if (!meta && !isHeaderOnlyDiscoverProbe) {
      return c.json(
        rpcError(id, -32602, `Invalid params: MCP ${MCP_PROTOCOL_VERSION} requests require params._meta.`),
        400
      );
    }
    if (meta && bodyVersion !== headerVersion) {
      return c.json(
        rpcError(id, HEADER_MISMATCH, "MCP-Protocol-Version header does not match params._meta protocolVersion."),
        400
      );
    }
    if (meta && !isRecord(meta[MCP_CLIENT_CAPABILITIES_META_KEY])) {
      return c.json(
        rpcError(id, -32602, `Invalid params: _meta.${MCP_CLIENT_CAPABILITIES_META_KEY} must be an object.`),
        400
      );
    }
    const clientInfo = meta?.[MCP_CLIENT_INFO_META_KEY];
    if (
      clientInfo !== undefined &&
      (!isRecord(clientInfo) || typeof clientInfo.name !== "string" || typeof clientInfo.version !== "string")
    ) {
      return c.json(
        rpcError(id, -32602, `Invalid params: _meta.${MCP_CLIENT_INFO_META_KEY} must contain name and version.`),
        400
      );
    }

    const headerMethod = c.req.header("mcp-method");
    if (!headerMethod || headerMethod !== method) {
      return c.json(
        rpcError(id, HEADER_MISMATCH, "Mcp-Method header is required and must match the JSON-RPC method."),
        400
      );
    }
    if (method === "tools/call") {
      const headerName = c.req.header("mcp-name");
      if (headerName === undefined || decodeHeaderValue(headerName) !== params.name) {
        return c.json(
          rpcError(id, HEADER_MISMATCH, "Mcp-Name header is required and must match tools/call params.name."),
          400
        );
      }
      return c.json(await handleToolCall(id, params, projectId, session, registry, stateStore));
    }

    const handler = METHOD_HANDLERS[method];
    if (!handler) {
      const message =
        method === "initialize"
          ? `Method not found: initialize. MCP ${MCP_PROTOCOL_VERSION} is stateless and has no initialize handshake.`
          : `Method not found: ${method}`;
      return c.json(rpcError(id, -32601, message), 404);
    }
    return c.json(await handler({ id, params, projectId, session }));
  });

  return app;
}
