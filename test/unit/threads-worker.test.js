import assert from "node:assert/strict";
import test from "node:test";
import {
  dispatchThreadsQueue, dispatchThreadsScheduled, matchThreadsRoute,
} from "../../src/threads-worker.js";
import { parseTelemetry } from "../../src/telemetry.js";

test("one matcher owns every exact Threads route contract and safe template", () => {
  /** @type {any[][]} */
  const routes = [
    ["/threads", "list", ["GET", "POST"], true, "/threads", null, null, null],
    ["/threads/connect", "connect", ["GET"], false, "/threads/connect", null, null, null],
    ["/threads/oauth/callback", "callback", ["GET"], true,
      "/threads/oauth/callback", null, null, null],
    ["/threads/disconnect", "disconnect", ["POST"], false,
      "/threads/disconnect", null, null, null],
    ["/threads/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "detail", ["GET"], true,
      "/threads/:id", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", null, null],
    ["/threads/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/sync", "sync", ["POST"], false,
      "/threads/:id/sync", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", null, "sync"],
    ["/threads/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/delete", "delete", ["POST"], false,
      "/threads/:id/delete", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", null, "delete"],
    ["/threads/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/media/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      "media", ["GET", "HEAD"], false, "/threads/:id/media/:mediaId",
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", null],
    ["/threads/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/media/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/retry",
      "retry", ["POST"], false, "/threads/:id/media/:mediaId/retry",
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "retry"],
  ];
  for (const [path, kind, methods, queryAllowed, template, postId, mediaId, action] of routes) {
    assert.deepEqual(matchThreadsRoute(path), {
      kind, methods, queryAllowed, template, postId, mediaId, action,
    });
    assert.equal(parseTelemetry({
      eventType: "navigation", metricName: "navigation_duration", value: 1,
    }, template, "release-1").routeTemplate, template);
  }
  for (const path of [
    "/threads/unsafe", "/threads/aaaaaaaa/media/not_hex", "/threads/aaaaaaaa/unknown",
    "/threads/oauth/callback/extra", "/repositories/aaaaaaaa",
  ]) assert.equal(matchThreadsRoute(path), null);
});

/** @param {unknown} body @param {boolean} [ackThrows] */
function message(body, ackThrows = false) {
  /** @type {{ body: unknown, acked: number, retries: { delaySeconds: number }[], ack(): void, retry(options: { delaySeconds: number }): void }} */
  const result = {
    body, acked: 0, retries: [],
    ack() { this.acked += 1; if (ackThrows) throw new Error("ack failure"); },
    /** @param {{ delaySeconds: number }} options */
    retry(options) { this.retries.push(options); },
  };
  return result;
}

const queueNames = Object.freeze({
  capture: "capture", media: "media", captureDlq: "capture-dlq", mediaDlq: "media-dlq",
});

test("Queue dispatcher routes primary and DLQ success, terminal, and transient outcomes", async () => {
  /** @type {any[]} */
  const calls = [];
  const adapters = {
    validateCapture: (/** @type {any} */ body) => body,
    validateMedia: (/** @type {any} */ body) => body,
    capture: async (/** @type {any} */ body) => { calls.push(["capture", body]); return body.result; },
    media: async (/** @type {any} */ body) => { calls.push(["media", body]); return body.result; },
    captureDlq: async (/** @type {any} */ body) => { calls.push(["captureDlq", body]); return body.result; },
    mediaDlq: async (/** @type {any} */ body) => { calls.push(["mediaDlq", body]); return body.result; },
  };
  for (const [queue, handler] of [
    [queueNames.capture, "capture"], [queueNames.media, "media"],
    [queueNames.captureDlq, "captureDlq"], [queueNames.mediaDlq, "mediaDlq"],
  ]) {
    const success = message({ result: { action: "ack" } });
    const terminal = message({ result: { action: "terminal" } });
    const transient = message({ result: { action: "retry", delaySeconds: 37 } });
    await dispatchThreadsQueue({ queue, messages: [success, terminal, transient] },
      queueNames, adapters);
    assert.equal(success.acked, 1);
    assert.equal(terminal.acked, 1);
    assert.deepEqual(transient.retries, [{ delaySeconds: 37 }]);
    assert.equal(calls.slice(-3).every(([name]) => name === handler), true);
  }
});

test("Queue dispatcher fails closed on unknown names and isolates every message exception", async () => {
  const first = message({ outcome: "throw" }, true);
  const second = message({ outcome: "ack" });
  const invalid = message({ invalid: true });
  const adapters = {
    validateCapture(/** @type {any} */ body) { if (body.invalid) throw new Error("invalid"); return body; },
    validateMedia: (/** @type {any} */ body) => body,
    async capture(/** @type {any} */ body) {
      if (body.outcome === "throw") throw new Error("temporary");
      return { action: "ack" };
    },
    media: async () => ({ action: "ack" }),
    captureDlq: async () => ({ action: "ack" }),
    mediaDlq: async () => ({ action: "ack" }),
  };
  await dispatchThreadsQueue({ queue: queueNames.capture, messages: [invalid, first, second] },
    queueNames, adapters);
  assert.equal(invalid.acked, 1);
  assert.deepEqual(first.retries, [{ delaySeconds: 1 }]);
  assert.equal(second.acked, 1);

  const untouched = message({ outcome: "ack" });
  await assert.rejects(dispatchThreadsQueue({ queue: "unknown", messages: [untouched] },
    queueNames, adapters), /threads_queue_not_configured/);
  assert.equal(untouched.acked, 0);
});

test("scheduled dispatcher accepts only daily cron and refreshes without content Queue work", async () => {
  /** @type {Array<[number, { refreshed: boolean, reconnectRequired: boolean }]>} */
  const cases = [
    [1_999_500_000, { refreshed: true, reconnectRequired: false }],
    [1_900_000_000, { refreshed: false, reconnectRequired: false }],
    [2_000_000_001, { refreshed: false, reconnectRequired: true }],
  ];
  let contentQueueSends = 0;
  for (const [nowSeconds, expected] of cases) {
    /** @type {Promise<unknown>[]} */
    const waited = [];
    const scheduledContext = /** @type {{ waitUntil(promise: Promise<unknown>): void }} */ ({
      waitUntil(promise) { waited.push(promise); },
    });
    const result = await dispatchThreadsScheduled({
      cron: "0 3 * * *", scheduledTime: nowSeconds * 1_000,
    }, scheduledContext,
    /** @type {any} */ ({
      async refresh(/** @type {number} */ actualNow) {
        assert.equal(actualNow, nowSeconds);
        return expected;
      },
      sendContent() { contentQueueSends += 1; },
    }));
    assert.deepEqual(result, expected);
    assert.equal(waited.length, 1);
    assert.deepEqual(await waited[0], expected);
  }
  assert.equal(contentQueueSends, 0);
  assert.throws(() => dispatchThreadsScheduled({ cron: "1 3 * * *", scheduledTime: 0 },
    { waitUntil() {} }, { refresh: async () => cases[0][1] }),
  /threads_schedule_not_configured/);
});
