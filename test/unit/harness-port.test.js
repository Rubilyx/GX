import assert from "node:assert/strict";
import test from "node:test";
import { shouldRetryBrowserListen, shouldAcceptBrowserListen } from "../support/harness.js";

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
