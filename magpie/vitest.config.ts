import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["client/**/*.test.ts", "server/**/*.test.ts"] },
});
