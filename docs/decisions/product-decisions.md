# Product decisions

**Status:** 🟢 Living document — the canonical product spec + decision log for ai-storm.
**Author:** ai-storm
**Related:** [`docs/design/ai-session-layer.md`](../design/ai-session-layer.md) · [`docs/design/ai-response-extraction-contract.md`](../design/ai-response-extraction-contract.md) · [`docs/design/idea-graph.md`](../design/idea-graph.md) · the `brainstorm-ux` issue epic

---

This is the single home for ai-storm's product spec and the product-level decisions that
shape it. It folds in the original **PRD v3.0** (Part 1, below — section numbering preserved
verbatim, so existing `PRD §x` references throughout the codebase and design docs still
resolve here) and a running **decision log** (Part 2) for the "why are we (not) building
this" calls that don't live naturally in code or a design doc.

When a decision is reversed, don't delete it — add a new entry that supersedes it and link
back, so the history stays readable.

---

# Part 1 — Requirements (PRD v3.0)

> **Note:** This is the original Product Requirement Document, folded in verbatim by section.
> The conversation/ingestion mechanism in **§3.3** has since been **superseded** — see
> **PD-008** and [`ai-response-extraction-contract.md`](../design/ai-response-extraction-contract.md):
> the conversation surface is now a real xterm terminal (raw PTY passthrough) and the backend
> scans only for `«IDEA»` markers, replacing the client-side slicing/parsing buffer described
> below. The §3.3 text is retained for reference and because other docs cite it.

**Summary:** ai-storm is a local-first collaborative canvas powered by a Node backend that
streams local terminal data into a multi-workspace spatial idea canvas.

## 1. Executive summary & core objectives

ai-storm is a localized, framework-agnostic collaborative product brainstorming workspace
designed to translate creative, conversational ideation into structural, executable developer
workflows. The application completely avoids external AI API connections, subscription models,
or cloud-hosted keys. Instead, it reuses existing local command-line interface subscriptions by
tapping directly into active pseudo-terminals and headless terminal sessions running on the
developer's machine.

Through a highly responsive user interface, the system gives the user an infinite visual canvas
to organize ideas while concurrently streaming real-time local text generation into spatial idea
cards. The backend layer is powered entirely by a
lightweight, local-only execution environment built on the Node runtime, using a Hono
HTTP/WebSocket server and `@lydell/node-pty` for real pseudo-terminals (ConPTY on Windows,
forkpty on POSIX).

## 2. High-level workflows & user persona

The target user is an independent software engineer or product builder who values speed, local
data privacy, and minimal tooling friction. The system facilitates a seamless three-stage
workflow:

- **Multi-project brainstorming:** The developer stands up isolated workspaces to explore
  multiple disparate product ideas concurrently, using a sidebar to snap between project
  canvases instantly.
- **Structured synchronization:** As a local terminal session generates suggestions, the web
  interface intelligently converts chaotic terminal output streams into clean, editable document
  components and notes.
- **Local agent hand-off:** Once a specific feature canvas or technical specification is refined,
  the user highlights the target blocks to trigger a local automated code generation pipeline via
  their system's terminal orchestrator tools.

## 3. Functional requirements

### 3.1. Dual-pane operational interface

- **Conversational Control Hub (right pane):** A dedicated interface providing user prompt
  inputs, terminal execution status logs, session controls, and diagnostic readouts of the
  background terminal stream. It can be the streamed terminal (like gotty) to ease the AI
  conversation, but that is up to complexity.
- **Structural Workspace Canvas (center/left pane):** A spatial idea canvas (tldraw) embedded as a
  framework-agnostic surface. Ideas live as spatial cards on an infinite edgeless canvas; there is
  no separate linear document view (PD-011).

### 3.2. Contextual document ingestion (input layer)

Prior to dispatching a user command or contextual update to the local terminal loop, a background
compilation service must serialize the current state of the active canvas into a
normalized, raw text document. This text representation must automatically inject itself into the
payload context, providing the local agent terminal execution loop with a complete structural
memory of the whiteboard state.

### 3.3. Stateful PTY terminal ingestion engine (output layer)

> ⚠️ **Superseded — see PD-008.** Retained for reference and citation.

- **The slicing & chunking buffer:** The application must implement a stateful text accumulator to
  ingest incoming data from the local terminal stream. The system cannot assume lines or delimiters
  arrive cleanly. It must buffer raw string fragments until structural boundaries, line breaks, or
  carriage returns can be programmatically verified at the character level.
- **Terminal garbage elimination:** The ingest engine must filter and strip all incoming ANSI
  escape sequences, color styling parameters, text animations, and terminal loading indicators to
  produce clean, uncorrupted strings.
- **Structural block translation:** The text parser must continuously scan the stateful text
  buffer. Upon confirming structural Markdown indicators at line beginnings, it must
  programmatically declare block boundaries in the active document model, initializing new
  headings, bullet points, checkbox task targets, or notes accordingly.

### 3.4. Multi-workspace management & sidebar navigation

- **Workspace segregation:** The system must enforce strict isolation between multiple
  concurrently running project workspaces. Each workspace retains its own distinct structural
  document layout, independent chat histories, local process bindings, and configuration metadata.
- **Global navigation framework:** A persistent vertical navigation sidebar must render on the
  screen. It must list all active, historical, or running workspaces with human-readable titles and
  system status tracking (e.g., active stream state vs. idle state).
- **Sub-100ms hot-switching:** Clicking any project in the sidebar must instantly unmount the
  current canvas layer, clean up running event states, and mount the targeted project's document
  graph. This transition must be completed completely client-side in under 100 milliseconds without
  forcing a web application or browser page reload.

### 3.5. Local-first persistence architecture

- **Local state integrity:** Workspace content must completely survive runtime crashes, web
  application refreshes, system restarts, and terminal disconnections. Every data change — whether
  driven by manual user keyboard input or incoming streamed text — must write down immediately.
- **Local IndexedDB persistence:** Workspace state must persist to the browser's native IndexedDB —
  the tldraw canvas store per workspace (via `persistenceKey`) and a CRDT (Yjs) registry of workspace
  metadata — so it survives reloads and crashes.
- **Crash recovery boot sequence:** Upon application boot, an initialization service must scan the
  browser storage engine index, identify the most recently active workspace identifier, rebuild the
  structural data engine from local binary storage logs, and present the workspace exactly as it was
  left.

### 3.6. Downstream agent execution hook

Every idea card or multi-selected group of cards on the canvas must
feature an actionable contextual interaction macro. When executed, the system must extract the plain
text contents, strip out layout wrappers, and dispatch a structured local loopback event to the Node
background service. The Node service must interpret the payload and instantly spawn an asynchronous
local system subprocess, invoking the target agent orchestrator command execution array with the text
payload passed as a clear functional argument.

## 4. System topology & backend specifications

### 4.1. Framework-agnostic core principles

> ⚠️ **Superseded — see PD-016.** The Angular shell was replaced with React; tldraw is no longer a
> mounted island under a foreign framework but a first-class part of the React tree, so the
> `createRoot`/`unmount` boundary and the `CanvasService` facade described below are gone. Retained
> for reference and citation.

The canvas is a React (tldraw) island mounted under the Angular shell at a single, framework-agnostic
boundary (`createRoot` on render, `unmount` on teardown) — no `@angular/elements`, Zone bridging, or
proprietary wrapper hooks. Angular owns the shell; React owns the canvas subtree; the two communicate
through a thin service facade (`CanvasService`).

### 4.2. Local-only Node runtime environment

The background daemon service runs on the Node runtime. Node does not provide an OS-enforced
permission model (there is no equivalent of a native `--allow-*` capability flag), so the daemon's
security posture is achieved through containment rather than a runtime sandbox: it binds exclusively
to the loopback interface (127.0.0.1) so the control channel never leaves the local machine, keeps
its spawn surface restricted to the explicitly configured agent harness, and path-traversal-guards
any static file serving. For stricter isolation, operators are expected to run the daemon under an
OS-level boundary (a restricted user account or container).

The Node backend is responsible for spawning pseudo-terminal instances — via `@lydell/node-pty`
(real ConPTY/forkpty) — that attach to local terminal execution binaries or running system sessions.
The backend must establish a local, low-overhead WebSocket server loop to broadcast the raw
pseudo-terminal standard output data directly to the web client, running entirely within a local-only
sandbox environment.

## 5. Non-functional requirements & performance targets

### 5.1. Framerate-throttled UI updates

To prevent the interface from locking or crashing under rapid terminal text output, the streaming
engine must decouple network transmission speeds from visual DOM rendering operations. The system
must use a double-buffering model combined with browser animation frame rendering loops. Text inputs
must accumulate in a virtual block buffer, and visual block changes must be throttled to execute
strictly on active browser paint cycles. This prevents the document store from being flooded with
successive micro-mutations while keeping user interaction rendering fluid. Modern Angular signals and
reactivity concepts must be used; Angular 22 uses OnPush change detection by default.

> ⚠️ **Reactivity stack superseded — see PD-017.** The RAF-throttled `RenderScheduler` requirement
> stands verbatim (it is framework-agnostic and ported unchanged); only the "Angular signals / OnPush"
> mechanism is replaced — Zustand external stores + React 19 are the equivalent.

### 5.2. Memory management safety

The application must actively monitor open workspace instances. Switching projects via the navigation
sidebar must explicitly clear current cache allocations, tear down active WebSocket listeners, and
terminate unneeded object maps to maintain long-term system stability during continuous engineering
sessions.

---

# Part 2 — Decision log

Recent decisions first; foundational PRD-v3.0 baseline decisions at the bottom. Each entry: the
decision, the date, the reasoning, and what it affects.

Format: **PD-NNN — <title>** `(date, status)` · **Decision** · **Why** · **Affects**.

### PD-022 — Subprocess safeguards are sized for local-first, not hosted

`(2026-07-03, accepted, extends PD-003/PD-007; #142)`

- **Decision:** The #142 hardening is scoped to a _local, single-user_ deployment. Byte caps
  (payload/capture/output) are fixed constants in `executor.ts` — approximate circuit breakers
  ("a runaway harness can't take the machine down"), not env/CLI-tunable quotas. Hard CPU/memory
  caps are not attempted (an earlier revision wired Linux `prlimit`; removed); the wall-clock
  timeout + process-tree kill is the bound on every platform. Only the timeout is real server
  config (`--agent-timeout-ms`) — the one bound a long side-effecting run may legitimately need.
- **Why:** ai-storm is never hosted (PD-003): the user who hits a limit is usually themselves, so
  favor recoverability over strictness, and every extra knob is permanent doc/test surface. The
  caps being approximate and non-tunable is a decision, not an oversight.
- **Affects:** `backend/src/agent/executor.ts`, `backend/src/pty/resolve.ts`,
  `ServerConfig.agentTimeoutMs`; details in
  [`docs/security/agent-executor-hardening.md`](../security/agent-executor-hardening.md). Sets the
  bar for future subprocess-security findings: hosted-threat-model fixes need a deployment-model
  change first.

### PD-021 — Spec export is backend-aware: run metadata on the wire, capabilities by name

`(2026-07-02, accepted, extends PD-007/PD-015; #110/#120)`

- **Decision:** The spec hand-off (#110) stops being frontend-only. Three moves, one principle — the
  backend owns everything that outlives one client's memory or widens a subprocess's permissions.
  (1) **Run metadata rides the wire:** the `agent` message carries `format` (the shared `SpecFormat`
  union now lives in `@ai-storm/shared`), the backend logs it and echoes it back on the `spawned`
  status, so any attached client (refresh, second tab) can label the run and name the download without
  local state. (2) **Side effects are opt-in by NAMED capability, scoped to one run:** instead of the
  user baking `--allowedTools "Bash(gh issue create:*)"` into the workspace's global agent args (which
  would apply to every hand-off), the client requests `capabilities: ['create-issues']` and the backend
  maps it through a vetted, hardcoded per-command table (`agent/capabilities.ts`). Unknown command →
  the capability is refused with a visible `stderr` note, never silently widened; the client never
  supplies raw argv. (3) **Artifacts are structured, parsed server-side:** on exit of an
  `issues` + `create-issues` run, the backend scans the captured stdout for created GitHub issue URLs,
  pairs them with the summary-table titles (pure function, `agent/artifacts.ts`), and emits a single
  `agent-artifacts` message the SpecPanel renders as link chips.
- **Why:** The #110 ship proved the format picker; what it left client-local was exactly the state
  that breaks on refresh (badge label, filename) and the one permission that should never be global
  (issue creation). Naming capabilities keeps the executor's trust model intact — only static
  backend-owned strings reach argv (the CVE-2024-27980 stance of the executor header) — while making
  the side-effecting mode a per-run grant. Parsing artifacts server-side (not in the panel) keeps the
  markdown blob as the display surface and the structured data on the protocol, where a future
  consumer (e.g. linking issues back to cards) can reach it. Only the one-shot subprocess path
  (PD-007) is touched; the live PTY seam is unchanged.
- **Affects:** `packages/shared` (`SpecFormat` canonical home; `AgentCapability`; `format`/
  `capabilities` on `AgentMessage`; `format` on `AgentStatusMessage`; new `AgentArtifactsMessage`),
  backend `agent/capabilities.ts` + `agent/artifacts.ts` + executor/server wiring, frontend
  `agent.generateSpec` (sends format + capabilities), `AgentRun.artifacts`, and the SpecPanel
  (scoped-permission hint, created-issue chips).

### PD-016 — React + Vite, retiring Angular

`(2026-06-07, accepted, supersedes the Angular shell of §4.1; refines PD-013)`

- **Decision:** The frontend is **React (via Vite + `@vitejs/plugin-react`)**, replacing the Angular 22
  shell. The canvas is no longer a React island `createRoot`-mounted under Angular through the
  `CanvasService` facade (§4.1, PD-013): tldraw is now a first-class node in the app's own React tree,
  rendered directly by `CanvasPane`. `CanvasService` is **deleted**; its imperative responsibilities
  (hold the live `Editor`, `applyIdeas`, arrange, mark, serialize, kind visibility, the background
  idea queue, per-workspace IndexedDB cleanup) move into a thin `canvas` controller module that the
  out-of-tree stores drive. The build swaps Angular CLI → Vite (Vitest kept; the `/pty` + `/health`
  proxy ported to `server.proxy`); the project was scaffolded with the official `create vite` /
  `react-ts` template, not a hand-assembled config. We are pre-prod (v0), so this was a clean rewrite,
  not an Angular↔React interop bridge.
- **Why:** **tldraw is a React library.** The whole reason the canvas was an island was to host a React
  component inside Angular; that impedance-mismatch seam (`createRoot`/`unmount`, the bridge facade,
  the React→Angular rendering techniques explored in #52) exists only to paper over the framework
  boundary. Making the host React removes the seam entirely — the canvas, the verb bar (#13/#15), the
  kind filter (#21) and the idea-card shape all live in one tree with one reconciler. The app is small
  (~2.2k LOC, 5 components, 5 services, no routing/forms/Material/NgRx) and the hard logic
  (render-scheduler, prompt-framing, idea-layout/descriptors, canvas-text, models, the tldraw island)
  is already framework-agnostic or already React, so the port carries them **verbatim** with their
  tests.
- **Affects:** Removes all `@angular/*`, `rxjs`, `tslib`; adds Vite + React toolchain. Rewrites §4.1
  (no Angular shell, no island boundary, no `CanvasService`). Refines **PD-013**: tldraw stays the
  canvas with the same shape/edge/persistence model — only its host changes; the pinned IndexedDB
  name scheme `TLDRAW_DOCUMENT_v2ai-storm:ws:{id}` is preserved so existing local boards are not
  orphaned. State layer is **PD-017**; UI/styling is **PD-018**. Backend, the `/pty` protocol, and
  `@ai-storm/shared` are untouched (PD-008 stands).

### PD-017 — Zustand as the state layer (external-store pattern)

`(2026-06-07, accepted, supersedes the Angular-signals mechanism of §5.1)`

- **Decision:** Client state is **Zustand**. Most of this app's "state" is not React-owned data — it is
  **external mutable singletons React subscribes to**: a Yjs `Y.Doc` registry (the real source of
  truth, persisted to IndexedDB), one imperative multiplexing `WebSocket`, live `xterm.js` instances,
  the tldraw `Editor` handle, and per-workspace ingestion pipelines. The five Angular services port
  near 1:1 to "singleton store + subscribe hook": `signal()` → store state, `computed()` →
  selectors/`useMemo`, `effect()` → `useEffect`. The socket, Y.Doc, pipelines, and editor stay as
  imperative module singletons (exactly as before); only their _reactive surface_ (connection state,
  workspace list, attached set, agent-run output, `ideasTick`) lives in a store, so code running
  **outside** the component tree (the WebSocket dispatcher, the ingestion pipelines) reads/writes via
  `store.getState()` / `setState()`.
- **Why:** Zustand is a ~1KB ergonomic wrapper over React 19's `useSyncExternalStore` — the exact
  primitive these external singletons need — with imperative out-of-tree access built in. Considered
  and rejected: **`useSyncExternalStore` directly** (purest/zero-dep but more per-store boilerplate —
  Zustand is just this with selectors); **Jotai** (atomic model solves fine-grained derived state we
  don't have); **Redux Toolkit** (action/reducer ceremony, overkill for single-user v0); **plain
  Context** (whole-subtree re-renders — fatal for the high-frequency terminal/idea streams).
- **Affects:** `workspace` / `backend` / `ingestion` / `agent` stores + the `canvas` controller. The
  RAF-throttled `RenderScheduler` (§5.1) is unchanged and still the idea-stream decoupler; only the
  signals/OnPush mechanism is replaced. The three service unit specs port to the stores (fresh module
  per test via `vi.resetModules()`) and pass alongside the framework-agnostic specs.

### PD-018 — UI/styling stack: shadcn/ui + Tailwind (Radix primitives)

`(2026-06-07, accepted, replaces @angular/aria)`

- **Decision:** The UI is **Tailwind CSS v4** + **shadcn/ui (Radix primitives, copied into the repo
  via the official CLI)** — initialized with `shadcn init` and components added with `shadcn add` (not
  hand-written): `button`, `input`, `badge`, `card`, `dropdown-menu`, `tooltip`, `separator`, `tabs`,
  and the full `sidebar`. This **replaces `@angular/aria`**: the workspace nav is shadcn's `Sidebar`
  (`SidebarMenu`/`SidebarMenuButton`/`SidebarMenuAction`), the per-row kebab is a Radix `DropdownMenu`
  (shadcn), and the canvas/session toolbars are Radix `Toolbar` rendering shadcn `Button`s. **We adopt
  the stock shadcn theme (neutral base, dark mode) verbatim and defer bespoke theming** — the app
  wears the default shadcn look for now; a themed palette is a later pass. The old Angular CSS
  custom-property tokens are **not** carried over. tldraw and xterm keep their own CSS.
- **Why:** shadcn is Radix + Tailwind with the component code scaffolded _into the repo_ (we own and
  restyle it, not a themed black box), which ends per-component hand-written CSS and supplies the a11y
  primitives that replace `@angular/aria` — no separate primitives lib. Starting from the **unmodified
  shadcn theme** (rather than re-implementing the previous bespoke palette) gets a clean, consistent
  baseline up first and keeps theming a separate, deliberate step — the design tokens are a future
  decision, not a migration constraint. Considered and rejected: **Mantine** (opinionated default look,
  adopt-its-API rather than own-the-code); **Radix + CSS Modules** (still hand-writing CSS — the thing
  we set out to retire).
- **Affects:** `Sidebar` (shadcn `Sidebar` + Radix `DropdownMenu`), `CanvasPane` / `ControlHub`
  (Radix `Toolbar` + shadcn `Button`/`Input`/`Badge`). `index.css` holds the stock shadcn theme
  (`:root` / `.dark` token blocks + `@theme inline`) plus a tiny xterm host-sizing rule (xterm builds
  its own DOM at runtime). Removes `@angular/aria` + `@angular/cdk`. A bespoke theme/palette is left
  as future work.

### PD-020 — Background context is baked at launch, a third priming lever

`(2026-06-07, accepted, extends PD-008/#61)`

- **Decision:** Pre-brainstorm **background context** (#76) — a freeform "set the scene" string the
  user authors before starting (e.g. _"We're a B2B fintech, audience is CFOs, avoid ideas needing new
  hardware"_) — is **baked into the launch system-prompt** as a **third priming segment**, beside the
  base `«IDEA»` contract (`PRIME_INSTRUCTION`) and the facilitation-mode preset (#61). The prime is
  composed `[PRIME_INSTRUCTION, modePreset, formatBackground(background)].filter(Boolean).join("\n\n")`;
  `formatBackground` wraps the user text in a labelled "BACKGROUND CONTEXT — standing context…" block so
  it reads as **guidance, not instructions**. Because it rides the launch prompt, it is **locked while
  the session is attached** — editing means **Stop & Start**, exactly like facilitation mode. We
  deliberately do **not** route it through the mid-session `ContextMessage` lane (PRD §3.2), which stays
  for _evolving_ context (the serialized canvas). Three roles, three lanes: **background is
  foundational, mode is how, canvas is what's emerged.**
- **Why:** Background is _standing_ context that should shape **turn one** and every turn after — the
  launch system-prompt is the strongest, earliest steering surface, so that's where it belongs. The
  session layer already treats priming as a first-class, swappable concept and already layers two
  segments on this exact seam (PD-008 passthrough prime + #61 mode), so background is a third segment on
  a path we've walked twice — **no new extraction, no new wire types, no new card kinds.** We rejected
  **live-injection** (mid-session, re-sent each turn): it competes with the canvas context lane, can't
  shape turn one, and makes "what's priming the agent right now" ambiguous. We rejected **structured
  fields** (audience / domain / constraints as separate inputs): freeform is lower-friction and the
  agent reads prose fine; structure can come later if a need appears. **Empty = byte-identical to
  today** — a blank background contributes nothing to the prime, so there is no behavioural regression
  and no migration.
- **Affects:** `background?: string` added to `AttachMessage` (`packages/shared`), to the frontend
  `TerminalConfig`, and to the `attach` payload the ingestion store sends. Backend `harnessSetup` gains
  the third compose segment via `formatBackground`. UI groups harness + mode + background under one
  **"Session setup · applied on start"** header in `ControlHub.tsx` — all three share the lock rule;
  while attached the group dims, inputs are `disabled`, and the header flips to a "🔒 session live — Stop
  to edit setup" tag with a hover tooltip giving the _how_. The textarea carries a ~1500-char soft cap
  (amber past it, not enforced — it rides every turn's prompt) and persists per workspace.

### PD-019 — Combine (merge) is a multi-source supersede, like challenge

`(2026-06-07, accepted, extends PD-012)`

- **Decision:** The multi-select **Combine** verb (#62) — "merge these cards into one stronger idea" —
  is modelled as a **convergent supersede**, the same shape as the single-card Challenge (PD-012),
  just fanned out: the agent emits **one** merged idea that **`supersedes` every selected source**, and
  each source **dims/archives** (lifecycle, #20) rather than disappearing. We rejected the `about`
  alternative (keep all sources live, merge merely _about_-links them): a merge is an act of
  _convergence_, so leaving the originals as live peers of their own synthesis re-clutters the board —
  exactly what supersede-and-dim avoids. The user retains the originals as ghosts (history kept,
  breadcrumb per #22), so nothing is lost; if they truly want a source kept live, they don't merge it.
- **Why:** The board's job is to converge (#22/#28), and Challenge already established the pattern —
  the strongest version wins while the path to it stays visible (PD-012). A merge is just that move
  over N sources instead of one, so it should reuse the same edge (`supersedes`), the same lifecycle
  dimming, and the same breadcrumb rather than inventing a new relation. Keeping it a supersede also
  means no new kind and no new lifecycle state — `combine` is _what was done_, an edge, not _what a
  card is_ (PD-010/PD-012). The bar shows **only** Combine for a 2+ selection: the single-card moves
  (discuss/expand/challenge) are about one idea and don't map onto a multi-card convergent action.
- **Affects:** Adds the `combine` `PromptIntent` + template + `combineDirective` (prompt-framing) and a
  multi-select branch in the `CardVerbBar` (#13/#15 seam). The supersede fan rides the **single-line
  marker** as a **chained ref form** — `«IDEA@a1!@a2!@a3!»` — extending the idea contract grammar
  (one `@ref[!]` → a chain of them; backend `extraction` + the session priming both teach/parse it),
  because the fenced `rel:` form is unreliable (PD-008: the TUI renders the fence away). Frontend
  `applyIdeas` now connects **all** resolved links and ghosts every superseded target, not just the
  first. Closes the `merge` scope dropped from #15 (PD-011 anticipated this "multi-select action bar").

### PD-015 — Convergence is a generated artifact, not a second surface

`(2026-06-07, accepted)`

- **Decision:** The brainstorm-ux epic built **divergence and structure** deeply (verbs #15, the
  idea graph #42, source-linking #40, lifecycle/supersede #20/#22, kinds #21, Arrange #16); the
  thin half is **convergence** — turning a full board into a decision or an output. We invest there
  next, and we build it as **generated artifacts produced on demand from the board**, _not_ as a
  second authoring surface. A synthesis, a ranking, a theme rollup, a spec hand-off — each is a
  _reading_ of the canvas: route `serializeToText(...)` through the agent and place the result
  somewhere (a markdown export, a read-only panel, or new cards/edges), then leave it for the user
  to curate on the one canvas. This keeps **PD-011** intact: the edgeless canvas stays the sole
  place you _author_; convergence never reintroduces a page/document _mode_ you edit in.
- **Why:** You can already generate, link, type, and lay out ideas, but the product's promised
  three-stage workflow (PRD §2: brainstorm → structure → hand-off) dead-ends at structure — there
  is no step that collapses the wall of cards into "here's the decision / here's the spec." That is
  the highest-leverage missing value, and it is _cheap_ because the seams already exist: the
  whole-board context path (`serializeToText` → context injection, PRD §3.2), the verb round-trip
  (`prompt-framing.ts`), union-find clustering and the placement engine (`idea-layout.ts`), and the
  typed edge/ref graph (#42). Building convergence as generated _output_ (not a new editable
  surface) reuses all of that and avoids the "two places to author the same thing" trap PD-011
  closed.
- **Affects:** Reframes **#28** (synthesis is a _generate + export_ action, not the dead
  page/edgeless mode-switch). Splits **#29**: the lightweight keep-mark star shipped in #59, and the
  "ranking drives visual weight + AI triage" half is refiled as **#60**. Spawns the convergence
  toolkit — synthesis (#28), AI triage / rank & weight (#60), cluster summarize → theme card (#63),
  and a spec/PRD hand-off (extends **PD-007**'s dispatch). All consume existing seams; none
  reinvents identity, edges, or layout. Preserves **PD-001** (single-user) and **PD-011** (one
  authoring surface). Sibling generative adds filed alongside: facilitation primings (#61),
  Merge verb (#62).

### PD-014 — Semantic layout is a manual "Arrange" action, not an automatic mode

`(2026-06-06, accepted, implements #16)`

- **Decision:** Semantic layout (#16) is exposed as an **on-demand "Arrange" action** in the
  canvas UI — a single click that re-flows the cards into an **organic mind map** — **not** an
  always-on auto-layout mode. The board never repositions a card on its own: cards land where the
  producer drops them (a new AI card docks near its linked target, else falls to the grid tail),
  and the user is free to drag anything anywhere. Arranging is something the user _invokes_;
  between invocations, manual positions are left untouched. The layout is **graph-driven, not
  lane-based**: each connected group of related cards becomes a cluster that **radiates out from
  its main idea** (an `about` child fans outward; same-kind children are grouped together in the
  fan), a `supersedes` relation reads **left→right** (the greyed original sits to the _left_, the
  new card is the anchor everything else fans from — PD-012), and unrelated loose cards are tidied
  into kind-grouped lanes off to the side. Distinct clusters get generous **breathing room** so
  the board doesn't read as one overloaded wall. Relationships are preserved for free — edges are
  native tldraw arrows **bound** to both cards, so they track their endpoints as Arrange moves
  them; Arrange only mutates card `x/y`, never the graph. Default for a new workspace: nothing
  auto-runs (the action is simply available).
- **Why:** Space carries meaning on an edgeless canvas, and the user's deliberate placement _is_
  meaning. An automatic re-layout that fires on every new card would fight the user — snapping a
  card they just nudged back — which destroys exactly the spatial intent the canvas exists to
  capture. Making it a click keeps the user in control of _when_ the board reorganizes: diverge
  freely by hand, then converge with one action when the pile needs tidying. Rigid kind-columns
  (the first cut) aligned everything into hard lanes and read as a spreadsheet, not a brainstorm;
  a mind map that clusters by _relationship_ and fans children around their idea matches how the
  graph (PD-010) actually reads and leaves cognitive room. A continuous/auto mode, a persisted
  preference, or model-driven affinity re-clustering (#17) can layer on later without reversing
  this call.
- **Affects:** Implements #16. Adds `CanvasService.arrange(workspaceId)` → `arrangeMindMap(editor)`
  in the canvas island, which extracts the typed edge graph from the bound arrows
  (`getBindingsFromShape` + the arrow `meta.relation`) and feeds a pure, testable `layoutMindMap`
  helper (`idea-layout.ts`): union-find clusters → per-cluster branching radial placement
  (`about` fans out, `supersedes` pins the original left) → shelf-packing with `clusterGap`
  breathing room; loose cards fall back to kind-grouped lanes. The trigger is an "Arrange" button
  in the existing canvas-pane toolbar (alongside the #21 kind filters and the Inject/Send
  actions). The dumb 3-col tiler in `applyIdeas` stays as the _new-card drop_ fallback (this PD
  governs the explicit re-flow, not where a single fresh card lands). Out of scope, deferred: an
  auto/continuous mode, a persisted setting, labeled cluster frames and model-driven affinity
  clustering (#17), overlap-free force resolution on dense graphs, docking heuristics beyond the
  existing linked-target placement (#18).

### PD-013 — The canvas is tldraw (native edgeless surface)

`(2026-06-06, accepted; host framework updated by PD-016)`

> ℹ️ **Refined by PD-016.** tldraw remains the canvas with the same shape/edge/persistence model
> described here. What changed: the host is now React (not an Angular shell), so the "React island
> under Angular" framing and the `CanvasService` Angular facade below are gone — the editor is held by
> a plain `canvas` controller module and rendered directly in the React tree.

- **Decision:** The spatial canvas is **tldraw**, rendered as a React island under the Angular
  shell. Ideas are custom `idea-card` shapes; typed edges are native arrows bound to cards (the
  `about`/`supersedes` relation lives in the arrow's `meta`); per-kind color is a tldraw shared
  style resolved against the active light/dark theme; identity is the card's short ref in its shape
  `meta`. The board persists per workspace via tldraw `persistenceKey` → IndexedDB (PD-001,
  local-first; survives reload).
- **Why:** tldraw's shapes-+-typed-bindings model maps directly onto the idea-graph (PD-010, nodes +
  typed edges), connectors are built in, the canvas UX/perf and SDK DX are strong, and the
  React→Angular boundary is a thin island (`createRoot`/`unmount`, no `@angular/elements` or Zone
  bridging — the app is zoneless). It is the native fit for the edgeless-only surface (PD-011).
- **Affects:** `CanvasService` is an Angular facade over the island; `applyIdeas` creates cards +
  bound arrows; `serializeToText` walks the shape store; the card verbs (#13/#15) are a tldraw
  selection action bar; kind colors come from the kind registry (PD-010). Multiplayer / server
  storage (tldraw sync or a backend snapshot store) is a later option; single-user (PD-001) stands.
  The shared `Idea`/`IdeaRelation`/`IdeaLink` types and the `«IDEA…@ref!»` extraction contract are
  framework-neutral and unaffected.

### PD-012 — A challenge is a supersede operation, not a kind

`(2026-06-08, accepted, refines PD-010)`

- **Decision:** "Challenge" is **not** a card kind — it is an **operation** on an existing idea.
  When the Challenge verb (#15) fires on a card, the agent produces a refined/stronger version
  that **supersedes** the original via a `supersedes` edge (the one relation that carries its own
  meaning, PD-010/idea-graph §2.3); the superseded card **dims/archives** rather than disappearing,
  so the history of the argument is preserved. So `challenge` is dropped from the kind enumeration
  in PD-010 — there is no `challenge`-tinted card. (A counter-point the user wants to keep as a
  standalone note is just an ordinary idea card, optionally `about`-linked.)
- **Why:** A challenge is fundamentally _about changing an idea_, not adding a parallel one. Spawning
  a free-floating "challenge" card (what an early kind-registry entry would have done) leaves the
  contested idea untouched and clutters the board with disconnected objections. Routing it through
  `supersedes` makes the board converge — the strongest version wins and the path to it stays
  visible — which is the point of decision capture (#22) and lifecycle (#20). It also keeps the
  kind set about _what a card is_, not _what was done to it_ (that's an edge, per PD-010).
- **Affects:** Implemented by #20 (lifecycle states: e.g. `active` → `superseded`) + #22 (decision
  capture / snapshot the superseded card). The data home already exists — a typed edge carries its
  `relation`, including `supersedes`, natively (a tldraw arrow's `meta`). The Challenge verb's prompt
  instructs the agent to emit the refined idea with a `supersedes` link back to the source ref.
  Removes `challenge` from PD-010's kind list and from the `idea-graph.md` §3.2 `KIND_REGISTRY`
  example.

### PD-011 — The edgeless canvas is the only surface

`(2026-06-06, accepted)`

- **Decision:** The spatial **edgeless canvas** is the sole interaction surface; there is no linear
  document/page view. All brainstorm-UX affordances — card verbs, selection-based context, the
  graph, layout, lifecycle — are designed for and built on it. Selection-based features read the
  canvas selection (`editor.getSelectedShapes()`).
- **Why:** Ideation is spatial — the product's value is the infinite canvas, where space carries
  meaning (#16/#17). A linear document is best understood as a convergent _reading_ of the board
  (the natural home for synthesis, #28, produced on demand), not a second place to author the
  divergent brainstorm. Committing to one surface keeps the UX coherent and the implementation
  focused.
- **Affects:** Re-scopes #14 (reply-to-card) from spatial-proximity guessing to an explicit
  **multi-card selection** as context (a toolbar "Discuss selection" that frames the selected cards
  into the editable terminal prompt — replacing the radius heuristic, which guessed relevance from
  position). Guides #42 (graph), #16/#17 (layout), #20 (lifecycle): all target the canvas. The
  card verbs (#13/#15) remain single-card; a custom multi-select action bar may come later.

### PD-010 — Ideas are a graph: uniform node + typed edges + kind registry

`(2026-06-06, accepted)`

- **Decision:** Model the board as a **graph**, not a pile or a tree. Three axes that were
  being conflated into `kind` are kept independent: **kind** (_what a card is_ — risk /
  feature / question / decision — on the node; **not** `challenge`, which is a supersede
  operation, see PD-012), **link** (_what it's about_ —
  a generic `about` edge to another card; the only edge type carrying its own meaning is
  `supersedes`), and **provenance** (_who made it_ — `ai`/`user`, already PD-009). A node has
  one kind but many edges, to many targets. Flavor is **not** duplicated onto the edge (no
  `risk-of`/`challenge-of` relation taxonomy) — you read "risk of X" by following an `about`
  edge from a `risk`-kind card. Per-kind behavior (label, tint, future shape/lifecycle) lives
  in a single client-side **kind registry**, so a new ideation concept is one registry entry
  (data), not a new wire marker/parser/type (code). Identity and edges persist on the canvas itself
  — a card's short ref in its shape `meta`, edges as bound arrows carrying their `relation` — **no
  server-side store**; the shared `@ai-storm/shared` types are the "both sides know it" contract.
- **Why:** #40 (source-linked responses), #19 (connectors), #20 (lifecycle), #22 (supersede),
  #16/#17 (layout) all need the same two primitives — **stable idea identity** and **typed
  edges**. Defining them once makes those issues cheap; building them on position-only data
  means each reinvents identity+edges or gets reworked. Uniform-node-+-registry was chosen over
  dedicated `Risk`/`Challenge` types because brainstorming concepts are open-ended and
  cross-referencing: adding a type should be data, not a new fragile `tmux`-grid marker. The
  edge stays generic because `kind:risk` + `relation:risk-of` is the same fact twice; only
  `supersedes` (an effect on the target) earns an edge type. Discussion is intentionally **not**
  a node — it's the terminal thread, referenced by #23, not forced into `{title, body}`.
- **Affects:** Foundational refactor tracked by its own ticket; design in
  [`idea-graph.md`](../design/idea-graph.md). Extends the `«IDEA»` contract with an optional
  `@ref` target (mirrors the existing inline `:kind` tag) and the shared `Idea` type with
  `id`/`links`. Refactors `idea-descriptors.ts` (`KIND_LABEL`/`KIND_BACKGROUND`/`KNOWN_KINDS` →
  `KIND_REGISTRY`) and `CanvasService` (`applyIdeas` creates cards + bound arrows; refs in shape
  `meta`). Unblocks #40/#19/#20/#22/#16. Single-user (PD-001) and terminal-passthrough (PD-008) stand.

### PD-009 — Note provenance, not a capture composer

`(2026-06-06, accepted, supersedes the composer approach of PD-002)`

- **Decision:** Humans author notes the way they already do — directly on the canvas. We do
  NOT add a dedicated "add idea" composer. Instead we **track provenance**: AI-created cards (the only
  programmatic creator, `CanvasService.applyIdeas()` from the `«IDEA»` stream) are tagged
  `origin: 'ai'`; any card the user draws on the canvas is untagged and treated as user-origin by
  default. AI cards are made visually distinct (kind color **and** a 🤖 badge).
- **Why:** A second input path is redundant when the editor already creates notes, and a structured
  composer's value was latent (kind is presentation-only until #21). The genuinely useful, missing
  signal is _who made this_ — at-a-glance separation of AI suggestions from the user's own thinking.
  Marking only the AI path (and defaulting everything else to user) needs no hook into user editing.
- **Affects:** Reframes [#31](https://github.com/drdreo/ai-storm/issues/31) (was "human idea-capture",
  now "note provenance"). The composer work (PR #34) is closed unmerged. Provenance persists with the
  card (its shape props, survives reload). Sets up provenance-link (#23) and kind-driven filters (#21),
  which can query the same origin signal.

### PD-002 — Humans capture ideas too

`(2026-06-06, accepted — composer approach superseded by PD-009)`

- **Decision:** Humans can capture ideas directly, not only the AI via the terminal.
- **Why:** Today the only human path to a card is drawing one directly on the canvas. A first-class
  "add idea" affordance is needed. The clean approach reuses the existing AI pipeline: a human-authored idea
  produces the same `Idea {title, body, kind}` object and flows through `ideaToDescriptors()` →
  `RenderScheduler` → `CanvasService.applyIdeas()`. So we add a second _producer_ to an existing
  pipeline rather than building a parallel system — which also de-risks the bidirectional-canvas
  keystone by proving an input-side entry point.
- **Affects:** Chosen **starting ticket** for the brainstorm-ux epic
  ([#31](https://github.com/drdreo/ai-storm/issues/31)). Unblocks
  [#27](https://github.com/drdreo/ai-storm/issues/27) (silent-brainstorm warmup).

### PD-001 — Single-user for now

`(2026-06-06, accepted)`

- **Decision:** ai-storm is single-user for now. No real-time co-editing, presence, attribution, or
  multiplayer voting yet.
- **Why:** Keeps scope focused. Local-first persistence stays (the tldraw canvas store + a Yjs
  workspace registry, §3.5); going multiplayer later (e.g. tldraw sync) is an additive step, not a
  rewrite — but no multiplayer-specific affordances are built now.
- **Affects:** Closes [#30](https://github.com/drdreo/ai-storm/issues/30) (not planned). De-prioritizes
  presence/attribution/voting across the brainstorm-ux epic. Revisit if/when multiplayer becomes a goal.

---

## Baseline decisions (PRD v3.0)

Foundational product calls baked into the original PRD. Recorded here as explicit decisions; the full
requirements are in Part 1.

### PD-008 — Terminal passthrough supersedes the §3.3 slicing buffer

`(PRD v3.0 baseline, superseded §3.3)`

- **Decision:** The conversation surface is a **real xterm terminal**: the backend streams raw PTY
  bytes (base64 `data` messages) and the browser renders them with xterm.js. The backend scans the
  rendered screen only for the `«IDEA»` / ` ```idea ` markers and emits one deduped `idea` message
  per capture. This replaces PRD §3.3's client-side slicing/chunking/markdown-parsing buffer for the
  _conversation_ path.
- **Why:** Server-side chat extraction and per-CLI-version chrome regexes were fragile and version-
  tuned. Passing the terminal through verbatim deleted that whole class of bugs; only the robust idea
  scan remains.
- **Affects:** Supersedes §3.3. Detailed in
  [`ai-response-extraction-contract.md`](../design/ai-response-extraction-contract.md). The
  `«IDEA»` contract (`Idea {title, body, kind}`) is the shared seam PD-002 builds on.

### PD-007 — Downstream agent hand-off via local subprocess

`(PRD v3.0 baseline, accepted)`

- **Decision:** Selecting cards on the canvas dispatches their plain text to the Node daemon, which
  spawns a local subprocess (the configured agent orchestrator) with the payload as an argument.
- **Why:** Closes the loop from refined canvas spec → executable developer workflow without leaving
  the app or hand-copying context. (§3.6)
- **Affects:** `AgentService.dispatch()`; the brainstorm-ux "card-to-prompt" ideas
  ([#15](https://github.com/drdreo/ai-storm/issues/15)) extend this seam.

### PD-006 — Sub-100ms client-side hot-switch + strict workspace isolation

`(PRD v3.0 baseline, accepted)`

- **Decision:** Workspace switching happens entirely client-side in <100ms (no reload), with strict
  isolation: each workspace has its own canvas, session binding, history, and config.
- **Why:** The product is about exploring many ideas concurrently; friction between workspaces kills
  that. (§3.4, §5.2)
- **Affects:** `WorkspaceService`, canvas remount/switch in `CanvasService`, per-workspace terminal caching.

### PD-005 — Local-first persistence to IndexedDB

`(PRD v3.0 baseline, accepted)`

- **Decision:** All workspace state persists locally to IndexedDB, written immediately on every
  change, with a crash-recovery boot sequence that restores the last-active workspace exactly: the
  **tldraw canvas store** per workspace (via `persistenceKey`) and a **CRDT (Yjs) registry** of
  workspace metadata.
- **Why:** Local data privacy + crash resilience without a server. (§3.5)
- **Affects:** `CanvasService` (the per-workspace tldraw store), the workspace registry.

### PD-003 — Local-only: reuse local CLI subscriptions via real PTYs

`(PRD v3.0 baseline, accepted)`

- **Decision:** No external AI APIs, subscriptions, or cloud keys. Tap the user's already-running
  local AI CLI through real pseudo-terminals (`@lydell/node-pty`, ConPTY/forkpty) behind a Node + Hono
  daemon bound to 127.0.0.1.
- **Why:** Local data privacy, zero added cost, and minimal tooling friction for the solo-builder
  persona. Security posture is containment (loopback bind, restricted spawn surface, path-traversal
  guards), since Node has no `--allow-*` model. (§1, §4.2)
- **Affects:** The entire backend topology; defines the project's identity.
