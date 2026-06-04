# ai-storm (v3.0)

A local-first collaborative product-brainstorming canvas. A Deno daemon streams
local pseudo-terminal output into a BlockSuite canvas through a stateful parsing
buffer, across multiple isolated workspaces — with no external AI APIs, no
subscriptions, and no cloud keys. It reuses the CLI tools already running on
your machine.

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
│  Deno daemon (127.0.0.1)   PtyManager → PtySession (spawn shell/CLI)   AgentExecutor (subprocess)   │
│  PRD §4.2                  PRD §3.3 source                              PRD §3.6                     │
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
**AI harness** (default `claude`), so prompts typed in the control hub are sent
to that CLI's stdin and its streamed output is parsed onto the canvas. The
harness command is editable per workspace in the control hub (e.g. `aider`, or a
plain shell like `powershell` for running commands). On Windows the backend
resolves npm `.cmd`/`.ps1` shims via `where.exe` and wraps them in the right
interpreter, and input that races ahead of the spawning PTY is buffered until it
is ready. If the harness isn't found, a clear message is streamed back instead
of a silent failure.

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

- **Deno** ≥ 2.x (backend + engine tests)
- **Node.js** ≥ 24.15 (Angular 22 CLI engine gate) and npm
- A modern Chromium-based browser

## Running

Two processes. **Backend** (Deno, least-privilege permissions):

```sh
cd backend
deno task start        # ws://127.0.0.1:8787/pty
```

**Frontend** (Angular dev server, proxies /pty → backend):

```sh
cd frontend
npm install
npm start              # http://localhost:4200
```

For a single-process production deploy, build the client and let Deno serve it:

```sh
cd frontend && npm run build
cd ../backend && deno task start -- --static ../frontend/dist/browser
```

## Tests

```sh
# Unit — framework-agnostic ingestion engine (19 tests, no browser needed)
cd frontend && deno test --allow-read src/app/core

# Type-check the daemon
cd backend && deno task check

# Integration — against a running backend (deno task start first)
cd backend && deno run --allow-net=127.0.0.1 smoke_test.ts

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

## Security model (PRD §4.2)

The daemon binds only to `127.0.0.1` and runs with explicit Deno grants:
`--allow-net=127.0.0.1 --allow-run --allow-read --allow-env`. No other
filesystem or network capability is granted.
