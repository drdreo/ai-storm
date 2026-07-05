/**
 * Shared frontend testkit — the single home for cross-test fakes, mocks, and
 * builders so no test hand-rolls its own. Fakes are `*Fake` (working in-memory
 * implementations); mocks are `*Mock` (stubbed call-recorders).
 */
export * from "./editor-fake";
export * from "./frame-clock-fake";
