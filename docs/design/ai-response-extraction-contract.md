# Design: backend AI response extraction contract (chat vs canvas ideas)

**Status:** ⚠️ SUPERSEDED (the chat/chrome half) — see the banner below.
**Author:** ai-storm backend
**Related:** [Product decisions](../decisions/product-decisions.md) §3.1, §3.2, §3.3, §3.5, §5.1 (the PRD now lives there) · builds directly on [`docs/design/ai-session-layer.md`](./ai-session-layer.md)

---

> ## ⚠️ Superseded: terminal passthrough + idea scan
>
> The **chat/display half** described below — server-side chat extraction, the
> per-claude-version chrome regexes, echo anchoring, the `● ` reply marker, and
> response-completion detection — has been **removed**. The conversation surface
> is now a **real terminal**: the backend streams raw PTY bytes (a `data`
> message, base64-encoded) and the browser renders them with **xterm.js**. This
> deleted the fragile, version-tuned chrome/anchor/completion logic outright.
>
> What remains — and what the rest of this document still accurately describes —
> is the **robust idea scan**: the `«IDEA»` / ` ```idea ` contract (§3, §4
> priming, Appendix B) is unchanged. The backend renders the pane (tmux
> `capture-pane` on POSIX, a headless `TerminalScreen` on Windows), scans **all**
> lines for markers via `IdeaScanner` (`backend/src/session/extraction.ts`), and
> emits each newly-seen idea as a single `idea` message, deduped by
> `(title, body, kind)` across the whole session. There is no longer a
> `response` message, a `chat` array, a completion flag, or the prose→idea
> heuristic floor.
>
> **Current touches:** `backend/src/session/extraction.ts` (now `IdeaScanner`),
> `screen.ts` (`snapshotAll`), `tmux-backend.ts` (`pipe-pane` raw stream +
> capture-pane idea poll), `nodepty-backend.ts`, `types.ts`, `server.ts`,
> `packages/shared/src/protocol.ts` (`data` + `idea`), the frontend
> `TerminalComponent`, `ingestion.service.ts`, and `control-hub.component.ts`.
> Sections below referring to `chat`, chrome stripping, `ResponseExtractor`,
> `responseMarker`/`completionMarker`, or `line-buffer.ts` are historical.

---

## 1. Problem statement

The tmux AI session layer (ai-session-layer.md, shipped in PR #6) works: an interactive harness
(`claude`) runs in a durable, named tmux session; `TmuxSessionBackend` polls `capture-pane -p`, diffs
captures, and ships clean lines to the client as a `response` message. The client turns those lines
into canvas blocks via `MarkdownBlockParser → RenderScheduler → CanvasService.applyBlocks`.

The byte-level cleaning is correct. The **semantic** layer is not. `capture-pane` faithfully flattens
the **whole claude TUI** — including chrome that is not the agent talking. Real samples the product
owner observed landing on the canvas as "ideas":

```
Opus 4.8 (1M context) |  main | ~/Work/projects/ai-storm/backend | ctx:29.0k/1000k (3%) | 5h:33%
* Catapulting…
✽ Forging… (5s · ↓ 227 tokens)
✶ Metamorphosing…
✻ Worked for 3s
⏵⏵ auto mode on (shift+tab to cycle) · ← for agents
⎿  Tip: Run claude --continue or claude --resume to resume a conversation
  Let me know which, or just tell me the task.
```

The last line is real chat. Everything above it is TUI chrome. The current extractor
(`ResponseExtractor` in `extraction.ts`) strips bare prompt glyphs, braille spinners, and box borders,
but its `DEFAULT_PROFILE` deliberately **does not** strip `*`/`✽`/`✶`/`✻` spinner frames (it avoids `*`
to protect markdown bullets — `extraction.ts:64-66`), and it has no rule for claude's status bar,
auto-mode affordance, or `⎿ Tip:` gutter. So that chrome flows through as `response` lines, and
`MarkdownBlockParser` dutifully turns `* Catapulting…` into a canvas bullet.

The deeper issue: **the extractor cleans bytes but cannot tell "idea worth a card" from "UI noise" or
even from "ordinary conversational reply."** `MarkdownBlockParser` *guesses* structure from markdown
shape, which conflates three different things the product wants kept apart:

1. the AI's **conversational reply** ("Let me know which…") — belongs in the **chat hub**;
2. genuine **brainstorming ideas / ideation notes** — belong on the **canvas** as cards/notes;
3. **TUI chrome** — belongs nowhere.

## 2. Goal & chosen approach

Introduce a proper **extraction contract**, parsed **backend-side**, so the client only ever renders:

- **(a)** the AI's conversational responses in the chat hub, and
- **(b)** extracted brainstorming ideas as cards/notes on the canvas.

The client **stops guessing structure**. It receives a pre-split message and renders each half
verbatim.

The approach is **already decided** (this doc designs it, it does not re-litigate it):

> **Prime the agent + heuristic floor.**
> 1. **Prime the session** with a harness-agnostic first message that defines a machine-parseable,
>    reflow-resilient, **single-line** idea marker. Everything not marked is chat.
> 2. **Heuristic floor**: a claude **harness profile** that (stage 1) strips TUI chrome with concrete
>    regexes and (stage 2) classifies the remaining prose-vs-structure as a fallback when no markers
>    are present — logging when it falls back, never silently mis-attributing.

Two layers, defence in depth: when the agent honours the contract (the common case) we get exact,
unambiguous ideas; when it doesn't (a model lapse, a non-claude harness, a TUI version we don't have a
profile for), the heuristic floor degrades gracefully and is **observable** in the logs.

---

## 3. Contract format spec

### 3.1 Design constraints

The marker is read out of `tmux capture-pane -p` output, which is **a fixed-width grid that tmux has
already wrapped at the pane width**. Any marker must therefore be:

- **Single-line / line-leading.** A logical idea is one line; reflow may wrap it across several screen
  rows, but the marker sits at the start of the *first* row. Multi-line JSON would be shredded by
  wrapping — there is no robust way to know a `{` on row 5 closes a `}` on row 9 after reflow.
- **Rare in prose & code.** Low collision with anything the agent might legitimately say.
- **Trivially regex-anchored** at line start so detection is O(1) per line.
- **ASCII-degradable** in case a terminal/locale mangles UTF-8.

### 3.2 Surface forms

Two forms parse to the same `Idea`. The single-line form is the contract's spine; the fenced form
exists **only** for genuinely multi-line bodies.

**Form 1 — single line (preferred, ~95% of ideas):**

```
«IDEA» <title> :: <one-line body>
«IDEA:risk» Token rotation may break long-lived sessions :: rotate on attach, grace-window old token
«IDEA» Offline-first canvas
```

Grammar (EBNF-ish):

```
idea-line   = ws* , marker , ws* , title , [ ws* , "::" , ws* , body ] , ws* ;
marker      = ( "«IDEA" , tag , "»" ) | ( "<<IDEA" , tag , ">>" ) ;
tag         = [ ":" , kind ] , { "@" , ref , [ "!" ] } ;   (* kind optional; zero or more refs, kind first *)
kind        = lower-alpha , { word-char | "-" } ;          (* e.g. risk, feature, question, todo *)
ref         = word-char , { word-char | "-" } ;            (* short ref of the linked card, e.g. a1 *)
                                                           (* a trailing "!" makes that link 'supersedes' (PD-012) *)
                                                           (* a CHAIN of refs (@a1!@a2!) = one idea superseding
                                                              several sources — the combine/merge verb (PD-019) *)
title       = printable - ( "::" ) ;                        (* required, non-empty after trim *)
body        = printable ;                                   (* optional; "" if "::" omitted *)
```

> **Idea-graph link (`@ref`, idea-graph design §5.1).** The in-marker tag is
> `[:kind][@ref[!]]`. An optional `@ref` after the kind links this idea to the card
> with that short ref (idea-graph §4): `«IDEA:risk@a1» Token leak :: …` parses to
> `{kind:"risk", links:[{to:"a1", relation:"about"}]}`. A **trailing `!`** makes
> that link a `supersedes` instead of `about` (PD-012): `«IDEA:feature@a1!» …`
> parses to `links:[{to:"a1", relation:"supersedes"}]` — the refined idea
> *replaces* the target. This keeps `supersedes` on the robust single-line marker:
> the fenced `rel:` key below also expresses it, but the agent's TUI renders the
> code fence away before the backend captures the screen (PD-008), so in practice
> the inline `!` is the form that survives. The default edge stays generic
> (`about`) — the *flavour* lives on the source card's `kind`, so no relation
> taxonomy is carried inline beyond the one structural `supersedes`. **Several refs
> may be chained** (`«IDEA@a1!@a2!@a3!» …` → three `supersedes` links) so a single
> idea can replace *several* sources at once — the multi-select combine/merge verb
> (#62, PD-019); each ref carries its own optional `!`, so a mixed `@a1@a2!` links
> `about` a1 and `supersedes` a2. If the agent
> omits `@ref` the idea lands unlinked, exactly as before (graceful degradation).
> The session-scoped dedupe key includes the links, so the same title/body pointed
> at a *different* target (or with a *different* relation) is a distinct idea.

- **Marker:** guillemets `«` (U+00AB) / `»` (U+00BB). Chosen because they are essentially absent from
  source code and ordinary English prose (very low collision), visually unmistakable, a balanced
  single-glyph pair, and cheap to anchor: `^\s*«IDEA(:…)?»`. The ASCII alias `<<IDEA>>` / `<</IDEA>>`
  is accepted for harnesses or locales that mangle the guillemets.
- **Kind:** optional, encoded *inside* the marker (`«IDEA:risk»`) so the `::` separator is never
  overloaded. Free-form lower-kebab; the canvas may style known kinds (`risk`, `question`, `feature`,
  `todo`, `decision`) and treats unknown kinds as a plain tag.
- **Separator `::`** splits title from body on its **first** occurrence. If absent, the whole remainder
  is the title and the body is empty (a bare idea like `«IDEA» Offline-first canvas`).
- **Tags:** any `#hashtag` tokens left in the body are kept verbatim (rendered, not stripped) — no
  separate grammar needed.

**Form 2 — fenced block (only for multi-line bodies):**

````
```idea kind=decision
title: Adopt event-sourced canvas history
body: Persist every CRDT op as an append-only log.
Enables time-travel scrub and per-idea provenance.
Cost: storage growth; mitigate with periodic snapshots.
```
````

- Opened by a line matching ` ```idea ` (optionally ` kind=… `), closed by a bare ` ``` `.
- Inside, recognised keys `title:` / `body:` / `kind:` (case-insensitive) seed the fields; any lines
  after `body:` (or all lines, if no keys are present) accumulate into the body verbatim. First
  non-key line with no key → title; the rest → body.
- **Idea-graph keys (idea-graph design §5.1):** `id:` stamps this idea's own short ref; `link:`
  (alias `parent:`) sets the target card ref; `rel:` selects the relation (`about` default, or
  `supersedes`). So a fenced idea can express the one structural relation the single-line `@ref`
  cannot: `link: a1` + `rel: supersedes` → `links:[{to:"a1", relation:"supersedes"}]`.
- The fences anchor start **and** end, so reflow *inside* the block is harmless — we never have to
  guess where it ends. This is why a fenced block is safe for multi-line where a wrapped single line
  is not.

### 3.3 Parse algorithm

Run **after** chrome-strip (stage 1, §5) over the surviving response region. Pseudocode:

```
parse(region: string[], paneWidth: number) -> { chat: string[], ideas: Idea[] }:
  chat = [], ideas = []
  i = 0
  while i < region.length:
    line = region[i]

    if IDEA_FENCE_OPEN.test(line):                  # Form 2
      kind = fenceKind(line)
      bodyLines = []
      i++
      while i < region.length and not IDEA_FENCE_CLOSE.test(region[i]):
        bodyLines.push(region[i]); i++
      i++                                            # consume closing fence
      ideas.push(ideaFromFence(kind, bodyLines))
      continue

    m = IDEA_MARKER.exec(line)                       # Form 1
    if m:
      kind = m.kind
      logical = line
      # Rejoin reflow-wrapped continuation rows (only if NOT captured with -J, §5.4):
      while i+1 < region.length
            and rowWasWrapped(region[i], paneWidth)  # prev row filled the full width
            and not IDEA_MARKER.test(region[i+1])
            and not IDEA_FENCE_OPEN.test(region[i+1])
            and region[i+1].trim() != "":
        i++; logical += region[i]
      ideas.push(ideaFromLine(kind, logical))
      i++
      continue

    chat.push(line); i++                             # everything else is chat
  return { chat, ideas }
```

Regexes (drop-in for the claude profile / a shared `contract.ts`):

```ts
const IDEA_MARKER     = /^\s*(?:«IDEA(?::([a-z][\w-]*))?»|<<IDEA(?::([a-z][\w-]*))?>>)\s*(.*)$/u;
const IDEA_FENCE_OPEN = /^\s*```idea(?:\s+kind=([a-z][\w-]*))?\s*$/u;
const IDEA_FENCE_CLOSE= /^\s*```\s*$/;
// title :: body, split on the FIRST "::"
function ideaFromLine(kind, logical) {
  const rest = logical.replace(IDEA_MARKER, "$3").trim();   // remainder after marker
  const sep  = rest.indexOf("::");
  const title = (sep >= 0 ? rest.slice(0, sep) : rest).trim();
  const body  = (sep >= 0 ? rest.slice(sep + 2) : "").trim();
  return { title, body, kind };
}
```

`rowWasWrapped(row, paneWidth)` returns `row.length >= paneWidth` (tmux only wraps a row that has
filled the full column width). This is the no-`-J` fallback; see §5.4 for why `-J` makes it mostly
moot.

> **Implementation note (calibrated to real claude).** With `-J`, terminal auto-wraps are already
> rejoined, and claude does its OWN word-wrapping (breaking at spaces) with logical units separated
> by a **blank line**. So the shipped parser drops the `paneWidth`/`rowWasWrapped` heuristic and
> instead absorbs an idea's continuation rows until a blank line / the next marker / a fence,
> rejoining with a single space (`parseContract(region, final)` — no `paneWidth` argument). This is
> simpler and matches the captured output; the width-based rule above was based on the idealized §1
> sample.

### 3.4 Multi-line bodies given the single-line preference

The contract **prefers** single-line. The agent is primed to keep an idea on one logical line and
reserve the fenced form for the rare idea whose body genuinely needs paragraphs/code. So:

- A long single-line body that *tmux* wraps is still one logical idea — rejoined by the algorithm
  above (or by `-J`, §5.4).
- A body the *agent* deliberately splits uses Form 2, which is fence-delimited and reflow-proof.

This keeps the parse trivial for the 95% case without losing the ability to express a rich idea.

---

## 4. Session priming

### 4.1 The instruction text

Sent once, as the **first message** into the session (a normal prompt — **not** a CLI flag, not a
headless mode; harness-agnostic per ai-session-layer.md §1 hard constraints):

```
You are in a brainstorming workspace. Reply to me normally in conversation.

Whenever you produce a brainstorming idea or ideation note worth capturing on the canvas,
emit it on its OWN line in exactly this format, then continue talking normally:

  «IDEA» <short title> :: <one-line description>

Optionally tag the kind: «IDEA:risk», «IDEA:feature», «IDEA:question», «IDEA:decision».
For an idea that truly needs several lines, use a fenced block instead:

  ```idea kind=<kind>
  title: <short title>
  body: <as many lines as you need>
  ```

Rules:
- One idea per «IDEA» line. Put each «IDEA» line on its own line.
- Use «IDEA» ONLY for real ideas, never for chitchat, status, or questions to me.
- Everything you write that is NOT an «IDEA» line is treated as ordinary chat.

Acknowledge with the single word READY and nothing else.
```

The trailing `READY` ack is deliberate (see §4.4): it gives the backend a deterministic signal that
priming landed, and a single, droppable line rather than a chatty paragraph polluting the hub.

### 4.2 Injection point

`server.ts`'s `attach` handler already calls `backend.create(...)` then `backend.attach(...)`. Priming
slots **between create-as-new and attach**, and is owned by the backend (not the server) so it can be
gated on whether the session was *actually created* vs *reused*:

- Add `prime?: string` and keep `harnessProfile?: string` on `SessionSpec` (`types.ts`).
- `TmuxSessionBackend.create()` already branches on `hasSession()` (`tmux-backend.ts:166`). On the
  **create** branch only (not the reuse branch), after the harness is confirmed ready, send the
  priming text via the existing `sendInput` path and record that the session is primed.
- `server.ts` derives the profile/prime text from the harness command (`claude` → claude profile +
  the §4.1 text) and passes them in the `create` spec. A bare shell or a harness with no idea-contract
  support passes `prime: undefined` and is never primed (§4.5).

### 4.3 Waiting for harness readiness

claude's TUI takes time to boot and may swallow keystrokes typed during startup. Priming must wait for
the harness to be ready to accept input. Reuse the poller's capture primitive:

- After `new-session`, poll `capture-pane -p` (the same `#capture` used by the extractor) until the
  claude input box is present (profile-provided `readyMarker`, e.g. the bordered `>` input line) **or**
  a short bounded timeout (~5 s) elapses.
- Then send the priming text through `sendInput` (which already does Escape/`C-u` → literal/paste →
  delayed Enter, `tmux-backend.ts:323`).
- This readiness probe is the same mechanism the extractor already relies on, so no new dependency.

### 4.4 Idempotency on a durable / reattached session (PRD §3.5)

The hard requirement: a session that survives a browser refresh, socket drop, or **backend restart**
must **not** be re-primed (which would replay the instruction and confuse the agent).

The session's *existence* is the durable idempotency key, but existence alone can't prove priming
*completed* (the backend could have crashed between `new-session` and the priming `Enter`). So we use a
**tmux-native, durable primed-flag**:

- After priming succeeds, stamp the session:
  `tmux set-option -t ai-storm-<id> @ai_storm_primed 1`.
- `create()`'s reuse branch reads it back:
  `tmux show-options -v -t ai-storm-<id> @ai_storm_primed`.
  - flag present → **skip priming** (already primed; this is a reattach/restart).
  - flag absent → session exists but priming never finished → **(re)prime now**, then stamp.

This makes priming idempotent *and* crash-safe across backend restarts, with no in-memory state to
lose. (On reconcile, `tmux-backend.ts:133` re-discovers `ai-storm-*` sessions; a reattach calls
`create` → `hasSession` true → reuse branch → primed-flag check → no re-prime.)

On **Windows** (`NodePtySessionBackend`) the node-pty session dies with the backend process (no
cross-restart durability — ai-session-layer.md §10.4), so an in-memory `primed: Set<workspaceId>` is
sufficient; there is no reattach-after-restart case to defend against.

### 4.5 Suppressing the priming turn

The priming message produces a reply (`READY`). That reply must **not** appear in the chat hub. The
backend marks the session `priming` from the moment it sends the instruction until it observes the ack;
during that window the extractor's output is **discarded** (not forwarded as a `response`). The `READY`
ack both confirms priming and is swallowed. If no ack arrives within the timeout, we still leave the
priming window (don't hang) and log `prime.no-ack` — the heuristic floor will carry that session.

### 4.6 Harness-agnostic degradation

- Priming is a plain first message, so any stdin-reading harness *receives* it. Whether the harness
  *honours* it is model-dependent.
- For a **non-claude AI harness** with no profile, we still send the generic priming text (it's
  harness-neutral) and rely on the **heuristic floor** (§5.3) when the contract isn't followed.
- For a **bare shell / non-AI command** we send **no** priming (it would just error/echo) — gated by
  the profile declaring `supportsIdeaContract: false`. Such a session is chat-only via the heuristic
  floor, and almost everything is chrome-stripped to nothing.

---

## 5. Claude harness profile (the heuristic floor)

The profile is **data**, kept per-harness so other harnesses add their own (`extraction.ts` already
has `PROFILES` keyed by name — `extraction.ts:76`). We extend `HarnessProfile` with the contract +
fallback hooks and register a `claude` profile.

### 5.1 Extended `HarnessProfile`

```ts
export interface HarnessProfile {
  name: string;
  promptMarkers: RegExp[];     // existing — idle input prompt / completion signal
  promptPrefix: RegExp;        // existing — strip leading prompt glyph from echo
  chrome: RegExp[];            // existing — stage-1 strip (extended below for claude)
  // NEW:
  /** Does this harness understand the §4 idea contract (→ prime it)? */
  supportsIdeaContract: boolean;
  /** Pane signature meaning "ready for input" (priming readiness probe, §4.3). */
  readyMarker?: RegExp;
  /** Enable the prose→idea heuristic fallback when no markers are present (§5.3). */
  ideaFallback: boolean;
  /** Anchor for the START of an assistant turn (claude bullets replies "● "); the
   *  response region is anchored on the first such line BELOW the echoed input
   *  rather than byte-matching the echo (claude re-wraps/indents it — §4.3). */
  responseMarker?: RegExp;
  /** Leading decoration stripped from each response line (claude's "● " bullet /
   *  2-space message margin) so it never reaches chat. */
  responsePrefix?: RegExp;
  /** Explicit "turn finished" signal (claude's "✻ <Verb> for <n>s" done-line); more
   *  precise than the idle-timeout, which can fire during a mid-stream pause. */
  completionMarker?: RegExp;
}
```

`DEFAULT_PROFILE` keeps its current chrome rules and sets `supportsIdeaContract: false`,
`ideaFallback: false` (conservative — a generic harness is chat-only until proven otherwise).

> **Calibration note (claude 2.1.165).** §1 was an idealized sample. The real TUI was
> captured live and the profile updated to match: the input prompt is a bare `❯` between two
> horizontal rules (not `╭ >`); assistant turns are bulleted `●` and the body carries a 2-space
> left margin; the spinner done-line randomises its verb (`Worked`/`Brewed`/`Baked for <n>s`);
> the status bar truncates with `…` on a narrow pane; and the echoed prompt is re-wrapped. So
> the claude profile anchors on the `●` turn (below the echoed input), strips the `●`/margin,
> completes on the done-line, and rejoins word-wrapped idea bodies (blank-line delimited).

### 5.2 Stage 1 — chrome-strip regexes (concrete, covering every sample in §1)

```ts
export const CLAUDE_PROFILE: HarnessProfile = {
  name: "claude",
  supportsIdeaContract: true,
  ideaFallback: true,
  // claude 2.1.x renders a bare "❯" input prompt between two horizontal rules.
  promptMarkers: [/^[>❯]$/u],
  promptPrefix: /^\s*[>❯]\s?/u,
  readyMarker: /^\s*❯/u,                       // the "❯" input prompt has appeared
  responseMarker: /^\s*●\s/u,                   // assistant turn starts with "● "
  responsePrefix: /^(?:●\s|\s{2})/u,            // strip "● " bullet / 2-space margin
  completionMarker: /^\s*[*✻✽✶✷∗·]\s+\w+ for \d+(?:\.\d+)?\s*[smhd]\b/iu,  // done-line
  chrome: [
    // 1) Status bar:
    //    "Opus 4.8 (1M context) | main | ~/path | ctx:29.0k/1000k (3%) | 5h:33%"
    //    Anchored on the highly-distinctive ctx:<n>/<n> (<n>%) signature.
    /^.*\bctx:\s*[\d.]+[kmg]?\s*\/\s*[\d.]+[kmg]?\s*\(\s*\d+\s*%\s*\).*$/iu,

    // 1b) Same status bar, TRUNCATED. When the pane is narrower than the bar,
    //    claude cuts the trailing "ctx:n/n (n%)" with an ellipsis, e.g.
    //    "Opus 4.8 (1M context) | feat/x | ~/long/path/worktrees/a…", so the
    //    ctx: anchor in (1) misses it. Anchor on the model header
    //    "(<n> context) |" — the context token + the status bar's pipe
    //    separator survive truncation and won't collide with ordinary prose.
    /\(\s*[\d.]+\s*[kmgt]?\s+context\s*\)\s*\|/iu,

    // 2) Spinner verb frames: "* Catapulting…", "✽ Forging… (5s · ↓ 227 tokens)",
    //    "✶ Metamorphosing…". Leading claude spinner glyph + text ENDING in an
    //    ellipsis (the discriminator vs a markdown bullet), optional "(… tokens)".
    /^\s*[*✻✽✶✷●∗·]\s+\S.*…(?:\s*\([^)]*\))?\s*$/u,

    // 3) Spinner DONE line, randomised verb: "✻ Worked for 3s", "✻ Brewed for 4s",
    //    "✻ Baked for 3s" → "<glyph> <Verb> for <n><unit>".
    /^\s*[*✻✽✶✷∗·]\s+\w+ for \d+(?:\.\d+)?\s*[smhd]\b.*$/iu,

    // 4) Auto-mode / agents affordance:
    //    "⏵⏵ auto mode on (shift+tab to cycle) · PR #10 · ← for agents"
    /^\s*⏵⏵?\s.*$/u,
    /(?:^|·)\s*←\s+for agents\s*$/u,

    // 5) Tip / continuation gutter:
    //    "⎿  Tip: Run claude --continue or claude --resume to resume a conversation"
    /^\s*⎿\s.*$/u,                              // claude's tool-result/gutter glyph
    /\bclaude\s+--(?:continue|resume)\b/u,      // resume hint anywhere

    // 6) Shortcuts / queued-message hints and placeholders.
    /^\s*\?\s+for shortcuts\s*$/u,
    /^\s*Press up to edit queued messages\s*$/iu,
    /^\s*Try\s+".*"\s*$/u,

    // 7) Box-drawing borders (U+2500–U+257F incl. ╭╮╰╯│ ─) + the bare "❯" input
    //    line (idle prompt, echoed input, or a queued suggestion). ASCII "---"
    //    markdown dividers are NOT matched (only the box-drawing range).
    /^[─-╿\s]+$/u,
    /^\s*❯/u,
  ],
};
```

Mapping against the §1 samples — every line is accounted for:

| Sample line | Rule |
|---|---|
| `Opus 4.8 (1M context) … ctx:29.0k/1000k (3%) … 5h:33%` | (1) status bar |
| `* Catapulting…` | (2) spinner |
| `✽ Forging… (5s · ↓ 227 tokens)` | (2) spinner + parenthetical |
| `✶ Metamorphosing…` | (2) spinner |
| `✻ Worked for 3s` | (3) worked-for |
| `⏵⏵ auto mode on (shift+tab to cycle) · ← for agents` | (4) auto-mode |
| `⎿  Tip: Run claude --continue or claude --resume …` | (5) gutter + resume hint |
| `Let me know which, or just tell me the task.` | **none → kept as chat** ✓ |

Whatever survives stage 1 still runs through the existing `ansi.ts` `sanitize()` (already done in
`tmux-backend.ts:#capture`) for residual control bytes.

> **Note on `⎿` (rule 5):** the gutter glyph prefixes claude tool-result lines as well as tips.
> Stripping all `⎿`-led lines is correct in a *brainstorming* workspace (tool noise isn't ideas) but
> is a known trade-off — see §9 risk 6.

### 5.3 Stage 2 — prose-vs-ideas classification (fallback only)

After chrome-strip and the §3.3 contract parse, **if the agent emitted no markers for the whole
response** and `profile.ideaFallback` is true, apply a conservative classifier so we don't lose ideas
from a model that ignored the contract:

- Trigger only when the surviving chat region looks like an idea list: **≥2** lines that are markdown
  bullets (`- `, `* `, `1. `) or headings (`# `) — reuse the patterns already in
  `markdown-block-parser.ts` (`BULLET`, `NUMBERED`, `HEADING`).
- Convert each such line to a candidate `Idea` (`title` = line text sans marker, `body` = "",
  `kind` = `"heuristic"`); the surrounding prose stays in `chat`.
- **Always log** `extract.heuristic { workspace, count }` so a contract-ignoring agent is *visible*,
  never silently mis-attributed (ai-session-layer.md §10 risk 1; the brief's "log when falling back").
- Default `ideaFallback: true` for claude, `false` for `DEFAULT_PROFILE`. When markers *are* present,
  the fallback never runs — the explicit contract always wins.

---

## 6. Protocol change (`packages/shared/src/protocol.ts`)

Evolve `ResponseMessage` from a single `lines: string[]` into the chat/ideas split. Add an `Idea`
type. This is the wire contract the whole design hinges on.

```ts
/** A single extracted brainstorming idea destined for the canvas. */
export interface Idea {
  /** Short title — the card heading. */
  title: string;
  /** One-line (or, for fenced ideas, multi-line) description — the card body. */
  body: string;
  /** Optional kind/tag, e.g. "risk" | "feature" | "question" | "decision" | "heuristic". */
  kind?: string;
}

/**
 * Backend-extracted agent output, pre-split so the client never guesses structure:
 *  - `chat`  → conversational lines rendered in the control hub
 *  - `ideas` → brainstorming ideas rendered as canvas cards/notes
 */
export interface ResponseMessage {
  type: "response";
  workspaceId: string;
  /** Conversational reply lines for the chat hub (chrome already stripped). */
  chat: string[];
  /** Extracted ideas for the canvas. */
  ideas: Idea[];
  /** True once idle/prompt-return marks the response complete (frontend flushNow()). */
  complete: boolean;
}
```

- `lines: string[]` is **removed**. `chat` replaces it for the hub; `ideas` is net-new.
- No change to `parseClientMessage` validation (it validates client→server only; `response` is
  server→client).
- The backend-internal `ResponseChunk` (`types.ts`) mirrors the split:
  `{ workspaceId, chat: string[], ideas: Idea[], complete }`. `Idea` is defined in `@ai-storm/shared`
  and imported by the backend so there's one source of truth.

---

## 7. Backend wiring

The chrome-strip **and** contract-parse live **backend-side**, inside the extraction layer — exactly
where the brief wants them. The existing capture-pane diff (`tmux-backend.ts` `#tick` → `#capture`)
remains the byte source; nothing about polling/cadence/durability changes.

### 7.1 `extraction.ts` — `ResponseExtractor` output becomes `{chat, ideas, complete}`

Current `ingest()` returns `{ lines, complete }` after: anchor on echo → slice response region → drop
prompt/chrome → hold back the growing tail (`extraction.ts:165-193`). Insert two stages and change the
return shape:

```
ingest(capture):
  lines  = toTrimmedLines(capture)
  region = lines.slice(responseStart)                 # unchanged: echo anchoring
  region = region.filter(!isPrompt && !isChrome)      # STAGE 1: chrome strip (now claude profile)
  { chat, ideas } = parseContract(region, paneWidth)  # STAGE 2: §3.3 contract parse
  if ideas.length == 0 and profile.ideaFallback:      # heuristic floor (§5.3), logged
    ideas += classifyProse(chat)  → and remove promoted lines from chat
  # hold-back + incremental emission, applied to BOTH chat and ideas:
  #  - a chat line that is the last non-blank line may still be growing → hold back
  #  - an idea whose marker line is the last non-blank line may still be streaming → hold back
  #    (emit an idea only once its logical line is terminated by blank / next-marker / prompt /
  #     completion — prevents emitting a half-typed «IDEA» card; §9 risk 3)
  return { chat: newChat, ideas: newIdeas, complete }
```

- `finalize()` (idle-timeout completion, `extraction.ts:199`) flushes any held-back chat tail **and**
  any held-back final idea, returning the same `{chat, ideas, complete}` shape.
- **Per-response idea dedupe:** key emitted ideas by `(title, body, kind)` within a response so a
  reflow re-capture of the same screen can't emit the same idea twice (the poller diffs captures, but
  a width change / re-anchor can re-present a line).
- The module stays **pure and runtime-free** — still unit-tested against fixtures (§8).

### 7.2 `tmux-backend.ts` — thread the profile, add priming, pass pane width

- **Profile selection.** `attach()` currently hardcodes `getProfile(undefined, …)` →
  `DEFAULT_PROFILE` (`tmux-backend.ts:232`). Store the profile name at `create()` time (derived from
  the harness command basename, e.g. `claude` → `"claude"`) in a per-workspace map; `attach()` reads it
  and builds the extractor with `CLAUDE_PROFILE`.
- **Priming.** In `create()`'s create branch (`tmux-backend.ts:161-221`), after `set-option status
  off` and the §4.3 readiness probe, if `profile.supportsIdeaContract` and the durable primed-flag is
  absent: send `spec.prime` via `sendInput`, run the §4.5 suppression window, then
  `set-option @ai_storm_primed 1`.
- **Pane width** for the reflow rejoin (§3.3) is the session's `cols` (already known at create:
  `tmux-backend.ts:187`); pass it into the extractor.
- **Capture with `-J`** — see §5.4.

### 7.3 `line-buffer.ts` (Windows path) is unaffected in shape

`SlicingBuffer` still reconstructs logical lines from the node-pty byte stream on Windows
(`line-buffer.ts` docstring); those lines feed the **same** `ResponseExtractor`, so the chrome-strip +
contract-parse + chat/ideas split are identical cross-platform. Only the byte source differs
(ai-session-layer.md §5.2). No change to `SlicingBuffer` itself.

### 7.4 `server.ts` — forward the split

The `attach` handler's `onChunk` (`server.ts:188-193`) changes from forwarding `lines` to forwarding
the split:

```ts
(chunk) => send({
  type: "response", workspaceId,
  chat: chunk.chat, ideas: chunk.ideas, complete: chunk.complete,
});
```

and `create({ … })` gains `harnessProfile` + `prime` (derived from the harness command). Everything
else in the dispatcher is untouched.

### 7.5 Pipeline at a glance

```
tmux capture-pane -p -J -S -N      (tmux-backend #capture; unchanged source)
        │
        ▼  diff vs last capture (tmux-backend #tick; unchanged)
ResponseExtractor.ingest
   ├─ echo anchor + region slice        (unchanged)
   ├─ STAGE 1  chrome strip              (CLAUDE_PROFILE.chrome — §5.2)
   ├─ STAGE 2  contract parse            (§3.3 → ideas[] + chat[])
   ├─ heuristic floor (if no markers)    (§5.3, logged)
   └─ hold-back + dedupe + complete
        │
        ▼  ResponseChunk { chat, ideas, complete }
server.ts → ws → ResponseMessage { chat, ideas, complete }
```

---

## 8. Frontend simplification

The client **stops inferring structure**. It renders `chat` in the hub and pushes `ideas` straight to
the canvas.

### 8.1 `ingestion.service.ts`

Today `#ingest(workspaceId, lines, complete)` runs `MarkdownBlockParser.translateAll(lines)` →
`RenderScheduler.enqueueAll` → `CanvasService.applyBlocks`, and also appends every line to the hub view
signal (`ingestion.service.ts:114-136`). New shape:

```ts
case 'response':
  this.#ingest(workspaceId, msg.chat, msg.ideas, msg.complete);
  break;
…
#ingest(workspaceId, chat, ideas, complete) {
  const p = this.#active.get(workspaceId);
  if (!p) return;
  // (a) chat → hub scrollback signal only (no canvas).
  if (chat.length) this.#appendChatLines(workspaceId, chat);
  // (b) ideas → canvas cards, batched through the scheduler (one CRDT txn / frame).
  if (ideas.length) p.scheduler.enqueueAll(ideas.map(ideaToDescriptors).flat());
  if (complete) p.scheduler.flushNow();
}
```

- The hub view signal (`terminalLines`) now holds **chat only** — it was already documented as
  "extracted RESPONSE text only, no raw mirror" (`ingestion.service.ts:120`); now it's specifically the
  conversational half.
- `MarkdownBlockParser` is **no longer on the live stream path**.

### 8.2 `canvas.service.ts` — ideas as cards/notes

The brief: "pushes ideas straight to `CanvasService.applyBlocks` as cards/notes." Two ways, recommend
**both**, layered:

- **Primary (smallest change, honours the brief literally):** a pure `ideaToDescriptors(idea):
  BlockDescriptor[]` adapter maps each idea to a deterministic block sequence — a `heading` (the
  title, prefixed/decorated by `kind`) + a `paragraph`/list for the body — and feeds the **existing**
  `applyBlocks` (`canvas.service.ts:138`). This is *not* inference: the structure is dictated by the
  `Idea` shape, not guessed from text shape.
- **Recommended enhancement (true "cards"):** add `applyIdeas(workspaceId, ideas)` that creates
  **one card per idea** on the canvas, seeded with the title heading + body. This realises "cards on
  the canvas" rather than appending paragraphs to one growing note. Ship the primary first; the
  enhancement is additive.

`kind` styling: known kinds map to a heading badge / note colour (`risk` → red, `question` → amber,
etc.); unknown kinds render as a plain tag. This is presentation-only and out of scope for the wire.

### 8.3 Fate of `MarkdownBlockParser`

**Retired from the streaming path; kept as a body formatter.** It no longer parses the raw response
stream (the backend already split chat/ideas, so there is nothing to infer). It is **retained** as a
pure helper to render a *multi-line idea body* (the fenced Form-2 case) that itself contains markdown:
`ideaToDescriptors` can call `MarkdownBlockParser.translateAll(body.split('\n'))` to turn a body with
bullets/code into child blocks under the card. So the module survives, demoted from "infer structure
from a byte stream" to "format a known idea body." Its unit tests stay valid.

### 8.4 `control-hub.component.ts`

Minimal. It already renders `ingestion.terminalLines(id)` as the response log
(`control-hub.component.ts:298-301, 63-70`) — that now shows **chat**. No structural change; optionally
relabel the panel "Conversation" since ideas now live on the canvas, not here. The input race
workaround note (`send()`, `control-hub.component.ts:341-349`) is unchanged — `attach` is already
idempotent (ai-session-layer.md §3.3).

---

## 9. Testing strategy

Unit tests over **recorded fixtures**, extending `backend/src/session/extraction.test.ts` (which
already uses the `cap(...)` helper and per-profile cases — `extraction.test.ts:11-16`). Add a
`backend/src/session/fixtures/claude/` directory of real `capture-pane` recordings so chrome regexes
are tested against ground truth, not hand-typed approximations.

Required cases:

1. **Chrome strip — the exact §1 samples.** A fixture containing every chrome line from §1 plus the
   one real chat line → assert `chat == ["Let me know which, or just tell me the task."]`,
   `ideas == []`. One assertion per rule guards against regex drift.
2. **Marked output.** Chat prose interleaved with `«IDEA» T :: B` lines (incl. `«IDEA:risk»` and a
   bare `«IDEA» T`) → assert exact `ideas` (title/body/kind) and that markers never leak into `chat`.
3. **Marker collision.** A chat line mentioning «IDEA» **mid-sentence** (not line-leading) → parsed as
   chat, not an idea.
4. **Multiline / fenced idea.** A ` ```idea ` block with `title:`/`body:` spanning lines → one `Idea`
   with the full multi-line body; fence lines absent from `chat`.
5. **Reflow / wrapped lines.** A long single-line idea wrapped across two capture rows — tested
   **both** ways: with `-J` (one line, trivially parsed) and without `-J` (two rows, rejoined via the
   full-width heuristic, §3.3). Assert identical `Idea` either way.
6. **Heuristic floor.** A response with bullets but **no** markers → candidate ideas produced **and**
   `extract.heuristic` logged (assert the log spy fired); a response **with** markers → fallback does
   **not** run.
7. **Streaming partial idea.** Capture N shows `«IDEA» Half a titl` as the last line (still growing);
   capture N+1 shows it terminated → assert the idea is emitted **once**, only after termination, with
   the final text (hold-back + dedupe, §7.1).
8. **Idempotent priming (backend).** Mock tmux: `create` on a fresh session sends priming + stamps
   `@ai_storm_primed`; a second `create` (reattach) sees the flag and sends **no** priming; a session
   that exists *without* the flag (simulated mid-prime crash) gets re-primed.
9. **Priming suppression.** The `READY` ack and anything before the first user input is **not**
   forwarded as a `response`.

Frontend: a small `ideaToDescriptors` spec (idea → expected `BlockDescriptor[]`, incl. kind decoration
and a fenced multi-line body routed through `MarkdownBlockParser`), and an `ingestion.service` spec
asserting `chat` → hub signal, `ideas` → `applyBlocks`/`applyIdeas`, parser **not** called on the
stream.

---

## 10. Migration steps (doc-only here; sequencing for the impl PRs)

Each step independently shippable; app stays working throughout.

1. **`@ai-storm/shared`:** add `Idea`, evolve `ResponseMessage` to `{chat, ideas, complete}`. Update
   `ResponseChunk` in `types.ts`. (Compiles against current code via a temporary `chat = lines`
   shim if needed.)
2. **`extraction.ts`:** extend `HarnessProfile`; add `CLAUDE_PROFILE`; add the §3.3 contract parser
   (a small `contract.ts` or inline); change `ingest`/`finalize` to emit `{chat, ideas, complete}`.
   Land with the full §9 fixture suite **first** — this is where the risk lives.
3. **`tmux-backend.ts`:** thread the profile into `attach`; add `-J` to `#capture`; pass pane width.
4. **Priming:** add `prime`/`harnessProfile` to `SessionSpec`; implement readiness probe, send,
   suppression window, and the `@ai_storm_primed` durable flag in `create`.
5. **`server.ts`:** derive profile/prime from the harness command; forward the split in `onChunk`.
6. **Frontend:** `ingestion.service` consumes `chat`/`ideas`; add `ideaToDescriptors` (+ optional
   `applyIdeas`); retire `MarkdownBlockParser` from the stream path (keep as body formatter).
7. **Windows parity:** confirm the shared extractor produces identical splits over the node-pty path.

---

## 11. Risks & open questions

1. **Marker collisions.** The agent could emit `«IDEA»` inside ordinary prose (e.g. *describing* the
   contract). Mitigation: line-leading anchor only (`^\s*«IDEA…`); priming explicitly says "ideas
   only." Residual risk accepted; rare and low-harm (a stray card, not lost chat).
2. **Agents that won't follow the contract.** A model lapse or a non-claude harness produces no
   markers. Mitigation: heuristic floor (§5.3), **logged**; chrome strip still removes the worst noise.
   Degrades to "some ideas missed / a few prose lines promoted," never to silent corruption.
3. **Streaming partial ideas.** A token-streaming harness paints `«IDEA» Half a t…` mid-flight.
   Mitigation: emit an idea only once its logical line is terminated (blank / next-marker / prompt /
   completion), plus per-response `(title,body,kind)` dedupe so a re-capture can't double-emit. tmux's
   in-place repaint collapsing (ai-session-layer.md §4.1, §10.3) helps; true token-level idea
   streaming remains out of scope (finalized cards are the product target).
4. **Idempotent priming across restart.** Covered by the durable `@ai_storm_primed` tmux option
   (§4.4); the only window is a crash *between* priming and stamping, which the absent-flag re-prime
   path handles. Open question: should a *very* old session be re-primed if we change the contract text
   (versioned flag, e.g. `@ai_storm_primed=2`)? Proposed: yes — stamp the contract version and re-prime
   on mismatch.
5. **claude TUI version drift breaking chrome regexes.** The biggest *ongoing* maintenance risk. The
   contract is the **primary** path, so drift degrades gracefully: an unmatched spinner/status leaks
   into **chat**, not onto the canvas (ideas are explicit markers, immune to chrome regex rot).
   Mitigation: keep chrome as data in the profile; commit a CI canary fixture captured from a pinned
   claude version; consider logging an "unmatched-glyph-led line" metric to surface drift early.
6. **`⎿` gutter over-stripping.** Stripping all `⎿`-led lines also removes claude tool-result content.
   Acceptable in a brainstorming workspace (tool output isn't an idea), but if a workspace ever needs
   tool results surfaced, this rule must narrow to `⎿ … Tip:`/resume-hint only. Flagged.
7. **`-J` join quirks.** `capture-pane -J` rejoins wrapped lines but can merge trailing whitespace and,
   on some tmux versions, join lines that merely abut. Mitigation: pair `-J` with the blank-line
   terminator the priming asks for, and keep the no-`-J` full-width rejoin as the tested fallback (§9
   case 5) so we can drop `-J` if a version misbehaves.
8. **Confirm no other `lines` consumer.** Before removing `ResponseMessage.lines`, verify nothing else
   (diagnostics, tests) reads it (ai-session-layer.md §10.7 made the same check for `data`).

---

## Appendix A — contract quick reference

| Form | Example | Parses to |
|---|---|---|
| Single line | `«IDEA» Offline-first canvas :: cache CRDT ops in IndexedDB` | `{title:"Offline-first canvas", body:"cache CRDT ops in IndexedDB"}` |
| With kind | `«IDEA:risk» Token rotation :: may break long-lived sessions` | `{title:"Token rotation", body:"may break long-lived sessions", kind:"risk"}` |
| With link (idea-graph) | `«IDEA:risk@a1» Token leak :: refresh races the reattach` | `{title:"Token leak", body:"refresh races the reattach", kind:"risk", links:[{to:"a1", relation:"about"}]}` |
| Supersedes (`@ref!`, PD-012) | `«IDEA:feature@a1!» Rotate token on attach :: survives the reconnect race` | `{title:"Rotate token on attach", body:"survives the reconnect race", kind:"feature", links:[{to:"a1", relation:"supersedes"}]}` |
| Bare | `«IDEA» Offline-first canvas` | `{title:"Offline-first canvas", body:""}` |
| ASCII alias | `<<IDEA>> Offline-first canvas :: …` | same as single line |
| Fenced (multiline) | ` ```idea kind=decision ` … ` ``` ` | `{title, body:"<multi-line>", kind:"decision"}` |
| Anything else | `Let me know which, or just tell me the task.` | → `chat` |

## Appendix B — key regexes (single source of truth for the impl)

```ts
// Contract (shared, harness-agnostic). In-marker tag is [:kind][@ref[!]…] (idea-graph §5.1):
//   groups 1/3 = kind (guillemet/ASCII), 2/4 = the ref CHAIN ("@a1!@a2"), 5 = remainder ("title :: body").
//   A trailing "!" after a ref makes THAT link 'supersedes' instead of the default 'about' (PD-012).
//   The chain (@a1!@a2!) = one idea superseding several sources — the combine/merge verb (PD-019);
//   individual {to, relation} links are parsed from the chain by REF_TOKEN.
const IDEA_MARKER      = /^\s*(?:«IDEA(?::([a-z][\w-]*))?((?:@[\w-]+!?)+)?»|<<IDEA(?::([a-z][\w-]*))?((?:@[\w-]+!?)+)?>>)\s*(.*)$/u;
const REF_TOKEN        = /@([\w-]+)(!)?/gu;  // one ref (+ optional supersede "!") within the chain
const IDEA_FENCE_OPEN  = /^\s*```idea(?:\s+kind=([a-z][\w-]*))?\s*$/u;
const IDEA_FENCE_CLOSE = /^\s*```\s*$/;
const FENCE_KEY        = /^(title|body|kind|id|link|parent|rel)\s*:\s*(.*)$/i;  // idea-graph keys added

// claude chrome strip (profile.chrome)
const STATUS  = /^.*\bctx:\s*[\d.]+[kmg]?\s*\/\s*[\d.]+[kmg]?\s*\(\s*\d+\s*%\s*\).*$/iu;
const STATUS_TRUNC = /\(\s*[\d.]+\s*[kmgt]?\s+context\s*\)\s*\|/iu;  // truncated bar (ctx: cut off)
const STATUS_T= /\(\s*[\d.]+\s*[kmgt]?\s+context\s*\)\s*\|/iu;  // truncated status bar
const SPINNER = /^\s*[*✻✽✶✷●∗·]\s+\S.*…(?:\s*\([^)]*\))?\s*$/u;
const DONE    = /^\s*[*✻✽✶✷∗·]\s+\w+ for \d+(?:\.\d+)?\s*[smhd]\b.*$/iu;  // "✻ Brewed for 4s"
const AUTO    = /^\s*⏵⏵?\s.*$/u;
const AGENTS  = /(?:^|·)\s*←\s+for agents\s*$/u;
const GUTTER  = /^\s*⎿\s.*$/u;
const RESUME  = /\bclaude\s+--(?:continue|resume)\b/u;
const SHORTCUT= /^\s*\?\s+for shortcuts\s*$/u;
const QUEUED  = /^\s*Press up to edit queued messages\s*$/iu;
const TRY     = /^\s*Try\s+".*"\s*$/u;
const BORDER  = /^[─-╿\s]+$/u;   // U+2500–U+257F box drawing (incl. ╭╮╰╯│); ASCII --- preserved
const PROMPT  = /^\s*❯/u;        // bare "❯" input line (idle / echoed input / suggestion)

// claude turn structure
const READY   = /^\s*❯/u;                         // readyMarker — input prompt present
const TURN    = /^\s*●\s/u;                        // responseMarker — assistant turn start
const MARGIN  = /^(?:●\s|\s{2})/u;                 // responsePrefix — "● " bullet / 2-space margin
```
