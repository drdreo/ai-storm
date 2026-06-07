import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The framework-agnostic core (src/app/core) and the ported Zustand stores
    // (src/app/stores) run with their heavy/DOM collaborators mocked, so a plain
    // Node environment is sufficient — no jsdom needed.
    environment: "node",
    include: ["src/app/core/**/*.test.ts", "src/app/stores/**/*.test.ts"],
  },
});
