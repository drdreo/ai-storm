/**
 * The custom `idea-card` shape — the idea-graph node (idea-graph.md §3) and the
 * foundation every other canvas module builds on. This barrel is the module's
 * public face (`./idea-card`); the pieces are grouped into cohesive files:
 *
 *  - `schema`     — the typed props, `meta` shape, provenance, dimension
 *                   constants, and the tldraw type-system registration.
 *  - `sizing`     — initial-size estimation from content (#215).
 *  - `styles`     — shared visual constants + the chip / edit-field styles.
 *  - `chips`      — the bottom-strip link chips + inline link editor (#125/#227).
 *  - `body`       — the rendered card body component.
 *  - `shape-util` — the tldraw `ShapeUtil` tying schema + body + content together.
 *  - `queries`    — the identity/content helpers (`ideaCards`, refs, order).
 *
 * Kept "as close to native tldraw as possible": the card tint is a real shared
 * `color` StyleProp, so cards live in the style panel and follow the theme.
 */
export { type Origin, type IdeaCardShape, type IdeaCardMeta, CARD_W, CARD_H, CARD_MAX_W } from "./schema";
export { type IdeaCardSizeInput, ideaCardSizeForContent } from "./sizing";
export { IdeaCardShapeUtil } from "./shape-util";
export { ideaCards, allIdeaCards, maxRefIndex, content, cardsInOrder, cardRef, resolveRef } from "./queries";
