/**
 * Pure short-ref namespace helpers (idea-graph §4, mcp-idea-capture §3.3).
 *
 * Two producers mint card refs, in deliberately DISJOINT namespaces:
 *  - the canvas mints `a<n>` at card creation (`applyIdeas` / lazy `cardRef`);
 *  - the backend MCP tool path mints `i<n>` and ships it as `Idea.id`, which
 *    `applyIdeas` honours as the card's `meta.ref`.
 * The canvas's mint counter must therefore count ONLY its own `a<n>` refs — a
 * backend-minted `i<n>` (or any user-typed ref) contributes nothing, so the two
 * sequences can never collide. Kept tldraw-free so the namespace rule is
 * unit-testable in the plain Node vitest env (like `canvas-text.ts`).
 */

/** Canvas-minted ref pattern: `a<n>`. Backend MCP refs (`i<n>`) do NOT match. */
export const CANVAS_MINT_REF = /^a(\d+)$/;

/**
 * The canvas mint-counter index a ref contributes: `n` for a canvas-minted
 * `a<n>`, else 0 (backend-minted `i<n>`, absent, or any foreign ref).
 */
export function canvasRefIndex(ref: string | undefined): number {
  const m = ref ? CANVAS_MINT_REF.exec(ref) : null;
  return m ? Number(m[1]) : 0;
}
