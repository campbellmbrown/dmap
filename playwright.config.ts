import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  use: {
    baseURL: "http://localhost:4311",
    trace: "on-first-retry"
  },
  webServer: {
    command: "npm run doctor && npm run build && node dist/server/index.js --port 4311 --host 127.0.0.1",
    url: "http://localhost:4311/player",
    timeout: 120_000,
    reuseExistingServer: !process.env.CI
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] }
    }
  ]
});
