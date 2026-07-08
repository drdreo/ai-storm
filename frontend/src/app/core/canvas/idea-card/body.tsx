/**
 * The card's rendered body (`IdeaCardBody`) — the React component tldraw mounts
 * for each `idea-card` shape. Resolves the shape's `color` style against the
 * current theme, lays out the badge / title / body / bottom stat strip, and
 * hosts the live text edit and inline link editing. Presentation constants and
 * the chip components it renders live in `./styles` and `./chips`.
 */
import { getColorValue, HTMLContainer, stopEventPropagation, useColorMode, useEditor, useIsEditing } from "tldraw";
import { AI_PROVENANCE_BADGE, kindLabel, normalizeKind } from "../../idea-descriptors";
import { collectIssueLinks } from "../../issue-links";
import { type CardLink } from "../../card-links";
import type { IdeaCardMeta, IdeaCardShape } from "./schema";
import {
  CARD_INK_DARK,
  CARD_INK_LIGHT,
  DONE_GREEN,
  EDIT_FIELD,
  LOW_CONFIDENCE_AMBER,
  scoreChip,
  STAR_GOLD
} from "./styles";
import { CardLinkChip, CardLinkEditor, IssueLinkChip } from "./chips";

/**
 * The card's rendered body — a function component (so React hooks are legal)
 * resolving the shape's `color` style against the CURRENT theme. `getColorValue`
 * + `useColorMode` is the styles-system replacement for the old `KIND_TINT`
 * Affine-hex map: the same card reads as a soft `semi` fill in light mode and the
 * theme's dark equivalent in dark mode, with a `solid` accent for the badge. A
 * superseded card (#20, PD-012) recedes to a grey, dashed-border ghost.
 */
export function IdeaCardBody({ shape }: { shape: IdeaCardShape }): React.JSX.Element {
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
