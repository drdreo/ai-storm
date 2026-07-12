import { describe, expect, it } from "vitest";
import { replayCapture } from "./replay.ts";

describe("replayCapture", () => {
  it("clears the fresh client terminal and replays flattened rows from column zero", () => {
    expect(replayCapture("first\nsecond")).toBe("\x1b[2J\x1b[3J\x1b[Hfirst\r\nsecond");
  });

  it("normalizes existing CRLF without duplicating carriage returns", () => {
    expect(replayCapture("first\r\nsecond")).toBe("\x1b[2J\x1b[3J\x1b[Hfirst\r\nsecond");
  });
});
