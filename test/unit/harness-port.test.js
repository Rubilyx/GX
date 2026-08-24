import assert from "node:assert/strict";
import test from "node:test";
import { shouldRetryBrowserListen, shouldAcceptBrowserListen } from "../support/harness.js";
import * as harnessSupport from "../support/harness.js";

test("retries only the native Fetch bad-port failure", () => {
  assert.equal(shouldRetryBrowserListen(new TypeError("fetch failed: bad port")), true);
  assert.equal(shouldRetryBrowserListen(new TypeError("fetch failed", {
    cause: new Error("bad port"),
  })), true);
  const serialized = new Error("fetch failed", { cause: new Error("bad port") });
  serialized.name = "TypeError";
  assert.equal(shouldRetryBrowserListen(serialized), true);
  assert.equal(shouldRetryBrowserListen({
    name: "TypeError", message: "fetch failed", cause: { message: "bad port" },
  }), true);
  assert.equal(shouldRetryBrowserListen(new Error("connection refused")), false);
});

test("accepts only the self-signed HTTPS health probe after a listen", () => {
  assert.equal(shouldAcceptBrowserListen(new TypeError("fetch failed", {
    cause: Object.assign(new Error("self signed certificate"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }),
  })), true);
  assert.equal(shouldAcceptBrowserListen(new Error("connection refused")), false);
});

test("reset transaction retries every bad-port stage and returns only the current initialized handle", async () => {
  const run = harnessSupport.runBrowserResetTransaction;
  assert.equal(typeof run, "function");
  const stages = ["reset", "listen", "probe", "handle", "migration", "binding"];
  for (const failingStage of stages) {
    let attempt = 0;
    /** @type {string[]} */
    const calls = [];
    const badPort = () => ({
      name: "TypeError", message: "fetch failed", cause: { message: "bad port" },
    });
    const result = await run({
      async reset() {
        attempt += 1; calls.push(`reset:${attempt}`);
        if (attempt === 1 && failingStage === "reset") throw badPort();
      },
      async listen() {
        calls.push(`listen:${attempt}`);
        if (attempt === 1 && failingStage === "listen") throw badPort();
        return new URL(`https://attempt-${attempt}.test/`);
      },
      async probe() {
        calls.push(`probe:${attempt}`);
        if (attempt === 1 && failingStage === "probe") throw badPort();
      },
      getWorker() {
        calls.push(`handle:${attempt}`);
        if (attempt === 1 && failingStage === "handle") throw badPort();
        return { attempt };
      },
      async migrate(worker) {
        calls.push(`migration:${worker.attempt}`);
        if (attempt === 1 && failingStage === "migration") throw badPort();
      },
      async initializeBinding(worker) {
        calls.push(`binding:${worker.attempt}`);
        if (attempt === 1 && failingStage === "binding") throw badPort();
      },
    });
    assert.equal(result.url.href, "https://attempt-2.test/");
    assert.deepEqual(result.worker, { attempt: 2 });
    assert.equal(calls[0], "reset:1");
    assert.equal(calls.includes("reset:2"), true, failingStage);
    assert.equal(calls.at(-1), "binding:2");
  }
});

test("reset transaction surfaces a non-bad-port initialization failure immediately", async () => {
  const run = harnessSupport.runBrowserResetTransaction;
  assert.equal(typeof run, "function");
  let resets = 0;
  const failure = new Error("migration_corrupt");
  await assert.rejects(run({
    async reset() { resets += 1; },
    async listen() { return new URL("https://attempt.test/"); },
    async probe() {},
    getWorker() { return {}; },
    async migrate() { throw failure; },
    async initializeBinding() { assert.fail("binding unexpectedly initialized"); },
  }), (error) => error === failure);
  assert.equal(resets, 1);
});
