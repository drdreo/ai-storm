# Design: tmux-based interactive AI session layer (POSIX) + response extraction

**Status:** Partially superseded — the durable-session layer stands; the response _extraction_ (§4.3 chrome filter, §6 `ResponseMessage`) is replaced by terminal passthrough. See banner.
**Author:** ai-storm backend
**Related:** [Product decisions](../decisions/product-decisions.md) §3.2, §3.3, §3.5, §3.6, §4.2, §5.1, §5.2 (the PRD now lives there)
**Reference implementation:** [`agent-orchestrator`](https://github.com/ComposioHQ/agent-orchestrator)

---

> ## ⚠️ Update: the conversation surface is a real terminal again
>
> The durable, named, connection-independent **session layer** described here
> stands (tmux on POSIX, in-process node-pty on Windows; priming, reconcile,
> idempotent attach). What changed is the **output path**: instead of polling
> `capture-pane`, extracting clean chat lines, and shipping a `ResponseMessage`
> (§4.3, §6), the backend now streams the **raw PTY bytes** to the browser as a
> `data` message and **xterm.js renders them** — much like the original AO model
> this document set out to replace, but keeping the durable session layer.
>
> - **POSIX raw stream:** `tmux pipe-pane` tees the pane's raw output to a temp
>   file which the backend tails and forwards as `data`. `capture-pane` is still
>   polled, but only to feed the **idea scan**.
> - **Windows raw stream:** node-pty `onData` bytes go straight to `data`, and in
>   parallel into a headless `TerminalScreen` whose render is scanned for ideas.
> - **Ideas:** the `«IDEA»` contract from
>   [`ai-response-extraction-contract.md`](./ai-response-extraction-contract.md)
>   is the only thing extracted server-side; each idea ships as an `idea` message.
>
> So §4.3's chrome filter, the `ResponseExtractor`, `ResponseMessage`/`chat`, and
> `line-buffer.ts`/`SlicingBuffer` are obsolete; the §2 session/transport
> machinery and §3.5 durability are not.

---

## 1. Current implementation and historical context

The durable-session portion of this design is shipped. `backend/src/session/runtime.ts`
selects `TmuxSessionBackend` on POSIX and `NodePtySessionBackend` on Windows;
`backend/src/server.ts` owns one process-wide backend whose sessions outlive a
WebSocket connection. The backend sends raw PTY bytes as `data`, scans rendered
terminal output for `idea`/`score` markers, and routes MCP tool events through the
same callbacks. Project metadata, tldraw board snapshots, ref allocation, and run
history are separately durable in `backend/src/state/store.ts`.

The original problem statement below is retained to explain why the named session,
raw terminal, and backend-owned state boundaries exist. It is historical, not a
claim about the current code.

### Historical problem statement

ai-storm originally spawned a local CLI agent directly under a per-connection PTY and
forwarded raw stdout to the browser. That prototype had three structural problems:

1. **The PTY was bound to a WebSocket connection.** A backend restart, browser refresh,
   or socket drop killed the agent process instead of allowing reattach.
2. **Input raced PTY creation.** The client could send `attach` and `input` back-to-back,
   requiring a pending-input buffer while the process was still spawning.
3. **A proposed response extractor overfit terminal chrome.** The abandoned design tried
   to infer agent prose from prompt echoes and spinner output; the shipped product keeps
   the terminal presentation raw and extracts only the explicit idea contract.

The implementation outcome is a durable named session (`ai-storm-<projectId>`) on
POSIX, an idempotent process-lifetime session on Windows, raw xterm passthrough, and
backend-side marker/MCP capture. The current state protocol is documented in
[`PD-024`](../decisions/product-decisions.md#pd-024--backend-owned-durable-project-state).

### Runtime constraints (implemented)

- **No headless/print mode.** The daemon drives the real interactive CLI. No `claude -p`
  or `--output-format` shortcut is used; profiles remain harness-agnostic.
- **Raw terminal presentation is intentional.** The browser receives the raw PTY stream
  as `data` and renders it with xterm.js; only the explicit idea/score contract is
  extracted into structured messages.
- **POSIX uses tmux; Windows uses node-pty/ConPTY.** Both sit behind one
  `SessionBackend` abstraction.

---

## 2. The agent-orchestrator mechanism (the template we port)

agent-orchestrator (AO) already solves "host an interactive harness in a durable, reattachable tmux session and relay it to a browser." We port its **session + transport** layer almost verbatim. The abandoned clean-response extractor is retained below as historical rationale; the shipped implementation intentionally keeps AO's raw terminal presentation and scans only the explicit idea contract.

### 2.1 Default runtime selection — `packages/core/src/platform.ts`

```ts
export function getDefaultRuntime(): "tmux" | "process" {
  return isWindows() ? "process" : "tmux";
}
```

tmux on POSIX (Linux/macOS); `process` (named-pipe relay) on Windows. This is exactly the POSIX/Windows split we want behind `SessionBackend`.

### 2.2 Session creation — `packages/plugins/runtime-tmux/src/index.ts`

A **detached** session is created with the working dir, environment, and launch command baked in:

```
tmux new-session -d -s {sessionName} -c {workspacePath} {env_args...} {shellCommand}
```

Environment is passed per-variable (lines 78–82):

```ts
const envArgs: string[] = [];
for (const [key, value] of Object.entries(config.environment ?? {})) {
  envArgs.push("-e", `${key}=${value}`);
}
```

The status bar is turned off so it is not mistaken for content and does not race with a client's own `set-option` (index.ts:122):

```
tmux set-option -t {sessionName} status off
```

**Keep-alive shell (index.ts:49) — critical for durability.** The launch command is wrapped so the pane survives the agent exiting:

```bash
exec "${SHELL:-/bin/bash}" -i
```

```ts
function withKeepAliveShell(command: string): string {
  return `${command.replace(/\n+$/, "")}\n${KEEP_ALIVE_SHELL}`;
}
```

When the launch command is long (>200 chars), AO writes a self-deleting launch script instead of inlining (index.ts:101–104) to avoid `ARG_MAX`/quoting problems:

```ts
const scriptPath = join(tmpdir(), `ao-launch-${randomUUID()}.sh`);
const content = `#!/usr/bin/env bash\nrm -- "$0" 2>/dev/null || true\n${withKeepAliveShell(command)}\n`;
writeFileSync(scriptPath, content, { encoding: "utf-8", mode: 0o700 });
return `bash ${shellEscape(scriptPath)}`;
```

Teardown (index.ts:147):

```
tmux kill-session -t {sessionName}
```

### 2.3 Sending input — `packages/core/src/tmux.ts`

AO's `sendKeys` is the model for `sendInput`. It does **not** just blast keys; it follows a deliberate sequence designed for interactive REPLs:

1. **Clear partial input first** (tmux.ts:89–92):

   ```ts
   await tmux("send-keys", "-t", sessionName, "Escape");
   await new Promise((resolve) => setTimeout(resolve, 100)); // let Escape land
   ```

2. **Long or multiline messages** (`message.includes("\n") || message.length > 200`) go through a **tmux paste buffer** — never as keystrokes — so newlines don't prematurely submit and large prompts don't overflow:

   ```
   tmux load-buffer -b {bufferName} {tmpPath}
   tmux paste-buffer  -b {bufferName} -t {sessionName} -d   # -d: delete buffer after paste
   ```

   (Message is written to a `0o600` temp file first; buffer/temp file cleaned up after.)

3. **Short single-line messages** go as a **literal** send (the `-l` flag stops tmux interpreting words like `Enter`/`C-c` as keysyms):

   ```
   tmux send-keys -t {sessionName} -l {message}
   ```

4. **Enter is sent separately, after a delay** (300 ms for literal, up to 1000 ms after a paste), so the harness's line discipline sees a settled line before submit:
   ```
   tmux send-keys -t {sessionName} Enter
   ```

### 2.4 Transport / reattach — `packages/web/server/mux-websocket.ts`

AO's `TerminalManager` spawns a `node-pty` that runs `tmux attach-session` and relays bytes to the browser. The original ai-storm proposal treated this as a fallback diagnostic transport; the shipped product intentionally keeps the raw terminal presentation, while the reattach machinery remains the part we want:

- Exact-match attach (prevents `ao-1` matching `ao-15`):
  ```ts
  const exactTmuxTarget = `=${tmuxSessionId}`;
  this.spawnTmuxPty(["attach-session", "-t", exactTmuxTarget], { name: "xterm-256color", cols: 80, rows: 24, ... });
  ```
- **Ring buffer** caps retained bytes: `RING_BUFFER_MAX = 50 * 1024` (50 KB), trimmed oldest-first on overflow.
- **Bounded reattach on PTY crash**: `MAX_REATTACH_ATTEMPTS = 3`, with a `REATTACH_RESET_GRACE_MS = 5_000` window that resets the counter once a fresh attach stays healthy. Crucially, **before reattaching it checks the tmux session still exists** (`tmux has-session`); if the session is gone it reports a clean exit instead of looping.
- **Windows branch** bypasses tmux entirely and relays over a **named pipe** with a `[type:u8][len:u32be][payload]` framing — this is the existing `process` runtime, which maps onto our Windows `SessionBackend`.

### 2.5 Session existence + naming

- AO's existence check uses exact match: `tmux has-session -t ={sessionId}`. The
  shipped backend uses the validated full session name because tmux 3.6b rejects
  the `=` form for several commands.
- Project IDs are validated against `^[a-zA-Z0-9_-]+$` before being interpolated
  into any tmux command (injection guard).
- AO captures clean text with `tmux capture-pane -t {sessionId} -p -S -{lines}` (e.g. `-S -50`). This single primitive is the seed of our extraction layer.

---

## 3. Current ai-storm backend audit + the input race

### 3.1 What exists today

| Component         | File                                     | Current behavior                                                                                                                                       |
| ----------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| WS + HTTP server  | `backend/src/server.ts`                  | Hono binds to `127.0.0.1`; `/pty` multiplexes projects and `/mcp` routes session-scoped tools. Disconnect detaches streams but does not kill sessions. |
| Runtime selector  | `backend/src/session/runtime.ts`         | One process-wide `SessionBackend`: tmux on POSIX, node-pty on Windows.                                                                                 |
| POSIX session     | `backend/src/session/tmux-backend.ts`    | Named `ai-storm-<projectId>` session, keep-alive shell, raw `pipe-pane` stream, `capture-pane` marker scan, MCP token recovery.                        |
| Windows session   | `backend/src/session/nodepty-backend.ts` | Process-lifetime ConPTY session with a headless screen for the same marker scanner; restart persistence remains a documented Windows limitation.       |
| Durable state     | `backend/src/state/store.ts`             | Atomic registry, board, ref-allocation, and history files under the platform state directory.                                                          |
| One-shot hand-off | `backend/src/agent/executor.ts`          | Backend-vetted subprocess execution with payload delivered on stdin where required by the security boundary.                                           |
| Wire protocol     | `packages/shared/src/protocol.ts`        | Shared project-keyed `ClientMessage`/`ServerMessage` and state request/response unions.                                                                |

### 3.2 The implemented lifecycle

`attach` → `SessionBackend.create()` ensures the project session exists →
`SessionBackend.attach()` replays/streams raw PTY bytes and starts the idea/score
scan → the browser renders `data` in xterm.js and applies discrete `idea`,
`score`, completion, and reference messages. On POSIX the session survives a
backend restart; on Windows it survives socket loss and browser refresh only while
the backend process remains alive. A reconnect reissues `attach` idempotently;
there is no client-side durable project store or PTY creation buffer.

### 3.3 The input race (historical, fixed by the named-session model)

The original frontend sent **attach and input back-to-back without waiting for `ready`**.
The component/service names in the example below describe that pre-session-backend
implementation; the current equivalent is `ControlHub` → `ingestion` → the shared
`backend` WebSocket client.

- `ControlHubComponent.send()`:
  ```ts
  send(id: string, input: HTMLTextAreaElement): void {
    const value = input.value;
    if (!value.trim()) return;
    if (!this.ingestion.isAttached(id)) this.start(id);     // start() → ingestion.attach() → sends {type:"attach"}
    this.ingestion.sendInput(id, value + '\r');             // immediately sends {type:"input"}
    input.value = '';
  }
  ```
- Both messages queue in `BackendService.#outbox` and are flushed **in order** on socket open. The backend receives `attach` (begins async spawn) then `input` while the PTY may not be live yet.
- Today this is salvaged by **buffering**: `PtyManager.write()` queues into `#pendingInput` while `#attaching`, then flushes once the PTY spawns.

This is a **correctness-by-buffering** contract: the producer assumes the consumer will hold its early writes. It breaks the moment we want idempotent reconnects (re-sending `attach` to an already-running session must **not** replay buffered keystrokes), and it conflates "create the session" with "the session is ready to take input."

**How the named-session model fixes it.** With a durable named session (`ai-storm-<projectId>`), `attach` becomes **idempotent and decoupled from readiness**:

- `attach` = "ensure session `ai-storm-<projectId>` exists" (create if absent via `has-session` → `new-session -d`; otherwise no-op and reattach the response stream). It never spawns a throwaway process tied to the socket.
- `input` = "send keys to that named session." The session always exists by the time input is processed because `attach`'s create step is synchronous w.r.t. the dispatcher (`has-session`/`new-session` complete before the next message is dispatched), and even a late `input` lands in a real, running tmux session rather than a not-yet-spawned PTY.
- A backend restart or browser refresh re-issues `attach`, which **finds the existing session** and resumes — no buffered-keystroke replay, no lost process.

The historical `#pendingInput` buffer was deleted; the named session is the durable buffer.

---

## 4. Historical response-extraction proposal (not shipped)

This is the part AO does not have. The proposal would have turned the agent's interactive terminal pane into a stream of **clean response text** that fed the old `SlicingBuffer → MarkdownBlockParser → RenderScheduler` pipeline — while excluding:

- the **echoed user prompt** (the harness echoes typed input back to the pane — see the spike in §4.4),
- the **harness chrome**: input prompt glyphs (`>`, `❯`), spinners/“thinking…”, status lines, banners, box-drawing UI.

We evaluated two approaches.

### 4.1 Approach A — poll `capture-pane -p` and diff

Periodically run `tmux capture-pane -t {session} -p -S -{N}` and diff each capture against the previous one; emit only newly-appeared content.

```
tmux capture-pane -t ai-storm-{workspaceId} -p -S -2000
```

`-p` prints to stdout; `-S -N` includes N lines of scrollback. `capture-pane` returns the **rendered screen text already flattened** — tmux has applied all cursor moves, line rewrites, and (without `-e`) **dropped escape sequences**. So a spinner that repaints the same cell, or a progress bar overwriting itself, collapses to its final state rather than a flood of intermediate frames.

**Pros**

- Trivial dependency surface: just `tmux`, already required. No emulator.
- tmux is the source of truth for the rendered screen — we inherit its (correct, battle-tested) VT handling for free.
- Naturally collapses in-place rewrites (spinners, `\r` progress) into stable text — exactly the “terminal garbage” PRD §3.3 wants gone.
- Resilient across backend restarts: capture is stateless; reattaching = capture again.

**Cons**

- **Diffing is non-trivial.** The pane is a fixed-size grid; content scrolls. A naive line-by-line diff breaks when the screen scrolls (every line "changes"). Needs anchoring (track last-emitted logical line, or capture a large scrollback window `-S -<big>` and diff the tail by content, not position).
- **Polling cadence vs. latency trade-off.** Too slow = laggy cards; too fast = CPU + redundant captures. Mitigated by idle/active adaptive cadence (§4.3) and the fact that `RenderScheduler` already throttles the DOM side (PRD §5.1).
- Reflow on resize reshuffles wrapped lines; must capture at a **fixed pane width** and treat width changes as a re-anchor event (§5).

### 4.2 Approach B — `pipe-pane` into a backend headless VT emulator

Stream the pane's raw output into a backend process and maintain the screen with a headless terminal emulator (e.g. `@xterm/headless`), then read clean text out of the emulator's buffer.

```
tmux pipe-pane -t ai-storm-{workspaceId} -O 'cat >> /path/to/fifo-or-pipe'
```

`pipe-pane -O` pipes pane **output** to a command; we'd feed those raw bytes into `@xterm/headless`, which maintains rows/cols/scrollback, and scrape `buffer.active` for text.

**Pros**

- Byte-level stream → lowest latency; no polling.
- We own the emulator state, so we can hook precisely when a line is finalized.

**Cons**

- **We'd be reimplementing what tmux already did.** tmux is _already_ a terminal emulator maintaining this exact pane. Piping its raw output into a _second_ emulator is redundant emulation of an emulator.
- **New heavyweight dependency** (`@xterm/headless`) on the backend — currently the repo has **no xterm dependency at all** (verified: `package.json` has none). PRD §4.2 emphasizes a "lightweight, local-only execution environment."
- **`pipe-pane` lifecycle is fragile**: the pipe must be re-established on every reattach and after backend restarts; a dropped FIFO silently stops the stream. Capture-pane has no such long-lived side channel.
- **Still doesn't solve the hard problem.** Distinguishing response-vs-echo-vs-chrome is identical work in both approaches — B just gives you the same flattened text A gives you, at higher cost. The emulator gives byte-accuracy we don't need (we're going to strip styling anyway via the existing `ansi.ts`).
- Emulator screen size must track the (fictional) pane size; same reflow issue as A, plus an extra moving part.

### 4.3 Recommendation: **Approach A (capture-pane diff) with adaptive cadence + prompt-anchored extraction**

`capture-pane -p` already gives us flattened, spinner-collapsed, escape-stripped screen text — which is _precisely_ what the PRD §3.3 ingest engine wants — using a dependency we already require. Approach B adds a redundant emulator and a fragile long-lived pipe to arrive at the same text. **We recommend A and reject B.**

The extraction algorithm:

1. **Anchor on the harness prompt.** Most interactive harnesses (claude, aider, a bare shell, a REPL) emit a recognizable **input-prompt marker** when idle and ready for input (`>`, `❯`, `>>>`, `claude>`, etc.). We treat the transition **prompt → (user input echoed) → output → prompt** as one response cycle. The extractor:
   - records the pane position/content snapshot at the moment we **send input** (we know exactly what we sent and when — §2.3);
   - on subsequent captures, **skips the line that echoes our just-sent input** (we sent it; we can match it),
   - emits everything **after the echoed prompt line and before the next idle prompt marker** as response text,
   - treats the **reappearance of the idle prompt marker** as the completion signal.
2. **Idle detection (response complete).** Completion = "the next idle prompt marker reappeared" **OR** "the pane content has been byte-identical for `IDLE_MS` (e.g. 400–600 ms)." Idle detection also drives **cadence**: poll fast (~80–120 ms) while content is changing, back off (~500 ms–1 s) once idle. This keeps cards arriving promptly during a response and near-zero CPU between responses.
3. **Strip chrome.** Spinners/“thinking…”/box UI that tmux _didn't_ collapse (because they're distinct text, not in-place rewrites) are removed by a small, **per-harness-overridable chrome filter** (regexes for known spinner frames, prompt glyphs, status footers). Default filter handles the common cases; harness-specific profiles refine it. Whatever survives goes through the **existing** `ansi.ts` `sanitize()` for residual control bytes.
4. **Feed the existing pipeline unchanged.** The emitted response lines are exactly the "clean lines" the frontend already expects — but now produced **backend-side** and shipped as a new `response` message (§6) instead of raw `data`. `SlicingBuffer`, `MarkdownBlockParser`, `RenderScheduler`, `CanvasService.applyBlocks` are **untouched**.

> **Honest scope note (open question, §10):** prompt-marker detection is inherently harness-specific at the margins. The design is "good defaults + per-harness profile override," not "magic universal parser." Approach B would not make this easier — it produces the same ambiguous text. We log when a profile is missing rather than silently mis-attributing echo as response.

### 4.4 Spike evidence

Run against a real interactive REPL inside tmux (`python3 -i` standing in for a harness), using AO's exact send sequence (`send-keys -l` then a delayed `Enter`) and `capture-pane -p -S -50`:

```
=== capture 1 (idle, just the prompt) ===
1: Python 3.14.2 ... on linux
2: Type "help", ... for more information.
3: >>>
=== capture 2 (after sending: print("hello\n- bullet one\n- bullet two")) ===
3: >>> print("hello\n- bullet one\n- bullet two")   ← ECHOED USER INPUT (must skip)
4: hello                                             ← response
5: - bullet one                                      ← response
6: - bullet two                                      ← response
7: >>>                                               ← idle prompt reappears = COMPLETE
```

This confirms the three-way discrimination the extractor must perform — **echo (line 3) vs. response (4–6) vs. idle-prompt completion marker (line 7)** — and that `capture-pane -p` already delivers flat, escape-free text. The recommended algorithm (skip the echoed input line we just sent; emit until the idle prompt reappears) maps directly onto this output.

---

## 5. Historical `SessionBackend` interface proposal

One abstraction, two implementations. `getDefaultRuntime()`-style selection picks tmux on POSIX, node-pty on Windows.

```ts
/** Identifies a durable, connection-independent agent session. */
export interface SessionHandle {
  workspaceId: string;
  /** e.g. "ai-storm-<workspaceId>" on tmux; an internal id on Windows. */
  sessionId: string;
}

export interface SessionSpec {
  workspaceId: string;
  /** Harness binary, e.g. "claude". Harness-agnostic; never a headless flag. */
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  /** Optional harness profile name selecting prompt/chrome rules (§4.3). */
  harnessProfile?: string;
}

/** A single extracted response chunk (clean text), backend-produced. */
export interface ResponseChunk {
  workspaceId: string;
  /** Newly-finalized clean lines, ready for MarkdownBlockParser. */
  lines: string[];
  /** True once idle/prompt-return marks this response complete. */
  complete: boolean;
}

export interface SessionBackend {
  /** Idempotent: create the named session if absent, else no-op. Returns handle. */
  create(spec: SessionSpec): Promise<SessionHandle>;

  /** True if a durable session for this workspace currently exists. */
  hasSession(workspaceId: string): Promise<boolean>;

  /** Begin (or resume) extracting responses; invokes onChunk per finalized batch.
   *  Replaces raw-byte streaming — callers never see the raw terminal. */
  attach(
    workspaceId: string,
    onChunk: (chunk: ResponseChunk) => void,
    onError: (message: string) => void
  ): Promise<void>;

  /** Send a prompt to the session (Escape→clear→literal/paste→delayed Enter, §2.3). */
  sendInput(workspaceId: string, data: string): Promise<void>;

  /** Inform the session of a new viewport; re-anchors extraction width (§4 reflow). */
  resize(workspaceId: string, cols: number, rows: number): Promise<void>;

  /** Stop extracting for this workspace but LEAVE the session alive (refresh/disconnect). */
  detach(workspaceId: string): void;

  /** Terminate and clean up the session (PRD §5.2 teardown). */
  kill(workspaceId: string): Promise<void>;
}
```

### 5.1 `TmuxSessionBackend` (POSIX)

- `create`: `tmux has-session -t ai-storm-<id>`; if absent, `tmux new-session -d -s ai-storm-<id> -c <cwd> -e KEY=VAL... <withKeepAliveShell(command)>` then `set-option -t ... status off`. Long launch commands → self-deleting launch script (§2.2).
- `sendInput`: AO's `sendKeys` sequence verbatim — Escape + 100 ms; `load-buffer`/`paste-buffer -d` for long/multiline, else `send-keys -l`; separate delayed `Enter` (§2.3).
- `attach`: starts the **capture-pane diff poller** (§4.3) with adaptive cadence; on each finalized batch calls `onChunk`. Reattach after backend restart = just resume polling the still-alive session.
- `resize`: `tmux resize-window`/pane to the new size and re-anchor extraction (treat as width-change → re-capture baseline).
- `kill`: `tmux kill-session -t =ai-storm-<id>`.
- `hasSession`: `tmux has-session -t ai-storm-<id>`.

### 5.2 `NodePtySessionBackend` (Windows) — refactor of today's path

The existing `backend/src/pty/manager.ts` becomes the Windows implementation, refactored to the interface:

- `create`: spawn `node-pty` on the harness (today's behavior) but key it by `workspaceId` in a process-lifetime map. (Windows has no tmux; the "durable session" is a backend-resident PTY. True cross-restart persistence is a **Windows limitation** — documented in §10; AO uses a named-pipe relay for in-process durability, which we can adopt later.)
- `attach`: run the **same response-extraction logic** over the PTY's byte stream by feeding it through a small in-memory line accumulator + the §4.3 prompt/chrome rules. (On Windows we don't have `capture-pane`, so this is the one place where a lightweight screen model — or simply line-buffered extraction — is used. Crucially the **extraction rules are shared**; only the byte source differs.)
- `sendInput`/`resize`/`kill`/`detach`: map to `pty.write`/`pty.resize`/`pty.kill`/stop-relay.
- `hasSession`: workspace key present in the map.

This keeps the platform difference confined to _"where do the bytes come from"_ (tmux capture vs. PTY stream); the response-extraction and the protocol are identical.

---

## 6. Historical wire-protocol proposal (`@ai-storm/shared`)

Today (`packages/shared/src/protocol.ts`) the server emits raw `DataMessage`:

```ts
/** A raw, unprocessed chunk of PTY stdout (PRD §3.3 — parsed client-side). */
export interface DataMessage {
  type: "data";
  workspaceId: string;
  chunk: string;
}
```

**Change:** responses are extracted **backend-side**, so we replace raw `data` framing with a `response` message carrying clean lines. The client no longer needs `SlicingBuffer`/`ansi.ts` to clean raw bytes (those can be retired or kept as a thin pass-through), and `MarkdownBlockParser` consumes the lines directly.

Proposed additions/edits to the `ServerMessage` union:

```ts
/** Backend-extracted agent response text (replaces raw `data`). */
export interface ResponseMessage {
  type: "response";
  workspaceId: string;
  /** Clean, finalized lines ready for MarkdownBlockParser. */
  lines: string[];
  /** True when idle/prompt-return marks the response complete (frontend flushNow()). */
  complete: boolean;
}

/** Session lifecycle, decoupled from a specific PTY/connection. */
export interface SessionStatusMessage {
  type: "session-status";
  workspaceId: string;
  status: "created" | "attached" | "idle" | "responding" | "killed";
}
```

`ClientMessage` stays nearly identical, but the **semantics** of `attach` change from _"spawn a PTY now"_ to _"ensure the named session exists and start streaming its responses to me"_ (idempotent — §3.3). `AttachMessage.shell` is reinterpreted as the **harness command** (kept optional, defaults to the configured harness). `ResizeMessage` now re-anchors extraction width. `ContextMessage` (§3.2) and `AgentMessage` (§3.6) are unchanged — the §3.6 one-shot executor and its **stdin-only payload** security property are untouched.

`DataMessage` is removed (or retained, deprecated, only behind an opt-in raw-debug flag — **not** shipped to the canvas).

---

## 7. Historical frontend changes (`IngestionService` / `control-hub`)

The frontend keeps its **structural** pipeline (`MarkdownBlockParser → RenderScheduler → CanvasService.applyBlocks`) but drops the **raw-cleaning front half**, since the backend now emits clean lines:

1. **`BackendService`/`IngestionService` subscribe to `response` instead of `data`.** On `{type:"response",lines,complete}`:
   - `MarkdownBlockParser.translateAll(lines)` → filter blanks → `RenderScheduler.enqueueAll(...)` (unchanged).
   - When `complete === true`, call `scheduler.flushNow()` (today this is done on `exit`; now it's per-response).
2. **`SlicingBuffer` + `ansi.ts` move backend-side (or retire).** Their job — accumulate partial chunks, strip ANSI, handle `\r` rewrites — is now done by tmux (capture flattening) + the §4.3 extractor. The frontend no longer receives partial ANSI-laden bytes, so the client copies can be deleted. (If we keep a thin sanitize as defense-in-depth, fine — but it's no longer load-bearing.)
3. **Drop the input race workaround on the client.** `ControlHubComponent.send()` can keep calling `start()` then `sendInput()` — but now `attach` is idempotent and the session is durable, so the "buffer until spawn" assumption is gone. No client change strictly required, but the comment about ConPTY/forkpty line discipline (`value + '\r'`) stays valid: the backend `sendInput` still terminates with a real Enter (§2.3).
4. **Raw terminal scrollback view becomes optional.** Today `IngestionService` keeps `terminalLines`/`terminalPending` signals for the control-hub's raw monospace panel. Under the new model the canvas shows responses; the raw panel (if kept at all) would show only extracted response text, **not** a terminal mirror — satisfying the "no xterm.js mirror" constraint.

---

## 8. Implementation status

The staged session migration is complete, with the deliberate terminal-passthrough
change described in the banner above:

1. `SessionBackend` and `getRuntime()` live in `backend/src/session/`; both runtime
   implementations are wired through `server.ts`.
2. POSIX uses named tmux sessions with keep-alive shells, reconnect-safe attach,
   raw `pipe-pane` streaming, and boot-time `reconcile()`.
3. Windows uses an in-process node-pty session plus `TerminalScreen`; it survives
   socket loss but not a backend process restart.
4. The backend emits the established `data` terminal surface plus discrete
   `idea`, `score`, `completion`, and `reference` messages. The proposed
   `ResponseMessage`/chat extraction path was intentionally not shipped.
5. Project durability is implemented separately by `StateStore`; the browser
   loads board and history snapshots through the state protocol. See PD-024.

---

## 9. Operational details

- **tmux prerequisite/version.** Requires `tmux` on `PATH` (POSIX). Verified locally with **tmux 3.6b**; the commands used (`new-session -d`, `-c`, `-e`, `set-option status`, `capture-pane -p -S`, `send-keys -l`, `load-buffer`/`paste-buffer -d`, `has-session`, `kill-session`) are stable since tmux ≥ 2.x. Backend should `tmux -V`-probe at startup and surface a clear error if missing.
- **Session naming.** `ai-storm-<projectId>`, with `<projectId>` validated against
  `^[a-zA-Z0-9_-]+$` before any interpolation. The implementation addresses the
  validated full session name because tmux 3.6b rejects the `=` exact-match form
  for several commands; project IDs are UUID-backed and cannot be prefixes of one
  another in normal operation.
- **Persistence/reattach (PRD §3.5).** Detached tmux sessions survive backend restart, browser refresh, and socket loss. The keep-alive shell (`exec "${SHELL:-/bin/bash}" -i`) keeps the pane alive even if the agent itself exits, so the workspace can be reattached and a new agent launched without recreating the session. On boot the backend reconciles live `ai-storm-*` sessions with known workspaces.
- **Teardown / memory (PRD §5.2).** `detach` (refresh/hot-switch) stops the poller but
  **leaves tmux alive**. Explicit `kill` (close project) runs `kill-session` and drops
  all maps. The current idea scan polls at a bounded 400 ms cadence while raw bytes
  stream through `pipe-pane`; the Windows path debounces scans with `ScanGate`.
  Captures are bounded to the configured scrollback window so a long session cannot
  grow the scanner input without limit.
- **Frame throttling (PRD §5.1).** Unchanged and complementary: the backend extractor controls _how often clean lines are produced_; `RenderScheduler` (double-buffer, `maxPerFrame: 80`, rAF) still governs _how often the canvas mutates_. The two decouple network/extraction cadence from DOM cadence exactly as §5.1 requires.

---

## 10. Risks & open questions

1. **Prompt-marker detection is harness-specific.** The biggest risk. Mitigation: ship good defaults + per-harness profiles (`harnessProfile`), test against recorded fixtures, and **log** (not silently guess) when no profile matches. Neither approach A nor B removes this risk.
2. **Multiline / wrapped output + reflow.** Capture is grid-based; wide responses wrap and resize reflows them. Mitigation: capture at a fixed pane width, treat resize as a re-anchor, and prefer large `-S` scrollback windows diffed by content rather than row position.
3. **Streaming harnesses that repaint partial answers** (token-by-token with cursor moves). tmux collapses in-place repaints to final state, which is _good_ for final cards but means **mid-response token streaming is lossy** under polling. Open question: is incremental token display a product requirement, or are finalized cards enough? (PRD §3.3 implies finalized structural blocks — likely fine.)
4. **Windows persistence gap.** node-pty sessions die with the backend process; true §3.5 cross-restart durability is POSIX-only for now. Option: adopt AO's named-pipe relay (a detached helper) on Windows later. Documented as a known limitation.
5. **Echo matching edge cases.** If a harness reformats or doesn't echo input, the "skip the line we sent" heuristic needs the prompt-marker fallback. Covered by profiles + idle detection, but worth fixture coverage.
6. **Capture cadence vs. very fast output.** Between two polls a screenful could scroll past the captured window. Mitigation: size the `-S` scrollback window generously relative to expected output rate and poll faster while active.
7. **Confirm `data` removal is safe.** Verify no other consumer (diagnostics, tests) depends on raw `data` before deleting it in migration step 9.

---

## Appendix A — exact tmux commands used

| Purpose                      | Command                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------ |
| Create detached session      | `tmux new-session -d -s ai-storm-<id> -c <cwd> -e KEY=VAL... <launch>`               |
| Hide status bar              | `tmux set-option -t ai-storm-<id> status off`                                        |
| Keep-alive shell (in launch) | `exec "${SHELL:-/bin/bash}" -i`                                                      |
| Clear partial input          | `tmux send-keys -t ai-storm-<id> Escape` (+100 ms)                                   |
| Long/multiline input         | `tmux load-buffer -b <buf> <tmp>` → `tmux paste-buffer -b <buf> -t ai-storm-<id> -d` |
| Short literal input          | `tmux send-keys -t ai-storm-<id> -l <text>`                                          |
| Submit                       | `tmux send-keys -t ai-storm-<id> Enter` (after 300 ms / 1 s)                         |
| Extract clean text           | `tmux capture-pane -t ai-storm-<id> -p -S -<N>`                                      |
| Existence check              | `tmux has-session -t ai-storm-<id>`                                                  |
| Teardown                     | `tmux kill-session -t ai-storm-<id>`                                                 |
| (Rejected B) raw stream      | `tmux pipe-pane -t ai-storm-<id> -O '<sink>'`                                        |
