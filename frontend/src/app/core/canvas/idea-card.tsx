/**
 * The custom `idea-card` shape — the idea-graph node (idea-graph.md §3) and the
 * foundation every other canvas module builds on. Owns the shape type + its
 * `ShapeUtil`, the rendered card body, and the low-level identity/content helpers
 * (`ideaCards`, refs, reading order). Kept "as close to native tldraw as possible":
 * the card tint is a real shared `color` StyleProp, so cards live in the style panel
 * and follow the light/dark theme.
 */
import {
  DefaultColorStyle,
  type Editor,
  type Geometry2d,
  getColorValue,
  HTMLContainer,
  type RecordProps,
  Rectangle2d,
  resizeBox,
  ShapeUtil,
  stopEventPropagation,
  T,
  type TLBaseShape,
  type TLDefaultColorStyle,
  type TLResizeInfo,
  type TLShapeId,
  useColorMode,
  useEditor,
  useIsEditing
} from "tldraw";
import { useEffect, useState } from "react";
import { type CardContent, cardToText } from "../canvas-text";
import { AI_PROVENANCE_BADGE, kindLabel, normalizeKind } from "../idea-descriptors";
import { collectIssueLinks, type IssueLink } from "../issue-links";
import { type CardLink, linkLabel, normalizeLinkUrl, upsertLink } from "../card-links";
import { issueStatus, useIssueStatusStore } from "../../stores/issue-status.store";
import { canvasRefIndex } from "./refs";

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

const CARD_HORIZONTAL_PADDING = 24;
const CARD_VERTICAL_PADDING = 20;
const CARD_META_ROW_H = 17;
const CARD_GAP = 5;
const CARD_TITLE_LINE_H = 18;
const CARD_BODY_LINE_H = 17;
const CARD_TITLE_CHAR_W = 7.5;
const CARD_BODY_CHAR_W = 6.2;

export interface IdeaCardSizeInput {
  kind?: string;
  title?: string;
  body?: string;
  origin?: Origin;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function measuredTextWidth(text: string, font: string): number | undefined {
  if (typeof document === "undefined") return undefined;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return undefined;
  ctx.font = font;
  return ctx.measureText(text).width;
}

function measuredLineCount(text: string, usableWidth: number, font: string): number | undefined {
  if (typeof document === "undefined") return undefined;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return undefined;
  ctx.font = font;

  let lines = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const words = rawLine.trimEnd().split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines += 1;
      continue;
    }

    let current = "";
    for (const word of words) {
      const next = current ? `${current} ${word}` : word;
      if (ctx.measureText(next).width <= usableWidth) {
        current = next;
        continue;
      }
      if (current) lines += 1;
      current = word;
    }
    lines += current ? Math.max(1, Math.ceil(ctx.measureText(current).width / usableWidth)) : 1;
  }
  return lines;
}

function estimatedLineCount(text: string, usableWidth: number, charWidth: number, font: string): number {
  const measured = measuredLineCount(text, usableWidth, font);
  if (measured != null) return measured;

  const charsPerLine = Math.max(1, Math.floor(usableWidth / charWidth));
  return text
    .split(/\r?\n/)
    .reduce((sum, line) => sum + Math.max(1, Math.ceil(line.trimEnd().length / charsPerLine)), 0);
}

/**
 * Estimate an idea card's initial size from its content (#215). This runs only
 * before creation: once the card exists, the user's manual resize is the source
 * of truth and edits do not auto-resize it out from under them.
 */
export function ideaCardSizeForContent(input: IdeaCardSizeInput): { w: number; h: number } {
  const title = input.title?.trim() || "Untitled idea";
  const body = input.body?.trim() ?? "";
  const normalizedKind = normalizeKind(input.kind);
  const hasMetaRow = input.origin === "ai" || !!normalizedKind;

  const titleFont = "600 14px tldraw_sans, sans-serif";
  const bodyFont = "12px tldraw_sans, sans-serif";
  const titleTextWidth = measuredTextWidth(title, titleFont) ?? title.length * CARD_TITLE_CHAR_W;
  const titleWidth = Math.ceil(titleTextWidth + CARD_HORIZONTAL_PADDING + 34 + 2);
  const bodyWidth = body
    ? Math.ceil(
        body
          .split(/\r?\n/)
          .reduce(
            (max, line) =>
              Math.max(max, measuredTextWidth(line.trimEnd(), bodyFont) ?? line.trimEnd().length * CARD_BODY_CHAR_W),
            0
          ) +
          CARD_HORIZONTAL_PADDING +
          2
      )
    : 0;
  const w = clamp(Math.max(CARD_W, titleWidth, bodyWidth), CARD_W, CARD_MAX_W);

  const usableWidth = w - CARD_HORIZONTAL_PADDING - 2;
  const titleLines = estimatedLineCount(title, usableWidth - 22, CARD_TITLE_CHAR_W, titleFont);
  const bodyLines = body ? estimatedLineCount(body, usableWidth, CARD_BODY_CHAR_W, bodyFont) : 0;
  const contentH =
    2 +
    CARD_VERTICAL_PADDING +
    (hasMetaRow ? CARD_META_ROW_H + CARD_GAP : 0) +
    titleLines * CARD_TITLE_LINE_H +
    (bodyLines > 0 ? CARD_GAP + bodyLines * CARD_BODY_LINE_H : 0);

  return { w, h: Math.ceil(contentH) };
}

/**
 * Card ink (#77 audit M4). Deliberately card-LOCAL near-black / near-white, NOT
 * the app `--foreground`: the text sits on the card's colored `semi` tint (a
 * sticky-note), so it tracks tldraw's light/dark card surface, not the app
 * chrome behind the canvas. Named here rather than inlined so the intent is
 * explicit and the values live in one place.
 */
const CARD_INK_LIGHT = "#1c1c1c";
const CARD_INK_DARK = "#e8e8e8";
/** The gold of the "kept for later" star mark (#29). */
const STAR_GOLD = "#f5b301";
/** The green of the "done / complete" mark (#167) — a finished, not discarded, card. */
const DONE_GREEN = "#3fa45b";
/** Warning amber for a low-confidence triage score's chip (#100). */
const LOW_CONFIDENCE_AMBER = "#e0a712";
/** GitHub's issue-state hues — the linked-issue chip's status dot (#125). */
const ISSUE_OPEN_GREEN = "#1a7f37";
const ISSUE_CLOSED_PURPLE = "#8250df";

/**
 * One triage score chip (#100) — a small pill in the card's bottom stat strip,
 * tinted from the card's accent so it stays legible on every card color in both
 * themes. `color-mix` keeps the fill/outline derived from a single accent —
 * normally the card's own, but the confidence chip passes
 * {@link LOW_CONFIDENCE_AMBER} instead when the score is shaky (#100), so a low
 * rating reads as a warning rather than just another same-colored stat.
 */
const scoreChip = (accent: string): React.CSSProperties => ({
  padding: "1px 7px",
  borderRadius: 999,
  lineHeight: 1.5,
  color: accent,
  background: `color-mix(in srgb, ${accent} 16%, transparent)`,
  border: `1px solid color-mix(in srgb, ${accent} 40%, transparent)`
});

/**
 * One linked-issue chip (#125) — a clickable pill in the card's bottom stat
 * strip beside the triage score chips. GitHub issues get a status dot in
 * GitHub's own open/closed hues (fetched lazily through the status store);
 * Linear chips render without one (no API key to ask with). `stopEventPropagation`
 * on pointerdown keeps tldraw from starting a drag/selection, while the click
 * itself stays default so the anchor opens the tracker in a new tab.
 */
function IssueLinkChip({ link, accent }: { link: IssueLink; accent: string }): React.JSX.Element {
  const status = useIssueStatusStore((s) => s.statuses[link.url]);
  useEffect(() => {
    issueStatus.request(link.url);
  }, [link.url]);
  // The chip shows the short number (`#125` / `ENG-12`); the repo lives in the
  // tooltip — card space is scarce and the key column already reads as "issue".
  const label = link.provider === "github" ? `#${link.key.split("#")[1] ?? link.key}` : link.key;
  const state = status && status.state !== "unknown" ? status.state : null;
  const dot = state === "open" ? ISSUE_OPEN_GREEN : state === "closed" ? ISSUE_CLOSED_PURPLE : null;
  const title = `${link.title ? `${link.title} — ` : ""}${link.key}${state ? ` (${state})` : ""}`;
  return (
    <a
      href={link.url}
      target="_blank"
      rel="noreferrer"
      title={title}
      onPointerDown={stopEventPropagation}
      style={{
        ...scoreChip(accent),
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        textDecoration: "none"
      }}
    >
      {dot ? (
        <span aria-hidden style={{ width: 6, height: 6, borderRadius: 999, background: dot, flexShrink: 0 }} />
      ) : null}
      {label}
    </a>
  );
}

/**
 * One generic external-link chip (#227) — a clickable pill in the card's bottom
 * stat strip, the general case of {@link IssueLinkChip} (no tracker status dot,
 * since a plain link has no API to ask). Shows the link's label (or its host)
 * with a ↗ external-link cue; the full URL lives in the tooltip. While the card
 * is being edited, a × appears to detach the link. `stopEventPropagation` on
 * pointerdown keeps tldraw from starting a drag; the anchor click stays default
 * so it opens the URL in a new tab.
 */
function CardLinkChip({
  link,
  accent,
  editing,
  onRemove
}: {
  link: CardLink;
  accent: string;
  editing: boolean;
  onRemove: () => void;
}): React.JSX.Element {
  return (
    <span style={{ ...scoreChip(accent), display: "inline-flex", alignItems: "center", gap: 4 }}>
      <a
        href={link.url}
        target="_blank"
        rel="noreferrer"
        title={link.url}
        onPointerDown={stopEventPropagation}
        style={{ display: "inline-flex", alignItems: "center", gap: 3, color: accent, textDecoration: "none" }}
      >
        {linkLabel(link)}
        <span aria-hidden style={{ opacity: 0.7 }}>
          ↗
        </span>
      </a>
      {editing ? (
        <button
          type="button"
          title="Remove link"
          aria-label={`Remove link ${linkLabel(link)}`}
          onPointerDown={stopEventPropagation}
          onClick={(e) => {
            stopEventPropagation(e);
            onRemove();
          }}
          style={{
            border: "none",
            background: "transparent",
            cursor: "pointer",
            padding: 0,
            margin: 0,
            lineHeight: 1,
            color: accent,
            opacity: 0.7,
            fontSize: 11
          }}
        >
          ✕
        </button>
      ) : null}
    </span>
  );
}

/**
 * The inline "add link" affordance shown while a card is being edited (#227):
 * an expandable row with a URL field and an optional label field (the
 * Confluence-style "text → url"), pinned below the card's edit fields. Pasting a
 * URL and pressing Enter (or Add) normalizes it (a bare host gains `https://`;
 * non-http schemes are rejected) and appends it to `meta.links` via
 * {@link upsertLink}. Kept local so the read view stays a plain set of chips.
 */
function CardLinkEditor({ shape, accent }: { shape: IdeaCardShape; accent: string }): React.JSX.Element {
  const editor = useEditor();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState(false);

  const add = () => {
    const normalized = normalizeLinkUrl(url);
    if (!normalized) {
      setError(true);
      return;
    }
    const trimmedLabel = label.trim();
    const link: CardLink = trimmedLabel ? { url: normalized, label: trimmedLabel } : { url: normalized };
    const links = upsertLink(((shape.meta as IdeaCardMeta).links ?? []) as CardLink[], link);
    editor.updateShape({ id: shape.id, type: "idea-card", meta: { ...shape.meta, links } });
    setUrl("");
    setLabel("");
    setError(false);
    setOpen(false);
  };

  const field: React.CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    border: `1px solid color-mix(in srgb, ${accent} 40%, transparent)`,
    borderRadius: 6,
    background: "transparent",
    color: "inherit",
    padding: "3px 6px",
    fontSize: 11,
    outline: "none"
  };

  if (!open) {
    return (
      <button
        type="button"
        onPointerDown={stopEventPropagation}
        onClick={(e) => {
          stopEventPropagation(e);
          setOpen(true);
        }}
        style={{ ...scoreChip(accent), cursor: "pointer", border: `1px dashed color-mix(in srgb, ${accent} 45%, transparent)` }}
      >
        🔗 Add link
      </button>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, width: "100%" }} onPointerDown={stopEventPropagation}>
      <input
        autoFocus
        value={url}
        placeholder="Paste URL…"
        onChange={(e) => {
          setUrl(e.target.value);
          setError(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setOpen(false);
          }
        }}
        style={{ ...field, borderColor: error ? "#e5484d" : field.borderColor }}
      />
      <input
        value={label}
        placeholder="Label (optional)"
        onChange={(e) => setLabel(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setOpen(false);
          }
        }}
        style={field}
      />
      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
        <button
          type="button"
          onClick={(e) => {
            stopEventPropagation(e);
            setOpen(false);
          }}
          style={{ ...scoreChip(accent), cursor: "pointer" }}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={(e) => {
            stopEventPropagation(e);
            add();
          }}
          style={{ ...scoreChip(accent), cursor: "pointer", fontWeight: 700 }}
        >
          Add
        </button>
      </div>
    </div>
  );
}

/**
 * Shared style for the in-edit title/body fields (#72): a borderless, transparent
 * textarea that sits exactly where the read-only text was, so entering edit mode
 * doesn't shift the card's layout. Font/size/color are applied per-field.
 */
const EDIT_FIELD: React.CSSProperties = {
  width: "100%",
  border: "none",
  outline: "none",
  background: "transparent",
  padding: 0,
  margin: 0,
  resize: "none",
  fontFamily: "inherit",
  overflow: "hidden"
};

export class IdeaCardShapeUtil extends ShapeUtil<IdeaCardShape> {
  static override type = "idea-card" as const;
  static override props: RecordProps<IdeaCardShape> = {
    w: T.number,
    h: T.number,
    kind: T.string,
    title: T.string,
    body: T.string,
    origin: T.literalEnum("ai", "user"),
    superseded: T.boolean,
    // A real shared style — this is what wires the card into the style panel and
    // the theme's light/dark color resolution (tldraw styles system).
    color: DefaultColorStyle
  };

  override getDefaultProps(): IdeaCardShape["props"] {
    return {
      w: CARD_W,
      h: CARD_H,
      kind: "",
      title: "Untitled idea",
      body: "",
      origin: "user",
      superseded: false,
      color: "blue"
    };
  }

  override getGeometry(shape: IdeaCardShape): Geometry2d {
    return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: true });
  }

  override canResize = () => true;
  override canEdit = () => true;

  // The card's text representation — what tldraw joins into the `text/plain`
  // clipboard fallback, search, and drag-out. Without it a copied card has no
  // text and consumers fall back to the shape blob (#74).
  override getText(shape: IdeaCardShape): string {
    return cardToText(content(shape));
  }

  override onResize(shape: IdeaCardShape, info: TLResizeInfo<IdeaCardShape>) {
    return resizeBox(shape, info);
  }

  override component(shape: IdeaCardShape) {
    return <IdeaCardBody shape={shape} />;
  }

  // tldraw 5 takes the selection outline as a Path2D (was a JSX <rect> in v3).
  override getIndicatorPath(shape: IdeaCardShape): Path2D {
    const path = new Path2D();
    path.rect(0, 0, shape.props.w, shape.props.h);
    return path;
  }
}

/**
 * The card's rendered body — a function component (so React hooks are legal)
 * resolving the shape's `color` style against the CURRENT theme. `getColorValue`
 * + `useColorMode` is the styles-system replacement for the old `KIND_TINT`
 * Affine-hex map: the same card reads as a soft `semi` fill in light mode and the
 * theme's dark equivalent in dark mode, with a `solid` accent for the badge. A
 * superseded card (#20, PD-012) recedes to a grey, dashed-border ghost.
 */
function IdeaCardBody({ shape }: { shape: IdeaCardShape }): React.JSX.Element {
  const editor = useEditor();
  const colorMode = useColorMode();
  const isEditing = useIsEditing(shape.id);
  const { kind, title, body, origin, superseded, color } = shape.props;
  const colors = editor.getCurrentTheme().colors[colorMode];
  const swatch = superseded ? "grey" : color;
  const tint = getColorValue(colors, swatch, "semi");
  const accent = getColorValue(colors, swatch, "solid");
  const text = superseded ? accent : colorMode === "dark" ? CARD_INK_DARK : CARD_INK_LIGHT;

  const normalized = normalizeKind(kind);
  // Mirrors `decorateProvenance(decorateTitle(...))`: a 🤖 for AI cards, then the
  // registry's kind label (or `#tag` for an unknown kind).
  const badge = `${origin === "ai" ? `${AI_PROVENANCE_BADGE} ` : ""}${normalized ? kindLabel(normalized) : ""}`.trim();

  // User mark (#29): "keep this one for later". Stored in meta (no schema
  // migration), persists with the card, toggled by the ★ in the corner.
  const starred = !!(shape.meta as IdeaCardMeta).starred;
  const score = (shape.meta as IdeaCardMeta).score;
  const editedByUser = !!(shape.meta as IdeaCardMeta).editedByUser;
  // Completion (#167): a done idea stays on the board but reads as finished — a
  // green ✓ in the meta row, a struck title, and a dimmed card. Distinct from a
  // superseded ghost (grey/dashed, #20): done is "we did it", not "replaced".
  const done = !superseded && !!(shape.meta as IdeaCardMeta).done;
  // A confidence of 1-2 (#100) is the agent flagging its own rating as shaky —
  // the chip flips to a warning amber instead of the card's own accent, rather
  // than softening the whole card (that read as broken, not "low confidence").
  const lowConfidence = typeof score?.confidence === "number" && score.confidence <= 2;
  // External issue links (#125): the explicit hand-off link stamped on meta
  // plus any references detected in the card's own text — derived per render,
  // never stored, so editing the text updates the chips immediately.
  const issueLinks = collectIssueLinks(title, body, (shape.meta as IdeaCardMeta).issue);
  // Generic external links (#227): the general case of the issue link — any web
  // URL, attached explicitly (MCP `link_idea` or the inline editor). Deduped
  // against the issue chips so a link that is already a tracked issue isn't
  // rendered twice.
  const issueUrls = new Set(issueLinks.map((l) => l.url));
  const cardLinks = (((shape.meta as IdeaCardMeta).links ?? []) as CardLink[]).filter((l) => !issueUrls.has(l.url));
  const removeLink = (url: string) => {
    const links = (((shape.meta as IdeaCardMeta).links ?? []) as CardLink[]).filter((l) => l.url !== url);
    editor.updateShape({ id: shape.id, type: "idea-card", meta: { ...shape.meta, links } });
  };
  const toggleStar = (e: React.SyntheticEvent) => {
    stopEventPropagation(e);
    editor.updateShape({
      id: shape.id,
      type: "idea-card",
      meta: { ...shape.meta, starred: !starred }
    });
  };

  // Live text edit (#72). tldraw enters this shape's edit mode on double-click /
  // Enter (canEdit === true); we then swap the read-only title/body for inputs.
  // The first user keystroke on an AI card stamps `editedByUser` — provenance
  // stays `ai` (the 🤖 endures) but a `· edited` mark records the human take-over.
  const edit = (patch: Partial<Pick<IdeaCardShape["props"], "title" | "body">>) => {
    const stampEdited = origin === "ai" && !editedByUser;
    editor.updateShape({
      id: shape.id,
      type: "idea-card",
      props: patch,
      ...(stampEdited ? { meta: { ...shape.meta, editedByUser: true } } : {})
    });
  };

  return (
    <HTMLContainer
      style={{
        width: shape.props.w,
        height: shape.props.h,
        boxSizing: "border-box",
        padding: "10px 12px",
        borderRadius: 10,
        background: tint,
        border: superseded ? `2px dashed ${accent}` : `1px solid ${accent}`,
        boxShadow: superseded ? "none" : "0 1px 4px rgba(0,0,0,0.12)",
        color: text,
        fontFamily: "var(--tl-font-sans, system-ui, sans-serif)",
        display: "flex",
        flexDirection: "column",
        gap: 5,
        // While editing, let the inline link editor extend past the card's fixed
        // height without being clipped (#227); read view stays clipped.
        overflow: isEditing ? "visible" : "hidden",
        pointerEvents: "all",
        opacity: superseded ? 0.85 : done ? 0.72 : 1
      }}
    >
      <button
        type="button"
        title={starred ? "Marked — keep for later (click to unmark)" : "Mark this idea for later"}
        aria-pressed={starred}
        onPointerDown={stopEventPropagation}
        onClick={toggleStar}
        style={{
          position: "absolute",
          top: 6,
          right: 8,
          border: "none",
          background: "transparent",
          cursor: "pointer",
          padding: 0,
          lineHeight: 1,
          fontSize: 15,
          color: starred ? STAR_GOLD : accent,
          opacity: starred ? 1 : 0.35
        }}
      >
        {starred ? "★" : "☆"}
      </button>
      {badge || done ? (
        <div style={{ fontSize: 11, fontWeight: 600, color: accent, letterSpacing: "0.02em" }}>
          {done ? <span style={{ color: DONE_GREEN }}>✓ done</span> : null}
          {done && badge ? " · " : ""}
          {badge}
          {superseded ? " · superseded" : ""}
          {editedByUser ? " · edited" : ""}
        </div>
      ) : null}
      {isEditing ? (
        <>
          <textarea
            autoFocus
            value={title}
            placeholder="Title"
            onPointerDown={stopEventPropagation}
            onChange={(e) => edit({ title: e.target.value })}
            style={{
              ...EDIT_FIELD,
              color: text,
              fontSize: 14,
              fontWeight: 600,
              lineHeight: 1.25
            }}
          />
          <textarea
            value={body}
            placeholder="Add detail…"
            onPointerDown={stopEventPropagation}
            onChange={(e) => edit({ body: e.target.value })}
            style={{
              ...EDIT_FIELD,
              color: text,
              fontSize: 12,
              lineHeight: 1.35,
              opacity: 0.85,
              flex: 1
            }}
          />
        </>
      ) : (
        <>
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              lineHeight: 1.25,
              textDecoration: done ? "line-through" : "none"
            }}
          >
            {title}
          </div>
          {body ? (
            <div style={{ fontSize: 12, lineHeight: 1.35, opacity: 0.85, whiteSpace: "pre-wrap" }}>{body}</div>
          ) : null}
        </>
      )}
      {score || issueLinks.length > 0 || cardLinks.length > 0 || isEditing ? (
        // The bottom stat strip: the AI triage score (#60/#100) as impact /
        // effort / confidence chips, then linked external issues (#125) and any
        // generic external links (#227) as clickable chips — pinned to the
        // bottom so they read as stats below the idea, scannable without
        // hovering; each chip's title spells it out. While editing, the "add
        // link" affordance and per-chip remove buttons appear here too.
        <div
          style={{
            marginTop: "auto",
            display: "flex",
            flexWrap: "wrap",
            gap: 5,
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: "0.02em",
            color: accent
          }}
        >
          {score ? (
            <>
              <span title={`Impact ${score.impact}/5 (AI triage)`} style={scoreChip(accent)}>
                ▲ {score.impact}
              </span>
              <span title={`Effort ${score.effort}/5 (AI triage)`} style={scoreChip(accent)}>
                ⚒ {score.effort}
              </span>
              {score.confidence != null ? (
                <span
                  title={`Confidence ${score.confidence}/5 (AI triage)${lowConfidence ? " — low, treat as tentative" : ""}`}
                  style={scoreChip(lowConfidence ? LOW_CONFIDENCE_AMBER : accent)}
                >
                  {lowConfidence ? "⚠" : "◎"} {score.confidence}
                </span>
              ) : null}
            </>
          ) : null}
          {issueLinks.map((link) => (
            <IssueLinkChip key={link.url} link={link} accent={accent} />
          ))}
          {cardLinks.map((link) => (
            <CardLinkChip
              key={link.url}
              link={link}
              accent={accent}
              editing={isEditing}
              onRemove={() => removeLink(link.url)}
            />
          ))}
          {isEditing ? <CardLinkEditor shape={shape} accent={accent} /> : null}
        </div>
      ) : null}
    </HTMLContainer>
  );
}

/** Every idea-card shape on the editor's current page. */
export function ideaCards(editor: Editor): IdeaCardShape[] {
  return editor.getCurrentPageShapes().filter((s): s is IdeaCardShape => s.type === "idea-card");
}

/**
 * Every idea-card shape across ALL of the editor's pages (#124). Search must see
 * the whole project, not just the open page — this reads the store directly,
 * mirroring how the persisted-store gather path sees every page's records.
 */
export function allIdeaCards(editor: Editor): IdeaCardShape[] {
  return editor.store
    .allRecords()
    .filter((r): r is IdeaCardShape => r.typeName === "shape" && (r as IdeaCardShape).type === "idea-card");
}

/**
 * Highest `a<n>` ref index currently minted on the canvas (0 if none). Counts
 * ONLY canvas-minted `a<n>` refs: a backend-minted `i<n>` ref (the MCP tool
 * path, mcp-idea-capture §3.3) lives in a disjoint namespace and deliberately
 * contributes nothing — see {@link canvasRefIndex}.
 */
export function maxRefIndex(editor: Editor): number {
  let max = 0;
  for (const card of ideaCards(editor)) {
    max = Math.max(max, canvasRefIndex((card.meta as IdeaCardMeta).ref));
  }
  return max;
}

/** Read a card's content props for serialization. */
export function content(card: IdeaCardShape): CardContent {
  return { kind: card.props.kind, title: card.props.title, body: card.props.body };
}

/** Cards in stable reading order (top-to-bottom, then left-to-right). */
export function cardsInOrder(editor: Editor): IdeaCardShape[] {
  return ideaCards(editor).sort((a, b) => a.y - b.y || a.x - b.x);
}

/**
 * The stable short ref of a card (idea-graph §4), minting one (`a1`, `a2`, …) on
 * first reference. `applyIdeas` mints refs for AI cards as they are created;
 * this is the lazy path for a user-drawn card the first time an edge names it.
 */
export function cardRef(editor: Editor, shapeId: TLShapeId): string | undefined {
  const shape = editor.getShape(shapeId);
  if (!shape || shape.type !== "idea-card") return undefined;
  const existing = (shape.meta as IdeaCardMeta).ref;
  if (existing) return existing;
  const ref = `a${maxRefIndex(editor) + 1}`;
  editor.updateShape({ id: shapeId, type: "idea-card", meta: { ...shape.meta, ref } });
  return ref;
}

/** Resolve a short ref back to its shape id (idea-graph §4), or undefined. */
export function resolveRef(editor: Editor, ref: string): TLShapeId | undefined {
  for (const card of ideaCards(editor)) {
    if ((card.meta as IdeaCardMeta).ref === ref) return card.id;
  }
  return undefined;
}
