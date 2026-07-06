/**
 * External issue-tracker link detection (#125).
 *
 * Pure scanning of card text for references to GitHub issues and Linear
 * tickets, so a card that mentions `drdreo/ai-storm#125` or pastes an issue URL
 * grows a clickable link chip — no card mutation, links are *derived* at render
 * time from the text. The one persisted form is the explicit `meta.issue` link
 * a hand-off-created issue stamps back on its source card (see
 * `applyIssueLinks`), which this module also types.
 *
 * Deliberately conservative: full GitHub/Linear issue URLs plus the
 * unambiguous `owner/repo#123` shorthand. Bare `#123` and bare `ABC-123` are
 * NOT detected — without a repo/workspace they are guesses, and `#tag` is
 * already the canvas's unknown-kind syntax. Kept dependency-free so it is
 * unit-testable in the plain Node vitest env (like `canvas-text.ts`).
 */

export type IssueProvider = "github" | "linear";

/**
 * One detected (or explicitly stored) external issue reference. A type alias
 * (not an interface) on purpose: aliases get TypeScript's implicit index
 * signature, so the link can be stamped straight into a tldraw shape's
 * `JsonValue` meta (see `IdeaCardMeta.issue`).
 */
export type IssueLink = {
  provider: IssueProvider;
  /** Short display key: `owner/repo#123` (GitHub) or `ABC-123` (Linear). */
  key: string;
  url: string;
  /** Issue title, when known (only explicit links carry one). */
  title?: string;
};

/** A full GitHub issue URL, e.g. `https://github.com/drdreo/ai-storm/issues/125`. */
const GITHUB_URL = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)/g;

/**
 * The `owner/repo#123` shorthand. Guarded on both sides so it doesn't fire
 * inside a URL or a longer path segment (`a/b/c#1` offers no clean owner/repo
 * split, so only the exact two-segment form counts).
 */
const GITHUB_SHORTHAND = /(^|[^\w/.])([\w.-]+)\/([\w.-]+)#(\d+)(?![\w#])/g;

/** A Linear issue URL, e.g. `https://linear.app/acme/issue/ENG-123/slug`. */
const LINEAR_URL = /https:\/\/linear\.app\/[\w-]+\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)/g;

/** Strict whole-string form of {@link GITHUB_URL} — the status endpoint's gate. */
export const GITHUB_ISSUE_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+$/;

/** The `owner/repo#n` key for a GitHub issue URL, or `null` if it isn't one. */
export function githubIssueKey(url: string): string | null {
  GITHUB_URL.lastIndex = 0;
  const m = GITHUB_URL.exec(url);
  return m ? `${m[1]}/${m[2]}#${m[3]}` : null;
}

/**
 * Scan free text for external issue references. Returns one link per distinct
 * URL, in first-seen order (a shorthand and the URL it expands to dedupe).
 */
export function detectIssueLinks(text: string): IssueLink[] {
  if (!text) return [];
  const found: { index: number; link: IssueLink }[] = [];

  GITHUB_URL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = GITHUB_URL.exec(text)) !== null) {
    found.push({
      index: m.index,
      link: { provider: "github", key: `${m[1]}/${m[2]}#${m[3]}`, url: m[0] }
    });
  }

  GITHUB_SHORTHAND.lastIndex = 0;
  while ((m = GITHUB_SHORTHAND.exec(text)) !== null) {
    const [, , owner, repo, num] = m;
    found.push({
      index: m.index,
      link: {
        provider: "github",
        key: `${owner}/${repo}#${num}`,
        url: `https://github.com/${owner}/${repo}/issues/${num}`
      }
    });
  }

  LINEAR_URL.lastIndex = 0;
  while ((m = LINEAR_URL.exec(text)) !== null) {
    found.push({
      index: m.index,
      link: { provider: "linear", key: m[1].toUpperCase(), url: m[0] }
    });
  }

  found.sort((a, b) => a.index - b.index);
  const byUrl = new Map<string, IssueLink>();
  for (const { link } of found) {
    if (!byUrl.has(link.url)) byUrl.set(link.url, link);
  }
  return [...byUrl.values()];
}

/**
 * A card's full link set: the explicit `meta.issue` link first (it carries the
 * title and is the one a hand-off stamped), then the links detected in the
 * card's text, deduped by URL.
 */
export function collectIssueLinks(title: string, body: string, explicit?: IssueLink): IssueLink[] {
  const detected = detectIssueLinks(`${title}\n${body ?? ""}`);
  if (!explicit) return detected;
  return [explicit, ...detected.filter((l) => l.url !== explicit.url)];
}
