// The end-to-end tests: the built screen (npm run web:build) served by a Gasho server of each test's own
// (harness/hub.ts), in Chromium as a computer and in WebKit as an iPhone. npm run e2e builds the screen and runs them.
import { defineConfig, devices } from "@playwright/test";

const CI = !!process.env.CI;

export default defineConfig({
  testDir: "tests",
  outputDir: "test-results",
  // Each test starts a Gasho server, and the machine may be busy.
  timeout: 120_000,
  expect: { timeout: 15_000 },
  forbidOnly: CI,
  reporter: CI ? [["list"], ["html", { open: "never", outputFolder: "playwright-report" }], ["json", { outputFile: "results.json" }]] : [["list"]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["iPhone 15"] } },
  ],
});
