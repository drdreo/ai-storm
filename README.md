# ai-storm (v3.0)

A local-first collaborative product-brainstorming canvas. A Node.js daemon runs
your local AI CLI in a **real pseudo-terminal** and streams its output into a
BlockSuite canvas through a stateful parsing buffer, across multiple isolated
workspaces — with no external AI APIs, no subscriptions, and no cloud keys. It
reuses the CLI tools already running on your machine.

## Architecture

```
┌──────────────────────────── Browser (Angular 22, zoneless, signals) ────────────────────────────┐
│  Sidebar (workspaces)  │   Canvas pane (BlockSuite)        │   Control hub (terminal + agent)     │
│  PRD §3.4              │   PRD §3.1 / §4.1                 │   PRD §3.1                           │
│                        │                                   │                                      │
│  WorkspaceService ─────┼─ CanvasService (DocCollection) ───┼── IngestionService ── AgentService   │
│  CRDT registry (IDB)   │  CRDT docs → IndexedDB (§3.5)      │   buffer→parser→scheduler (§3.3/§5.1)│
└────────────────────────┴───────────────────────────────────┴──────────────────────────────────────┘
                                          │  WebSocket /pty (JSON, multiplexed by workspaceId)
┌─────────────────────────────────────────▼─────────────────────────────────────────────────────────┐
│  Node + Hono daemon (127.0.0.1)   PtyManager → PtySession (node-pty, real ConPTY/forkpty)           │
│  PRD §4.2                         PRD §3.3 source                       AgentExecutor (subprocess)  │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### The ingestion engine (PRD §3.3, §5.1) — `frontend/src/app/core/`

Pure, framework-agnostic TypeScript with full unit coverage (`deno test`):

| Module | Responsibility | PRD |
| --- | --- | --- |
| `ansi.ts` | Strip ANSI/SGR/OSC/control bytes | §3.3 garbage elimination |
| `slicing-buffer.ts` | Char-level accumulator; partial-escape & CR/CRLF handling | §3.3 slicing & chunking |
| `markdown-block-parser.ts` | Line → structural block descriptors | §3.3 block translation |
| `render-scheduler.ts` | rAF double-buffer, throttled batched mutations | §5.1 framerate throttling |

### The conversational session (PRD §2)

A workspace session does **not** spawn a raw shell — it launches your configured
**AI harness** (default `claude`) inside a **real pseudo-terminal** (ConPTY on
Windows, forkpty on POSIX) via `node-pty`. Because it's a genuine TTY, the CLI
runs fully interactively — its TUI renders, raw-mode keys work — exactly as in a
normal terminal; the keystrokes you type in the control hub go to the PTY and
its output is sanitised and parsed onto the canvas. The harness is editable per
workspace (e.g. `aider`, or a plain shell like `powershell`). On Windows the
backend resolves npm `.cmd`/`.ps1` shims via `where.exe`, input that races ahead
of the spawning PTY is buffered until ready, and a missing harness streams a
clear message instead of failing silently.

### Persistence (PRD §3.5)

All workspace canvas content lives in one BlockSuite `DocCollection` whose root
Yjs document is persisted to **IndexedDB** via `y-indexeddb` (CRDT binary). The
workspace registry (titles, status, mode, terminal config) is a second CRDT
document with its own IndexedDB store. On boot the app rehydrates both and
restores the most recently active workspace.

### Hot-switching (PRD §3.4) & memory (PRD §5.2)

A **single** `AffineEditorContainer` instance is reused across all workspaces and
simply rebound to a different `Doc` on switch — sub-100ms, one heavy object in
memory. Detaching a workspace tears down its pipeline, render scheduler, and PTY.

## Requirements

- **Node.js** ≥ 24.15 (backend runtime — uses native TS type-stripping — and the
  Angular 22 CLI engine gate)
- **pnpm** (via `corepack pnpm`, bundled with Node)
- A modern Chromium-based browser
- **Deno** ≥ 2.x — optional, only to run the ingestion-engine unit tests

## Running

Two processes. **Backend** (Node + Hono + node-pty):

```sh
cd backend
corepack pnpm install
corepack pnpm start    # ws://127.0.0.1:8787/pty
```

**Frontend** (Angular dev server, proxies /pty → backend):

```sh
cd frontend
corepack pnpm install
corepack pnpm start    # http://localhost:4200  (ng serve)
```

For a single-process production deploy, build the client and let the backend
serve it:

```sh
cd frontend && corepack pnpm build
cd ../backend && corepack pnpm start -- --static ../frontend/dist/browser
```

## Tests

```sh
# Unit — framework-agnostic ingestion engine (19 tests, no browser needed)
cd frontend && deno test --allow-read src/app/core

# Integration — against a running backend (corepack pnpm start first)
cd backend && node smoke_test.ts

# Browser E2E — against the built app served by the backend on :8790
#   (boot, BlockSuite mount, IndexedDB stores, mode toggle, <100ms hot-switch)
cd frontend && node e2e/smoke.mjs http://127.0.0.1:8790
#   Full PTY → buffer → parser → scheduler → BlockSuite pipeline
cd frontend && node e2e/pipeline.mjs http://127.0.0.1:8790
```

### Verification status

All layers are verified on Windows 11: 19/19 engine unit tests pass; the daemon
type-checks; the WebSocket PTY round-trip, input echo, agent hook, and static
serving pass the integration smoke test; and the browser E2E confirms the editor
mounts, both CRDT IndexedDB stores are created, the doc/edgeless toggle works,
hot-switching is ~8ms, and real streamed terminal output renders as canvas
blocks — with no console errors.

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
machine, and static serving is path-traversal guarded. Note a deliberate
trade-off from the original spec: moving the daemon to Node.js (required for a
real ConPTY via `node-pty`) gives up Deno's OS-enforced `--allow-*` sandbox over
file-system and subprocess access. For stricter confinement, run the daemon
under an OS-level sandbox (e.g. a restricted user/container).
