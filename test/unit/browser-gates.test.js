import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import config from "../../playwright.config.js";

test("browser gate defines the required isolated engine matrix", () => {
  assert.equal(config.workers, 1);
  assert.equal(config.fullyParallel, false);
  assert.equal(config.forbidOnly, Boolean(process.env.CI));
  assert.equal(config.retries, process.env.CI ? 1 : 0);
  assert.deepEqual(config.use, {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    extraHTTPHeaders: { "CF-Connecting-IP": "192.0.2.100" },
  });
  assert.deepEqual((config.projects ?? []).map(({ name }) => name), [
    "chromium", "firefox", "webkit", "chrome", "edge",
    "mobile-chrome", "mobile-safari", "chromium-no-js",
  ]);
  assert.equal((config.projects ?? []).every(({ use }) => use?.ignoreHTTPSErrors === true), true);
  const noJavaScript = (config.projects ?? []).find(({ name }) => name === "chromium-no-js");
  assert.match(String(noJavaScript?.testMatch), /native-no-js/);
  assert.equal((config.projects ?? []).filter(({ name }) => name !== "chromium-no-js")
    .every(({ testIgnore }) => /native-no-js/.test(String(testIgnore))), true);
});

test("local browser projects trust only the test harness certificate", async () => {
  const [releaseSmoke, releaseCsp] = await Promise.all([
    readFile(new URL("../e2e/release-smoke.spec.js", import.meta.url), "utf8"),
    readFile(new URL("../e2e/release-csp.spec.js", import.meta.url), "utf8"),
  ]);
  assert.match(releaseSmoke, /ignoreHTTPSErrors:\s*false/);
  assert.match(releaseSmoke, /expect\(health\.status\(\)\)\.toBe\(200\);[\s\S]*expect\(await health\.json\(\)\)/);
  assert.match(releaseCsp, /expect\(health\.status\(\)\)\.toBe\(200\);[\s\S]*expect\(await health\.json\(\)\)/);
  assert.match(releaseSmoke, /toHaveURL\(release\.base\.href\)/);
  assert.match(releaseSmoke, /getByRole\("heading", \{ name: "Repo Atlas", exact: true \}\)/);
  assert.match(releaseSmoke, /form\[action="\/repositories\/\$\{createdId\}\/delete"\]/);
  assert.match(releaseSmoke, /\?flash=repository_deleted/);
});
