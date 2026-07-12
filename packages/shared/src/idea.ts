/** Canonical persisted/read model for an ai-storm idea card. */
export type IdeaOrigin = "agent" | "user";
export type IdeaRelation = "about" | "supersedes";

/** A capture-time link from the new idea to an existing card ref. */
export interface IdeaLink {
  to: string;
  relation?: IdeaRelation;
}

export interface IdeaIssueLink {
  provider: "github" | "linear";
  key: string;
  url: string;
  title?: string;
}

export interface IdeaExternalLink {
  url: string;
  label?: string;
}

export interface IdeaScore {
  impact: number;
  effort: number;
  confidence?: number;
}

/** One logical idea. Raw tldraw records remain the authoritative document format. */
export interface IdeaCard {
  /** Opaque tldraw shape identity. */
  id: string;
  /** Readable, project-global, non-reused identity. */
  ref: string;
  /** Opaque tldraw page identity. */
  pageId: string;
  kind: string;
  color?: string;
  title: string;
  body: string;
  origin: IdeaOrigin;
  createdAt?: number;
  editedByUser: boolean;
  issue?: IdeaIssueLink;
  links?: IdeaExternalLink[];
  starred: boolean;
  done: boolean;
  superseded: boolean;
  score?: IdeaScore;
  position: { x: number; y: number };
}

/** Canonical typed edge. Logical endpoints are refs; id preserves arrow identity. */
export interface IdeaEdge {
  id: string;
  pageId: string;
  from: string;
  to: string;
  relation: IdeaRelation;
}

export interface IdeaPage {
  id: string;
  name: string;
  cards: IdeaCard[];
  edges: IdeaEdge[];
}

/**
 * Input accepted from terminal/MCP capture. Creation allocates the ref when it
 * is absent and enriches this payload into a persisted {@link IdeaCard}.
 */
export interface CreateIdeaInput {
  title: string;
  body: string;
  kind?: string;
  ref?: string;
  links?: IdeaLink[];
}
