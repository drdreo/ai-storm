/**
 * The card's bottom-strip link chips — the clickable pills rendered beside the
 * triage-score chips: {@link IssueLinkChip} for first-class tracker issues (#125,
 * with a status dot), {@link CardLinkChip} for any generic external URL (#227),
 * and {@link CardLinkEditor}, the inline "add link" affordance shown while a card
 * is being edited. Split out of the card body so the renderer stays about layout,
 * not chip internals.
 */
import { stopEventPropagation, useEditor } from "tldraw";
import { useEffect, useState } from "react";
import type { IssueLink } from "../../issue-links";
import { type CardLink, linkLabel, normalizeLinkUrl, upsertLink } from "../../card-links";
import { issueStatus, useIssueStatusStore } from "../../../stores/issue-status.store";
import { ISSUE_CLOSED_PURPLE, ISSUE_OPEN_GREEN, scoreChip } from "./styles";
import type { IdeaCardMeta, IdeaCardShape } from "./schema";

/**
 * One linked-issue chip (#125) — a clickable pill in the card's bottom stat
 * strip beside the triage score chips. GitHub issues get a status dot in
 * GitHub's own open/closed hues (fetched lazily through the status store);
 * Linear chips render without one (no API key to ask with). `stopEventPropagation`
 * on pointerdown keeps tldraw from starting a drag/selection, while the click
 * itself stays default so the anchor opens the tracker in a new tab.
 */
export function IssueLinkChip({ link, accent }: { link: IssueLink; accent: string }): React.JSX.Element {
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
export function CardLinkChip({
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
export function CardLinkEditor({ shape, accent }: { shape: IdeaCardShape; accent: string }): React.JSX.Element {
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
        style={{
          ...scoreChip(accent),
          cursor: "pointer",
          border: `1px dashed color-mix(in srgb, ${accent} 45%, transparent)`
        }}
      >
        🔗 Add link
      </button>
    );
  }

  return (
    <div
      style={{ display: "flex", flexDirection: "column", gap: 4, width: "100%" }}
      onPointerDown={stopEventPropagation}
    >
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
