import { useMemo, useState } from "react";
import DOMPurify from "dompurify";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { markdownToHtml } from "../core/render-markdown";

type ViewMode = "rendered" | "raw";

/**
 * Hand-off Markdown display (#123). Agent-produced artifacts (specs, plans,
 * issue lists) arrive as raw Markdown; this renders them as parsed HTML by
 * default with a toggle back to the raw source — the toggle matters because
 * the raw text is what gets copied/downloaded verbatim (SpecPanel's Copy /
 * Download actions), so users occasionally want to see exactly what that is.
 *
 * Sanitization happens HERE, right at the `dangerouslySetInnerHTML` boundary
 * — `markdownToHtml` is a pure parser with no DOM dependency (unit-tested in
 * the Node vitest environment), so DOMPurify can't run inside it. The
 * Markdown originates from an LLM run and must be treated as untrusted.
 */
export function MarkdownView({ markdown, className }: { markdown: string; className?: string }) {
  const [mode, setMode] = useState<ViewMode>("rendered");
  const html = useMemo(() => DOMPurify.sanitize(markdownToHtml(markdown)), [markdown]);

  return (
    <div className={className}>
      <Tabs value={mode} onValueChange={(v) => setMode(v as ViewMode)}>
        <TabsList variant="line" className="mb-2">
          <TabsTrigger value="rendered">Rendered</TabsTrigger>
          <TabsTrigger value="raw">Raw</TabsTrigger>
        </TabsList>
      </Tabs>
      {mode === "rendered" ? (
        <div className="markdown-body text-sm" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="m-0 whitespace-pre-wrap break-words font-mono text-xs leading-snug">{markdown}</pre>
      )}
    </div>
  );
}
