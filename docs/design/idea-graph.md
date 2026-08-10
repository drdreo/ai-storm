# Design: the idea graph (identity, typed edges, kind registry)

**Status:** 🟢 Implemented — the foundational data model the output-visualization epic
builds on, rendered on the tldraw canvas (PD-010, PD-013).
**Author:** ai-storm
**Related:** [`product-decisions.md` PD-010](../decisions/product-decisions.md) ·
[`ai-response-extraction-contract.md`](./ai-response-extraction-contract.md) ·
issues #40 (source-linked responses), #19 (parent refs + connectors), #20 (lifecycle),
#22 (decision capture), #16/#17 (layout/clustering), #21 (kinds), #31/PD-009 (provenance)

---

## 1. Why this exists

Before this model shipped, a brainstorm board was a _pile_ of cards rather than a
_graph_. Card verbs (#13 Discuss, #15 Expand/Challenge/Find-risks, #14 reply-to-card)
fed an editable prompt into the live terminal; the backend extracted `«IDEA»` markers
into cards, but those cards were free-floating and had no durable link back to the
source card. A "Find risks" response could therefore land elsewhere in the layout,
visually disconnected from the idea it qualified.

The graph work unified the primitives needed by #40 (source-linked responses), #19
(connector edges), #22 (supersede), #20 (lifecycle), and #16/#17 (layout): **stable
idea identity** and **typed relationships between ideas**. Without that shared model,
each feature would have needed its own position-based identity and edge maps.

The resulting **data-model refactor is shipped** through the existing pipeline:
`CreateIdeaInput` flows through `frontend/src/app/stores/canvas.store.ts` into cards
with canonical refs, typed edges, supersede ghosts, and manual graph-driven
arrangement. New graph consumers should extend these primitives rather than create
parallel identity or persistence maps.

## 2. The model: three orthogonal axes

The core realization (see the dialogue captured in PD-010) is that three different
questions were being conflated into one `kind` field. They are independent:

| Axis           | Question it answers  | Lives on                | Example values                                                               |
| -------------- | -------------------- | ----------------------- | ---------------------------------------------------------------------------- |
| **Kind**       | _What is this card?_ | the **node**            | `idea`, `risk`, `question`, `feature`, `decision` (not `challenge` — PD-012) |
| **Link**       | _What is it about?_  | an **edge**             | → points at another card                                                     |
| **Provenance** | _Who made it?_       | the node (existing #31) | `user`, `ai`                                                                 |

### 2.1 Nodes, not nesting

An idea is a **node**. Relationships are **edges**, never containment. Nesting (a risk
living _inside_ an idea) assumes a tree — single owner, clean containment — but the real
usage breaks the tree:

- a concern can be a risk of **two** ideas (shared child — trees can't share),
- a fanned-out idea is **itself an idea** that grows its own risks (recursion),
- "challenge the challenge", "risk of the mitigation" — same-type children.

The moment children recurse or are shared, nesting _is_ a graph wearing a costume. A
flat node set + typed edges handles sharing, re-parenting, and recursion natively.

### 2.2 Kind is what it _is_; the edge is what it's _about_

We deliberately do **not** carry a parallel relation taxonomy (`risk-of`, `challenge-of`,
`expands`) on the edge. That would store the flavor twice — `kind: risk` on the card
_and_ `relation: risk-of` on its link say the same thing. Instead:

- The **node's `kind`** carries the flavor. A risk card is `kind: risk`. A feature is
  `kind: feature`.
- The **edge is generic** — "this card is _about_ that card" (`relation: 'about'`). You
  read "it's a risk _of_ X" by following an `about` edge from a `risk`-kind card to X.

Test for whether a label is a kind or a relation: **does it need a target to make sense?**
"risk **of**" only means something pointed at a target — but that target is already supplied
by the edge, and the _flavor_ (risk vs feature) is the source card's kind. So the flavor is a
node property, and the edge stays generic.

> **Note (PD-012): `challenge` is not a kind.** A challenge is an _operation_ that produces a
> refined idea **superseding** the one it contests (§2.3), not a parallel `challenge`-kind card.
> It is therefore absent from the kind set below.

A node has **one kind** (a card is one thing) but **many edges**, to **many targets**.
The genuinely common multiplicity is _one card → several targets_ (a cross-cutting
concern that's a risk of several ideas), which generic edges handle directly.

### 2.3 The one edge type that carries its own meaning: `supersedes`

The only relationship not derivable from the source's kind is a **structural** one:
when a card (often a refined `challenge`) is accepted and **replaces** its target
(#22 decision capture, #20 lifecycle). That's an effect on the target, not a flavor of
the source, so it lives on the edge:

```
IdeaRelation = 'about' | 'supersedes'    // extensible; 'about' is the default
```

Start with exactly these two. New _flavors_ are new `kind` values (data); new _structural
effects_ are new `IdeaRelation` values (rare). We resist a large relation enum on purpose.

### 2.4 Provenance is a third, independent axis

"The AI challenged my note" vs. "I added a risk to an AI note myself" is **not** a
relationship distinction — it's _who authored the node_, which already exists as
`origin: 'ai' | 'user'` (#31, PD-009). It is orthogonal: a `kind: risk` card linked to
target X can be either AI- or user-made, and that changes neither its kind nor its link.

## 3. Shapes

### 3.1 Wire / storage (shared, additive)

`CreateIdeaInput` in `packages/shared/src/idea.ts` carries the capture-time graph
fields — additive, so nothing that produces today's `{title, body, kind}` breaks:

```ts
export type IdeaRelation = "about" | "supersedes";

export interface IdeaLink {
  /** Short ref of the target card this idea is about (see §4 identity). */
  to: string;
  /** Defaults to 'about'; 'supersedes' means this card replaces the target. */
  relation?: IdeaRelation;
}

export interface CreateIdeaInput {
  title: string;
  body: string;
  kind?: string; // what it IS — drives presentation + lifecycle via the registry
  ref?: string; // canonical project ref reserved by the backend StateStore
  links?: IdeaLink[]; // 0..n edges to other cards; usually 0 or 1 from a verb
}
```

`links` is a list from day one so the model supports many edges, even though a single
verb-spawned idea usually carries one (its originating edge) or zero.

### 3.2 Kind registry (client-only)

The danger of a uniform node is a stringly-typed `kind` junk-drawer. We neutralize it
with a **registry** — the single client-side place where a kind's behavior lives. It
replaced the three parallel maps that used to live in `idea-descriptors.ts` (`KIND_LABEL`,
`KIND_BACKGROUND`, `KNOWN_KINDS`):

```ts
interface KindSpec {
  label: string; // e.g. '⚠ Risk'
  color: string; // tldraw palette color-style name (a shared StyleProp)
  shape?: "note" | "diamond"; // #40 — per-kind shape; 'note' for now
  lifecycle?: LifecycleSpec; // #20 — states + transitions; absent for now
}

const KIND_REGISTRY: Record<string, KindSpec> = {
  risk: { label: "⚠ Risk", color: "red" },
  feature: { label: "✨ Feature", color: "green" },
  question: { label: "❓ Question", color: "yellow" },
  decision: { label: "✅ Decision", color: "blue" }
  // …unknown kinds fall back to a plain '#tag' + default color, exactly as today.
};
```

**Adding an ideation concept = one registry entry.** No wire change, no parser branch,
no new marker. That is the whole point of the uniform node: new concepts are _data_, not
_code_.

### 3.3 Discussion is **not** a node

One concept deliberately stays outside this model: a _discussion_ is a **thread** (the
ordered terminal conversation), not a titled card. Don't force it into `{title, body}`.
A card links to _a moment in the conversation_ (that's #23, "jump to the terminal
moment") — a reference, not an idea-node. Knowing this boundary keeps the node shape from
over-fitting.

## 4. Identity: short refs

Edges need to name their endpoints, and the **AI must be able to reproduce an endpoint
name in its reply**. A tldraw shape id is a generated token a language model can't
reproduce. So every card gets a **short ref** — `i1`, `i2`, … — that is:

- reserved by the backend state store at card creation (AI cards and user cards
  use the same per-project allocator),
- stored on the card itself in its shape `meta.ref` (persisted with the shape; survives reload),
- the value used for `CreateIdeaInput.ref` and `IdeaLink.to`.

The ref space _is_ the identity layer; the shape id stays tldraw's internal concern.

## 5. The crux: prompt ↔ response correlation

The hard part (already flagged in #40). The verb prompt goes into an **async interactive
PTY**; the backend extracts ideas from the reply **independently**, with no built-in link
between "this verb fired from card i1" and "these ideas came back." We solve it with an
**injected correlation token**, not magic:

```
verb fires from card i1
   → primed prompt for this turn instructs: "tag every idea you emit with @i1"
   → agent reply: «IDEA:risk@i1» Token leak on reconnect :: refresh races the reattach
   → backend parses @i1 → Idea.links = [{ to: 'i1', relation: 'about' }]
   → applyIdeas resolves i1 → its card, places the new card near it, draws a bound arrow
```

### 5.1 Contract extension (reflow-safe, mirrors `kind`)

The extraction contract is a deliberately constrained, **reflow-resilient single line**
(read off a fixed-width `tmux capture-pane` grid), and it _already_ encodes a tag inside
the marker (`«IDEA:risk»`). The target ref slots into the same pattern:

```
«IDEA:risk@i1» <title> :: <body>        # kind=risk, link to i1 (relation 'about')
«IDEA@i1» <title> :: <body>             # no kind, link to i1
«IDEA:feature@i1!» <title> :: <body>    # trailing ! → 'supersedes' i1 (PD-012)
«IDEA@i1!@i2!@i3!» <title> :: <body>    # chained refs → supersedes i1+i2+i3 (combine/merge, PD-019)
```

Grammar delta (see `ai-response-extraction-contract.md` §3.2): the in-marker tag becomes
`[:kind][@ref[!]…]`. A **trailing `!`** on a ref makes that link `supersedes` instead of
the default `about` (PD-012) — keeping the one structural relation on the robust single-line
marker. **Refs may be chained** (`@i1!@i2!`) so one idea supersedes several sources at once —
the multi-select combine/merge verb (#62, PD-019); each ref carries its own optional `!`. The fenced form _also_ expresses it via `rel: supersedes`, but the agent's TUI
renders the code fence away before the backend captures the screen (PD-008), so in practice
the inline `!` is the form that reaches the parser; the Challenge verb emits `!`, not a
fence. The fenced form additionally has keys `id:`, `link:` (alias `parent:`), and `rel:`.
The dedup key (`ideaKey`) includes links (target + relation) so the same marker isn't
delivered twice.

### 5.2 Graceful degradation

If the agent ignores the tag (no `@ref`), the idea lands as today — an unlinked card.
Nothing breaks; you simply don't get the connector. The correlation is best-effort, and
the editable-prompt seam means the user can see/curate the prompt before submitting.

Open question deferred to implementation: an **out-of-band** fallback (correlate to the
session's "last verb invocation") is simpler but loses correctness if the user interleaves
prompts. The in-prompt token is preferred for correctness; the fallback is a maybe-later.

## 6. Persistence: the backend-owned board snapshot is the source of truth

The tldraw editor is the live client projection, while `backend/src/state/store.ts`
(the backend `StateStore`) owns the durable project documents. Each project board is saved as a complete
snapshot to `projects/<project-id>/board.json` through the `board-save` state
operation, with revisions used to detect competing or offline writes. Identity and
edges still live on the canvas itself, not in side-maps:

| Where                                               | Shape                   | Purpose         |
| --------------------------------------------------- | ----------------------- | --------------- |
| a card's `shape.meta.ref`                           | `i1`, `i2`, …           | identity (§4)   |
| a native arrow bound to both cards, `meta.relation` | `about` \| `supersedes` | the graph edges |

Edges are native tldraw **arrows bound to both endpoints** (so they track the cards as they
move), with the relation in the arrow's `meta`. The **shared package** (`@ai-storm/shared`) is the
"both sides know it" contract — satisfied by the wire types, not a second graph database. The
backend board snapshot is the one durable copy; the browser's localStorage only keeps UI session
preferences such as the active project, folder collapse, and camera state. AI priming over the
whole graph already works via the existing `serializeToText` → context-injection path (PRD §3.2).

## 7. Implementation status

**Shipped.** The model is live on the tldraw canvas (PD-013):

- the shared contract + extraction — `CreateIdeaInput` with `ref`/`links`, and the `@ref[!]`
  marker grammar (`ai-response-extraction-contract.md` §3.2) the backend parses;
- the `KIND_REGISTRY` (`idea-descriptors.ts`), replacing the old parallel label/color/known
  maps; the kind's color is a tldraw shared StyleProp;
- short-ref identity in `shape.meta.ref` (reserved by the backend `StateStore`, with
  client-side guards for imported/pasted cards);
- edges as native arrows bound to both cards, the relation in the arrow `meta`. `applyIdeas`
  resolves each `link.to` → its card, places the new card near it, and draws a relation-styled
  arrow; a verb injects the source card's ref into the primed prompt so responses come back
  tagged — "risks branch off the card" (#40) is real.

**Remaining (separate tickets, out of scope here).** Per-kind shapes and richer
model-driven affinity clustering remain future work. The shipped canvas already
supports lifecycle `supersedes` ghosts and manual graph-driven Arrange; those features
consume the registry + edges rather than reinvent them.

## 8. What this is explicitly _not_

- Not a separate graph database, and not multiplayer (PD-001 stands); the graph is
  persisted inside the backend-owned board snapshot.
- Not a relation taxonomy — `kind` carries flavor; edges stay generic bar `supersedes`.
- Not nesting/containment — flat nodes + edges.
- Not a change to how the conversation surface works (PD-008) — only the idea markers gain
  an optional `@ref`.
- Not the consumer features themselves — those are Phase 4 / separate issues.
