# Plan: terminal passthrough + idea scan (drop server-side chat extraction)

## Why

Today the backend renders claude's TUI and runs `ResponseExtractor` to split the
pane into **chat** (bubbles) and **ideas** (canvas). The chat/display half is the
fragile part: it needs per-version chrome regexes (status bar, spinner glyphs,
box drawing), echo-anchoring on the typed input, the `● ` reply marker, and
response-completion detection (the `✻ … for Ns` done-line + the idle timeout that
kept firing mid-turn and completing empty). All of that exists only to turn a
cursor-addressed terminal into clean chat bubbles.

AO's model avoids it entirely: stream raw PTY bytes to the browser and let
**xterm.js** render the real terminal. We adopt the same for the conversation
surface and keep only the **idea-marker scan** — the robust 20% (the `«IDEA»` /
` ```idea ` contract is one we define via priming, so it's unambiguous and
machine-readable).

**Net effect:** delete chrome/anchor/completion logic and the per-claude-version
tuning; the display becomes always-correct (xterm's job); ideas emit per-marker
as their line/fence completes — so the whole "is the response done?" problem
disappears.

**Tradeoff (product, not engineering):** the chat hub becomes a real terminal
instead of polished bubbles. For an agentic harness (tool calls, todos,
clarifying questions, diffs) the terminal is more honest and useful — and the
"AI asked a question, nothing showed" confusion goes away because the question is
visible in the terminal.

## Target architecture

Two independent streams per workspace over the existing `/pty` WebSocket:

1. **`data`** — raw PTY bytes → frontend xterm.js (display). Frontend xterm
   `onData` → `input`; fit-addon resize → `resize` (both already exist).
2. **`idea`** — extracted canvas ideas, emitted one at a time as their marker
   line/fence completes.

The backend stays the source of ideas (reuse `TerminalScreen` + the contract
parser — already tested) so the frontend stays thin and the contract lives in one
place.

```
PTY bytes ─┬─► ws "data" ─────────────► xterm.js terminal (conversation)
           └─► TerminalScreen.render ─► IdeaScanner (markers only) ─► ws "idea" ─► canvas
```

## Backend changes

### `shared` (`@ai-storm/shared`) — protocol
- [ ] Add `ServerMessage` variant `{ type: "data"; workspaceId; data: string }`
      (raw bytes; send as UTF-8 string or base64 — pick base64 to be safe with
      control bytes).
- [ ] Add `{ type: "idea"; workspaceId; idea: Idea }` (single idea per message).
- [ ] Remove the `{ type: "response"; chat; ideas; complete }` variant (or keep
      temporarily behind a flag during migration).
- [ ] Client→server messages (`attach`/`input`/`resize`/`detach`/`kill`/`context`)
      are unchanged.

### `session/extraction.ts` — strip to an idea scanner
- [ ] Keep: `IDEA_MARKER`, `IDEA_FENCE_*`, `FENCE_KEY`, `ideaFromLine`,
      `ideaFromFence`, `parseContract` (marker half), `MARKER_NEAR_MISS`
      diagnostic, idea dedupe, priming-related profile bits
      (`supportsIdeaContract`, `readyMarker`).
- [ ] Delete: chrome regex arrays, `promptMarkers`/`promptPrefix`,
      `responseMarker`/`responsePrefix`, `completionMarker`, `#responseStart`,
      `#echoEnd`, `#matchesEcho`, `#isPrompt`/`#isChrome`, `#trailingPrompt`,
      `reanchor`, the heuristic floor (`#classifyProse`) unless we still want
      prose→idea fallback (decide below).
- [ ] New `IdeaScanner`: feed it the current rendered capture; it scans **all**
      lines (no region slicing) for `«IDEA»` / ` ```idea ` and returns
      newly-seen ideas. Dedupe by `(title, body, kind)` across the **whole
      session** (not per-response — there are no response boundaries now).
- [ ] No completion concept. No `responding` state. No idle/`finalize`.

### `session/nodepty-backend.ts` (Windows)
- [ ] On `term.onData(chunk)`: send raw `data` to the client AND
      `screen.write(chunk)`.
- [ ] After write, scan the screen for ideas. **Scan scrollback + viewport**
      (full `buffer.active`, not just the visible rows) so an `«IDEA»` line that
      scrolled off between snapshots is still caught before xterm trims it; dedupe
      makes re-scans idempotent. (This is a small change to `TerminalScreen` —
      add a `snapshotAll()` alongside the viewport `snapshot()`.)
- [ ] Remove `#armIdleTimer`, `IDLE_COMPLETE_MS`, the `response.capture` log, and
      the priming-via-readyMarker stays (still needed to prime claude).
- [ ] `detach`/`kill` unchanged.

### `session/tmux-backend.ts` (POSIX) — the one real unknown
- [ ] Raw stream: tmux currently `capture-pane`s rendered text on a poll; there
      is no raw byte stream. To feed xterm.js we need raw output. Options:
      - **`tmux pipe-pane -o 'cat >>/path/fifo'`** (or pipe to a process) to tee
        the pane's raw output — AO-style. Stream that to the client as `data`.
      - Or keep POSIX on the **poll + `capture-pane`** model for *display too*
        (send capture snapshots as text) — simpler but not a true terminal.
      - Decision needed; `pipe-pane` is the faithful option.
- [ ] Ideas on POSIX: `capture-pane` already returns rendered text, so the
      `IdeaScanner` runs on that exactly as today — no terminal emulator needed
      server-side on POSIX.
- [ ] `types.ts` `SessionBackend.attach` callback changes from `ResponseChunk`
      to `(raw: string)` + `(idea: Idea)` (or a small union). Update both
      backends to the new shape.

### `server.ts`
- [ ] In `attach`, wire the backend's raw callback → `send({type:"data"})` and
      idea callback → `send({type:"idea"})`.
- [ ] Drop the `response` send + its `log.info("response", …)`; keep
      `idea.extracted` info log.

## Frontend changes (Angular)
- [ ] Add `@xterm/xterm` + `@xterm/addon-fit` (+ optionally `addon-webgl`).
- [ ] A `TerminalComponent` per workspace: create `Terminal`, `term.open(el)`,
      `fit()`; on ws `data` → `term.write(bytes)`; `term.onData` → ws `input`;
      `ResizeObserver`/fit → ws `resize` (cols/rows). This is the AO terminal
      wiring.
- [ ] Canvas subscribes to ws `idea` events and drops cards (existing canvas
      ingestion path — just change the source from `response.ideas` to `idea`).
- [ ] Remove the custom chat-bubble UI and the client-side handling of
      `response` chat lines.

## Cleanup (after the above lands)
- [ ] Delete `session/line-buffer.ts` + `ansi.ts` (+ their tests) — already
      unused since the xterm-headless switch.
- [ ] Trim `extraction.test.ts` to the marker-parsing + dedupe cases; delete the
      chrome/anchor/completion tests.
- [ ] Update `docs/design/ai-response-extraction-contract.md` and
      `ai-session-layer.md` to describe passthrough + idea scan (the chat/chrome
      sections are obsolete).

## Open decisions
1. **POSIX raw stream**: `tmux pipe-pane` (faithful terminal) vs keep
   `capture-pane` snapshots for display. → pick `pipe-pane`.
2. **Idea source on Windows**: backend `TerminalScreen` scan (recommended,
   reuses tested code) vs scan the client xterm buffer (backend becomes a pure
   pipe; would move the marker parser into `shared`). → backend scan first; revisit.
3. **Heuristic prose→idea floor**: keep it (promote bullet lists when no markers)
   or drop it and rely solely on explicit `«IDEA»`? Dropping is simpler and more
   predictable. → drop, rely on priming.
4. **`data` encoding**: base64 (safe for all bytes) vs UTF-8 string. → base64.

## Risks
- **Idea miss on fast scroll**: many `«IDEA»` lines dumped between snapshots could
  scroll past the viewport — mitigated by scanning scrollback (`snapshotAll`) +
  session-scoped dedupe.
- **Duplicate ideas**: the rendered snapshot re-shows the same `«IDEA»` line every
  frame until it scrolls off — session-scoped dedupe by content is mandatory.
- **POSIX `pipe-pane`** is the largest piece of new work; everything else is
  deletion + rewiring.
- **Product**: confirm a terminal conversation surface is acceptable before
  ripping out the chat UI (this is the point of no return).

## Suggested order
1. Shared protocol (`data` + `idea`), keep `response` temporarily.
2. Windows backend: emit `data` + idea scan; frontend xterm terminal alongside
   the existing chat (parallel, behind a toggle) to validate.
3. POSIX `pipe-pane` raw stream.
4. Switch canvas to `idea` events; remove chat UI + `response`.
5. Strip `ResponseExtractor`; delete dead files + tests; update design docs.
