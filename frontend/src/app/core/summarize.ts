/**
 * Board summarization (#28, PD-015) — turn the whole board into a convergent
 * *reading* of it: themes → ideas → decisions → open questions, produced on
 * demand and exportable as markdown.
 *
 * PD-015 is the frame: convergence is a **generated artifact**, not a second
 * authoring surface. This module is the artifact's engine. It is a pure,
 * deterministic *reading* of the canvas — no agent round-trip — so it is instant,
 * reproducible, and unit-testable in the plain Node env (like `idea-layout/`
 * and `idea-descriptors.ts`, and unlike anything that touches tldraw).
 *
 * The structure the board already carries does the work: the typed edge graph
 * (#42) clusters related cards into **themes**; `kind` (#21) lifts out the
 * **decisions** and **open questions**; `supersedes` edges (#22/PD-012) read as
 * **resolutions** (X replaced by Y); the keep-mark star (#59) surfaces the
 * **highlights**. The canvas island flattens its live `Editor` into the
 * {@link BoardSnapshot} this consumes (`collectBoard`), and the side panel renders
 * the {@link ConvergentSummary} read-only while {@link summaryToMarkdown} feeds
 * copy/export — a markdown reading, never an editable document (PD-011 holds).
 */
import { decorateTitle, normalizeKind } from "./idea-descriptors";

/** One idea card, flattened off the live editor for synthesis (see `collectBoard`). */
export interface BoardCard {
  /** Stable identity for edge-matching — the tldraw shape id (not the short ref). */
  id: string;
  kind: string;
  title: string;
  body: string;
  /** Keep-mark (#59): the user flagged this one as worth keeping. */
  starred: boolean;
  /** Lifecycle (#20/PD-012): replaced by a refined card via a `supersedes` edge. */
  superseded: boolean;
  origin: "ai" | "user";
}

/** A typed edge between two cards (the bound arrows behind the graph, #42). */
export interface BoardEdge {
  /** For `about`: the child; for `supersedes`: the surviving/new card. */
  from: string;
  /** For `about`: the idea it is about; for `supersedes`: the replaced original. */
  to: string;
  relation: "about" | "supersedes";
}

/** The whole board, flattened — the input to {@link summarizeBoard}. */
export interface BoardSnapshot {
  cards: readonly BoardCard[];
  edges: readonly BoardEdge[];
}

/** A cluster of related cards, titled by its main idea (a connected component, #42). */
export interface SummaryTheme {
  /** The main idea's title — the card the rest of the cluster fans out from. */
  title: string;
  /** All cards in the cluster, the main idea first, then its related cards. */
  cards: BoardCard[];
}

/** A resolved argument (#22/PD-012): the surviving card replaced the original. */
export interface SupersedeResolution {
  winner: BoardCard;
  replaced: BoardCard;
}

/**
 * The convergent reading of the board (#28) — a structured artifact, each field a
 * different lens on the same cards (so a card legitimately appears in more than
 * one section: a decision card is both a theme member and a decision).
 */
export interface ConvergentSummary {
  /** Total idea cards on the board. */
  cardCount: number;
  /** Connected clusters, biggest first; loose cards collected into a final theme. */
  themes: SummaryTheme[];
  /** Cards of kind `decision` — the calls that have been made. */
  decisions: BoardCard[];
  /** `supersedes` edges read as "X replaced by Y" — arguments that resolved. */
  resolutions: SupersedeResolution[];
  /** Cards of kind `question` — what is still open. */
  openQuestions: BoardCard[];
  /** Starred cards (#59) — the user's keep-marks. */
  highlights: BoardCard[];
  /** True when the board has no idea cards (the panel shows an empty state). */
  isEmpty: boolean;
}

/** Title of the catch-all theme gathering cards that belong to no cluster. */
export const STANDALONE_THEME = "Standalone ideas";

/* -------------------------------------------------------------------------- */
/* Union-find over the edges — same clustering the layout uses, kept local.   */
/* -------------------------------------------------------------------------- */

/** Map each card to its connected-component representative (over all edges). */
function components(snapshot: BoardSnapshot): Map<string, string> {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let cur = x;
    while (parent.get(cur) !== r) {
      const next = parent.get(cur)!;
      parent.set(cur, r);
      cur = next;
    }
    return r;
  };
  for (const c of snapshot.cards) parent.set(c.id, c.id);
  for (const e of snapshot.edges) {
    if (!parent.has(e.from) || !parent.has(e.to)) continue;
    parent.set(find(e.from), find(e.to));
  }
  const rep = new Map<string, string>();
  for (const c of snapshot.cards) rep.set(c.id, find(c.id));
  return rep;
}

/**
 * Pick a cluster's *main idea*: the card the most `about` edges point at (the hub
 * everything fans out from), preferring a card that is not itself superseded, with
 * the cluster's reading order as the final tiebreaker. Mirrors the root choice the
 * mind-map layout makes (`idea-layout/mind-map.ts` placeCluster), so the synthesis names a
 * theme after the same card Arrange would centre it on.
 */
function mainIdea(cluster: BoardCard[], edges: readonly BoardEdge[]): BoardCard {
  const aboutTargets = new Map<string, number>();
  for (const e of edges) {
    if (e.relation !== "about") continue;
    aboutTargets.set(e.to, (aboutTargets.get(e.to) ?? 0) + 1);
  }
  return cluster.reduce((best, card) => {
    const score = aboutTargets.get(card.id) ?? 0;
    const bestScore = aboutTargets.get(best.id) ?? 0;
    if (score !== bestScore) return score > bestScore ? card : best;
    if (card.superseded !== best.superseded) return best.superseded ? card : best;
    return best; // cluster is already in reading order — keep the earlier card
  });
}

/* -------------------------------------------------------------------------- */
/* The synthesis                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Read the board into a {@link ConvergentSummary} (#28). Pure and deterministic:
 * the only ordering input is the order of `snapshot.cards`, which the caller
 * provides in stable reading order (top-to-bottom, left-to-right). Cluster
 * membership comes from the edge graph; the section lenses (decisions / questions
 * / highlights) come from `kind` and the keep-mark. An empty board yields an empty
 * summary (`isEmpty: true`) rather than throwing.
 */
export function summarizeBoard(snapshot: BoardSnapshot): ConvergentSummary {
  const { cards, edges } = snapshot;
  if (cards.length === 0) {
    return {
      cardCount: 0,
      themes: [],
      decisions: [],
      resolutions: [],
      openQuestions: [],
      highlights: [],
      isEmpty: true
    };
  }

  // Cluster the cards by connected component, preserving the incoming card order
  // within each cluster (so the main-idea tiebreak and rendering are stable).
  const rep = components(snapshot);
  const clusters = new Map<string, BoardCard[]>();
  for (const card of cards) {
    const key = rep.get(card.id)!;
    const list = clusters.get(key);
    if (list) list.push(card);
    else clusters.set(key, [card]);
  }

  const themes: SummaryTheme[] = [];
  const standalone: BoardCard[] = [];
  for (const cluster of clusters.values()) {
    if (cluster.length < 2) {
      standalone.push(...cluster);
      continue;
    }
    const main = mainIdea(cluster, edges);
    // Main idea first, then the rest in reading order.
    const ordered = [main, ...cluster.filter((c) => c.id !== main.id)];
    themes.push({ title: main.title, cards: ordered });
  }
  // Biggest clusters first; the loose-card catch-all always sits last.
  themes.sort((a, b) => b.cards.length - a.cards.length);
  if (standalone.length) themes.push({ title: STANDALONE_THEME, cards: standalone });

  const byKind = (kind: string) => cards.filter((c) => normalizeKind(c.kind) === kind);

  const byId = new Map(cards.map((c) => [c.id, c]));
  const resolutions: SupersedeResolution[] = [];
  for (const e of edges) {
    if (e.relation !== "supersedes") continue;
    const winner = byId.get(e.from);
    const replaced = byId.get(e.to);
    if (winner && replaced) resolutions.push({ winner, replaced });
  }

  return {
    cardCount: cards.length,
    themes,
    decisions: byKind("decision"),
    resolutions,
    openQuestions: byKind("question"),
    highlights: cards.filter((c) => c.starred),
    isEmpty: false
  };
}

/* -------------------------------------------------------------------------- */
/* Markdown export — the copy/download artifact (PD-015)                       */
/* -------------------------------------------------------------------------- */

/** One card as a markdown bullet: decorated title in bold, em-dash body if any. */
function cardLine(card: BoardCard): string {
  const heading = decorateTitle(card.title.trim(), normalizeKind(card.kind));
  const body = card.body?.trim();
  return body ? `- **${heading}** — ${body}` : `- **${heading}**`;
}

/**
 * Render a {@link ConvergentSummary} as a normalized markdown document — the
 * artifact behind Copy / Download (#28, PD-015). A *reading* of the board, never
 * an editable surface. Empty sections are omitted; an empty board yields a single
 * "nothing to summarize yet" line.
 */
export function summaryToMarkdown(summary: ConvergentSummary): string {
  if (summary.isEmpty) {
    return "# Board summary\n\n_No ideas on the board yet — nothing to summarize._";
  }

  const out: string[] = ["# Board summary"];
  const themeCount = summary.themes.filter((t) => t.title !== STANDALONE_THEME).length;
  const themeNote = themeCount ? ` across ${themeCount} ${themeCount === 1 ? "theme" : "themes"}` : "";
  out.push(`_${summary.cardCount} ${summary.cardCount === 1 ? "idea" : "ideas"}${themeNote}._`);

  if (summary.themes.length) {
    out.push("## Themes");
    for (const theme of summary.themes) {
      out.push(`### ${theme.title.trim()}`);
      out.push(theme.cards.map(cardLine).join("\n"));
    }
  }

  if (summary.decisions.length) {
    out.push("## Decisions");
    out.push(summary.decisions.map(cardLine).join("\n"));
  }

  if (summary.resolutions.length) {
    out.push("## Resolved");
    out.push(
      summary.resolutions
        .map((r) => `- **${r.winner.title.trim()}** replaces ~~${r.replaced.title.trim()}~~`)
        .join("\n")
    );
  }

  if (summary.openQuestions.length) {
    out.push("## Open questions");
    out.push(summary.openQuestions.map(cardLine).join("\n"));
  }

  if (summary.highlights.length) {
    out.push("## Highlights (marked to keep)");
    out.push(summary.highlights.map(cardLine).join("\n"));
  }

  return out.join("\n\n");
}
