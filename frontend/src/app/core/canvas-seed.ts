/**
 * Seed-guard decision for BlockSuite workspace docs (PRD §3.5 crash recovery).
 *
 * Each workspace's blocks live in a Yjs **subdoc** of the collection root, and
 * each subdoc is persisted to its own IndexedDB store (see CanvasService). A
 * subdoc rehydrates **asynchronously**: at the moment a doc is first `load()`ed
 * its block tree is still empty even when persisted content exists, because the
 * store has not finished applying its updates yet. Seeding a fresh
 * page/surface/note at that instant — the original data-loss bug — clobbers the
 * content that was about to arrive.
 *
 * The rule is therefore: seed **only** once the subdoc's own persistence has
 * fully synced AND the doc is still genuinely empty. A doc that rehydrated with
 * a root is left untouched; a brand-new doc (empty store, nothing to restore) is
 * seeded after its quick empty-sync.
 */
export interface SeedDecisionInput {
  /** Whether the doc has a root block right now (`!!doc.root`). */
  hasRoot: boolean;
  /** Whether the subdoc's IndexedDB persistence has finished its initial sync. */
  synced: boolean;
}

/**
 * Seed a doc only when its persistence has fully rehydrated and it is still
 * empty. Never seed a still-loading doc (data loss) nor a restored one.
 */
export function shouldSeedDoc({ hasRoot, synced }: SeedDecisionInput): boolean {
  return synced && !hasRoot;
}
