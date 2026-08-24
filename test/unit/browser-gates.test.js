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

test("Threads browser enhancements are reachable, same-origin, abortable, and native-safe", async () => {
  const [app, capture, panel, worker, manifest] = await Promise.all([
    readFile(new URL("../../public/assets/app.js", import.meta.url), "utf8"),
    readFile(new URL("../../public/assets/thread-capture.js", import.meta.url), "utf8"),
    readFile(new URL("../../public/assets/thread-panel.js", import.meta.url), "utf8"),
    readFile(new URL("../../src/worker.js", import.meta.url), "utf8"),
    readFile(new URL("../../public/modulepreload.json", import.meta.url), "utf8"),
  ]);
  assert.match(app, /import "\.\/thread-capture\.js";/);
  assert.match(app, /import "\.\/thread-panel\.js";/);
  assert.deepEqual(JSON.parse(manifest), [
    "dom.js", "repo-capture.js", "repo-filter.js", "repo-panel.js",
    "thread-capture.js", "thread-panel.js",
  ]);
  for (const name of ["threads.css", "thread-capture.js", "thread-panel.js"])
    assert.match(worker, new RegExp(`"${name.replace(".", "\\.")}"`));
  for (const source of [capture, panel]) {
    assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML/);
    assert.doesNotMatch(source, /WebSocket|EventSource|XMLHttpRequest|https?:\/\//);
  }
  assert.match(capture, /formJson\(form, controller\.signal\)/);
  assert.match(panel, /credentials:\s*"same-origin"/);
  assert.match(panel, /document\.visibilityState/);
  assert.match(panel, /visibilitychange/);
  assert.match(panel, /AbortController/);
  assert.match(panel, /event\.button === 0[\s\S]*!event\.ctrlKey[\s\S]*!event\.metaKey/);
  assert.match(panel, /textContent/);
});
