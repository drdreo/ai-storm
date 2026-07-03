/**
 * Manual idea creation (#31, PD-009) — the user-origin counterpart to `applyIdeas`.
 * Until now the only producer of `idea-card`s was the AI ingest path; a user who
 * wanted to jot their own thought reached for tldraw's native note/text tools,
 * whose shapes the idea-graph doesn't track (no ref, no provenance) and the card
 * verbs/menus ignore (they gate on `type === 'idea-card'`). This module makes a
 * user's manual note a first-class idea card:
 *
 * - {@link IdeaCardTool} — a native tldraw {@link StateNode} tool: pick it, click
 *   the canvas, and a `origin: 'user'` card drops at the pointer in edit mode.
 * - {@link ideaToolOverrides} — registers it on the toolbar (with the `i` shortcut).
 * - {@link IdeaToolbar} — the toolbar component that surfaces the tool button.
 * - {@link createUserIdea} — the shared create-at-point helper (also used by the
 *   right-click "New idea here" menu item in {@link ./menus}).
 *
 * Kept "as close to native tldraw as possible" (canvas-island.tsx): a real tool in
 * the native toolbar, a real keyboard shortcut, the native style panel for color.
 */
import {
  StateNode,
  createShapeId,
  DefaultToolbar,
  DefaultToolbarContent,
  TldrawUiMenuItem,
  useTools,
  useIsToolSelected,
  type Editor,
  type TLComponents,
  type TLUiOverrides,
  type VecLike
} from "tldraw";
import { CARD_W, CARD_H, type IdeaCardMeta, type IdeaCardShape } from "./idea-card";

/**
 * Create a user-origin idea card centred on `at`, select it, and drop straight
 * into edit mode so the user types their thought immediately. Props fall back to
 * the shape's defaults (`origin: 'user'`, `title: 'Untitled idea'`), so this is
 * the user analogue of `applyIdeas`' AI-origin `createShape`. Returns the new id.
 */
export function createUserIdea(editor: Editor, at: VecLike): void {
  const id = createShapeId();
  editor.run(() => {
    editor.createShape<IdeaCardShape>({
      id,
      type: "idea-card",
      x: at.x - CARD_W / 2,
      y: at.y - CARD_H / 2,
      // No props → the shape's getDefaultProps wins: origin: 'user'. Stamp the
      // creation time (#124) so the card is dateable by full-text search.
      meta: { createdAt: Date.now() } satisfies IdeaCardMeta
    });
    editor.select(id);
    // Enter the card's text edit mode (idea-card canEdit === true) so the title
    // field is focused and the user can type without a second click.
    editor.setEditingShape(id);
  });
}

/**
 * The "Idea" tool — a minimal {@link StateNode}: on pointer-down it drops a
 * user-origin card at the click point (via {@link createUserIdea}) and hands back
 * to the select tool, so creation is a single click, mirroring tldraw's own note
 * tool. Registered under the `idea-card` tool id by {@link ideaToolOverrides}.
 */
export class IdeaCardTool extends StateNode {
  static override id = "idea-card";

  override onEnter(): void {
    this.editor.setCursor({ type: "cross", rotation: 0 });
  }

  override onPointerDown(): void {
    createUserIdea(this.editor, this.editor.inputs.currentPagePoint);
    // Drop back to select so the freshly-created card is immediately editable
    // and movable — the same one-shot feel as placing a native note.
    this.editor.setCurrentTool("select");
  }
}

/** The tool instances passed to `<Tldraw tools={…}>`. */
export const IDEA_TOOLS = [IdeaCardTool];

/**
 * Register the Idea tool with the UI so it shows on the toolbar and binds the `i`
 * keyboard shortcut — the idiomatic tldraw override (tldraw.dev/examples/custom-tool).
 * Reuses the built-in `tool-note` icon, so no custom asset wiring is needed.
 */
export const ideaToolOverrides: TLUiOverrides = {
  tools(editor, tools) {
    tools.idea = {
      id: "idea-card",
      icon: "tool-note",
      label: "Idea",
      kbd: "i",
      onSelect: () => editor.setCurrentTool("idea-card")
    };
    return tools;
  }
};

/**
 * The toolbar with our Idea tool button prepended to the default content — the
 * custom-toolbar pattern (keep {@link DefaultToolbarContent}, add our item). The
 * button highlights while the tool is active, exactly like the native tools.
 */
export function IdeaToolbar(props: React.ComponentProps<typeof DefaultToolbar>): React.JSX.Element {
  const tools = useTools();
  const isSelected = useIsToolSelected(tools["idea"]);
  return (
    <DefaultToolbar {...props}>
      <TldrawUiMenuItem {...tools["idea"]} isSelected={isSelected} />
      <DefaultToolbarContent />
    </DefaultToolbar>
  );
}

/** The `components` slice this module owns, merged into the island's components. */
export const ideaToolComponents: Pick<TLComponents, "Toolbar"> = {
  Toolbar: IdeaToolbar
};
