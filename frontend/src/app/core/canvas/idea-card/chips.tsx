import { ExternalLink, Link, X } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { stopEventPropagation, useEditor } from "tldraw";
import { type CardLink, linkLabel, normalizeLinkUrl, upsertLink } from "../../card-links";
import type { IssueLink } from "../../issue-links";
import { issueStatus, useIssueStatusStore } from "../../../stores/issue-status.store";
import type { IdeaCardMeta, IdeaCardShape } from "./schema";
import { ISSUE_CLOSED_PURPLE, ISSUE_OPEN_GREEN } from "./styles";

interface ExternalAnchorChipProps {
  href: string;
  title: string;
  ariaLabel: string;
  accent: string;
  children: React.ReactNode;
}

function ExternalAnchorChip({ href, title, ariaLabel, accent, children }: ExternalAnchorChipProps): React.JSX.Element {
  return (
    <a
      className="as-card-chip as-card-link"
      href={href}
      target="_blank"
      rel="noreferrer"
      title={title}
      aria-label={ariaLabel}
      onPointerDown={stopEventPropagation}
      style={{ "--as-chip-accent": accent } as React.CSSProperties}
    >
      {children}
      <ExternalLink aria-hidden size={10} strokeWidth={2} />
    </a>
  );
}

/** A compact first-class tracker reference with live GitHub state. */
export function IssueLinkChip({ link, accent }: { link: IssueLink; accent: string }): React.JSX.Element {
  const status = useIssueStatusStore((state) => state.statuses[link.url]);
  useEffect(() => {
    issueStatus.request(link.url);
  }, [link.url]);

  const label = link.provider === "github" ? `#${link.key.split("#")[1] ?? link.key}` : link.key;
  const state = status && status.state !== "unknown" ? status.state : null;
  const dot = state === "open" ? ISSUE_OPEN_GREEN : state === "closed" ? ISSUE_CLOSED_PURPLE : null;
  const title = `${link.title ? `${link.title} — ` : ""}${link.key}${state ? ` (${state})` : ""}`;

  return (
    <ExternalAnchorChip href={link.url} title={title} ariaLabel={`Open ${title}`} accent={accent}>
      {dot ? <span aria-hidden className="as-card-issue-dot" style={{ background: dot }} /> : null}
      <span className="as-card-link-label">{label}</span>
    </ExternalAnchorChip>
  );
}

/** A generic external reference; removal is available while the card is editing. */
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
  const label = linkLabel(link);

  return (
    <>
      <ExternalAnchorChip href={link.url} title={link.url} ariaLabel={`Open ${label}`} accent={accent}>
        <span className="as-card-link-label">{label}</span>
      </ExternalAnchorChip>
      {editing ? (
        <button
          type="button"
          className="as-card-chip as-card-link-remove"
          title={`Remove ${label}`}
          aria-label={`Remove link ${label}`}
          onPointerDown={stopEventPropagation}
          onClick={(event) => {
            stopEventPropagation(event);
            onRemove();
          }}
          style={{ "--as-chip-accent": accent } as React.CSSProperties}
        >
          <X aria-hidden size={11} strokeWidth={2.3} />
        </button>
      ) : null}
    </>
  );
}

/** Inline URL and optional-label editor shown while the parent card is editing. */
export function CardLinkEditor({ shape, accent }: { shape: IdeaCardShape; accent: string }): React.JSX.Element {
  const editor = useEditor();
  const errorId = useId();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState(false);

  const close = () => {
    setOpen(false);
    setError(false);
  };

  const add = () => {
    const normalized = normalizeLinkUrl(url);
    if (!normalized) {
      setError(true);
      return;
    }

    const trimmedLabel = label.trim();
    const link: CardLink = trimmedLabel ? { url: normalized, label: trimmedLabel } : { url: normalized };
    const links = upsertLink((shape.meta as IdeaCardMeta).links ?? [], link);
    editor.updateShape({ id: shape.id, type: "idea-card", meta: { ...shape.meta, links } });
    setUrl("");
    setLabel("");
    setError(false);
    setOpen(false);
  };

  if (!open) {
    return (
      <button
        type="button"
        className="as-card-chip as-card-add-link"
        aria-expanded={false}
        onPointerDown={stopEventPropagation}
        onClick={(event) => {
          stopEventPropagation(event);
          setOpen(true);
        }}
        style={{ "--as-chip-accent": accent } as React.CSSProperties}
      >
        <Link aria-hidden size={11} strokeWidth={2.1} />
        Add link
      </button>
    );
  }

  return (
    <div
      className="as-card-link-editor"
      style={{ "--as-chip-accent": accent } as React.CSSProperties}
      onPointerDown={stopEventPropagation}
    >
      <input
        autoFocus
        className={`as-card-link-field${error ? " is-invalid" : ""}`}
        type="text"
        inputMode="url"
        value={url}
        placeholder="Paste a web URL…"
        aria-label="Link URL"
        aria-invalid={error}
        aria-describedby={error ? errorId : undefined}
        onChange={(event) => {
          setUrl(event.target.value);
          setError(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            add();
          } else if (event.key === "Escape") {
            event.preventDefault();
            close();
          }
        }}
      />
      {error ? (
        <span id={errorId} className="as-card-link-error" role="alert">
          Enter a valid http(s) URL.
        </span>
      ) : null}
      <input
        className="as-card-link-field"
        value={label}
        placeholder="Label (optional)"
        aria-label="Link label"
        onChange={(event) => setLabel(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            add();
          } else if (event.key === "Escape") {
            event.preventDefault();
            close();
          }
        }}
      />
      <div className="as-card-link-actions">
        <button type="button" className="as-card-chip" onClick={close}>
          Cancel
        </button>
        <button type="button" className="as-card-chip as-card-link-submit" onClick={add}>
          Add
        </button>
      </div>
    </div>
  );
}
