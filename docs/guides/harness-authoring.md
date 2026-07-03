# Guide: authoring a new agent harness profile

**Audience:** anyone wiring a new AI CLI (harness) into ai-storm — i.e. adding
support beyond the shipped `claude`, `pi`, and `codex` profiles.
**Related design docs:** [`ai-response-extraction-contract.md`](../design/ai-response-extraction-contract.md)
(the `«IDEA»` marker grammar) · [`mcp-idea-capture.md`](../design/mcp-idea-capture.md)
(the MCP tool channel) · [`ai-session-layer.md`](../design/ai-session-layer.md) (how a
harness is launched and captured).

---

## 1. What a "harness" is here

A harness is any interactive CLI ai-storm launches inside a PTY (tmux on POSIX,
node-pty on Windows) as the thing the user brainstorms with — `claude`, `pi`,
`codex`, or a bare `bash`/`python` shell. The terminal is the **presentation**
surface: raw bytes stream straight to the browser and render in xterm.js, so
ai-storm never parses the conversation itself. What it *does* need from a
harness-specific **profile** is:

1. how to prime the harness with the idea contract at launch, and
2. how ideas get from the model back to ai-storm — either as `«IDEA»` marker
   lines rendered in the pane (parsed by `IdeaScanner`), or as MCP tool calls
   (`capture_idea` / `capture_score`), or both.

Everything a profile needs lives in one object: `HarnessProfile`
(`backend/src/session/extraction.ts`). There is no other integration point —
you do not touch `tmux-backend.ts`, `nodepty-backend.ts`, or `server.ts` to add
a harness; they already consume profiles generically.

## 2. The `HarnessProfile` contract

```ts
export interface HarnessProfile {
  name: string;
  /** Does this harness understand the idea contract (→ prime it)? */
  supportsIdeaContract: boolean;
  /** CLI flag used to inject the priming text as a system/developer prompt. */
  systemPromptFlag?: string;
  /** Transform the prime text into the value paired with `systemPromptFlag`. */
  systemPromptValue?: (prime: string) => string;
  /** Default CLI flags for this harness unless the caller already supplied them. */
  defaultArgs?: string[];
  /** CLI flag this harness uses to select a model, paired with `defaultModel`. */
  modelFlag?: string;
  /** Model passed via `modelFlag` at launch when the caller supplies none. */
  defaultModel?: string;
  /** One-off Codex/pi-style config overrides appended unless the caller supplies the key. */
  defaultConfig?: Record<string, string>;
  /** Build the CLI args that wire this harness to the backend MCP server. */
  mcpArgs?: (ctx: McpLaunchContext) => string[];
}
```

A profile is pure data plus one optional function (`mcpArgs`). `getProfile`
resolves a profile by name, falling back to `DEFAULT_PROFILE` (contract
support off) and **logging** on an unknown name — never silently guessing
(`extraction.ts:217-225`). `commandProfileName(command)` maps the launched
command's basename (`/usr/local/bin/claude` → `"claude"`) to a profile name; a
harness that isn't recognised there falls back to `DEFAULT_PROFILE` too.

`launchArgsForProfile(profile, baseArgs, prime, mcp)` turns a profile + prime
text + optional MCP context into the final argv, and is the single place both
the tmux and node-pty launch paths call — so a new profile automatically works
on both backends. It is **idempotent against caller-supplied flags**: if
`baseArgs` already contains `--model`, `-c model_x=...`, or `--mcp-config`, the
profile's defaults for that flag are skipped.

## 3. The two capture channels — pick one, or both

### 3.1 Marker contract (works for any harness that can print text)

The agent is primed to emit ideas as a single, regex-anchored line:

```
«IDEA» <title> :: <one-line body>
«IDEA:risk» Token rotation may break long-lived sessions :: rotate on attach, grace-window old token
«IDEA» Offline-first canvas
```

or, for genuinely multi-line bodies, a fenced block:

````
```idea kind=decision
title: Adopt event-sourced canvas history
body: Persist every CRDT op as an append-only log.
Enables time-travel scrub and per-idea provenance.
```
````

`IdeaScanner.scan(capture)` (`extraction.ts`) re-scans the rendered pane on
every poll/chunk and emits each **newly-seen** idea, deduped session-wide by
`ideaIdentityKey` (title + kind + links — the body is excluded so a resize
that re-wraps it can't resurface the idea as "new"). There's also a triage
marker, `«SCORE@ref» <impact>/<effort>[/<confidence>]`, scanned by
`ScoreScanner`. Full grammar and rationale: extraction-contract §3.

This channel needs **nothing from your profile** except `supportsIdeaContract:
true` plus a way to prime the text (`systemPromptFlag`/`systemPromptValue`,
below) — the scanner itself is harness-agnostic.

### 3.2 MCP tool channel (primary, when the harness supports it)

If the harness can be launched with an MCP server config, prefer this: the
agent calls `capture_idea` / `capture_score` as schema-validated JSON-RPC tool
calls against the backend's own `/mcp/:workspaceId/:token` endpoint
(`backend/src/mcp/endpoint.ts`, `registry.ts`). This sidesteps every
terminal-rendering failure mode the marker channel has (mid-repaint captures,
resize-dependent rejoin, fence-eating TUIs) because there is no screen to
parse — see mcp-idea-capture.md §1 for the full failure catalogue.

Wire it via `mcpArgs`, which receives `{ url, serverName }` and returns the
extra argv:

```ts
mcpArgs: ({ url, serverName }) => [
  "--mcp-config",
  JSON.stringify({ mcpServers: { [serverName]: { type: "http", url } } }),
  "--allowedTools",
  `mcp__${serverName}__capture_idea,mcp__${serverName}__capture_score`,
],
```

If a profile declares `mcpArgs`, ai-storm sends the **MCP-flavoured** prime
(teach the tools) instead of the marker grammar — one mechanism per session,
never both taught at once. The marker scanner keeps running underneath as a
silent fallback regardless (a lapsed tool call, or a harness with no MCP
support, still gets picked up as a marker line if the agent emits one).

**Don't add `mcpArgs` speculatively.** Wire it only once you've verified the
harness's actual MCP config surface against a pinned version — CLI MCP config
keys have historically churned (see §11.2 of mcp-idea-capture.md, and why the
shipped `codex`/`pi` profiles omit `mcpArgs` and stay marker-only). An
unverified guess produces silent failures (no `initialize` ever arrives) or a
worse UX (a permission prompt because `--allowedTools` doesn't match the
actual tool id `mcp__<serverName>__<tool>`).

## 4. Worked examples

### 4.1 Claude Code — full contract (system prompt + MCP)

```ts
export const CLAUDE_PROFILE: HarnessProfile = {
  name: "claude",
  supportsIdeaContract: true,
  systemPromptFlag: "--append-system-prompt",
  modelFlag: "--model",
  defaultModel: "haiku", // fast/cheap for a scanning-only session; user can override with --model
  mcpArgs: ({ url, serverName }) => [
    "--mcp-config",
    JSON.stringify({ mcpServers: { [serverName]: { type: "http", url } } }),
    "--allowedTools",
    `mcp__${serverName}__capture_idea,mcp__${serverName}__capture_score`,
  ],
};
```

`systemPromptValue` is omitted, so `launchArgsForProfile` pairs
`--append-system-prompt` with the raw prime text verbatim.

### 4.2 pi — mirrors Claude's flags, marker-only for now

```ts
export const PI_PROFILE: HarnessProfile = {
  name: "pi",
  supportsIdeaContract: true,
  systemPromptFlag: "--append-system-prompt",
  modelFlag: "--model",
  // No defaultModel: pi is multi-provider with its own user/project default —
  // forcing "haiku" here would break users on OpenAI/Copilot/Gemini backends.
};
```

pi intentionally exposes the same prompt/model flags as Claude Code, so it
reuses the identical seam. It has **no `mcpArgs`** — whether pi mirrors
`--mcp-config` is unverified, so it stays on the marker fallback until checked.

### 4.3 Codex — a different launch seam entirely

```ts
export const CODEX_PROFILE: HarnessProfile = {
  name: "codex",
  supportsIdeaContract: true,
  systemPromptFlag: "-c",
  systemPromptValue: (prime) => `developer_instructions=${JSON.stringify(prime)}`,
  defaultArgs: ["--no-alt-screen"],
  modelFlag: "--model",
  defaultModel: "gpt-5.3-codex-spark",
  defaultConfig: { model_reasoning_effort: JSON.stringify("medium") },
};
```

Codex has no `--append-system-prompt` equivalent, so priming rides its `-c
key=value` config-override flag instead — `systemPromptValue` does the
key-wrapping. `--no-alt-screen` is load-bearing: without it Codex renders on
the terminal's alternate screen, which `tmux capture-pane` cannot see, so
marker lines would never reach the scanner. Codex also has no `mcpArgs` yet
(its HTTP MCP transport and config keys are the newer, less-verified surface —
see mcp-idea-capture.md §4.3).

### 4.4 Registering a profile

Add it to the `PROFILES` map and, if the CLI's binary name differs from the
profile name, to `commandProfileName`:

```ts
const PROFILES: Record<string, HarnessProfile> = {
  default: DEFAULT_PROFILE,
  claude: CLAUDE_PROFILE,
  pi: PI_PROFILE,
  codex: CODEX_PROFILE,
  // + your new profile
};

export function commandProfileName(command: string): string | undefined {
  // ...
  if (normalized === "your-cli") return "your-cli";
  return undefined;
}
```

A harness with no AI behaviour at all (a bare shell) just needs
`{ ...DEFAULT_PROFILE, name: "..." }` — no priming, no scanning, no MCP, as
`bash`/`python` already do.

## 5. Testing a new profile

All of this is pure/runtime-free and unit-tested against **recorded fixtures**
in `backend/src/session/extraction.test.ts` — no real harness or PTY needed.
Follow the existing pattern in `backend/src/session/fixtures/<profile>/`:

- `marked-ideas.txt` — a realistic capture with the agent correctly emitting
  `«IDEA»` lines (plain, typed, and — for claude — a fenced multi-line body).
  Assert `scanIdeas(...)` produces the exact expected `Idea[]`.
- `heuristic-bullets.txt` — a capture where the agent ignored the contract and
  answered with plain markdown bullets instead. Assert **no** ideas are
  produced (there is no heuristic promotion any more — bullets stay chat) and,
  if you wire diagnostics, that a near-miss/no-marker path is observable.

Minimum coverage for a new profile, mirroring what `claude`/`pi`/`codex`
already have (`extraction.test.ts`):

1. **Profile resolution.** `getProfile("your-cli")` returns your profile;
   `supportsIdeaContract` is what you intended.
2. **Launch args.** `launchArgsForProfile(YOUR_PROFILE, baseArgs, prime, mcp)`
   produces the exact expected argv, and is a no-op addition when `baseArgs`
   already supplies the flag your profile would default (idempotency).
3. **Marker fixtures.** Feed `fixture("your-cli", "marked-ideas.txt")` through
   `scanIdeas` (or `IdeaScanner.scan`) and assert the resulting `Idea[]`
   deep-equals what you expect — this is where you prove the harness's actual
   rendering (turn bullets, margins, box-drawing) doesn't break the shared
   marker grammar. If the harness renders a distinctive turn-leading glyph
   (Claude's `●`, Codex's `•`), confirm it's covered by `TURN_BULLET` or add to
   it.
4. **Heuristic/no-contract fixture.** A capture with no markers → zero ideas,
   proving you haven't accidentally reintroduced prose-to-idea promotion.
5. **If you added `mcpArgs`:** the marker-parity test from
   mcp-idea-capture.md §9.2 — every row of its mapping table should produce an
   `Idea` deep-equal between the marker path (`scanIdeas`) and the tool path
   (`parseCaptureIdea` / `parseCaptureScore` in `backend/src/mcp/endpoint.ts`),
   plus a launch-args test proving `--mcp-config`/`--allowedTools` (or your
   harness's equivalent) appears exactly once and is idempotent.
6. **Live smoke (manual, once per pinned harness version).** Launch the real
   CLI through ai-storm, brainstorm one turn, confirm ideas land as cards with
   no stray marker text leaking into the visible terminal reply, and — if MCP
   is wired — confirm no permission prompt interrupts the session and no
   marker line appears in the transcript at all.

Run the suite with:

```sh
pnpm --filter backend test extraction
```

## 6. Checklist

- [ ] `HarnessProfile` added to `extraction.ts`, registered in `PROFILES`
- [ ] `commandProfileName` maps the CLI's binary basename to the profile
- [ ] Priming seam chosen and wired (`systemPromptFlag` [+ `systemPromptValue`
      if the flag isn't a bare "append this text"])
- [ ] `defaultArgs`/`modelFlag`/`defaultConfig` set only if the harness needs
      them to run non-interactively/deterministically in a brainstorm session
- [ ] Decided marker-only vs. marker+MCP; if MCP, verified against a pinned
      CLI version before shipping `mcpArgs`
- [ ] Fixtures added under `backend/src/session/fixtures/<profile>/`
      (`marked-ideas.txt`, `heuristic-bullets.txt`, plus a fenced-idea fixture
      if the harness's TUI preserves code fences)
- [ ] Tests added in `extraction.test.ts` per §5 above
- [ ] Manual live smoke run once against the real CLI
