import type { CardLink } from "../../card-links";
import { kindLabel, normalizeKind } from "../../idea-descriptors";
import { collectIssueLinks, type IssueLink } from "../../issue-links";
import type { IdeaCardMeta, IdeaCardShape } from "./schema";

export interface IdeaCardPresentation {
  provenanceLabel?: "AI";
  kindLabel?: string;
  isKindlessNote: boolean;
  starred: boolean;
  done: boolean;
  superseded: boolean;
  editedByUser: boolean;
  score?: IdeaCardMeta["score"];
  lowConfidence: boolean;
  issueLinks: IssueLink[];
  cardLinks: CardLink[];
  showFooter: boolean;
}

/** Strip the legacy emoji prefix from known kind labels while preserving unknown `#tags`. */
export function visualKindLabel(kind: string): string {
  return kindLabel(kind)
    .replace(/^[^#\p{L}\p{N}]+/u, "")
    .trim();
}

/**
 * Build the semantic state consumed by the renderer. Keeping this pure makes the
 * AI/user and lifecycle rules explicit without coupling tests to tldraw hooks.
 */
export function ideaCardPresentation(
  props: Pick<IdeaCardShape["props"], "kind" | "title" | "body" | "origin" | "superseded">,
  meta: IdeaCardMeta,
  isEditing = false
): IdeaCardPresentation {
  const normalizedKind = normalizeKind(props.kind);
  const isKindlessNote = props.origin === "user" && !normalizedKind;
  const issueLinks = collectIssueLinks(props.title, props.body, meta.issue);
  const issueUrls = new Set(issueLinks.map((link) => link.url));
  const cardLinks = (meta.links ?? []).filter((link) => !issueUrls.has(link.url));
  const score = meta.score;
  const lowConfidence = typeof score?.confidence === "number" && score.confidence <= 2;

  return {
    provenanceLabel: props.origin === "ai" ? "AI" : undefined,
    kindLabel: normalizedKind ? visualKindLabel(normalizedKind) : isKindlessNote ? "Note" : undefined,
    isKindlessNote,
    starred: !!meta.starred,
    done: !props.superseded && !!meta.done,
    superseded: props.superseded,
    editedByUser: props.origin === "ai" && !!meta.editedByUser,
    score,
    lowConfidence,
    issueLinks,
    cardLinks,
    showFooter: !!score || issueLinks.length > 0 || cardLinks.length > 0 || isEditing
  };
}
