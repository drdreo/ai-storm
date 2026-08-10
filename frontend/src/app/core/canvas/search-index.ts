/** Shared mapping from a backend-loaded tldraw shape record to search results. */
import type { IdeaCardMeta, Origin } from "./idea-card";
import type { SearchableIdea } from "./search";

export function toSearchableIdea(
  projectId: string,
  projectTitle: string,
  shapeId: string,
  props: { kind?: string; title?: string; body?: string; origin?: Origin; superseded?: boolean },
  meta: IdeaCardMeta
): SearchableIdea {
  return {
    projectId,
    projectTitle,
    shapeId,
    ref: meta.ref,
    kind: props.kind ?? "",
    title: props.title ?? "",
    body: props.body ?? "",
    origin: props.origin ?? "user",
    superseded: !!props.superseded,
    starred: !!meta.starred,
    triaged: !!meta.score,
    createdAt: typeof meta.createdAt === "number" ? meta.createdAt : undefined
  };
}
