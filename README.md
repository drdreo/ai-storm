# ai-storm (v3.0)

A local-first collaborative product-brainstorming canvas. A Node.js daemon runs
your local AI CLI in a **real pseudo-terminal** and streams its output into a
**tldraw** canvas — the raw conversation renders in an embedded terminal, while
extracted ideas land as spatial cards — across multiple isolated workspaces, with
no external AI APIs, no subscriptions, and no cloud keys. It reuses the CLI tools
already running on your machine.

> 📋 The PRD and all product decisions live in
> [`docs/decisions/product-decisions.md`](docs/decisions/product-decisions.md).
> The `PRD §x` references below resolve to Part 1 of that document (section numbering preserved).
>
> 🧩 Adding support for a new AI CLI? See
> [`docs/guides/harness-authoring.md`](docs/guides/harness-authoring.md).

## Architecture

```
┌──────────────────────────── Browser (React 19 + Vite, Zustand) ─────────────────────────────────┐
│  Sidebar (workspaces)  │   Canvas pane (tldraw)            │   Control hub (terminal + agent)     │
│  PRD §3.4              │   PRD §3.1 / §4.1                 │   PRD §3.1                           │
│                        │                                   │                                      │
│  workspace store ──────┼─ canvas controller (tldraw) ──────┼── ingestion store ── agent store     │
│  CRDT registry (IDB)   │  per-workspace store → IndexedDB  │   xterm sink + RenderScheduler       │
└────────────────────────┴───────────────────────────────────┴──────────────────────────────────────┘
                                          │  WebSocket /pty (JSON, multiplexed by workspaceId)
┌─────────────────────────────────────────▼─────────────────────────────────────────────────────────┐
│  Node + Hono daemon (127.0.0.1)   PtyManager → PtySession (node-pty, real ConPTY/forkpty)           │
│  PRD §4.2                         PRD §3.3 source                       AgentExecutor (subprocess)  │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

The frontend is React (Vite + `@vitejs/plugin-react`). State is **Zustand**: the
WebSocket multiplexer, the Yjs workspace registry, the per-workspace ingestion
pipelines and the tldraw `Editor` are imperative module singletons whose reactive
surface is exposed through small stores (see PD-016/PD-017). UI is **Tailwind v4
+ shadcn/ui** (Radix primitives; PD-018). The conversation surface is a real
**xterm.js** terminal fed the raw PTY stream — no server-side chat extraction.

### The framework-agnostic core — `frontend/src/app/core/`

Pure TypeScript with unit coverage (`pnpm test`, run by [Vitest](https://vitest.dev)):

| Module | Responsibility | PRD |
| --- | --- | --- |
| `render-scheduler.ts` | rAF double-buffer, throttled batched idea mutations | §5.1 framerate throttling |
| `markdown-block-parser.ts` | Markdown → structural block descriptors for idea cards | §3.3 |
| `idea-descriptors.ts` | Idea kind registry + provenance decoration (#21/#31) | §3.3 |
| `idea-layout.ts` | Graph-driven mind-map "Arrange" layout (#16) | §3.1 |
| `prompt-framing.ts` | Card-verb prompt framing (#13/#15) | §3.6 |
| `canvas-text.ts` | Serialize the canvas to normalized markdown | §3.2 |

The tldraw island (`canvas-island.tsx`) owns the `idea-card` shape, the typed-edge
graph, `applyIdeas`, the card-verb bar and the kind filter; it persists each
workspace's board to IndexedDB via tldraw `persistenceKey`.

### The conversational session (PRD §2)

A workspace session does **not** spawn a raw shell — it launches your configured
**AI harness** (default `claude`) inside a **real pseudo-terminal** (ConPTY on
Windows, forkpty on POSIX) via `node-pty`. Because it's a genuine TTY, the CLI
runs fully interactively — its TUI renders, raw-mode keys work — exactly as in a
normal terminal; keystrokes typed in the control-hub terminal go to the PTY and
its output renders verbatim in xterm. The harness is editable per workspace (e.g.
`pi`, `codex`, `aider`, or a plain shell like `powershell`). Contract-aware
harnesses (`claude`, `pi`, `codex`) are primed at launch through their
prompt/config seam so emitted `«IDEA»` / `«SCORE»` markers flow to the canvas
from the first turn. Codex defaults to `gpt-5.3-codex-spark` with medium
reasoning for cheaper/faster brainstorming runs unless you pass explicit model
args. On Windows
the backend resolves npm `.cmd`/`.ps1` shims via `where.exe`, input that races
ahead of the spawning PTY is buffered until ready, and a missing harness streams
a clear message instead of failing silently.

### Persistence (PRD §3.5)

Each workspace's canvas is a tldraw store persisted to **IndexedDB** under the key
`TLDRAW_DOCUMENT_v2ai-storm:ws:{id}`. The workspace registry (titles, status,
terminal config) is a Yjs CRDT document with its own IndexedDB store
(`ai-storm-registry`) via `y-indexeddb`. On boot the app rehydrates both and
restores the most recently active workspace.

### Hot-switching (PRD §3.4) & memory (PRD §5.2)

Switching the active workspace remounts the tldraw island onto the next
workspace's persisted store (the React `key` changes) and swaps the kept-alive
xterm instance — sub-100ms. Detaching a workspace tears down its pipeline, render
scheduler, and PTY.

## Requirements

- **Node.js** ≥ 24.15 (backend runtime — uses native TS type-stripping)
- **pnpm** (via `corepack pnpm`, bundled with Node)
- A modern Chromium-based browser

The unit tests run on [Vitest](https://vitest.dev) (a devDependency installed via
`corepack pnpm install`), so they need no extra runtime beyond Node itself.

## Running

Two processes. **Backend** (Node + Hono + node-pty):

```sh
cd backend
corepack pnpm install
corepack pnpm start    # ws://127.0.0.1:8787/pty
```

**Frontend** (Vite dev server, proxies /pty → backend):

```sh
cd frontend
corepack pnpm install
corepack pnpm dev      # http://localhost:4200
```

For a single-process production deploy, build the client and let the backend
serve it:

```sh
cd frontend && corepack pnpm build
cd ../backend && corepack pnpm start -- --static ../frontend/dist
```

## Tests

```sh
# Unit — framework-agnostic core + Zustand stores (no browser needed)
cd frontend && corepack pnpm test

# Integration — against a running backend (corepack pnpm start first)
cd backend && node smoke_test.ts

# Browser E2E — Playwright runner (auto-starts vite dev on :4200)
#   UI suite (backend-free): boot, three panes, tldraw mount, create/rename,
#   IndexedDB naming, theming, dialogs, empty state, tooltips
cd frontend && pnpm e2e
cd frontend && pnpm e2e:ui            # headed/watch UI mode

#   Full suite incl. the ConPTY PTY round-trip + hot-switch scrollback
#   (needs the Node backend on :8787 — start `pnpm dev:backend` first)
cd frontend && pnpm e2e:all
```

### Verification status

All layers are verified on Windows 11: the frontend unit suite passes (core +
stores); the daemon type-checks; the WebSocket PTY round-trip, input echo, agent
hook, and static serving pass the integration smoke test; and the browser E2E
confirms the app boots, tldraw mounts, workspaces create/rename, a real PowerShell
PTY round-trips through ConPTY, hot-switching preserves terminal scrollback, and
the tldraw + registry IndexedDB stores use the pinned name scheme — with no
console errors.

## Logging & tracing

The backend emits structured flow logs and OpenTelemetry spans:

```sh
# Human-readable structured logs (level via AI_STORM_LOG=debug|info|warn|error)
cd backend && AI_STORM_LOG=debug corepack pnpm start

# Export spans over OTLP (starts the OTel Node SDK via --import ./src/otel.ts)
cd backend && corepack pnpm trace
#   point at a collector:
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 corepack pnpm trace
```

Key events you can trace per workspace: `ws.open/close`, `attach.request`,
`resolve.candidates`/`resolve.chosen` (exactly what the harness resolves to and
the launch command), `pty.spawned` (pid), `attach.ready`, `input`
(+`input.flush_buffered`, `input.dropped`), `pty.data` (byte counts),
`pty.exit`, `agent.dispatch/spawned/exit`, and `attach.error`. The `pty.attach`
flow is also emitted as an OTel span (via `@opentelemetry/api`); `pnpm trace`
registers the exporter, otherwise the spans are no-ops.

## Security model (PRD §4.2)

The daemon binds only to `127.0.0.1`, so the loop never leaves the local
machine, and static serving is path-traversal guarded. Beyond that, Node offers
no OS-enforced permission model, so containment is the security boundary: the
spawn surface is limited to the explicitly configured agent harness. Historical
note: an earlier design ran the daemon on Deno for its OS-enforced `--allow-*`
sandbox over file-system and subprocess access; moving to Node.js (required for a
real ConPTY via `node-pty`, which Deno does not support) gave that up. For
stricter confinement, run the daemon under an OS-level sandbox (e.g. a restricted
user/container).
