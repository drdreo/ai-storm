# Design: the idea graph (identity, typed edges, kind registry)

**Status:** 🟡 Proposed — design for the foundational data-model refactor that the
output-visualization epic builds on.
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
`CanvasService.applyIdeas` → one tinted note card per idea (tint by `kind`, #21).

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
absorbs and replaces the three parallel maps that exist today (`KIND_LABEL`,
`KIND_BACKGROUND`, `KNOWN_KINDS` in `idea-descriptors.ts`):

```ts
interface KindSpec {
  label: string;                 // e.g. '⚠ Risk' (today: KIND_LABEL)
  background: string;            // note tint CSS var (today: KIND_BACKGROUND)
  shape?: 'note' | 'diamond';    // #40 — per-kind shape; 'note' for now
  lifecycle?: LifecycleSpec;     // #20 — states + transitions; absent for now
}

const KIND_REGISTRY: Record<string, KindSpec> = {
  risk:      { label: '⚠ Risk',      background: '--affine-note-background-red' },
  feature:   { label: '✨ Feature',   background: '--affine-note-background-green' },
  question:  { label: '❓ Question',  background: '--affine-note-background-yellow' },
  decision:  { label: '✅ Decision',  background: '--affine-note-background-blue' },
  // …unknown kinds fall back to a plain '#tag' + default tint, exactly as today.
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
name in its reply**. A BlockSuite block id (21-char nanoid) is unreproducible by a
language model. So every card gets a **short ref** — `a1`, `a2`, … — that is:

- minted at card creation (in `applyIdeas` for AI cards; lazily for a user card the
  first time it's referenced),
- stored in a CRDT map alongside the existing kind/provenance maps (`ai-storm:ref`,
  `noteId ↔ ref`, bidirectional),
- the value used for `Idea.id` and `IdeaLink.to`.

The ref space *is* the identity layer. The block id stays BlockSuite's internal concern.

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
   → applyIdeas resolves a1 → its noteId, places the new card near it, draws a connector
```

### 5.1 Contract extension (reflow-safe, mirrors `kind`)

The extraction contract is a deliberately constrained, **reflow-resilient single line**
(read off a fixed-width `tmux capture-pane` grid), and it *already* encodes a tag inside
the marker (`«IDEA:risk»`). The target ref slots into the same pattern:

```
«IDEA:risk@a1» <title> :: <body>        # kind=risk, link to a1
«IDEA@a1» <title> :: <body>             # no kind, link to a1
```

Grammar delta (see `ai-response-extraction-contract.md` §3.2): the in-marker tag becomes
`[:kind][@ref]`. The fenced form gains recognized keys `id:`, `link:` (alias `parent:`),
and `rel:`. The dedup key (`ideaKey`) extends to include links so the same marker isn't
delivered twice.

### 5.2 Graceful degradation

If the agent ignores the tag (no `@ref`), the idea lands as today — an unlinked card.
Nothing breaks; you simply don't get the connector. The correlation is best-effort, and
the editable-prompt seam means the user can see/curate the prompt before submitting.

Open question deferred to implementation: an **out-of-band** fallback (correlate to the
session's "last verb invocation") is simpler but loses correctness if the user interleaves
prompts. The in-prompt token is preferred for correctness; the fallback is a maybe-later.

## 6. Persistence: client CRDT stays the single source of truth

No server-side graph store. The canvas CRDT (Yjs subdocs → IndexedDB, PD-005) is already
the source of truth and persistence story, and the kind/provenance side-maps already prove
the pattern. We add **two more** namespaced maps on the workspace subdoc:

| Key | Shape | Purpose |
| --- | --- | --- |
| `ai-storm:ref` | `noteId ↔ shortRef` | identity (§4) |
| `ai-storm:edges` | list of `{ from, to, relation }` (noteIds) | the graph edges |

Drawn on the surface as `affine:connector` elements. The **shared package** (`@ai-storm/shared`)
is the "both sides know it" contract — that requirement is satisfied by the wire types, not by a
second persistence home. A server graph DB would split truth between the board and the DB and
create a sync problem we don't have today. Revisit only if multi-device/collab (PD-001) or
server-side graph reasoning becomes a goal. AI priming over the whole graph already works via
the existing `serializeToText` → context-injection path (PRD §3.2).

## 7. Phased refactor plan

Each phase ships independently and is invisible to users until Phase 3 — no big-bang.

- **Phase 0 — Connector spike (de-risk).** Confirm the BlockSuite `affine:connector` API:
  create one programmatically between two `affine:note` elements, confirm it persists in
  the CRDT subdoc and survives reload. This is the one real unknown; prove it before
  committing to the plan. *(throwaway branch)*

- **Phase 1 — Contract & types (no behavior change).** Extend shared `Idea`
  (`id`, `links`, `IdeaRelation`, `IdeaLink`). Extend backend `extraction.ts`: marker
  regex parses `@ref`, fenced keys `id`/`link`/`rel`, dedup key includes links. Update the
  priming text + `ai-response-extraction-contract.md`. Frontend ignores `links` for now.
  Fully unit-testable (backend extraction + shared types). *(ships green, dormant)*

- **Phase 2 — Identity & registry (frontend, no edges yet).** Collapse
  `KIND_LABEL`/`KIND_BACKGROUND`/`KNOWN_KINDS` into `KIND_REGISTRY`. Add the `ai-storm:ref`
  map + `cardRef(workspaceId, noteId)` / `resolveRef(workspaceId, ref)` on `CanvasService`;
  mint refs in `applyIdeas`. No visible change (registry is a pure refactor; refs are
  internal plumbing).

- **Phase 3 — Edges & connectors (the payoff).** Store edges in `ai-storm:edges`; in
  `applyIdeas`, resolve each `link.to` ref → noteId, place the new card near its target
  (minimal offset — full layout is #16), and draw the connector. Inject the source card's
  ref into the primed prompt when a verb fires, so verb responses come back tagged. This is
  where "risks branch off the card" (#40) becomes real.

- **Phase 4 — consumer features (separate tickets, out of scope here).** Per-kind shapes
  (#40), lifecycle + `supersedes` / replace-on-challenge (#20, #22), semantic layout/
  clustering near targets (#16, #17). They consume the registry + edges; they don't
  reinvent them.

## 8. What this is explicitly *not*

- Not a server-side store, and not multiplayer (PD-001 stands).
- Not a relation taxonomy — `kind` carries flavor; edges stay generic bar `supersedes`.
- Not nesting/containment — flat nodes + edges.
- Not a change to how the conversation surface works (PD-008) — only the idea markers gain
  an optional `@ref`.
- Not the consumer features themselves — those are Phase 4 / separate issues.
