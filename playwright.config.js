import { defineConfig, devices } from "@playwright/test";

const nativeNoJavaScript = "**/native-no-js.spec.js";

export default defineConfig({
  testDir: "test/e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [["line"], ["json", { outputFile: "artifacts/playwright-results.json" }]]
    : "list",
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    extraHTTPHeaders: { "CF-Connecting-IP": "192.0.2.100" },
  },
  projects: [
    { name: "chromium", testIgnore: nativeNoJavaScript, use: { ...devices["Desktop Chrome"], ignoreHTTPSErrors: true } },
    { name: "firefox", testIgnore: nativeNoJavaScript, use: { ...devices["Desktop Firefox"], ignoreHTTPSErrors: true } },
    { name: "webkit", testIgnore: nativeNoJavaScript, use: { ...devices["Desktop Safari"], ignoreHTTPSErrors: true } },
    { name: "chrome", testIgnore: nativeNoJavaScript, use: { ...devices["Desktop Chrome"], channel: "chrome", ignoreHTTPSErrors: true } },
    { name: "edge", testIgnore: nativeNoJavaScript, use: { ...devices["Desktop Edge"], channel: "msedge", ignoreHTTPSErrors: true } },
    { name: "mobile-chrome", testIgnore: nativeNoJavaScript, use: { ...devices["Pixel 7"], ignoreHTTPSErrors: true } },
    { name: "mobile-safari", testIgnore: nativeNoJavaScript, use: { ...devices["iPhone 15"], ignoreHTTPSErrors: true } },
    { name: "chromium-no-js", testMatch: nativeNoJavaScript, use: { ...devices["Desktop Chrome"], javaScriptEnabled: false, ignoreHTTPSErrors: true } },
  ],
});
