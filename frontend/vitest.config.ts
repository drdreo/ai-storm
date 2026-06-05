import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The ingestion engine in src/app/core is framework-agnostic and has no DOM
    // dependency (the RenderScheduler tests inject their own frame scheduler),
    // so a plain Node environment is sufficient — no jsdom needed.
    environment: "node",
    include: ["src/app/core/**/*.test.ts"],
  },
});
