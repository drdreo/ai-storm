# Design: MCP idea capture — a structured side-channel for ideas and scores

**Status:** 🟡 Proposed
**Author:** ai-storm backend
**Related:** [Product decisions](../decisions/product-decisions.md) PD-008 (terminal passthrough + idea scan) ·
[`ai-response-extraction-contract.md`](./ai-response-extraction-contract.md) (the `«IDEA»` marker contract this
doc demotes to a fallback) · [`ai-session-layer.md`](./ai-session-layer.md) §4/§5 (capture backends) ·
[`idea-graph.md`](./idea-graph.md) §4/§5 (refs, typed edges) · issues #38 (resize dedupe), #60 (triage), #62 (combine)

---

## 1. Problem statement

The idea pipeline today transports **data over a presentation surface**. The agent emits `«IDEA»` /
`«SCORE»` marker lines into its TUI; the backend renders the terminal (tmux `capture-pane -p -J` on
POSIX, a headless `@xterm/headless` screen on Windows) and `IdeaScanner` re-parses the rendered text
on every poll/chunk, deduping by `ideaIdentityKey` (title + kind + links).

This works in the steady state, but the rendered screen is **width-dependent and repaint-dependent**,
and terminal resizing exercises both weaknesses at once. Observed failure modes:

1. **Mid-repaint captures.** On resize, the harness TUI clears and repaints the whole conversation at
   the new width. The Windows backend scans after _every_ PTY chunk; a chunk boundary mid-line leaves
   a marker row holding half a title while rows _below_ it (input box, status area) are already
   painted — so the growing-tail hold-back (`extraction.ts` `scanIdeas`) does not protect it. The
   truncated title parses "successfully", gets a different identity key, and lands as a bogus card;
   the completed line then lands as a second card. The tmux poller has the same race at 400 ms
   granularity.
2. **Hard wraps join differently than soft wraps.** The TUIs word-wrap their own output with real
   newlines, invisible to `capture-pane -J` and `isWrapped`. The scanner rejoins those continuation
   rows with a **space**; a long token split mid-word reads differently at different widths, and if
   the split lands in the _title_, the identity key changes across a resize → duplicate card.
3. **Stale scrollback (Windows).** `snapshotAll()` keeps scanning the pre-resize copy of the
   conversation in scrollback _and_ the re-wrapped repaint below it; any reconstruction divergence
   between the two duplicates the idea.
4. **Width-sensitive rejoin boundaries.** Continuation absorption stops at blank lines / markers /
   `CHROME_BOUNDARY`. Where those fall depends on the wrap width, so the _same_ logical idea can
   reconstruct differently before and after a resize.

Each of these can be (and has been) patched heuristically — identity excludes the body (#38), `-J`
rejoin, hold-back, near-miss telemetry — but the heuristics share a ceiling: **a marker line is only
as stable as the terminal rendering it.** Every patch hardens the parse of a surface that was never
designed to be parsed.

## 2. Goal & chosen approach

Give the agent a **structured, validated side-channel** for the data half of the contract, so the
terminal goes back to being purely presentational:

> **Expose MCP tools from the backend** — `capture_idea` and `capture_score` — served over MCP's
> Streamable HTTP transport on the localhost server the backend already runs. Contract-aware harness
> profiles inject the MCP wiring at launch through the **same profile seam** that injects the system
> prompt today (`launchArgsForProfile`). The priming instructs the agent to **call the tool** instead
> of emitting marker lines.
>
> The `«IDEA»` marker scan is **kept, demoted to a fallback** for harnesses without MCP support and
> for tool-call lapses — exactly the defence-in-depth shape the original extraction contract used
> (explicit contract primary, heuristic floor secondary, every fallback **logged**).

Why this eliminates the §1 class rather than patching it:

- An idea arrives as a **JSON tool call**, schema-validated at the tool layer. There is no wrap, no
  repaint, no reconstruction — width is irrelevant. Resize can do whatever it wants to the screen.
- Validation is **self-correcting**: a malformed tool call returns an MCP error the model sees and
  retries. A mangled marker line today is silently lost (at best logged as a near-miss).
- Multi-line bodies — the fenced Form 2, which PD-008 already flagged as unreliable because the TUI
  renders the fence away — become trivially safe: `body` is just a JSON string.
- The ref chain (`@a1!@a2!`, the #62 combine verb) becomes a typed `links` array instead of a
  micro-grammar the model must reproduce character-perfectly.
- The tool **returns the captured card's ref** to the model, closing a loop the marker contract
  cannot: today the agent never learns the ref of a card it just created, so it cannot link follow-up
  ideas to it within the same turn. With the tool result (`captured as @i3`) it can.

This is also the honest answer to "make the AI response more deterministic": the CLIs expose no
sampling controls, so determinism must come from moving the structured part of the response into a
channel with **schema validation and retry** — which is precisely what tool calls are.

### Non-goals

- Replacing the interactive terminal as the conversation surface (PD-008 stands; chat stays in the
  PTY, rendered by xterm.js).
- Removing the marker scanner. It remains the fallback floor (§7) and the only path for
  contract-aware harnesses without MCP.
- Scanner hardening (quiescence gating, two-frame confirmation, resize settle window). Those are
  complementary, cheap, and worth doing for the fallback path — tracked separately; this doc removes
  the _primary_ path's dependence on them.

---

## 3. Tool surface

Two tools, mirroring the two marker forms. Schemas are the single source of truth (zod backend-side,
serialized to JSON Schema in the MCP `tools/list` response).

### 3.1 `capture_idea`

```ts
{
  name: "capture_idea",
  description:
    "Capture a brainstorming idea onto the canvas as a card. Call this whenever you produce " +
    "an idea worth keeping — instead of writing it as a special marker line in your reply. " +
    "Returns the card's @ref so you can link follow-up ideas to it.",
  inputSchema: z.object({
    title: z.string().min(1).max(120),          // the card heading — short, stable
    body: z.string().max(2000).default(""),     // description; multi-line welcome
    kind: z.string().regex(/^[a-z][\w-]*$/).optional(),  // risk | feature | question | decision | …
    links: z.array(z.object({
      to: z.string().regex(/^[\w-]+$/),          // short ref of an existing card (@a1 → "a1")
      relation: z.enum(["about", "supersedes"]).default("about"),
    })).max(8).default([]),
  }),
}
```

**Result:** `{ ref: string }` — e.g. `{ "ref": "i3" }`, rendered to the model as
`Captured as @i3. Link follow-up ideas to it with links:[{to:"i3"}].`

Semantics map 1:1 onto today's `Idea`:

| Marker form                              | Tool form                                                                     |
| ---------------------------------------- | ----------------------------------------------------------------------------- |
| `«IDEA» T :: B`                          | `{title: "T", body: "B"}`                                                     |
| `«IDEA:risk» …`                          | `{kind: "risk", …}`                                                           |
| `«IDEA:risk@a1» …`                       | `{links: [{to: "a1"}], …}` (relation defaults to `about`)                     |
| `«IDEA@a1!» …` (supersede, PD-012)       | `{links: [{to: "a1", relation: "supersedes"}]}`                               |
| `«IDEA@a1!@a2!» …` (combine, #62/PD-019) | `{links: [{to:"a1",relation:"supersedes"}, {to:"a2",relation:"supersedes"}]}` |
| ` ```idea ` fenced multi-line body       | `body` with embedded `\n` — no special form needed                            |

### 3.2 `capture_score`

```ts
{
  name: "capture_score",
  description:
    "Rate an existing canvas card for triage. Call once per card when asked to triage; " +
    "never create new cards while triaging.",
  inputSchema: z.object({
    ref: z.string().regex(/^[\w-]+$/),           // the card's @ref (required — a score needs a target)
    impact: z.number().int().min(1).max(5),
    effort: z.number().int().min(1).max(5),
    confidence: z.number().int().min(1).max(5).optional(),
  }),
}
```

**Result:** `{ ok: true }` (`Scored @a1.`). Maps 1:1 onto `«SCORE@a1» 4/2/3`.

### 3.3 Ref minting for tool-captured ideas

Today refs (`a1`, `a2`, …) are minted **frontend-side** at card creation (`idea-card.tsx` `cardRef`),
and `Idea.id` exists for the rare agent-stamped ref (fenced `id:`). A synchronous tool result cannot
wait for the canvas round-trip, so:

- The MCP handler mints the ref **backend-side** in a distinct namespace — `i1`, `i2`, … per session —
  and stamps it into `Idea.id` before emitting. The `i` prefix cannot collide with the canvas's
  `a${n}` mint sequence.
- The canvas must **honour `Idea.id` as the card's ref** when present (`applyIdeas` → shape
  `meta.ref`). The `Idea.id` field and its documented intent already exist; verify the honour path
  and add it if `applyIdeas` currently ignores it (small frontend change, the only one in this
  design).
- `resolveRef` already resolves any string ref, so `links: [{to: "i3"}]` and `«SCORE@i3»` work
  unchanged once the meta is stamped.

---

## 4. Transport & session scoping

### 4.1 Streamable HTTP on the existing server

The backend already runs a Hono HTTP+WS server bound to `127.0.0.1`. Add an MCP **Streamable HTTP**
endpoint (the modern transport; stdio would require a shim subprocess per session and complicates the
tmux launch line):

```
POST /mcp/:workspaceId/:token        ← JSON-RPC (initialize / tools/list / tools/call)
```

- **Workspace identity comes from the URL, never from the model.** Each session's launch config gets
  its own URL, so a tool call is attributed to its workspace structurally — the agent cannot name (or
  misname) a workspace.
- **`:token`** is a per-session secret (128-bit, `randomUUID`-derived) minted at `create()`. The
  server rejects a mismatched token with 404. Binding stays `127.0.0.1`; the token guards against
  other local processes, same trust model as the existing WS endpoint. (Header-based auth would be
  cleaner but is not uniformly supported across harness MCP configs; a path token works everywhere.
  Trade-off: the URL can appear in process listings/logs — acceptable for a localhost dev tool, noted
  in §10.)
- The handler implements the minimal server surface: `initialize`, `tools/list`, `tools/call`.
  Sessionless mode (no SSE stream, no server-initiated messages) keeps it ~one file.

### 4.2 Durability across backend restarts (POSIX)

A tmux session outlives the backend process (PRD §3.5), but the MCP URL baked into its launch args
must keep working after a restart:

- The **port** must be stable across restarts (it already effectively is — the backend binds a
  configured port).
- The **token** is persisted tmux-natively at create time — `set-option @ai_storm_mcp_token <token>`
  — and re-registered into the in-memory token map during `reconcile()`, exactly the pattern the
  extraction contract used for the `@ai_storm_primed` flag. On Windows the session dies with the
  process (design §10.4), so the in-memory map suffices.

### 4.3 Per-harness launch injection

Extend the profile seam, not the backends. `HarnessProfile` gains one hook; `launchArgsForProfile`
gains an optional MCP context so tmux and node-pty launch paths stay byte-for-byte aligned:

```ts
interface McpLaunchContext {
  url: string; // http://127.0.0.1:<port>/mcp/<workspaceId>/<token>
  serverName: string; // "ai-storm" — fixed; tool ids derive from it
}

interface HarnessProfile {
  // …existing fields…
  /** Build the CLI args that wire this harness to the backend MCP server.
   *  Absent → the harness gets no MCP and stays on the marker-scan path. */
  mcpArgs?: (ctx: McpLaunchContext) => string[];
}
```

**Claude Code** — inline `--mcp-config` plus pre-allowed tools so no permission prompt interrupts the
brainstorm:

```ts
mcpArgs: ({ url, serverName }) => [
  "--mcp-config", JSON.stringify({ mcpServers: { [serverName]: { type: "http", url } } }),
  "--allowedTools", `mcp__${serverName}__capture_idea,mcp__${serverName}__capture_score`,
],
```

**Codex CLI** — config overrides through the same `-c` seam the profile already uses for
`developer_instructions`:

```ts
mcpArgs: ({ url }) => [
  "-c", `mcp_servers.ai_storm.url=${JSON.stringify(url)}`,
  // plus whatever approval/enable key the pinned codex version requires — verify (§11.2)
],
```

> ⚠️ Codex's **HTTP** MCP transport is the newer path (the long-standing one is stdio
> `command`-launched servers) and its config keys have churned across versions. §11.2 makes
> verification against the pinned codex version an explicit migration step; until verified, the
> codex profile simply omits `mcpArgs` and stays on the marker fallback — graceful degradation by
> construction.

**pi** — has **no MCP support by design** (pi's guidance: build a CLI tool or an extension
instead). Resolved by #177 through pi's native extension seam instead of MCP config: `fileLaunch`
generates a TypeScript extension (`ai-storm-capture.ts`, loaded via pi's repeatable `-e` flag —
the `args` field of `FileLaunchResult`) that registers the capture tools natively and forwards
each call to this endpoint as a plain `tools/call` POST. The extension is a minimal MCP client, so
the profile sets `usesMcp: true`. The **prime rides the same extension** (via pi's
`before_agent_start` event) rather than `--append-system-prompt` argv: on Windows pi is an npm
`.cmd` shim wrapped as `cmd.exe /c`, whose parser truncates the launch line at the first newline
of a multi-line argv value, swallowing all later arguments. Verified against pi 0.80.3 (see
harness-authoring.md §4.2).

**default / bash / python** — no `mcpArgs`, no MCP, no priming (unchanged).

**opencode** (#173) — a third variant: no CLI flag for MCP (or priming) at all.
Both are read from `opencode.json`, located via the `OPENCODE_CONFIG` env var.
`HarnessProfile` gains a second, orthogonal hook for this — `fileLaunch: (ctx)
=> { files, env } | undefined` — a pure function returning file writes +
env vars for the backend to apply (see
[`harness-authoring.md` §4.4](../guides/harness-authoring.md#44-opencode--no-cli-flags-at-all-fileenv-wiring-instead)
for the full shape). Because `mcpArgs` presence was also being used as a
three-site truthiness gate (priming-text selection here in §5, and MCP
session-token minting in both backends) that has nothing to do with argv, a
profile that wires MCP via `fileLaunch` sets `usesMcp: true` instead, and those
three call sites now check `profileUsesMcp(profile) = !!profile.mcpArgs ||
!!profile.usesMcp`. The idempotency rule carries over: `fileLaunch` returns
`undefined` (skips generation) if the caller already set `OPENCODE_CONFIG`
themselves.

Unverified against real opencode (flagged, not yet confirmed): the exact `mcp`
key JSON shape, whether a `permission` key can scope tool access without a
prompt, and whether `OPENCODE_CONFIG` merges with or replaces a project's own
config. Per the graceful-degradation principle above: if `permission` syntax
doesn't hold, omit it and tolerate a permission prompt rather than drop MCP
wiring altogether.

---

## 5. Priming changes

The prime stays a launch-time system prompt on the existing seam (PD-020's three segments stand:
base contract + facilitation mode + background). Only the **base segment** changes, and only when the
profile has MCP wired:

- **MCP prime (new, used when `mcpArgs` present):** teach the tools, not the grammar —
  _"Whenever you produce a brainstorming idea worth capturing on the canvas, call the
  `capture_idea` tool — title, short description, optional kind (risk/feature/question/decision),
  and links to existing cards by their @ref (relation `supersedes` when your idea replaces that
  card; when combining several cards, one call with a `supersedes` link per source). When asked to
  TRIAGE, call `capture_score` once per card. Do NOT also write the idea as a special marker line —
  the tool call is the capture. Mention the returned @ref in your reply so the user can follow
  along."_
- **Marker prime (existing `PRIME_INSTRUCTION`):** unchanged, used when the profile lacks `mcpArgs`.
- **Facilitation modes (#61):** mode primes currently say "emit `«IDEA»` lines". Reword to
  capability-neutral phrasing ("capture each idea") so one mode catalog serves both primes; the base
  segment defines what "capture" means. Pure wording change, no structural change to `modes.ts`.
- The verb-prompt directives (`prompt-framing.ts`) only ever carry **refs**, never marker tokens
  (PD-008 echo rule), so they work under both primes verbatim — "tag every idea with @a1" reads
  naturally as "pass `links:[{to:"a1"}]`" to a tool-primed agent. No frontend change.

The marker grammar is deliberately **not** taught alongside the tools: one mechanism per session
keeps the model's behaviour unimodal (the strongest determinism lever available). The scanner still
runs underneath as a silent safety net (§7).

---

## 6. Data flow & the shared sink

Tool-call path, end to end:

```
agent → POST /mcp/<ws>/<token> tools/call capture_idea
  → zod-validate args                      (invalid → MCP error → model retries)
  → mint ref "i<n>", stamp Idea.id
  → IdeaSink.offer(idea)                   (shared dedupe — see below)
  → onIdea callback                        (same callback the scanner feeds)
  → ws `idea` message → ingestion.service → applyIdeas → card
  → tool result { ref } → model
```

**`IdeaSink` — one dedupe authority per session.** Today `IdeaScanner` owns the session-scoped
`ideaIdentityKey` seen-set. Extract that set into a small `IdeaSink` owned by the session (both
backends), fed by **both** producers:

- the MCP handler (primary), and
- the `IdeaScanner` (fallback, still scanning every capture).

So if a primed agent lapses and emits a marker line _instead of_ calling the tool, the scanner still
catches it (floor); and if it redundantly does _both_, identity dedupe delivers it once. The sink
also serializes emission ordering (tool calls and scan ticks interleave) — last writer wins is fine
because dedupe is by identity, not position. `ScoreScanner`'s tuple-keyed set gets the same
treatment (`ScoreSink`), with one deliberate carry-over: a **re-triage** that changes a card's
rating is a new tuple and passes through, matching today's semantics.

**Diagnostics.** `idea.captured` (info) logs the tool path with `{workspace, ref, kind}`. A scanner
hit on a session that _has_ MCP wired logs `idea.fallback_scan` (warn) — a primed agent ignored the
tool, the tool-lapse analog of today's near-miss telemetry. Near-miss logging itself is unchanged.

---

## 7. What the scanner becomes

Unchanged in code, demoted in role:

| Session type                                                                                 | Primary path                     | Floor                              |
| -------------------------------------------------------------------------------------------- | -------------------------------- | ---------------------------------- |
| Tool-wired harness (claude via `mcpArgs`; opencode/pi via `fileLaunch`; codex once verified) | MCP tools                        | marker scan (logged when it fires) |
| Contract-aware harness without MCP                                                           | marker scan (today's behaviour)  | near-miss telemetry                |
| Bare shell / non-AI                                                                          | — (no priming, no scan emission) | —                                  |

This is the same defence-in-depth posture as the original extraction contract: explicit contract
primary, heuristic floor secondary, every fallback observable. The §1 resize failure modes still
exist _for the floor_ — which is why the separate scanner-hardening work (quiescence gating,
two-frame confirmation) remains worthwhile, just no longer load-bearing for the primary product
path.

---

## 8. Protocol & shared-package changes

Deliberately near-zero:

- `Idea`, `Score`, `idea`/`score` WS messages: **unchanged**. The canvas cannot tell which channel
  produced a card.
- `Idea.id`: already exists; now actually populated (by the backend mint) on the primary path. The
  one frontend change is ensuring `applyIdeas` honours it as the shape's `meta.ref` (§3.3).
- `SessionSpec`: no change — MCP wiring is derived backend-side from the profile at `create()`.
- Optional, additive: `session-status` gains `capture: "mcp" | "markers"` so the UI can surface which
  contract a session is running (useful for debugging a misbehaving brainstorm). Not required for
  correctness.

---

## 9. Testing strategy

Unit-first, matching the existing extraction test shape (pure modules + fixtures; the MCP handler is
pure JSON-RPC over Hono, testable with injected requests, no real harness needed):

1. **Schema validation.** Valid `capture_idea` minimal/maximal payloads → `Idea` emitted with minted
   `i<n>` id; invalid payloads (empty title, bad relation, oversize links) → MCP error response,
   nothing emitted.
2. **Marker-parity fixtures.** Every row of the §3.1 mapping table — including the `@a1!@a2!`
   combine chain and a multi-line body — produces an `Idea` deep-equal to what `scanIdeas` produces
   for the equivalent marker fixture. Guards the two paths against semantic drift.
   **opencode (#173): pending.** opencode is an alt-screen TUI with no `--no-alt-screen` escape
   hatch (unlike codex), so marker-scan-from-capture may be structurally unreliable for it — this
   parity test (and its marker fixtures) need a real captured opencode session before they can be
   written meaningfully; `extraction.test.ts` carries `it.todo` placeholders in the interim rather
   than hand-authored, unverified fixture text.
3. **Shared dedupe.** Tool call then identical marker scan (and the reverse) → exactly one emission;
   `idea.fallback_scan` logged for the scan-on-MCP-session case.
4. **Ref round-trip.** `capture_idea` result ref used in a follow-up call's `links.to` and in a
   `capture_score.ref` → links/score resolve; refs are session-scoped and reset with the session.
5. **Routing & auth.** Wrong token → 404, nothing emitted; two workspaces capturing concurrently →
   ideas land on the right `onIdea` callbacks; tool call after `kill()` → 404.
6. **Token durability (tmux).** Fake-tmux test (the existing seam): `create()` stamps
   `@ai_storm_mcp_token`; a reconciled backend restores it and a tool call against the old URL still
   routes.
7. **Launch args.** `launchArgsForProfile` with an MCP context: claude profile gets
   `--mcp-config`/`--allowedTools` exactly once (idempotent against caller-supplied flags, like the
   existing model/config arg logic); profiles without `mcpArgs` are byte-identical to today.
8. **Live smoke (manual, per pinned harness version).** One brainstorm turn over real Claude Code:
   idea arrives via tool call, no marker line in the transcript, no permission prompt; resize the
   pane mid-response → no duplicate or truncated cards (the §1 repro, now passing by construction).

---

## 10. Security notes

- Endpoint stays on `127.0.0.1`; the per-session URL token gates cross-process access (same local
  trust model as the existing WS endpoint). Token in the URL path can leak into local process
  listings / shell history on the tmux launch line — accepted for a localhost dev tool; the
  `writeLaunchScript` path (0700 temp file) already shields long launch lines, and MCP-wired
  launches will typically exceed the 200-char threshold anyway.
- Tool input is **untrusted model output**: schemas bound every field (lengths, ref charset, enum
  relations, link count) before anything reaches the canvas; `ref`s are validated against
  `^[\w-]+$` exactly like the marker grammar's injection guard.
- No tool ever executes anything or touches the filesystem — `capture_idea`/`capture_score` are pure
  data writes into the session's existing callback plumbing.

---

## 11. Migration steps

Each independently shippable; the app works throughout (markers remain the default until a profile
opts in).

1. **`IdeaSink`/`ScoreSink` extraction** — move the seen-sets out of the scanners into
   session-owned sinks; scanners feed them. Pure refactor, behaviour-identical, lands with tests.
2. **MCP endpoint** — `/mcp/:workspaceId/:token` (initialize / tools/list / tools/call), zod
   schemas, ref minting, routing into the sinks. Token map + tmux `@ai_storm_mcp_token`
   persistence + `reconcile()` restore. (§9 cases 1–6.)
3. **Profile seam** — `mcpArgs` hook + `McpLaunchContext` through `launchArgsForProfile`; wire the
   **claude** profile only. (§9 case 7.)
4. **Prime split** — MCP-conditional base prime; reword mode primes capability-neutral; add the
   `idea.fallback_scan` diagnostic.
5. **Frontend ref honour** — `applyIdeas` uses `Idea.id` as `meta.ref` when present (collision-safe
   by namespace). Optional `capture` field on `session-status`.
6. **Codex/pi verification** — pin versions, verify their MCP config surfaces (codex HTTP transport
   keys; whether pi mirrors `--mcp-config`), then add their `mcpArgs`. Until then both stay on
   markers by construction.
7. **Cleanup (later)** — once MCP-primary has soaked: consider retiring the fenced ` ```idea ` form
   from the prime (its only reason to exist — multi-line bodies — is solved), shrinking the marker
   grammar the fallback must support.

---

## 12. Risks & open questions

1. **Harness MCP config drift.** `--mcp-config` shapes and codex `mcp_servers.*` keys have changed
   across CLI versions, and the launch line is built blind (no handshake). Mitigation: the MCP
   `initialize` call is itself the probe — if no initialize arrives within a grace window after
   launch on an MCP-wired session, log `mcp.never_connected` (warn); the marker floor is already
   running regardless, so the failure mode is "today's behaviour + a warning", never silence.
2. **Model ignores the tools.** A lapse (or a weak model) writes prose or marker lines instead of
   calling. Mitigation: the floor catches marker lines; `idea.fallback_scan` quantifies the lapse
   rate per model so the prime can be tuned with evidence. Residual: an idea expressed only as prose
   is lost — identical to today.
3. **Permission prompts.** If `--allowedTools` doesn't cover the tool ids (naming drift in
   `mcp__<server>__<tool>`), Claude Code interrupts the brainstorm with an approval dialog —
   worse UX than markers. The §9.8 live smoke gates each pinned-version bump.
4. **Double capture.** An agent that both calls the tool _and_ emits a marker produces two
   producers for one idea; identity dedupe collapses exact duplicates, but a _paraphrased_ title
   slips both through. Accepted: same residual risk as today's re-render dedupe, lower frequency
   (the prime explicitly forbids the marker when the tool succeeds).
5. **Ref namespace forever.** Backend-minted `i<n>` refs interleave with canvas-minted `a<n>` ones;
   serializations (`serializeForTriage`, hand-off) must not assume the `a` prefix. Audit at step 5.
6. **Streamable HTTP session semantics.** We implement the sessionless minimum. If a harness
   requires the full session lifecycle (session ids, SSE GET stream), the handler grows — verify
   against pinned claude first (it tolerates sessionless servers today). Contained: one module.
7. **Should `capture_idea` support updates?** An `update_idea(ref, …)` tool would let the agent
   refine a card it just captured (today: supersede only). Deliberately out of scope — supersede
   already models refinement with history (PD-012); revisit if real transcripts show the agent
   wanting in-place edits.

---

## Appendix A — quick reference

| Agent intent         | Marker contract (fallback)          | MCP contract (primary)                                           |
| -------------------- | ----------------------------------- | ---------------------------------------------------------------- |
| Plain idea           | `«IDEA» T :: B`                     | `capture_idea {title, body}`                                     |
| Typed idea           | `«IDEA:risk» T :: B`                | `capture_idea {kind: "risk", …}`                                 |
| Linked idea          | `«IDEA@a1» …`                       | `capture_idea {links: [{to: "a1"}]}`                             |
| Supersede (PD-012)   | `«IDEA@a1!» …`                      | `…{links: [{to: "a1", relation: "supersedes"}]}`                 |
| Combine (#62)        | `«IDEA@a1!@a2!» …`                  | one call, one `supersedes` link per source                       |
| Multi-line body      | ` ```idea ` fence (fragile, PD-008) | `body` with `\n`                                                 |
| Triage (#60)         | `«SCORE@a1» 4/2/3`                  | `capture_score {ref: "a1", impact: 4, effort: 2, confidence: 3}` |
| Learn own card's ref | — (impossible)                      | tool result `{ ref: "i3" }`                                      |
| Malformed attempt    | near-miss log, idea lost            | MCP validation error → model retries                             |
