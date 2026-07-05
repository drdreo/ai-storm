import { describe, it, expect } from "vitest";
import { encodeServerMessage } from "./codec.ts";

describe("encodeServerMessage", () => {
  it("round-trips a server message through JSON", () => {
    const msg = { type: "data", projectId: "p1", data: "aGVsbG8=" } as const;
    expect(JSON.parse(encodeServerMessage(msg))).toEqual(msg);
  });
});
