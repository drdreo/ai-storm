/**
 * The `idea-card` shape's schema — its typed props, `meta` shape, provenance
 * union, and the tldraw type-system registration (idea-graph.md §3). Kept free of
 * React/JSX so every other idea-card module (and the wider canvas) can import the
 * types without pulling in the renderer.
 */
import type { TLBaseShape, TLDefaultColorStyle } from "tldraw";
import type { IssueLink } from "../../issue-links";
import type { CardLink } from "../../card-links";

/** Provenance of a card (#31, PD-009): AI-created vs user-drawn. */
export type Origin = "ai" | "user";

/** A spatial idea card: the tldraw analogue of an `affine:note` (idea-graph §2.1). */
export type IdeaCardShape = TLBaseShape<
  "idea-card",
  {
    w: number;
    h: number;
    /** What it IS (idea-graph §2.2) — drives the badge via the registry. */
    kind: string;
    title: string;
    body: string;
    /** Who made it (#31, PD-009) — AI cards get the 🤖 badge. */
    origin: Origin;
    /** Lifecycle (#20, PD-012): a supersede target becomes a grey/dashed ghost. */
    superseded: boolean;
    /**
     * The card's tint — a **shared** tldraw color StyleProp (was a hardcoded
     * Affine hex). Being `DefaultColorStyle` makes it a first-class member of the
     * style panel: it remembers last-used, persists, and resolves to the active
     * light/dark theme automatically. `kind` sets its default (see `applyIdeas`);
     * the user can recolor freely without changing what the card *is*.
     */
    color: TLDefaultColorStyle;
  }
>;

/**
 * The metadata we hang on a card's `meta` (outside the styled props): its stable
 * SHORT REF (`a1`, `a2`, … — idea-graph §4). A tldraw shape id is a generated
 * token an LLM can't reproduce; the short ref is the identity an agent names in
 * its reply (`«IDEA@a1»`) and an edge points at. Persisted with the shape, so it
 * survives reload. Minted in `applyIdeas` for AI cards and lazily by
 * {@link cardRef} the first time a user card is referenced.
 */
export interface IdeaCardMeta {
  ref?: string;
  /** User mark — "good, keep for later processing" (#29). Toggled via the ★. */
  starred?: boolean;
  /**
   * Completion state (#167): the idea has been acted on / finished. Set by the
   * MCP `mark_idea_done` tool (an agent reflecting workflow progress) and by the
   * manual context-menu toggle. A done card reads as visibly completed (✓ mark,
   * struck title, dimmed) but stays on the board. `meta` (like `starred`/`score`)
   * so no schema migration; absent means open.
   */
  done?: boolean;
  /**
   * AI triage score (#60): 1..5 impact / effort (and optional confidence),
   * assigned by the agent via the `«SCORE@ref»` contract. Drives the 2×2
   * prioritization layout (and, later, visual weight). Absent until the board is
   * triaged — `meta` so no schema migration, exactly like `starred`.
   */
  score?: { impact: number; effort: number; confidence?: number };
  /**
   * Set the first time the user edits an AI card's text (#72). The card keeps its
   * `origin: 'ai'` provenance (and the 🤖 badge) but gains a `· edited` mark, so a
   * human take-over of an AI idea stays honest about both halves of its history.
   * `meta` (like `starred`/`score`) so no schema migration.
   */
  editedByUser?: boolean;
  /**
   * Epoch ms the card was created (#124) — stamped by the AI ingest path and the
   * manual "Idea" tool so full-text search can offer a date facet. `meta` (like
   * `starred`/`score`) so no schema migration; cards made before this landed
   * simply lack it and are treated as unknown-date by the search filter.
   */
  createdAt?: number;
  /**
   * The external tracker issue this card was handed off to (#125), stamped by
   * `applyIssueLinks` when a create-issues run reports which cards each created
   * issue came from. Rendered as a clickable link chip alongside any issue
   * references *detected* in the card's text (those are derived, never stored).
   * `meta` (like `starred`/`score`) so no schema migration.
   */
  issue?: IssueLink;
  /**
   * Generic external-link references attached to this card (#227) — the general
   * case of {@link issue}: any web URL (Figma, a Google Doc, a spec), set by the
   * agent via the MCP `link_idea` tool or by the user in the card's inline link
   * editor. Rendered as clickable chips alongside the issue links. `meta` (like
   * `starred`/`score`) so no schema migration; absent means none attached.
   */
  links?: CardLink[];
  [key: string]: unknown;
}

/**
 * Register the custom shape with tldraw's type system. tldraw 5 derives the
 * `TLShape` union from the augmentable `TLGlobalShapePropsMap` interface, so this
 * one declaration makes `idea-card` a first-class shape type everywhere — the
 * typed equivalent of registering a BlockSuite block flavour in the schema.
 */
declare module "tldraw" {
  interface TLGlobalShapePropsMap {
    "idea-card": IdeaCardShape["props"];
  }
}

export const CARD_W = 250;
export const CARD_H = 132;
export const CARD_MAX_W = 420;
