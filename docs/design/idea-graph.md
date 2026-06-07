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

Today a brainstorm board is a *pile* of cards, not a *graph*. The card verbs (#13
Discuss, #15 Expand/Challenge/Find-risks, #14 reply-to-card) feed an editable prompt
into the live terminal; the agent's reply streams back as terminal text, and the
backend independently extracts `«IDEA»` markers into `Idea {title, body, kind?}` →
`CanvasService.applyIdeas` → one card per idea (colored by `kind`, #21).

So responses already become cards — but **free-floating, with no link back to the card
the verb fired from**. Click "Find risks" on a card and the risk cards land wherever
the 4-column tiler drops them, visually disconnected from their source. That throws
away the spatial story an edgeless canvas is supposed to tell.

Several filed issues (#40 source-linked responses, #19 connector edges, #22 supersede,
#20 lifecycle, #16/#17 layout) all want the same two primitives underneath them:
**stable idea identity** and **typed relationships between ideas**. Building those
issues on position-only data means each reinvents identity + edges, or gets reworked
once edges exist. This document defines the primitive once, so they become cheap.

This is a **data-model refactor**, not a feature. It ships behind the existing pipeline
and is invisible until the consumer features (a separate epic) turn it on.

## 2. The model: three orthogonal axes

The core realization (see the dialogue captured in PD-010) is that three different
questions were being conflated into one `kind` field. They are independent:

| Axis | Question it answers | Lives on | Example values |
| --- | --- | --- | --- |
| **Kind** | *What is this card?* | the **node** | `idea`, `risk`, `question`, `feature`, `decision` (not `challenge` — PD-012) |
| **Link** | *What is it about?* | an **edge** | → points at another card |
| **Provenance** | *Who made it?* | the node (existing #31) | `user`, `ai` |

### 2.1 Nodes, not nesting

An idea is a **node**. Relationships are **edges**, never containment. Nesting (a risk
living *inside* an idea) assumes a tree — single owner, clean containment — but the real
usage breaks the tree:

- a concern can be a risk of **two** ideas (shared child — trees can't share),
- a fanned-out idea is **itself an idea** that grows its own risks (recursion),
- "challenge the challenge", "risk of the mitigation" — same-type children.

The moment children recurse or are shared, nesting *is* a graph wearing a costume. A
flat node set + typed edges handles sharing, re-parenting, and recursion natively.

### 2.2 Kind is what it *is*; the edge is what it's *about*

We deliberately do **not** carry a parallel relation taxonomy (`risk-of`, `challenge-of`,
`expands`) on the edge. That would store the flavor twice — `kind: risk` on the card
*and* `relation: risk-of` on its link say the same thing. Instead:

- The **node's `kind`** carries the flavor. A risk card is `kind: risk`. A feature is
  `kind: feature`.
- The **edge is generic** — "this card is *about* that card" (`relation: 'about'`). You
  read "it's a risk *of* X" by following an `about` edge from a `risk`-kind card to X.

Test for whether a label is a kind or a relation: **does it need a target to make sense?**
"risk **of**" only means something pointed at a target — but that target is already supplied
by the edge, and the *flavor* (risk vs feature) is the source card's kind. So the flavor is a
node property, and the edge stays generic.

> **Note (PD-012): `challenge` is not a kind.** A challenge is an *operation* that produces a
> refined idea **superseding** the one it contests (§2.3), not a parallel `challenge`-kind card.
> It is therefore absent from the kind set below.

A node has **one kind** (a card is one thing) but **many edges**, to **many targets**.
The genuinely common multiplicity is *one card → several targets* (a cross-cutting
concern that's a risk of several ideas), which generic edges handle directly.

### 2.3 The one edge type that carries its own meaning: `supersedes`

The only relationship not derivable from the source's kind is a **structural** one:
when a card (often a refined `challenge`) is accepted and **replaces** its target
(#22 decision capture, #20 lifecycle). That's an effect on the target, not a flavor of
the source, so it lives on the edge:

```
IdeaRelation = 'about' | 'supersedes'    // extensible; 'about' is the default
```

Start with exactly these two. New *flavors* are new `kind` values (data); new *structural
effects* are new `IdeaRelation` values (rare). We resist a large relation enum on purpose.

### 2.4 Provenance is a third, independent axis

"The AI challenged my note" vs. "I added a risk to an AI note myself" is **not** a
relationship distinction — it's *who authored the node*, which already exists as
`origin: 'ai' | 'user'` (#31, PD-009). It is orthogonal: a `kind: risk` card linked to
target X can be either AI- or user-made, and that changes neither its kind nor its link.

## 3. Shapes

### 3.1 Wire / storage (shared, additive)

`Idea` in `packages/shared/src/protocol.ts` gains three optional fields — additive, so
nothing that produces today's `{title, body, kind}` breaks:

```ts
export type IdeaRelation = 'about' | 'supersedes';

export interface IdeaLink {
  /** Short ref of the target card this idea is about (see §4 identity). */
  to: string;
  /** Defaults to 'about'; 'supersedes' means this card replaces the target. */
  relation?: IdeaRelation;
}

export interface Idea {
  title: string;
  body: string;
  kind?: string;          // what it IS — drives presentation + lifecycle via the registry
  id?: string;            // this idea's own short ref (usually backend/canvas-minted)
  links?: IdeaLink[];     // 0..n edges to other cards; usually 0 or 1 from a verb
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
  label: string;                 // e.g. '⚠ Risk'
  color: string;                 // tldraw palette color-style name (a shared StyleProp)
  shape?: 'note' | 'diamond';    // #40 — per-kind shape; 'note' for now
  lifecycle?: LifecycleSpec;     // #20 — states + transitions; absent for now
}

const KIND_REGISTRY: Record<string, KindSpec> = {
  risk:      { label: '⚠ Risk',      color: 'red' },
  feature:   { label: '✨ Feature',   color: 'green' },
  question:  { label: '❓ Question',  color: 'yellow' },
  decision:  { label: '✅ Decision',  color: 'blue' },
  // …unknown kinds fall back to a plain '#tag' + default color, exactly as today.
};
```

**Adding an ideation concept = one registry entry.** No wire change, no parser branch,
no new marker. That is the whole point of the uniform node: new concepts are *data*, not
*code*.

### 3.3 Discussion is **not** a node

One concept deliberately stays outside this model: a *discussion* is a **thread** (the
ordered terminal conversation), not a titled card. Don't force it into `{title, body}`.
A card links to *a moment in the conversation* (that's #23, "jump to the terminal
moment") — a reference, not an idea-node. Knowing this boundary keeps the node shape from
over-fitting.

## 4. Identity: short refs

Edges need to name their endpoints, and the **AI must be able to reproduce an endpoint
name in its reply**. A tldraw shape id is a generated token a language model can't
reproduce. So every card gets a **short ref** — `a1`, `a2`, … — that is:

- minted at card creation (in `applyIdeas` for AI cards; lazily for a user card the
  first time it's referenced),
- stored on the card itself in its shape `meta.ref` (persisted with the shape; survives reload),
- the value used for `Idea.id` and `IdeaLink.to`.

The ref space *is* the identity layer; the shape id stays tldraw's internal concern.

## 5. The crux: prompt ↔ response correlation

The hard part (already flagged in #40). The verb prompt goes into an **async interactive
PTY**; the backend extracts ideas from the reply **independently**, with no built-in link
between "this verb fired from card a1" and "these ideas came back." We solve it with an
**injected correlation token**, not magic:

```
verb fires from card a1
   → primed prompt for this turn instructs: "tag every idea you emit with @a1"
   → agent reply: «IDEA:risk@a1» Token leak on reconnect :: refresh races the reattach
   → backend parses @a1 → Idea.links = [{ to: 'a1', relation: 'about' }]
   → applyIdeas resolves a1 → its card, places the new card near it, draws a bound arrow
```

### 5.1 Contract extension (reflow-safe, mirrors `kind`)

The extraction contract is a deliberately constrained, **reflow-resilient single line**
(read off a fixed-width `tmux capture-pane` grid), and it *already* encodes a tag inside
the marker (`«IDEA:risk»`). The target ref slots into the same pattern:

```
«IDEA:risk@a1» <title> :: <body>        # kind=risk, link to a1 (relation 'about')
«IDEA@a1» <title> :: <body>             # no kind, link to a1
«IDEA:feature@a1!» <title> :: <body>    # trailing ! → 'supersedes' a1 (PD-012)
«IDEA@a1!@a2!@a3!» <title> :: <body>    # chained refs → supersedes a1+a2+a3 (combine/merge, PD-019)
```

Grammar delta (see `ai-response-extraction-contract.md` §3.2): the in-marker tag becomes
`[:kind][@ref[!]…]`. A **trailing `!`** on a ref makes that link `supersedes` instead of
the default `about` (PD-012) — keeping the one structural relation on the robust single-line
marker. **Refs may be chained** (`@a1!@a2!`) so one idea supersedes several sources at once —
the multi-select combine/merge verb (#62, PD-019); each ref carries its own optional `!`. The fenced form *also* expresses it via `rel: supersedes`, but the agent's TUI
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

## 6. Persistence: the canvas store is the single source of truth

No server-side graph store. The tldraw canvas store (persisted per workspace via
`persistenceKey` → IndexedDB, PD-005/PD-013) is the source of truth. Identity and edges live on
the canvas itself, not in side-maps:

| Where | Shape | Purpose |
| --- | --- | --- |
| a card's `shape.meta.ref` | `a1`, `a2`, … | identity (§4) |
| a native arrow bound to both cards, `meta.relation` | `about` \| `supersedes` | the graph edges |

Edges are native tldraw **arrows bound to both endpoints** (so they track the cards as they
move), with the relation in the arrow's `meta`. The **shared package** (`@ai-storm/shared`) is the
"both sides know it" contract — satisfied by the wire types, not a second persistence home. A
server graph DB would split truth between the board and the DB and create a sync problem we don't
have today. Revisit only if multi-device/collab (PD-001) or server-side graph reasoning becomes a
goal. AI priming over the whole graph already works via the existing `serializeToText` →
context-injection path (PRD §3.2).

## 7. Implementation status

**Shipped.** The model is live on the tldraw canvas (PD-013):

- the shared contract + extraction — `Idea` with `id`/`links`, and the `@ref[!]` marker
  grammar (`ai-response-extraction-contract.md` §3.2) the backend parses;
- the `KIND_REGISTRY` (`idea-descriptors.ts`), replacing the old parallel label/color/known
  maps; the kind's color is a tldraw shared StyleProp;
- short-ref identity in `shape.meta.ref` (minted in `applyIdeas`, lazily via `cardRef`);
- edges as native arrows bound to both cards, the relation in the arrow `meta`. `applyIdeas`
  resolves each `link.to` → its card, places the new card near it, and draws a relation-styled
  arrow; a verb injects the source card's ref into the primed prompt so responses come back
  tagged — "risks branch off the card" (#40) is real.

**Remaining (separate tickets, out of scope here).** Per-kind shapes (#40), lifecycle +
`supersedes` / replace-on-challenge (#20, #22), semantic layout/clustering near targets
(#16, #17). They consume the registry + edges; they don't reinvent them.

## 8. What this is explicitly *not*

- Not a server-side store, and not multiplayer (PD-001 stands).
- Not a relation taxonomy — `kind` carries flavor; edges stay generic bar `supersedes`.
- Not nesting/containment — flat nodes + edges.
- Not a change to how the conversation surface works (PD-008) — only the idea markers gain
  an optional `@ref`.
- Not the consumer features themselves — those are Phase 4 / separate issues.
