import { describe, expect, it } from "vitest";
import { resolveStateDir, type StatePlatformEnv } from "./index.ts";

describe("resolveStateDir", () => {
  const linux: StatePlatformEnv = { platform: "linux", env: {}, home: "/home/me" };

  it("prefers only an absolute AI_STORM_STATE_DIR", () => {
    expect(resolveStateDir({ ...linux, env: { AI_STORM_STATE_DIR: "/var/lib/storm" } })).toBe("/var/lib/storm");
    expect(resolveStateDir({ ...linux, env: { AI_STORM_STATE_DIR: "relative", XDG_STATE_HOME: "/state" } })).toBe(
      "/state/ai-storm"
    );
  });

  it("uses XDG and platform defaults", () => {
    expect(resolveStateDir(linux)).toBe("/home/me/.local/state/ai-storm");
    expect(resolveStateDir({ ...linux, env: { XDG_STATE_HOME: "/xdg" } })).toBe("/xdg/ai-storm");
    expect(resolveStateDir({ platform: "darwin", env: {}, home: "/Users/me" })).toBe(
      "/Users/me/Library/Application Support/ai-storm"
    );
    expect(resolveStateDir({ platform: "win32", env: {}, home: "C:\\Users\\me" })).toBe(
      "C:\\Users\\me\\AppData\\Local\\ai-storm"
    );
    expect(
      resolveStateDir({ platform: "win32", env: { LOCALAPPDATA: "C:\\Users\\me\\Local" }, home: "C:\\Users\\me" })
    ).toBe("C:\\Users\\me\\Local\\ai-storm");
  });

  it("normalizes an explicit root with target-platform semantics", () => {
    expect(resolveStateDir({ ...linux, env: { AI_STORM_STATE_DIR: "/tmp/one/../two" } })).toBe("/tmp/two");
    expect(
      resolveStateDir({ platform: "win32", env: { AI_STORM_STATE_DIR: "C:\\state\\..\\storm" }, home: "C:\\Users\\me" })
    ).toBe("C:\\storm");
  });
});
