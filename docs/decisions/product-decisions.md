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
streams local terminal data into a multi-workspace BlockSuite environment.

## 1. Executive summary & core objectives

ai-storm is a localized, framework-agnostic collaborative product brainstorming workspace
designed to translate creative, conversational ideation into structural, executable developer
workflows. The application completely avoids external AI API connections, subscription models,
or cloud-hosted keys. Instead, it reuses existing local command-line interface subscriptions by
tapping directly into active pseudo-terminals and headless terminal sessions running on the
developer's machine.

By integrating BlockSuite into a highly responsive user interface, the system gives the user an
infinite visual layout to organize notes while concurrently streaming real-time local text
generation directly into structured document blocks. The backend layer is powered entirely by a
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
- **Structural Workspace Canvas (center/left pane):** An embedded instance of BlockSuite that
  operates in a framework-agnostic capacity. It must support fluid, client-side toggling between a
  linear document configuration and a spatial node canvas. Both layouts must read and write to the
  exact same underlying project data structure.

### 3.2. Contextual document ingestion (input layer)

Prior to dispatching a user command or contextual update to the local terminal loop, a background
compilation service must serialize the current state of the active BlockSuite canvas into a
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
- **CRDT binary serialization:** The data layer must rely entirely on Conflict-free Replicated Data
  Type binary trees mapped to localized data storage via the browser's native IndexedDB directory.
- **Crash recovery boot sequence:** Upon application boot, an initialization service must scan the
  browser storage engine index, identify the most recently active workspace identifier, rebuild the
  structural data engine from local binary storage logs, and present the workspace exactly as it was
  left.

### 3.6. Downstream agent execution hook

Every structural node component or multi-selected group of blocks within the BlockSuite canvas must
feature an actionable contextual interaction macro. When executed, the system must extract the plain
text contents, strip out layout wrappers, and dispatch a structured local loopback event to the Node
background service. The Node service must interpret the payload and instantly spawn an asynchronous
local system subprocess, invoking the target agent orchestrator command execution array with the text
payload passed as a clear functional argument.

## 4. System topology & backend specifications

### 4.1. Framework-agnostic core principles

The front-end web interface must treat BlockSuite as a set of standard, browser-native web
components. No framework-specific lifecycle boundaries or proprietary wrapper hooks may be utilized
for data rendering or view synchronization.

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

### PD-011 — The edgeless canvas is the primary surface; the doc view is a bonus

`(2026-06-06, accepted)`

- **Decision:** The edgeless **Canvas** view is the primary interaction surface; the linear
  **Document** (page) view is a secondary bonus. All brainstorm-UX affordances — card verbs,
  selection-based context, connectors/graph, layout, lifecycle — are designed for and built on
  the edgeless surface. We build **no** UX specifically for the doc view; it stays a plain
  alternate rendering of the same CRDT data (PD-004) with no dedicated affordances. Concretely,
  selection-based features read the **edgeless gfx selection** (`GfxControllerIdentifier` →
  `selection.selectedElements`), not the page/text selection.
- **Why:** Ideation is spatial — the product's value is the infinite canvas, where space carries
  meaning (#16/#17). Building every affordance twice (doc + edgeless) is wasted effort, and the
  doc view is best understood as a convergent *reading* of the same data (a natural home for
  synthesis, #28), not a place to author the divergent brainstorm. Committing to one primary
  surface keeps the UX coherent and the implementation focused.
- **Affects:** Re-scopes #14 (reply-to-card) from spatial-proximity guessing to an explicit
  **edgeless multi-note selection** as context (a top-toolbar "Discuss selection" that frames the
  selected cards into the editable terminal prompt — replacing the radius heuristic, which guessed
  relevance from position). Guides #42 (graph), #16/#17 (layout), #20 (lifecycle): all target the
  edgeless surface. The element-toolbar verbs (#13/#15) remain single-card; a custom multi-select
  toolbar may come later, but multi-select context lives on the top toolbar for now. Builds on
  PD-004 (page+edgeless over one model) — the doc view persists, it just gets no bespoke UX.

### PD-010 — Ideas are a graph: uniform node + typed edges + kind registry

`(2026-06-06, accepted)`

- **Decision:** Model the board as a **graph**, not a pile or a tree. Three axes that were
  being conflated into `kind` are kept independent: **kind** (*what a card is* — risk /
  challenge / feature / question / decision — on the node), **link** (*what it's about* —
  a generic `about` edge to another card; the only edge type carrying its own meaning is
  `supersedes`), and **provenance** (*who made it* — `ai`/`user`, already PD-009). A node has
  one kind but many edges, to many targets. Flavor is **not** duplicated onto the edge (no
  `risk-of`/`challenge-of` relation taxonomy) — you read "risk of X" by following an `about`
  edge from a `risk`-kind card. Per-kind behavior (label, tint, future shape/lifecycle) lives
  in a single client-side **kind registry**, so a new ideation concept is one registry entry
  (data), not a new wire marker/parser/type (code). Persistence stays the client CRDT (two new
  namespaced maps: `ai-storm:ref` for short-ref identity, `ai-storm:edges` for the graph) — **no
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
  `KIND_REGISTRY`) and `CanvasService` (ref + edges maps, connector drawing in `applyIdeas`).
  Unblocks #40/#19/#20/#22/#16. Single-user (PD-001) and terminal-passthrough (PD-008) stand.

### PD-009 — Note provenance, not a capture composer

`(2026-06-06, accepted, supersedes the composer approach of PD-002)`

- **Decision:** Humans author notes the way they already do — directly in the BlockSuite editor. We do
  NOT add a dedicated "add idea" composer. Instead we **track provenance**: AI-created notes (the only
  programmatic creator, `CanvasService.applyIdeas()` from the `«IDEA»` stream) are tagged
  `origin: 'ai'`; any note the user draws in the editor is untagged and treated as user-origin by
  default. AI cards are made visually distinct (background tint **and** a badge marker).
- **Why:** A second input path is redundant when the editor already creates notes, and a structured
  composer's value was latent (kind is presentation-only until #21). The genuinely useful, missing
  signal is *who made this* — at-a-glance separation of AI suggestions from the user's own thinking.
  Marking only the AI path (and defaulting everything else to user) needs no hook into user editing.
- **Affects:** Reframes [#31](https://github.com/drdreo/ai-storm/issues/31) (was "human idea-capture",
  now "note provenance"). The composer work (PR #34) is closed unmerged. Provenance must persist in the
  CRDT doc (survives reload). Sets up provenance-link (#23) and kind-driven filters (#21), which can
  query the same origin signal.

### PD-002 — Humans capture ideas too

`(2026-06-06, accepted — composer approach superseded by PD-009)`

- **Decision:** Humans can capture ideas directly, not only the AI via the terminal.
- **Why:** Today the only human path to a card is raw BlockSuite editing. A first-class "add idea"
  affordance is needed. The clean approach reuses the existing AI pipeline: a human-authored idea
  produces the same `Idea {title, body, kind}` object and flows through `ideaToDescriptors()` →
  `RenderScheduler` → `CanvasService.applyIdeas()`. So we add a second *producer* to an existing
  pipeline rather than building a parallel system — which also de-risks the bidirectional-canvas
  keystone by proving an input-side entry point.
- **Affects:** Chosen **starting ticket** for the brainstorm-ux epic
  ([#31](https://github.com/drdreo/ai-storm/issues/31)). Unblocks
  [#27](https://github.com/drdreo/ai-storm/issues/27) (silent-brainstorm warmup).

### PD-001 — Single-user for now

`(2026-06-06, accepted)`

- **Decision:** ai-storm is single-user for now. No real-time co-editing, presence, attribution, or
  multiplayer voting yet.
- **Why:** Keeps scope focused. The CRDT persistence layer (Yjs/IndexedDB, see §3.5) stays because it
  is effectively free and already in place — so going multiplayer later is an incremental step, not a
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
  *conversation* path.
- **Why:** Server-side chat extraction and per-CLI-version chrome regexes were fragile and version-
  tuned. Passing the terminal through verbatim deleted that whole class of bugs; only the robust idea
  scan remains.
- **Affects:** Supersedes §3.3. Detailed in
  [`ai-response-extraction-contract.md`](../design/ai-response-extraction-contract.md). The
  `«IDEA»` contract (`Idea {title, body, kind}`) is the shared seam PD-002 builds on.

### PD-007 — Downstream agent hand-off via local subprocess

`(PRD v3.0 baseline, accepted)`

- **Decision:** Selecting blocks on the canvas dispatches their plain text to the Node daemon, which
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
- **Affects:** `WorkspaceService`, editor rebind in `CanvasService`, per-workspace terminal caching.

### PD-005 — Local-first persistence via CRDT → IndexedDB

`(PRD v3.0 baseline, accepted)`

- **Decision:** All workspace state persists as CRDT (Yjs) binary in IndexedDB, written immediately on
  every change, with a crash-recovery boot sequence that restores the last-active workspace exactly.
- **Why:** Local data privacy + crash resilience without a server. Also makes eventual multiplayer an
  incremental step (see PD-001). (§3.5)
- **Affects:** `CanvasService`, workspace registry, subdoc persistence.

### PD-004 — BlockSuite canvas: page + edgeless over one shared model

`(PRD v3.0 baseline, accepted)`

- **Decision:** Use BlockSuite as a framework-agnostic web component; support client-side toggling
  between linear document (page) and spatial node (edgeless) views, both reading/writing the same
  underlying data structure.
- **Why:** Ideation needs both divergent spatial layout and convergent document structure over one
  source of truth. (§3.1, §4.1)
- **Affects:** `CanvasService`, canvas-pane view toggle; the convergence ideas
  ([#28](https://github.com/drdreo/ai-storm/issues/28)) lean on this duality.

### PD-003 — Local-only: reuse local CLI subscriptions via real PTYs

`(PRD v3.0 baseline, accepted)`

- **Decision:** No external AI APIs, subscriptions, or cloud keys. Tap the user's already-running
  local AI CLI through real pseudo-terminals (`@lydell/node-pty`, ConPTY/forkpty) behind a Node + Hono
  daemon bound to 127.0.0.1.
- **Why:** Local data privacy, zero added cost, and minimal tooling friction for the solo-builder
  persona. Security posture is containment (loopback bind, restricted spawn surface, path-traversal
  guards), since Node has no `--allow-*` model. (§1, §4.2)
- **Affects:** The entire backend topology; defines the project's identity.
