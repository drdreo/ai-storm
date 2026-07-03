# Security review: PTY / agent subprocess spawning (#142)

Scope: how the backend turns client `agent` messages and workspace session
specs into local subprocesses — `backend/src/agent/executor.ts` (one-shot agent
runs), `backend/src/pty/resolve.ts` (cross-platform launch resolution, shared
with the PTY session backends), and the WebSocket dispatch in
`backend/src/server.ts`. Platforms considered: Windows (ConPTY/node-pty,
`cmd.exe`/`.ps1` shims), Linux (tmux), and future macOS (POSIX path, no
platform-specific code today).

## Threat model

The server binds to loopback (`127.0.0.1`) and the `/pty` WebSocket rejects
browser connections whose `Origin` is not a loopback host, so the attacker of
interest is not a remote host but:

1. **A compromised or buggy frontend** (XSS in the canvas, a malicious
   dependency) sending crafted `agent`/`attach` messages.
2. **Untrusted content flowing through trusted plumbing** — the payload handed
   to an agent run is canvas/terminal-derived text the user did not author.
3. **Resource abuse** — a runaway or hostile harness process exhausting CPU,
   memory, or flooding the WebSocket.

Spawning a *user-configured* command is the product's purpose; the goal is
that the client can only launch the configured harness with vetted arguments
and bounded resources — never smuggle extra commands through argument parsing.

## Findings

### Already sound (verified, unchanged)

- **Payload never reaches argv.** The untrusted payload is delivered on stdin
  and the stream is closed for EOF. This avoids both CVE-2024-27980-class
  re-parsing and the ~32 KB Windows command-line limit.
- **Capabilities are named, not raw argv.** A client requests `create-issues`;
  the backend maps it to a hardcoded flag for the recognized command
  (`capabilities.ts`). Unknown requests are rejected loudly.
- **Origin gate.** Cross-site browser pages cannot open `/pty` (loopback-only
  `Origin` allowlist; non-browser clients are local by definition).
- **`.ps1` wrapping is injection-safe.** `powershell.exe -File` passes
  remaining tokens as literal arguments; PowerShell does not re-parse them.

### Fixed in this change

| # | Finding | Severity | Fix |
|---|---------|----------|-----|
| 1 | **BatBadBut-class injection via `.cmd` shim wrapping** (CVE-2024-24576 class). npm shims (`claude.cmd`) are wrapped in `cmd.exe /d /s /c`, but cmd parses its `/c` line with its own rules, not `CommandLineToArgvW` — an arg like `x&calc` survives Node's quoting and cmd runs `calc`. Client-supplied `args`/`command` reach this path. | High (local, post-XSS) | `resolve.ts` rejects any token carrying a cmd metacharacter (`& \| < > ^ % "` or line breaks) before a `.cmd`/`.bat` wrap — in **strict mode** (agent runs), see #2. Rejection, not escaping — cmd escaping is not reliably round-trippable. |
| 2 | **No control-character validation on launch tokens** (NUL, ESC, CR/LF) on any platform. | Medium | `resolveLaunch` gained a **strict mode**, used by the agent-run path only: its args are short static flags, so control chars and cmd metachars are never legitimate there. PTY session launches stay non-strict (NUL-only rejection) **by necessity**: their argv legitimately carries the multi-line `--append-system-prompt` prime (PD-020) and quoted `--mcp-config` JSON — the first strict-everywhere version of this fix broke every session launch. |
| 3 | **No resource limits on agent runs** — a hung harness lived as long as the WebSocket. | Medium | Wall-clock timeout (default 10 min) with process-**tree** kill. Hard CPU/memory caps (prlimit/Job Objects) are **deliberately not attempted** for a local single-user tool (PD-022). |
| 4 | **Unbounded output/memory** — artifact capture buffered stdout without limit; stdout/stderr streamed to the browser unbounded. | Medium | Artifact capture capped (2 MB); total stdout+stderr capped (16 MB) — exceeding it kills the run with an explanatory `stderr` emit. Oversized payloads (> 2 MB) are refused before spawn. Caps are fixed constants, not tunables (PD-022). |
| 5 | **Wrapper-only kill left orphans.** Disconnect teardown called `child.kill()`, which on Windows kills only the `cmd.exe` shim and strands the harness. | Medium | `killAgentTree`: `taskkill /t /f` on Windows; POSIX children are spawned `detached` (own process group) and the group is signalled. |
| 6 | **No concurrency ceiling** — a message burst could fork-bomb the host. | Medium | Max 4 concurrent agent runs per connection; excess requests get an `agent-status: error`. |
| 7 | **Loose `agent` message validation** — optional `args`/`cwd`/`capabilities`/`format` were not shape-checked; a non-string args entry would reach `spawn`. | Low | `parseClientMessage` now validates the optional fields (string / string-array). |

### Bounds

Exactly one bound is user-configurable: the **timeout** — the one limit a user
may legitimately need to raise (a long side-effecting hand-off can honestly
exceed 10 minutes), so it is real server configuration (`--agent-timeout-ms` on
the backend CLI, `ServerConfig`, PD-022). Everything else is a fixed
circuit-breaker constant in `executor.ts` — deliberately **not** env/CLI-tunable,
so the safeguards don't grow permanent knob/doc/test surface for a local tool.

| Bound | Value | Meaning |
|-------|-------|---------|
| `--agent-timeout-ms` (server CLI) | 600 000 | Wall-clock ceiling per run; tree-killed on expiry |
| `MAX_PAYLOAD_BYTES` (const) | 2 MiB | Max stdin payload accepted; larger runs refused pre-spawn |
| `MAX_CAPTURE_BYTES` (const) | 2 MiB | Max stdout retained for artifact parsing |
| `MAX_OUTPUT_BYTES` (const) | 16 MiB | Max streamed stdout+stderr before the run is killed |

**Byte caps are approximate by design (PD-022).** Accounting is per chunk in
UTF-16 code units (multi-byte output undercounts real bytes), the chunk that
crosses a cap is still streamed, and a few already-buffered chunks can arrive
between the kill signal and process death; every overshoot is bounded by
pipe-buffer size. ai-storm is local-first and never hosted (PD-003), so the
caps' job is "a runaway harness cannot take the machine down" — byte-exact
UTF-8 accounting, truncating the crossing chunk, per-connection-plus-global cap
matrices, and hard CPU/memory caps (prlimit/Job Objects) are all deliberately
declined as hosted-grade over-engineering.

### Deferred / accepted risk

- **Hard memory/CPU caps.** Doing this properly needs Linux cgroups/`prlimit`,
  Windows Job Objects, or macOS `posix_spawnattr` — none uniformly reachable
  from Node without native modules, and for a local single-user tool the payoff
  is not worth the platform-specific surface (PD-022). The wall-clock timeout +
  tree kill is the enforced bound on every platform. (An earlier revision wired
  `prlimit --cpu`/`--as` on Linux only; it was removed as local-first overkill.)
- **PTY sessions are intentionally not resource-limited.** They are the
  user's interactive terminal; killing them on a timer would be wrong. They
  inherit the injection fixes (shared `resolveLaunch`).
- **`cwd` is client-chosen.** Spawning in an arbitrary directory is the
  workspace feature itself; a nonexistent path fails the spawn and is
  reported. No traversal risk beyond what the local user already has.

## Reconnecting to spawned sessions after navigate/reload (investigated)

Two different lifetimes exist today:

- **PTY sessions already survive reloads.** A WebSocket close *detaches* the
  stream but leaves the session alive (tmux detached session on POSIX;
  in-process node-pty on Windows within the backend's lifetime, design §10.4).
  Reattaching resumes it. No change needed.
- **One-shot agent runs do not.** They are keyed to the *connection*
  (`agents` set in `server.ts`) and are deliberately torn down on disconnect —
  otherwise a reload would leak side-effecting runs (e.g. `gh issue create`)
  with nobody watching the confirmation stream.

Making agent runs survive a reload would need: a workspace-keyed run registry
decoupled from the connection, a bounded output ring buffer for replay on
reattach (the `MAX_OUTPUT_BYTES` cap makes this feasible),
an ownership rule for multiple tabs, and an orphan-reaping timeout for runs
whose client never returns. That is a feature with UX decisions (does a reload
*resume* the stream or summarize it?), not a hardening fix — recommended as a
follow-up issue rather than part of #142.
