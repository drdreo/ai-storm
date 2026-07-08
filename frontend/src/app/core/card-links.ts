/**
 * Generic external-link references on idea cards (#227).
 *
 * The GitHub/Linear issue link (`issue-links.ts`) is a *first-class* reference:
 * it is auto-detected in card text and carries tracker status. This module is
 * the general case the issue asks for — "it's just a ref to an external url":
 * a plain link (Figma, a Google Doc, a spec, any web URL) explicitly attached to
 * a card, either by the agent through the MCP `link_idea` tool or by the user
 * pasting a URL in the card's inline link editor. Stored on the card's
 * `meta.links` array (no schema migration, like `starred`/`score`).
 *
 * Kept dependency-free so it is unit-testable in the plain Node vitest env (like
 * `issue-links.ts` / `canvas-text.ts`).
 */

/**
 * One external link attached to a card. A type alias (not an interface) on
 * purpose: aliases get TypeScript's implicit index signature, so the link can be
 * stamped straight into a tldraw shape's `JsonValue` meta (like `IssueLink`).
 */
export type CardLink = {
  /** The external URL (always an absolute http/https URL after normalization). */
  url: string;
  /** Optional display text; when absent the chip shows the URL's host. */
  label?: string;
};

/**
 * Normalize a pasted/typed URL into a usable absolute http(s) URL, or `null` if
 * it isn't one. A bare `figma.com/file/abc` gains an `https://` scheme (the
 * common paste); a `javascript:`/`data:`/`mailto:` scheme is rejected — the chip
 * is a real anchor opened in a new tab, so only http(s) is meaningful (and safe).
 */
export function normalizeLinkUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.href;
}

/**
 * The text shown on a link chip: the explicit label when set, otherwise a
 * compact label derived from the URL — the host with a leading `www.` dropped
 * (e.g. `figma.com`), falling back to the raw URL if it somehow won't parse.
 */
export function linkLabel(link: CardLink): string {
  const label = link.label?.trim();
  if (label) return label;
  try {
    return new URL(link.url).host.replace(/^www\./, "");
  } catch {
    return link.url;
  }
}

/**
 * Append `link` to a card's existing links, deduped by URL: an incoming link for
 * a URL already present updates that entry (last write wins the label) in place
 * rather than adding a duplicate. Pure — returns a new array, mutating nothing —
 * so it is shared by the MCP apply path and the inline editor.
 */
export function upsertLink(links: readonly CardLink[], link: CardLink): CardLink[] {
  const next = links.filter((l) => l.url !== link.url);
  next.push(link);
  return next;
}
