import { describe, it, expect } from "vitest";
import { parseIssueArtifacts } from "./artifacts.ts";

describe("parseIssueArtifacts (#120)", () => {
  it("returns no artifacts for output without issue URLs (drafts fallback)", () => {
    const drafts = [
      "gh is not authorized; outputting drafts instead.",
      "## Add dark mode",
      "Body text…",
      "## Fix login flake"
    ].join("\n");
    expect(parseIssueArtifacts(drafts)).toEqual([]);
    expect(parseIssueArtifacts("")).toEqual([]);
  });

  it("pairs titles with URLs from a markdown summary table", () => {
    const out = [
      "Created 2 issues:",
      "",
      "| Title | URL |",
      "| --- | --- |",
      "| Add dark mode | https://github.com/acme/app/issues/12 |",
      "| Fix login flake | https://github.com/acme/app/issues/13 |"
    ].join("\n");
    expect(parseIssueArtifacts(out)).toEqual([
      {
        kind: "github-issue",
        title: "Add dark mode",
        url: "https://github.com/acme/app/issues/12"
      },
      {
        kind: "github-issue",
        title: "Fix login flake",
        url: "https://github.com/acme/app/issues/13"
      }
    ]);
  });

  it("uses a markdown-link label as the title", () => {
    const out = "| Add dark mode | [acme/app#12](https://github.com/acme/app/issues/12) |";
    expect(parseIssueArtifacts(out)).toEqual([
      {
        kind: "github-issue",
        title: "Add dark mode",
        url: "https://github.com/acme/app/issues/12"
      }
    ]);
  });

  it("falls back to Issue #n for a bare gh-printed URL line", () => {
    expect(parseIssueArtifacts("https://github.com/acme/app/issues/7")).toEqual([
      { kind: "github-issue", title: "Issue #7", url: "https://github.com/acme/app/issues/7" }
    ]);
  });

  it("dedupes the bare gh URL against the summary row, keeping the real title", () => {
    const out = [
      "https://github.com/acme/app/issues/12",
      "",
      "| Title | URL |",
      "| --- | --- |",
      "| Add dark mode | https://github.com/acme/app/issues/12 |"
    ].join("\n");
    expect(parseIssueArtifacts(out)).toEqual([
      {
        kind: "github-issue",
        title: "Add dark mode",
        url: "https://github.com/acme/app/issues/12"
      }
    ]);
  });

  it("ignores non-issue GitHub URLs", () => {
    expect(parseIssueArtifacts("See https://github.com/acme/app/pull/9 and https://github.com/acme/app")).toEqual([]);
  });
});
