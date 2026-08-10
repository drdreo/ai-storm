import { expect, it, vi } from "vitest";
import { McpSessionRegistry } from "./registry.ts";

it("uses the configured canonical allocator for MCP capture refs", async () => {
  const registry = new McpSessionRegistry();
  registry.configure("http://127.0.0.1:8787");
  const reserve = vi.fn(async () => "i42");
  registry.configureRefAllocator(reserve);
  const target = registry.registerSession("project1")!;
  const session = registry.resolve("project1", target.token)!;
  await expect(session.mintRef()).resolves.toBe("i42");
  expect(reserve).toHaveBeenCalledWith("project1");
});
