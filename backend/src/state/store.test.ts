import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveStateDir, type StatePlatformEnv } from "@ai-storm/state";
import { atomicWriteJson, StateFileError, StateStore } from "./store.ts";

const roots: string[] = [];
async function store(options: ConstructorParameters<typeof StateStore>[0] = {}): Promise<StateStore> {
  const root = await mkdtemp(join(tmpdir(), "ai-storm-state-"));
  roots.push(root);
  const value = new StateStore({ root, ...options });
  await value.initialize();
  return value;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("state root resolution", () => {
  const linux: StatePlatformEnv = { platform: "linux", env: {}, home: "/home/me" };

  it("prefers only an absolute AI_STORM_STATE_DIR", () => {
    expect(resolveStateDir({ ...linux, env: { AI_STORM_STATE_DIR: "/var/lib/storm" } })).toBe("/var/lib/storm");
    expect(resolveStateDir({ ...linux, env: { AI_STORM_STATE_DIR: "relative", XDG_STATE_HOME: "/state" } })).toBe(
      "/state/ai-storm"
    );
  });

  it("uses platform defaults", () => {
    expect(resolveStateDir(linux)).toBe("/home/me/.local/state/ai-storm");
    expect(resolveStateDir({ ...linux, env: { XDG_STATE_HOME: "/xdg" } })).toBe("/xdg/ai-storm");
    expect(resolveStateDir({ platform: "darwin", env: {}, home: "/Users/me" })).toBe(
      "/Users/me/Library/Application Support/ai-storm"
    );
    expect(
      resolveStateDir({ platform: "win32", env: { LOCALAPPDATA: "C:\\Users\\me\\Local" }, home: "C:\\Users\\me" })
    ).toBe("C:\\Users\\me\\Local\\ai-storm");
  });
});

describe("StateStore", () => {
  it("initializes only an empty valid registry with owner-only POSIX permissions", async () => {
    const value = await store();
    expect(await value.readRegistry()).toEqual({ version: 1, revision: 0, projects: [], folders: [] });
    await expect(readFile(value.boardPath("missing"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    if (process.platform !== "win32") {
      expect((await stat(value.root)).mode & 0o777).toBe(0o700);
      expect((await stat(value.registryPath)).mode & 0o777).toBe(0o600);
    }
  });

  it("creates child documents before registering a project and round trips metadata", async () => {
    const order: string[] = [];
    const value = await store({
      now: () => 42,
      writeJson: async (path, document) => {
        order.push(path);
        await atomicWriteJson(path, document);
      }
    });
    order.length = 0;
    await value.createProject({ id: "p1", title: "Project", terminal: { shell: "bash" }, color: "blue" });
    expect(order).toEqual([value.boardPath("p1"), value.historyPath("p1"), value.registryPath]);
    expect(await value.readBoard("p1")).toEqual({ version: 1, revision: 0, nextIdeaRef: 1, document: null });
    expect(await value.readHistory("p1")).toEqual({ version: 1, revision: 0, runs: [] });
    expect((await value.readRegistry()).projects[0]).toEqual({
      id: "p1",
      title: "Project",
      terminal: { shell: "bash" },
      color: "blue",
      createdAt: 42,
      updatedAt: 42
    });
  });

  it("handles board revisions, stale conflicts, and opaque document round trips", async () => {
    const value = await store();
    await value.createProject({ id: "p1", title: "Project", terminal: {} });
    const document = {
      store: { "shape:any": { typeName: "shape", type: "geo", custom: [1, 2] } },
      schema: { sequences: {} }
    };
    expect(await value.writeBoard("p1", 0, document)).toMatchObject({ ok: true, board: { revision: 1, document } });
    expect(await value.writeBoard("p1", 0, { stale: true })).toEqual({
      ok: false,
      conflict: { revision: 1, document }
    });
    expect((await value.readBoard("p1")).document).toEqual(document);
  });

  it("serializes concurrent ref reservations without reuse", async () => {
    const value = await store();
    await value.createProject({ id: "p1", title: "Project", terminal: {} });
    const reservations = await Promise.all(Array.from({ length: 20 }, () => value.reserveIdeaRefs("p1", 2)));
    expect(reservations.flat()).toEqual(Array.from({ length: 40 }, (_, index) => `i${index + 1}`));
    expect(await value.reserveIdeaRefs("p1", 1)).toEqual(["i41"]);
    expect((await value.readBoard("p1")).revision).toBe(21);
  });

  it("applies granular registry and history mutations", async () => {
    let now = 10;
    const value = await store({ now: () => ++now });
    await value.createFolder({ id: "f1", title: "Folder", createdAt: 1 });
    await value.createProject({ id: "p1", title: "Old", folderId: "f1", terminal: {} });
    const updated = await value.updateProject("p1", { title: "New" });
    expect(updated.updatedAt).toBe(12);
    await value.updateFolder("f1", { title: "Renamed" });
    await value.deleteFolder("f1");
    const registry = await value.readRegistry();
    expect(registry.projects[0]).not.toHaveProperty("folderId");
    expect(registry.projects[0].updatedAt).toBe(13);
    expect(registry.folders).toEqual([]);

    await value.appendHistoryEntry("p1", { id: "run1", status: "running" });
    await value.updateHistoryEntry("p1", "run1", { status: "done" });
    expect((await value.readHistory("p1")).runs).toEqual([{ id: "run1", status: "done" }]);
    expect((await value.deleteHistoryEntry("p1", "run1")).runs).toEqual([]);
  });

  it("does not replace malformed files or destroy the prior file after a failed write", async () => {
    const value = await store();
    await writeFile(value.registryPath, "{broken", "utf8");
    await expect(value.initialize()).rejects.toBeInstanceOf(StateFileError);
    expect(await readFile(value.registryPath, "utf8")).toBe("{broken");

    await atomicWriteJson(value.registryPath, { version: 1, revision: 7, projects: [], folders: [] });
    const failing = new StateStore({
      root: value.root,
      writeJson: async () => {
        throw new Error("disk full");
      }
    });
    await expect(failing.createFolder({ id: "f", title: "Nope", createdAt: 1 })).rejects.toThrow("disk full");
    expect(JSON.parse(await readFile(value.registryPath, "utf8"))).toMatchObject({ revision: 7, folders: [] });
  });

  it("rejects malformed store envelopes without overwriting them", async () => {
    const value = await store();
    await value.createProject({ id: "p1", title: "Project", terminal: {} });
    await writeFile(value.boardPath("p1"), '{"version":1,"document":{}}', "utf8");
    await expect(value.writeBoard("p1", 0, { replacement: true })).rejects.toBeInstanceOf(StateFileError);
    expect(await readFile(value.boardPath("p1"), "utf8")).toBe('{"version":1,"document":{}}');
  });

  it("removes the registry entry before deleting project files", async () => {
    const value = await store();
    await value.createProject({ id: "p1", title: "Project", terminal: {} });
    expect(await value.deleteProject("p1")).toBe(true);
    expect((await value.readRegistry()).projects).toEqual([]);
    await expect(readFile(value.boardPath("p1"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
