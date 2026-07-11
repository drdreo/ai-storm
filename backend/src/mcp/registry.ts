/**
 * MCP session registry — the routing/auth seam between the `/mcp` HTTP endpoint
 * and the session backends (mcp-idea-capture design §4.1).
 *
 * The endpoint must route a tool call to the CURRENTLY-attached session
 * plumbing: the shared dedupe sinks (§6) and the WS `onIdea`/`onScore`
 * callbacks the scanner also feeds. Neither backend can own that map alone
 * (the HTTP handler lives outside both), so it lives here, in a module both
 * backends and the server import, with one process-wide singleton mirroring
 * `getRuntime()`. Lifecycle, driven by the backends:
 *
 *   create()  → {@link registerSession} mints the per-session token (and the
 *               launch URL that embeds it) so it can be baked into the argv.
 *   attach()  → {@link attachSession} swaps in this attachment's sinks +
 *               callbacks (a tmux reattach builds fresh sinks, so the tool
 *               path must follow the swap to keep dedupe shared).
 *   detach()  → {@link detachSession} clears the attachment; the token stays
 *               valid (the durable session lives on) but tool calls get a
 *               "session not attached" tool error until the next attach.
 *   kill()    → {@link removeSession} forgets the project entirely → 404.
 *   reconcile() (tmux) → {@link restoreSession} re-registers a token read back
 *               from the durable session's `@ai_storm_mcp_token` option (§4.2).
 *
 * Ref minting (§3.3) also lives here: `i1`, `i2`, … per session, a namespace
 * disjoint from the canvas's `a<n>` mint, surviving attach/detach cycles and
 * resetting with the session. A backend restart resets the counter too, and a
 * re-issued `i<n>` is NOT harmless: the agent holds the old ref, so follow-up
 * links become ambiguous and lineage corrupts (#210). `mintRef` therefore
 * fast-forwards past every `i<n>` visible in the board snapshot before
 * issuing, and the canvas remints on collision as a last-resort guard.
 */

import { randomUUID, timingSafeEqual } from "node:crypto";
import type { BoardIdeasSnapshot, Completion, Idea, Reference, Score } from "@ai-storm/shared";
import type { IdeaSink, ScoreSink } from "../session/extraction/index.ts";

/** Logical MCP server name; harness tool ids derive from it (`mcp__ai-storm__…`). */
export const MCP_SERVER_NAME = "ai-storm";

/** What `create()` gets back: the minted secret and the launch URL embedding it. */
export interface McpLaunchTarget {
  token: string;
  /** `http://<host>:<port>/mcp/<projectId>/<token>` — project identity is
   *  structural (it comes from the URL, never from the model — design §4.1). */
  url: string;
}

/** The live attachment the tool path emits through — same plumbing as the scanner. */
export interface McpAttachment {
  /** The session's shared idea dedupe authority (mcp-idea-capture §6). */
  ideaSink: IdeaSink;
  /** The session's shared score dedupe authority. */
  scoreSink: ScoreSink;
  onIdea: (idea: Idea) => void;
  onScore: (score: Score) => void;
  /** Emit a completion-state change for an existing card (#167). Unlike ideas and
   *  scores there is no scanner producer — only the `mark_idea_done` tool feeds
   *  this — so no shared dedupe sink is needed (a tool call is discrete, not a
   *  per-frame re-render), and the canvas applies it last-write-wins per ref. */
  onCompletion: (completion: Completion) => void;
  /** Emit an external-link reference for an existing card (#227). Like
   *  {@link onCompletion} it has no scanner producer — only the `link_idea` tool
   *  feeds it — so no shared dedupe sink is needed; the canvas appends it to the
   *  card's `meta.links` (deduped by URL). */
  onReference: (reference: Reference) => void;
}

/** What the endpoint sees after a successful token check. */
export interface McpSession {
  /** The current attachment, or null while detached ("session not attached"). */
  attachment: McpAttachment | null;
  boardSnapshot: BoardIdeasSnapshot | null;
  /** Mint the next session-scoped `i<n>` ref (§3.3). */
  mintRef: () => Promise<string>;
}

interface Entry {
  token: string;
  attachment: McpAttachment | null;
  boardSnapshot: BoardIdeasSnapshot | null;
  /** Next `i<n>` index — session-scoped, survives reattach, dies with kill(). */
  nextRef: number;
}

/** Backend-minted ref pattern — the `i<n>` namespace (§3.3). */
const MCP_MINT_REF = /^i(\d+)$/;

/**
 * Fast-forward a (possibly restart-reset) `nextRef` counter past every `i<n>`
 * ref already on the board (#210): a re-issued ref would collide with a card
 * the agent already holds a handle to, corrupting follow-up links. The snapshot
 * covers the current page only, so this is best-effort — the canvas keeps a
 * remint guard for anything it can't see.
 */
function skipMintedRefs(nextRef: number, snapshot: BoardIdeasSnapshot | null): number {
  if (!snapshot) return nextRef;
  for (const card of snapshot.cards) {
    const m = card.ref ? MCP_MINT_REF.exec(card.ref) : null;
    if (m) nextRef = Math.max(nextRef, Number(m[1]) + 1);
  }
  return nextRef;
}

/** Constant-time token comparison (the token is the only auth on the endpoint). */
function tokenMatches(expected: string, given: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(given, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export class McpSessionRegistry {
  /** Server origin (e.g. `http://127.0.0.1:8787`) — set by `buildApp` before any
   *  attach can race it. Null until then → `registerSession` declines and the
   *  session launches without MCP (markers floor), never with a dead URL. */
  #baseUrl: string | null = null;

  #entries = new Map<string, Entry>();
  #reserveRef: ((projectId: string) => Promise<string>) | null = null;

  /** Use the canonical filesystem allocator for MCP captures. */
  configureRefAllocator(reserve: (projectId: string) => Promise<string>): void {
    this.#reserveRef = reserve;
  }

  /** Hand the registry the server's reachable origin (no trailing slash). */
  configure(baseUrl: string): void {
    this.#baseUrl = baseUrl.replace(/\/+$/, "");
  }

  /**
   * Mint (or, idempotently, reuse) the per-session token at `create()` and
   * return the launch target. `randomUUID()` with the dashes stripped is the
   * 128-bit secret (design §4.1). Returns undefined when no base URL is
   * configured — the caller then launches without MCP wiring.
   */
  registerSession(projectId: string): McpLaunchTarget | undefined {
    if (!this.#baseUrl) return undefined;
    let entry = this.#entries.get(projectId);
    if (!entry) {
      entry = { token: randomUUID().replace(/-/g, ""), attachment: null, boardSnapshot: null, nextRef: 1 };
      this.#entries.set(projectId, entry);
    }
    return { token: entry.token, url: `${this.#baseUrl}/mcp/${projectId}/${entry.token}` };
  }

  /**
   * Re-register a token recovered from a durable session at `reconcile()`
   * (tmux `@ai_storm_mcp_token`, design §4.2) so the URL baked into its launch
   * args keeps routing after a backend restart.
   */
  restoreSession(projectId: string, token: string): void {
    if (this.#entries.has(projectId)) return; // live entry wins
    this.#entries.set(projectId, { token, attachment: null, boardSnapshot: null, nextRef: 1 });
  }

  /** Route the tool path into this attachment's sinks/callbacks (no-op if the
   *  project was never MCP-registered — a markers-only session). */
  attachSession(projectId: string, attachment: McpAttachment): void {
    const entry = this.#entries.get(projectId);
    if (entry) entry.attachment = attachment;
  }

  /** Detach: keep the token (the durable session lives on), drop the plumbing. */
  detachSession(projectId: string): void {
    const entry = this.#entries.get(projectId);
    if (entry) entry.attachment = null;
  }

  updateBoardSnapshot(projectId: string, snapshot: BoardIdeasSnapshot): void {
    const entry = this.#entries.get(projectId);
    if (entry) entry.boardSnapshot = snapshot;
  }

  /** Kill: forget the project — its URL 404s and its `i<n>` counter resets. */
  removeSession(projectId: string): void {
    this.#entries.delete(projectId);
  }

  /** True when this session launched MCP-wired (used to flag `idea.fallback_scan`). */
  isRegistered(projectId: string): boolean {
    return this.#entries.has(projectId);
  }

  /**
   * Auth + routing lookup for the endpoint. Unknown project and wrong token
   * are indistinguishable to the caller (both → undefined → 404, design §4.1).
   */
  resolve(projectId: string, token: string): McpSession | undefined {
    const entry = this.#entries.get(projectId);
    if (!entry || !tokenMatches(entry.token, token)) return undefined;
    return {
      get attachment() {
        return entry.attachment;
      },
      get boardSnapshot() {
        return entry.boardSnapshot;
      },
      mintRef: async () => {
        if (this.#reserveRef) return this.#reserveRef(projectId);
        // Test/legacy fallback when no StateStore has been configured.
        entry.nextRef = skipMintedRefs(entry.nextRef, entry.boardSnapshot);
        return `i${entry.nextRef++}`;
      }
    };
  }
}

/**
 * The process-wide registry, shared by the server (routes into it) and both
 * session backends (feed it). Mirrors the `getRuntime()` singleton pattern;
 * tests construct private instances instead.
 */
export const mcpRegistry = new McpSessionRegistry();
