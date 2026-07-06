/**
 * Generated pi capture extension (#177) — pi's deterministic idea channel.
 *
 * pi has no MCP support (by design: "build CLI tools or an extension instead"),
 * but its native extensibility seam — TypeScript extensions loaded with
 * `-e <file>` that call `pi.registerTool(...)` — gives the model the exact same
 * schema-validated, deterministic capture channel MCP gives Claude. The
 * backend's "MCP server" is already a sessionless single-message JSON-RPC
 * endpoint (`POST /mcp/:projectId/:token`, endpoint.ts), so each registered
 * tool just forwards its call as one `tools/call` fetch and relays the result.
 *
 * `PI_PROFILE.fileLaunch` writes this source into the session temp dir at
 * `create()` with the per-session endpoint URL baked in (token minted
 * backend-side — never derived from model output, same posture as
 * `McpLaunchContext`).
 *
 * Verified against pi 0.80.3 (docs/extensions.md + dist/core/extensions/types.d.ts):
 *  - `-e <path>` / `--extension <path>` loads a TS module via jiti, repeatable,
 *    additive to auto-discovered extensions.
 *  - Extension shape: `export default function (pi: ExtensionAPI)`.
 *  - `pi.registerTool({ name, label, description, parameters, execute })` with
 *    `parameters` a typebox `TSchema`; `execute` resolves to
 *    `{ content: [{ type: "text", text }], details }`.
 *  - Errors are signalled by THROWING from `execute` (a returned value never
 *    sets `isError`) — so backend `isError` tool results are re-thrown, which
 *    keeps the self-correcting validation loop (mcp-idea-capture §2) intact.
 *  - String enums must use `StringEnum` from `@earendil-works/pi-ai`
 *    (`Type.Union`/`Type.Literal` breaks Google-provider schemas).
 *
 * The tool names, descriptions, and constraints below mirror `TOOLS` in
 * `backend/src/mcp/endpoint.ts` (typebox here vs. JSON Schema there — the two
 * schema dialects prevent literal reuse). Drift is tolerable in one direction
 * only: the endpoint re-validates every argument and returns a readable
 * `isError` text, so a looser schema here degrades to a retry, never to a bad
 * card. A test in extraction.test.ts pins the tool-name parity.
 */

/** Filename the extension is written under in the session temp dir. */
export const PI_EXTENSION_FILENAME = "ai-storm-capture.ts";

/**
 * Render the extension source with the per-session capture endpoint baked in.
 * Pure string building — the backend writes the file via the shared
 * `fileLaunch` seam (file-launch.ts), which also owns cleanup on kill/failure.
 */
export function piCaptureExtensionSource(endpointUrl: string): string {
  return `/**
 * ai-storm capture extension — GENERATED at session launch; do not edit.
 * Forwards capture tool calls to this session's ai-storm backend endpoint as
 * single-message JSON-RPC (the same tools/call surface MCP clients use).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

const ENDPOINT = ${JSON.stringify(endpointUrl)};

interface RpcResponse {
  result?: { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  error?: { message?: string };
}

/** POST one tools/call and return the result text. Backend validation
 * failures arrive as \`isError\` results — thrown here so pi reports the tool
 * call as failed and the model retries with corrected arguments. */
async function forward(name: string, args: unknown): Promise<string> {
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })
    });
  } catch (err) {
    throw new Error("ai-storm backend unreachable: " + (err instanceof Error ? err.message : String(err)));
  }
  if (!res.ok) throw new Error("ai-storm capture endpoint returned HTTP " + res.status);
  const msg = (await res.json()) as RpcResponse;
  if (msg.error) throw new Error(msg.error.message ?? "capture failed");
  const text = (msg.result?.content ?? [])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\\n");
  if (msg.result?.isError) throw new Error(text || "capture failed");
  return text || "ok";
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "capture_idea",
    label: "Capture idea",
    description:
      "Capture a brainstorming idea onto the canvas as a card. Call this whenever you produce " +
      "an idea worth keeping — instead of writing it as a special marker line in your reply. " +
      "Returns the card's @ref so you can link follow-up ideas to it.",
    promptSnippet: "Capture a brainstorming idea onto the canvas",
    parameters: Type.Object({
      title: Type.String({ minLength: 1, maxLength: 120, description: "The card heading — short, stable." }),
      body: Type.Optional(Type.String({ maxLength: 2000, description: "Description; multi-line welcome." })),
      kind: Type.Optional(
        Type.String({ pattern: "^[a-z][\\\\w-]*$", description: "Optional kind tag: risk | feature | question | decision | …" })
      ),
      links: Type.Optional(
        Type.Array(
          Type.Object({
            to: Type.String({ pattern: "^[\\\\w-]+$", description: 'Short ref of an existing card (@a1 → "a1").' }),
            relation: Type.Optional(StringEnum(["about", "supersedes"] as const))
          }),
          { maxItems: 8, description: "Edges to existing cards by their short @ref." }
        )
      )
    }),
    async execute(_toolCallId, params) {
      return { content: [{ type: "text", text: await forward("capture_idea", params) }], details: {} };
    }
  });

  pi.registerTool({
    name: "capture_score",
    label: "Capture score",
    description:
      "Rate an existing canvas card for triage. Call once per card when asked to triage; " +
      "never create new cards while triaging.",
    promptSnippet: "Rate an existing canvas card for triage",
    parameters: Type.Object({
      ref: Type.String({ pattern: "^[\\\\w-]+$", description: "The card's @ref (required — a score needs a target)." }),
      impact: Type.Integer({ minimum: 1, maximum: 5 }),
      effort: Type.Integer({ minimum: 1, maximum: 5 }),
      confidence: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 }))
    }),
    async execute(_toolCallId, params) {
      return { content: [{ type: "text", text: await forward("capture_score", params) }], details: {} };
    }
  });

  pi.registerTool({
    name: "mark_idea_done",
    label: "Mark idea done",
    description:
      "Mark an existing canvas card as done/complete (or reopen it). Call this when an idea has " +
      "been acted on, decided, or otherwise finished, so the board reflects workflow progress. " +
      "Targets the card by its @ref; pass done:false to reopen a card marked done by mistake.",
    promptSnippet: "Mark an existing canvas card done (or reopen it)",
    parameters: Type.Object({
      ref: Type.String({ pattern: "^[\\\\w-]+$", description: "The card's @ref (required — a completion needs a target)." }),
      done: Type.Optional(Type.Boolean({ description: "true marks the card done (default); false reopens it." }))
    }),
    async execute(_toolCallId, params) {
      return { content: [{ type: "text", text: await forward("mark_idea_done", params) }], details: {} };
    }
  });
}
`;
}
