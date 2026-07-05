import { marked } from "marked";

/**
 * Hand-off Markdown → HTML parsing (#123). The spec panel streams raw
 * Markdown from the downstream agent; this turns it into HTML for the
 * "rendered" view. `marked` alone has no DOM dependency, so this stays a
 * pure string→string helper, unit-testable in the plain Node vitest
 * environment (no jsdom needed).
 *
 * Sanitization is deliberately NOT done here: DOMPurify requires a real DOM
 * (`window`/`document`), which this Node test environment doesn't provide.
 * Callers that feed the result into `dangerouslySetInnerHTML` MUST run it
 * through DOMPurify.sanitize first — see `MarkdownView.tsx`, the only such
 * call site. The Markdown originates from an LLM run, so it's untrusted.
 */
export function markdownToHtml(markdown: string): string {
  return marked.parse(markdown, { async: false, gfm: true, breaks: false }) as string;
}
