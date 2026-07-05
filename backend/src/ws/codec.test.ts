import { describe, it, expect } from "vitest";
import { decodeClientMessage, encodeServerMessage } from "./codec.ts";

describe("decodeClientMessage", () => {
  it("decodes a well-formed client message", () => {
    expect(decodeClientMessage(JSON.stringify({ type: "resize", projectId: "p1", cols: 80, rows: 24 }))).toEqual({
      type: "resize",
      projectId: "p1",
      cols: 80,
      rows: 24
    });
  });

  it("throws on malformed JSON", () => {
    expect(() => decodeClientMessage("not json")).toThrow();
  });

  it("throws on a message missing required fields", () => {
    expect(() => decodeClientMessage(JSON.stringify({ type: "input" }))).toThrow(/projectId/);
  });
});

describe("encodeServerMessage", () => {
  it("round-trips a server message through JSON", () => {
    const msg = { type: "data", projectId: "p1", data: "aGVsbG8=" } as const;
    expect(JSON.parse(encodeServerMessage(msg))).toEqual(msg);
  });
});
