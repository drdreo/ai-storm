/**
 * The debug inspector (#219) — tldraw's inspector-panel example adapted to the
 * idea board. When the "Debug mode" setting is on, a small panel floats in the
 * bottom-right of the canvas: click a card and it reveals the metadata the UI
 * normally hides (shape id, short ref, triage score, provenance, timestamps,
 * issue link, raw meta), with the whole selection copyable as JSON so it can be
 * pasted straight to an agent or a bug report. With nothing selected it shows
 * board-level facts instead (shape/card/edge counts, camera, page).
 *
 * A `track`ed component rendered `InFrontOfTheCanvas` by {@link ../canvas-island},
 * so it re-renders reactively off the editor's signals — selection, shape edits,
 * and camera moves all update it live.
 */
import { useState } from "react";
import { stopEventPropagation, track, useEditor, type TLShape } from "tldraw";
import { Bug, Check, Copy } from "lucide-react";
import { ideaCards, type IdeaCardMeta, type IdeaCardShape } from "./idea-card";
import { ideaEdges } from "./edges";

/** One labelled key/value line in the panel. */
function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right font-medium text-foreground">{children}</span>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="mt-2 border-t border-border pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground first:mt-0 first:border-t-0 first:pt-0">
      {children}
    </div>
  );
}

function formatTimestamp(epochMs: number | undefined): string | undefined {
  if (!epochMs) return undefined;
  const d = new Date(epochMs);
  return Number.isNaN(d.getTime()) ? undefined : d.toLocaleString();
}

/** Strip a shape to the JSON a developer/agent actually wants to paste around. */
function shapeToDebugJson(shape: TLShape): Record<string, unknown> {
  const { id, type, x, y, rotation, props, meta } = shape;
  return { id, type, x: Math.round(x), y: Math.round(y), rotation, props, meta };
}

/** The copy-selection-as-JSON affordance, with a brief ✓ acknowledgement. */
function CopyButton({ payload }: { payload: unknown }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(JSON.stringify(payload, null, 2)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <button
      type="button"
      onClick={copy}
      title="Copy as JSON"
      aria-label="Copy as JSON"
      className="inline-flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      {copied ? <Check className="size-3" aria-hidden /> : <Copy className="size-3" aria-hidden />}
    </button>
  );
}

/** Full detail for a single selected idea card — props plus the hidden meta. */
function CardDetail({ card }: { card: IdeaCardShape }): React.JSX.Element {
  const meta = card.meta as IdeaCardMeta;
  const created = formatTimestamp(meta.createdAt);
  return (
    <>
      <SectionTitle>Card</SectionTitle>
      <Row label="id">{card.id}</Row>
      <Row label="ref">{meta.ref ?? "— (unminted)"}</Row>
      <Row label="kind">{card.props.kind}</Row>
      <Row label="origin">
        {card.props.origin}
        {meta.editedByUser ? " · edited" : ""}
      </Row>
      <Row label="color">{card.props.color}</Row>
      <Row label="position">
        {Math.round(card.x)}, {Math.round(card.y)}
      </Row>
      <Row label="size">
        {Math.round(card.props.w)} × {Math.round(card.props.h)}
      </Row>
      <Row label="state">
        {[meta.starred && "★ starred", meta.done && "✓ done", card.props.superseded && "superseded"]
          .filter(Boolean)
          .join(" · ") || "—"}
      </Row>
      {meta.score && (
        <Row label="score">
          impact {meta.score.impact} · effort {meta.score.effort}
          {meta.score.confidence != null ? ` · conf ${meta.score.confidence}` : ""}
        </Row>
      )}
      {created && <Row label="created">{created}</Row>}
      {meta.issue && <Row label="issue">{meta.issue.key}</Row>}
      <Row label="title chars">{card.props.title.length}</Row>
      <Row label="body chars">{card.props.body.length}</Row>
    </>
  );
}

/** Board-level facts shown when nothing is selected. */
function BoardDetail(): React.JSX.Element {
  const editor = useEditor();
  const shapes = editor.getCurrentPageShapes();
  const cards = ideaCards(editor);
  const edges = ideaEdges(editor, new Set(cards.map((c) => c.id)));
  const camera = editor.getCamera();

  const byKind = new Map<string, number>();
  let ai = 0;
  let starred = 0;
  let done = 0;
  let superseded = 0;
  for (const card of cards) {
    byKind.set(card.props.kind, (byKind.get(card.props.kind) ?? 0) + 1);
    const meta = card.meta as IdeaCardMeta;
    if (card.props.origin === "ai") ai += 1;
    if (meta.starred) starred += 1;
    if (meta.done) done += 1;
    if (card.props.superseded) superseded += 1;
  }

  return (
    <>
      <SectionTitle>Board</SectionTitle>
      <Row label="page">{editor.getCurrentPageId()}</Row>
      <Row label="shapes">{shapes.length}</Row>
      <Row label="idea cards">{cards.length}</Row>
      <Row label="edges">{edges.length}</Row>
      <Row label="origin">
        {ai} ai · {cards.length - ai} user
      </Row>
      <Row label="state">
        {starred} ★ · {done} ✓ · {superseded} superseded
      </Row>
      {byKind.size > 0 && (
        <Row label="kinds">{[...byKind.entries()].map(([kind, count]) => `${kind} ${count}`).join(" · ")}</Row>
      )}
      <SectionTitle>Camera</SectionTitle>
      <Row label="position">
        {Math.round(camera.x)}, {Math.round(camera.y)}
      </Row>
      <Row label="zoom">{editor.getZoomLevel().toFixed(2)}</Row>
    </>
  );
}

/**
 * The floating inspector panel. Mounted only while debug mode (#219) is on.
 * Bottom-right, above tldraw's watermark/helper buttons; `stopEventPropagation`
 * on pointer-down so interacting with it never pans or deselects the canvas.
 */
export const DebugInspector = track(function DebugInspector({ projectId }: { projectId: string }): React.JSX.Element {
  const editor = useEditor();
  const selected = editor.getSelectedShapes();
  const selectedCards = selected.filter((s): s is IdeaCardShape => s.type === "idea-card");
  const single = selected.length === 1 ? selected[0] : undefined;

  // The copy payload mirrors what the panel is showing: the selection's raw
  // shape records, or (empty selection) every idea card on the page.
  const payload = selected.length > 0 ? selected.map(shapeToDebugJson) : ideaCards(editor).map(shapeToDebugJson);

  return (
    <div
      onPointerDown={stopEventPropagation}
      style={{ pointerEvents: "all", zIndex: 300 }}
      className="absolute bottom-14 right-2 w-72 rounded-lg border border-border bg-background/95 p-2.5 font-mono text-[11px] leading-5 shadow-md backdrop-blur"
    >
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 font-semibold text-foreground">
          <Bug className="size-3.5" aria-hidden /> Debug
        </span>
        <span className="flex items-center gap-1">
          <span className="text-muted-foreground">
            {selected.length === 0 ? "board" : `${selected.length} selected`}
          </span>
          <CopyButton payload={payload} />
        </span>
      </div>

      <div className="max-h-72 space-y-0.5 overflow-y-auto">
        <Row label="project">{projectId}</Row>
        {selected.length === 0 && <BoardDetail />}
        {single && single.type === "idea-card" && <CardDetail card={single as IdeaCardShape} />}
        {single && single.type !== "idea-card" && (
          <>
            <SectionTitle>Shape</SectionTitle>
            <Row label="id">{single.id}</Row>
            <Row label="type">{single.type}</Row>
            <Row label="position">
              {Math.round(single.x)}, {Math.round(single.y)}
            </Row>
          </>
        )}
        {selected.length > 1 && (
          <>
            <SectionTitle>Selection</SectionTitle>
            <Row label="cards">{selectedCards.length}</Row>
            <Row label="other shapes">{selected.length - selectedCards.length}</Row>
            {selectedCards.map((card) => (
              <Row key={card.id} label={(card.meta as IdeaCardMeta).ref ?? "—"}>
                {card.props.kind} · {card.props.title || "(untitled)"}
              </Row>
            ))}
          </>
        )}
      </div>
    </div>
  );
});
