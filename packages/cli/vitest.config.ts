import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The launcher's parse/path/version helpers under test are pure Node code.
    environment: "node",
    include: ["src/**/*.test.ts"]
  }
});
