import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "shared/src")
    }
  },
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["server/src/**/*.ts", "shared/src/**/*.ts"]
    }
  }
});
