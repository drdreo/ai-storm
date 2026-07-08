/**
 * The `IdeaCardShapeUtil` — the tldraw `ShapeUtil` that ties the schema, the
 * rendered {@link IdeaCardBody}, and the content helpers together: default props,
 * geometry, resize, the clipboard/search text representation, and the selection
 * indicator. Kept "as close to native tldraw as possible" (idea-graph.md §3).
 */
import {
  DefaultColorStyle,
  type Geometry2d,
  type RecordProps,
  Rectangle2d,
  resizeBox,
  ShapeUtil,
  T,
  type TLResizeInfo
} from "tldraw";
import { cardToText } from "../../canvas-text";
import { CARD_H, CARD_W, type IdeaCardShape } from "./schema";
import { content } from "./queries";
import { IdeaCardBody } from "./body";

export class IdeaCardShapeUtil extends ShapeUtil<IdeaCardShape> {
  static override type = "idea-card" as const;
  static override props: RecordProps<IdeaCardShape> = {
    w: T.number,
    h: T.number,
    kind: T.string,
    title: T.string,
    body: T.string,
    origin: T.literalEnum("ai", "user"),
    superseded: T.boolean,
    // A real shared style — this is what wires the card into the style panel and
    // the theme's light/dark color resolution (tldraw styles system).
    color: DefaultColorStyle
  };

  override getDefaultProps(): IdeaCardShape["props"] {
    return {
      w: CARD_W,
      h: CARD_H,
      kind: "",
      title: "Untitled idea",
      body: "",
      origin: "user",
      superseded: false,
      color: "blue"
    };
  }

  override getGeometry(shape: IdeaCardShape): Geometry2d {
    return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: true });
  }

  override canResize = () => true;
  override canEdit = () => true;

  // The card's text representation — what tldraw joins into the `text/plain`
  // clipboard fallback, search, and drag-out. Without it a copied card has no
  // text and consumers fall back to the shape blob (#74).
  override getText(shape: IdeaCardShape): string {
    return cardToText(content(shape));
  }

  override onResize(shape: IdeaCardShape, info: TLResizeInfo<IdeaCardShape>) {
    return resizeBox(shape, info);
  }

  override component(shape: IdeaCardShape) {
    return <IdeaCardBody shape={shape} />;
  }

  // tldraw 5 takes the selection outline as a Path2D (was a JSX <rect> in v3).
  override getIndicatorPath(shape: IdeaCardShape): Path2D {
    const path = new Path2D();
    path.rect(0, 0, shape.props.w, shape.props.h);
    return path;
  }
}
