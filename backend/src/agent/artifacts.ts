/**
 * Created-issues artifact parsing (#120).
 *
 * A spec hand-off run with format `issues` + the `create-issues` capability
 * asks the agent to run `gh issue create` per work item and finish with a
 * summary table (title | URL). This module turns that captured stdout into
 * structured `{ title, url }` artifacts so the client can render link chips
 * instead of scraping markdown. Pure function over the final output string —
 * unit-testable without spawning anything.
 *
 * Parsing is deliberately forgiving: `gh issue create` prints the bare issue
 * URL, and the summary table repeats it, possibly as a markdown link. Any
 * GitHub issue URL found anywhere in the output becomes an artifact; the title
 * is taken from the nearest useful text on the URL's own line (a table cell or
 * markdown-link label), falling back to `Issue #n`. URLs are deduped — the
 * first occurrence with a real title wins.
 */

import type { AgentArtifact } from "@ai-storm/shared";

const ISSUE_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/(\d+)/g;

/** Strip table pipes, markdown emphasis, and link syntax down to plain text. */
function cleanCell(cell: string): string {
  return cell
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // [label](url) → label
    .replace(/[*_`]/g, "")
    .trim();
}

/** True for table chrome like `---`, `:---:`, or empty cells. */
function isSeparatorCell(cell: string): boolean {
  return /^:?-{2,}:?$/.test(cell) || cell === "";
}

/**
 * Extract a human title for a URL from its own line: prefer the first non-URL
 * table cell / text on the line (the summary table's title column), then a
 * markdown-link label wrapping this exact URL (e.g. `[acme/app#12](url)` on a
 * line with no separate title cell). Returns "" when the line offers nothing
 * (e.g. `gh`'s bare-URL output line).
 */
function titleFromLine(line: string, url: string): string {
  const cells = line.split("|").map(cleanCell);
  for (const cell of cells) {
    if (isSeparatorCell(cell)) continue;
    if (cell.includes("github.com")) continue;
    // Skip pure header-ish noise cells that are just the row index.
    if (/^\d+\.?$/.test(cell)) continue;
    return cell;
  }
  const link = new RegExp(`\\[([^\\]]+)\\]\\(${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`).exec(line);
  if (link) {
    const label = cleanCell(link[1]);
    // A label that is itself the URL (autolink style) is not a title.
    if (label && !label.includes("github.com")) return label;
  }
  return "";
}

/**
 * Scan a finished run's captured stdout for created GitHub issues.
 * Returns one artifact per distinct issue URL, in first-seen order.
 */
export function parseIssueArtifacts(output: string): AgentArtifact[] {
  const byUrl = new Map<string, AgentArtifact>();
  for (const line of output.split(/\r?\n/)) {
    ISSUE_URL.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ISSUE_URL.exec(line)) !== null) {
      const url = m[0];
      const title = titleFromLine(line, url) || `Issue #${m[1]}`;
      const existing = byUrl.get(url);
      // First occurrence wins, but a later row with a real title upgrades a
      // bare-URL fallback (gh prints the URL alone before the summary table).
      if (!existing) byUrl.set(url, { kind: "github-issue", title, url });
      else if (existing.title.startsWith("Issue #") && !title.startsWith("Issue #")) existing.title = title;
    }
  }
  return [...byUrl.values()];
}
