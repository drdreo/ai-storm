import { describe, expect, it } from "vitest";
import { markdownToHtml } from "./render-markdown";

describe("markdownToHtml", () => {
  it("renders headings", () => {
    expect(markdownToHtml("# Title").trim()).toBe("<h1>Title</h1>");
  });

  it("renders bullet lists", () => {
    const html = markdownToHtml("- one\n- two");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>one</li>");
    expect(html).toContain("<li>two</li>");
  });

  it("renders fenced code blocks with a language class", () => {
    const html = markdownToHtml("```ts\nconst a = 1;\n```");
    expect(html).toContain('<code class="language-ts">');
    expect(html).toContain("const a = 1;");
  });

  it("renders links", () => {
    const html = markdownToHtml("[go](https://example.com)");
    expect(html).toContain('<a href="https://example.com">go</a>');
  });

  it("passes raw HTML through untouched (marked does not sanitize)", () => {
    // `marked` intentionally leaves embedded HTML as-is — sanitizing is out of
    // scope for a Markdown parser. DOMPurify, applied at the DOM boundary in
    // MarkdownView, is what actually strips something like an inline <script>
    // before this ever reaches `dangerouslySetInnerHTML`.
    const html = markdownToHtml("plain <script>alert(1)</script> text");
    expect(html).toContain("<script>alert(1)</script>");
  });

  it("returns empty string for empty input", () => {
    expect(markdownToHtml("")).toBe("");
  });
});
