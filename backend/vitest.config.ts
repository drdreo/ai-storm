import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The session-layer logic under test (response extraction, ANSI cleaning,
    // line buffering) is pure and has no runtime dependency, so a plain Node
    // environment is sufficient.
    environment: "node",
    include: ["src/**/*.test.ts"]
  }
});
