# Security review: PTY / agent subprocess spawning (#142)

Scope: how the backend turns client `agent` messages and session specs into
local subprocesses — `agent/executor.ts`, `pty/resolve.ts` (shared with the PTY
backends), `server.ts` dispatch.

## Threat model

The server binds loopback and the `/pty` WebSocket rejects non-loopback
`Origin`s, so the attacker is not remote but a **compromised/buggy frontend**
(XSS, bad dependency) sending crafted messages, and **untrusted payload text**
(canvas/terminal-derived, not user-authored) flowing to a run. Spawning a
user-configured command is the product; the goal is that the client can only
launch the _configured_ harness with _vetted_ args and bounded resources —
never smuggle extra commands through argument parsing. Sizing is local-first,
not hosted (see [PD-022](../decisions/product-decisions.md)).

## Already sound (verified, unchanged)

- **Payload never reaches argv** — delivered on stdin (avoids CVE-2024-27980
  re-parsing and the ~32 KB Windows command-line limit).
- **Capabilities are named, not raw argv** — client requests `create-issues`;
  backend maps it to a hardcoded flag (`capabilities.ts`), unknown rejected.
- **Origin gate** — cross-site pages cannot open `/pty`.
- **`.ps1` wrapping is injection-safe** — `powershell.exe -File` passes tokens
  literally.

## Fixed

| #   | Finding                                                                                                                                  | Sev  | Fix                                                                                                                                                                                         |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **BatBadBut `.cmd` injection** (CVE-2024-24576 class): cmd re-parses its `/c` line, so `x&calc` survives Node's quoting and runs `calc`. | High | Reject cmd metachars (`& \| < > ^ % "`, line breaks) before a `.cmd`/`.bat` wrap — strict mode only. Reject, don't escape (cmd escaping isn't round-trippable).                             |
| 2   | **No control-char validation** on launch tokens.                                                                                         | Med  | `resolveLaunch` strict mode (agent runs only) rejects control chars. Sessions stay NUL-only — their argv legitimately carries the multi-line prime (PD-020) and quoted `--mcp-config` JSON. |
| 3   | **No timeout** — a hung harness lived as long as the WebSocket.                                                                          | Med  | Wall-clock timeout (default 10 min, `--agent-timeout-ms`) with process-**tree** kill.                                                                                                       |
| 4   | **Unbounded output** — capture buffer and stream were uncapped.                                                                          | Med  | Fixed constants: capture 2 MB, stdout+stderr 16 MB (kills the run), payload 2 MB (refused pre-spawn). Approximate circuit breakers, not quotas (PD-022).                                    |
| 5   | **Wrapper-only kill left orphans** — `child.kill()` killed only the Windows `cmd.exe` shim.                                              | Med  | `killAgentTree`: `taskkill /t /f`; POSIX runs spawn `detached` and the group is signalled.                                                                                                  |
| 6   | **No concurrency ceiling** — a burst could fork-bomb the host.                                                                           | Med  | Max 4 concurrent runs per connection.                                                                                                                                                       |
| 7   | **Loose `agent` validation** — optional fields weren't shape-checked.                                                                    | Low  | `parseClientMessage` validates `args`/`cwd`/`capabilities`/`format`.                                                                                                                        |

## Accepted risk (local-first, PD-022)

- **No hard CPU/memory caps.** Needs cgroups/`prlimit`/Job Objects — not worth
  the per-platform surface for a single-user tool. Timeout + tree kill is the
  bound everywhere. (An earlier revision wired Linux `prlimit`; removed.)
- **PTY sessions aren't resource-limited** — they're the user's interactive
  terminal. They inherit the injection fixes via shared `resolveLaunch`.
- **`cwd` is client-chosen** — that's the workspace feature; no traversal risk
  beyond the local user's own.
- **Agent runs are connection-scoped** — torn down on disconnect so a reload
  can't leak side-effecting runs. Surviving reload is a deferred feature (needs
  a workspace-keyed registry + replay buffer), not a hardening fix.
