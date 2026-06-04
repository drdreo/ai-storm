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
cd frontend && deno test --allow-read src/app/core   # ingestion engine (19 tests)
cd backend  && deno task check                       # type-check daemon
```

## Security model (PRD §4.2)

The daemon binds only to `127.0.0.1` and runs with explicit Deno grants:
`--allow-net=127.0.0.1 --allow-run --allow-read --allow-env`. No other
filesystem or network capability is granted.
