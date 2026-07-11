import { describe, expect, it } from "vitest";
import { parseCliArgs } from "./args.ts";
import { backgroundSpawnOptions, looksLikeAiStorm } from "./daemon.ts";
import { nodeVersionSupported } from "./doctor.ts";
import { backendLogFile, daemonStateFile, stateDir, type PlatformEnv } from "./paths.ts";

describe("parseCliArgs", () => {
  it("defaults to start with no arguments", () => {
    const opts = parseCliArgs([]);
    expect(opts.command).toBe("start");
    expect(opts.noOpen).toBe(false);
    expect(opts.foreground).toBe(false);
  });

  it("parses a command plus flags", () => {
    const opts = parseCliArgs(["start", "--port", "9000", "--no-open", "--foreground"]);
    expect(opts).toMatchObject({ command: "start", port: 9000, noOpen: true, foreground: true });
  });

  it("parses logs flags with short aliases", () => {
    const opts = parseCliArgs(["logs", "-f", "-n", "10"]);
    expect(opts).toMatchObject({ command: "logs", follow: true, lines: 10 });
  });

  it("maps --help and --version to commands", () => {
    expect(parseCliArgs(["--help"]).command).toBe("help");
    expect(parseCliArgs(["--version"]).command).toBe("version");
    expect(parseCliArgs(["status", "--help"]).command).toBe("help");
  });

  it("rejects unknown commands and flags", () => {
    expect(() => parseCliArgs(["strat"])).toThrow(/Unknown command/);
    expect(() => parseCliArgs(["start", "--prot", "9000"])).toThrow(/Unknown option/);
  });

  it("rejects malformed numeric flags", () => {
    expect(() => parseCliArgs(["start", "--port", "nope"])).toThrow(/--port/);
    expect(() => parseCliArgs(["start", "--port", "70000"])).toThrow(/--port/);
    expect(() => parseCliArgs(["logs", "-n", "-3"])).toThrow(/--lines/);
  });
});

describe("nodeVersionSupported", () => {
  it("accepts the minimum and anything newer", () => {
    expect(nodeVersionSupported("22.18.0")).toBe(true);
    expect(nodeVersionSupported("22.22.2")).toBe(true);
    expect(nodeVersionSupported("24.0.0")).toBe(true);
    expect(nodeVersionSupported("26.1.0")).toBe(true);
  });

  it("rejects versions without unflagged type stripping", () => {
    expect(nodeVersionSupported("22.17.1")).toBe(false);
    expect(nodeVersionSupported("20.19.0")).toBe(false);
    expect(nodeVersionSupported("18.20.0")).toBe(false);
  });
});

describe("looksLikeAiStorm", () => {
  it("recognizes the backend /health payload", () => {
    expect(looksLikeAiStorm({ status: "ok", os: "linux", runtime: "tmux" })).toBe(true);
    expect(looksLikeAiStorm({ status: "ok", os: "win32", runtime: "process" })).toBe(true);
  });

  it("rejects other services and junk", () => {
    expect(looksLikeAiStorm(null)).toBe(false);
    expect(looksLikeAiStorm("ok")).toBe(false);
    expect(looksLikeAiStorm({ status: "ok" })).toBe(false);
    expect(looksLikeAiStorm({ healthy: true })).toBe(false);
  });
});

describe("state paths", () => {
  const home = "/home/tester";

  it("uses an absolute explicit state root, then XDG state on Linux", () => {
    const linux: PlatformEnv = { platform: "linux", env: {}, home };
    expect(stateDir(linux)).toBe("/home/tester/.local/state/ai-storm");
    const xdg: PlatformEnv = { platform: "linux", env: { XDG_STATE_HOME: "/xdg" }, home };
    expect(stateDir(xdg)).toBe("/xdg/ai-storm");
    expect(stateDir({ ...linux, env: { AI_STORM_STATE_DIR: "/custom/state" } })).toBe("/custom/state");
    expect(stateDir({ ...linux, env: { AI_STORM_STATE_DIR: "relative", XDG_STATE_HOME: "/xdg" } })).toBe(
      "/xdg/ai-storm"
    );
  });

  it("uses Application Support on macOS and LOCALAPPDATA on Windows", () => {
    const mac: PlatformEnv = { platform: "darwin", env: {}, home };
    expect(stateDir(mac)).toBe("/home/tester/Library/Application Support/ai-storm");
    const win: PlatformEnv = {
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" },
      home: "C:\\Users\\tester"
    };
    expect(stateDir(win)).toBe("C:\\Users\\tester\\AppData\\Local\\ai-storm");
  });

  it("falls back to home-derived AppData when LOCALAPPDATA is unset", () => {
    const win: PlatformEnv = { platform: "win32", env: {}, home: "C:\\Users\\tester" };
    expect(stateDir(win)).toBe("C:\\Users\\tester\\AppData\\Local\\ai-storm");
  });

  it("nests logs and the daemon record under the state dir", () => {
    const linux: PlatformEnv = { platform: "linux", env: {}, home };
    expect(backendLogFile(linux)).toBe("/home/tester/.local/state/ai-storm/logs/backend.log");
    expect(daemonStateFile(linux)).toBe("/home/tester/.local/state/ai-storm/daemon.json");
  });

  it("uses the target platform's separator regardless of the host OS", () => {
    const win: PlatformEnv = {
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" },
      home: "C:\\Users\\tester"
    };
    expect(backendLogFile(win)).toBe("C:\\Users\\tester\\AppData\\Local\\ai-storm\\logs\\backend.log");
    expect(daemonStateFile(win)).toBe("C:\\Users\\tester\\AppData\\Local\\ai-storm\\daemon.json");
    const linux: PlatformEnv = { platform: "linux", env: {}, home };
    expect(stateDir(linux)).not.toContain("\\");
  });
});

describe("backgroundSpawnOptions", () => {
  // Regression for #216 review: the Windows daemon died with the launcher
  // because the background spawn was not detached there.
  it("detaches the daemon on every platform so it survives launcher exit", () => {
    const opts = backgroundSpawnOptions("/repo", 7);
    expect(opts.detached).toBe(true);
    expect(opts.stdio).toEqual(["ignore", 7, 7]);
    expect(opts.windowsHide).toBe(true);
    expect(opts.cwd).toBe("/repo");
  });
});
