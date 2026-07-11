import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dispatchStateRequest } from "../server.ts";
import { StateStore } from "./store.ts";

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ai-storm-protocol-"));
  roots.push(root);
  const store = new StateStore({ root });
  await store.initialize();
  return store;
}
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("backend state protocol", () => {
  it("loads registry/board, acknowledges saves, returns conflicts, reserves refs, and persists granular history", async () => {
    const store = await fixture();
    const registry = (await dispatchStateRequest(
      "registry-create-project",
      undefined,
      {
        project: { id: "p1", title: "Project", terminal: {} }
      },
      store
    )) as { projects: Array<{ id: string }> };
    expect(registry.projects.map((project) => project.id)).toEqual(["p1"]);

    expect(await dispatchStateRequest("board-load", "p1", {}, store)).toEqual({ revision: 0, document: null });
    const document = { store: { "shape:one": { typeName: "shape" } }, schema: { schemaVersion: 2 } };
    expect(await dispatchStateRequest("board-save", "p1", { expectedRevision: 0, document }, store)).toMatchObject({
      ok: true,
      board: { revision: 1, document }
    });
    expect(
      await dispatchStateRequest("board-save", "p1", { expectedRevision: 0, document: { stale: true } }, store)
    ).toEqual({ ok: false, conflict: { revision: 1, document } });

    expect(await dispatchStateRequest("reserve-idea-refs", "p1", { count: 2 }, store)).toEqual({ refs: ["i1", "i2"] });
    await dispatchStateRequest("history-append", "p1", { entry: { id: "run1", status: "running" } }, store);
    const history = (await dispatchStateRequest(
      "history-update",
      "p1",
      {
        entryId: "run1",
        patch: { status: "done" }
      },
      store
    )) as { runs: unknown[] };
    expect(history.runs).toEqual([{ id: "run1", status: "done" }]);
  });
});
