/**
 * Pure short-ref namespace helpers (idea-graph §4, mcp-idea-capture §3.3).
 *
 * The backend allocator is the sole authority for new `i<n>` refs. These helpers
 * only recognize the obsolete browser-local `a<n>` namespace in existing raw
 * documents; they do not allocate or repair refs. Kept tldraw-free so legacy-ref
 * detection remains unit-testable in the plain Node vitest environment.
 */

/** Obsolete browser-local ref pattern: `a<n>`. Canonical refs (`i<n>`) do not match. */
export const CANVAS_MINT_REF = /^a(\d+)$/;

/**
 * The legacy index a ref contributes: `n` for an old browser-local `a<n>`,
 * otherwise 0.
 */
export function canvasRefIndex(ref: string | undefined): number {
  const m = ref ? CANVAS_MINT_REF.exec(ref) : null;
  return m ? Number(m[1]) : 0;
}
