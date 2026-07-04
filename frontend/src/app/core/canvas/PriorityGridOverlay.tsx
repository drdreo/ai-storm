/**
 * The priority-grid overlay (#100) — labeled quadrant frames drawn on the canvas
 * while the board is arranged as a 2×2 impact×effort grid, so "Quick wins" /
 * "Big bets" / "Fill-ins" / "Time sinks" (and the "Not triaged" lane) are
 * readable without hovering, and grid mode has a visible active-state cue.
 *
 * Rendered in tldraw's `OnTheCanvas` slot, so it lives in page space and pans /
 * zooms with the camera like the cards do. Everything is `pointerEvents: none`
 * — the frames are pure annotation and never intercept canvas editing. Geometry
 * comes from the grid layout itself (carried on the per-editor
 * {@link activeBoardLayout} atom, so frames always trace what actually tiled);
 * `track` re-renders when the mode toggles or the theme flips.
 */
import { track, useColorMode, useEditor } from "tldraw";
import { activeBoardLayout } from "./layout";

export const PriorityGridOverlay = track(function PriorityGridOverlay(): React.JSX.Element | null {
  const editor = useEditor();
  const colorMode = useColorMode();
  const layout = activeBoardLayout(editor).get();
  if (layout?.mode !== "grid") return null;
  const frames = layout.frames;

  // Theme-local ink (like the card body's): the overlay sits on tldraw's canvas
  // background, so it follows the editor's light/dark mode, not the app chrome.
  const ink = colorMode === "dark" ? "#e8e8e8" : "#1c1c1c";
  return (
    <>
      {frames.map((f) => (
        <div
          key={f.key}
          style={{
            position: "absolute",
            left: f.x,
            top: f.y,
            width: f.w,
            height: f.h > 0 ? f.h : undefined,
            pointerEvents: "none",
            // h === 0 marks a label-only strip (the unscored lane, whose depth
            // depends on how many cards parked there) — caption, no box.
            border: f.h > 0 ? `2px dashed color-mix(in srgb, ${ink} 22%, transparent)` : "none",
            borderRadius: 20,
            boxSizing: "border-box"
          }}
        >
          <div
            style={{
              position: "absolute",
              top: 10,
              left: 18,
              fontSize: 22,
              fontWeight: 600,
              letterSpacing: "0.03em",
              fontFamily: "var(--tl-font-sans, system-ui, sans-serif)",
              color: ink,
              opacity: 0.5,
              whiteSpace: "nowrap"
            }}
          >
            {f.label}
          </div>
        </div>
      ))}
    </>
  );
});
