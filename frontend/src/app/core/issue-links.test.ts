import { describe, expect, it } from "vitest";
import { collectIssueLinks, detectIssueLinks, GITHUB_ISSUE_URL, githubIssueKey } from "./issue-links";

describe("detectIssueLinks (#125)", () => {
  it("detects a full GitHub issue URL", () => {
    expect(detectIssueLinks("see https://github.com/drdreo/ai-storm/issues/125 for details")).toEqual([
      { provider: "github", key: "drdreo/ai-storm#125", url: "https://github.com/drdreo/ai-storm/issues/125" }
    ]);
  });

  it("detects the owner/repo#n shorthand and expands it to the issue URL", () => {
    expect(detectIssueLinks("tracked in drdreo/ai-storm#125.")).toEqual([
      { provider: "github", key: "drdreo/ai-storm#125", url: "https://github.com/drdreo/ai-storm/issues/125" }
    ]);
  });

  it("detects the shorthand at the start of the text", () => {
    expect(detectIssueLinks("acme/app#7 blocks this")).toHaveLength(1);
  });

  it("detects a Linear issue URL and uses the ticket key", () => {
    expect(detectIssueLinks("https://linear.app/acme/issue/ENG-123/fix-the-thing")).toEqual([
      { provider: "linear", key: "ENG-123", url: "https://linear.app/acme/issue/ENG-123" }
    ]);
  });

  it("dedupes a URL and its shorthand form, first-seen order preserved", () => {
    const links = detectIssueLinks(
      "acme/app#7 and later https://github.com/acme/app/issues/7 plus acme/app#8 again acme/app#7"
    );
    expect(links.map((l) => l.key)).toEqual(["acme/app#7", "acme/app#8"]);
  });

  it("does not detect bare #123, bare ticket keys, PR URLs, or deep paths", () => {
    expect(detectIssueLinks("the #123 tag and ABC-123 and src/lib/util#1")).toEqual([]);
    expect(detectIssueLinks("https://github.com/acme/app/pull/9")).toEqual([]);
    expect(detectIssueLinks("")).toEqual([]);
  });

  it("keeps multiple providers in text order", () => {
    const links = detectIssueLinks("https://linear.app/acme/issue/ENG-1 then acme/app#2");
    expect(links.map((l) => l.provider)).toEqual(["linear", "github"]);
  });
});

describe("collectIssueLinks (#125)", () => {
  const explicit = {
    provider: "github" as const,
    key: "acme/app#7",
    url: "https://github.com/acme/app/issues/7",
    title: "Fix the thing"
  };

  it("puts the explicit meta link first and dedupes it against detected text links", () => {
    const links = collectIssueLinks("Ship acme/app#7", "also acme/app#8", explicit);
    expect(links.map((l) => l.key)).toEqual(["acme/app#7", "acme/app#8"]);
    expect(links[0].title).toBe("Fix the thing");
  });

  it("returns just the detected links without an explicit one", () => {
    expect(collectIssueLinks("Ship acme/app#7", "")).toHaveLength(1);
  });
});

describe("GitHub URL helpers (#125)", () => {
  it("GITHUB_ISSUE_URL accepts exactly a full issue URL", () => {
    expect(GITHUB_ISSUE_URL.test("https://github.com/drdreo/ai-storm/issues/125")).toBe(true);
    expect(GITHUB_ISSUE_URL.test("https://github.com/drdreo/ai-storm/pull/125")).toBe(false);
    expect(GITHUB_ISSUE_URL.test("https://github.com/drdreo/ai-storm/issues/125/comments")).toBe(false);
    expect(GITHUB_ISSUE_URL.test("http://github.com/a/b/issues/1")).toBe(false);
  });

  it("githubIssueKey extracts owner/repo#n", () => {
    expect(githubIssueKey("https://github.com/acme/app/issues/7")).toBe("acme/app#7");
    expect(githubIssueKey("https://example.com/x")).toBeNull();
  });
});
