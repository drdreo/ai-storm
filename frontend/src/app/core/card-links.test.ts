/**
 * Unit tests for the generic card-link helpers (#227). Pure string/URL logic,
 * exercised in the plain Node vitest env (like `issue-links.test.ts`).
 */
import { describe, it, expect } from "vitest";
import { type CardLink, linkLabel, normalizeLinkUrl, upsertLink } from "./card-links";

describe("normalizeLinkUrl", () => {
  it("keeps an absolute http(s) URL", () => {
    expect(normalizeLinkUrl("https://figma.com/file/abc")).toBe("https://figma.com/file/abc");
    expect(normalizeLinkUrl("http://example.com/x")).toBe("http://example.com/x");
  });

  it("adds https:// to a bare host", () => {
    expect(normalizeLinkUrl("figma.com/file/abc")).toBe("https://figma.com/file/abc");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeLinkUrl("  https://example.com/x  ")).toBe("https://example.com/x");
  });

  it("rejects empty, non-http schemes, and garbage", () => {
    expect(normalizeLinkUrl("")).toBeNull();
    expect(normalizeLinkUrl("   ")).toBeNull();
    expect(normalizeLinkUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeLinkUrl("mailto:a@b.com")).toBeNull();
    expect(normalizeLinkUrl("data:text/html,x")).toBeNull();
  });
});

describe("linkLabel", () => {
  it("uses the explicit label when set", () => {
    expect(linkLabel({ url: "https://figma.com/file/abc", label: "Figma spec" })).toBe("Figma spec");
  });

  it("falls back to the host without www.", () => {
    expect(linkLabel({ url: "https://www.notion.so/page" })).toBe("notion.so");
    expect(linkLabel({ url: "https://docs.google.com/document/d/1" })).toBe("docs.google.com");
  });

  it("treats a blank label as absent", () => {
    expect(linkLabel({ url: "https://example.com", label: "   " })).toBe("example.com");
  });
});

describe("upsertLink", () => {
  it("appends a new link", () => {
    const links: CardLink[] = [{ url: "https://a.com" }];
    expect(upsertLink(links, { url: "https://b.com", label: "B" })).toEqual([
      { url: "https://a.com" },
      { url: "https://b.com", label: "B" }
    ]);
  });

  it("replaces an existing URL in place (last write wins the label)", () => {
    const links: CardLink[] = [{ url: "https://a.com", label: "old" }, { url: "https://b.com" }];
    expect(upsertLink(links, { url: "https://a.com", label: "new" })).toEqual([
      { url: "https://b.com" },
      { url: "https://a.com", label: "new" }
    ]);
  });

  it("does not mutate the input array", () => {
    const links: CardLink[] = [{ url: "https://a.com" }];
    upsertLink(links, { url: "https://b.com" });
    expect(links).toEqual([{ url: "https://a.com" }]);
  });
});
