import assert from "node:assert/strict";
import test from "node:test";
import worker, {
  handleRequest, handleThreadsQueue, handleThreadsScheduled, securityHeaders, selectRuntime,
} from "../../src/worker.js";

const db = Object.freeze({ name: "db" });
const env = {
  ENVIRONMENT: "test",
  PRODUCTION_HOST: "production.repo-atlas.test",
  PROD_DB: db,
  PROD_PIN_SALT: "cHJvZC1zYWx0",
  PROD_PIN_DIGEST: "cHJvZC1kaWdlc3Q=",
  PROD_IP_HMAC_KEY: "cHJvZC1pcA==",
  PROD_SESSION_KEY: "cHJvZC1zZXNzaW9u",
  OPENAI_API_KEY: "test-openai-key",
  OPENAI_MODEL: "test-snapshot",
  RELEASE_ID: "test-release",
  TRUSTED_TYPES_MODE: "report-only",
  THREADS_MEDIA: { get() {}, head() {}, put() {}, delete() {} },
  THREADS_CAPTURE_QUEUE: { send() {} },
  THREADS_MEDIA_QUEUE: { send() {} },
  THREADS_APP_ID: "test-threads-app",
  THREADS_APP_SECRET: "test-threads-secret",
  THREADS_TOKEN_KEY: "cmVwby1hdGxhcy10aHJlYWRzLXRlc3Qta2V5LTAwMDE=",
  THREADS_CAPTURE_QUEUE_NAME: "capture-primary",
  THREADS_MEDIA_QUEUE_NAME: "media-primary",
  THREADS_CAPTURE_DLQ_NAME: "capture-dlq",
  THREADS_MEDIA_DLQ_NAME: "media-dlq",
};

test("selectRuntime uses one production runtime and rejects unknown hosts", () => {
  const runtime = selectRuntime(env.PRODUCTION_HOST, env);
  assert.equal(runtime.environment, "production");
  assert.equal(runtime.db, env.PROD_DB);
  assert.equal(runtime.productionHost, env.PRODUCTION_HOST);
  assert.equal(runtime.allowedOrigin, `https://${env.PRODUCTION_HOST}`);
  const legacyStagingEnv = /** @type {any} */ ({
    ...env, STAGING_HOST: "staging.repo-atlas.test",
  });
  assert.throws(() => selectRuntime("staging.repo-atlas.test", legacyStagingEnv), /host_not_allowed/);
  assert.throws(() => selectRuntime("random.repo-atlas.test", env), /host_not_allowed/);
});

test("selectRuntime accepts only loopback hosts in the test environment", () => {
  assert.equal(selectRuntime("localhost", env).db, env.PROD_DB);
  assert.equal(selectRuntime("127.0.0.1", env).db, env.PROD_DB);
  assert.equal(selectRuntime(env.PRODUCTION_HOST, env).allowedOrigin,
    `https://${env.PRODUCTION_HOST}`);
  assert.throws(() => selectRuntime("0.0.0.0", env), /host_not_allowed/);
  assert.throws(() => selectRuntime("localhost", { ...env, ENVIRONMENT: "production" }),
    /host_not_allowed/);
});

test("GET /health exposes only status and release ID", async () => {
  const response = await handleRequest(
    new Request(`https://${env.PRODUCTION_HOST}/health`),
    env,
    { waitUntil() {} },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok", releaseId: "test-release" });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("referrer-policy"), "same-origin");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});

test("test worker fails closed without a valid provider fixture", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error("unexpected_global_fetch"); };
  try {
    for (const fixture of [undefined, {}, { fetch: "not-a-function" }]) {
      const response = await worker.fetch(new Request("https://localhost/health"),
        /** @type {any} */ ({ ...env, PROVIDER_FIXTURE: fixture }), { waitUntil() {} });
      assert.equal(response.status, 503);
    }
    assert.equal(calls, 0);
    assert.equal((await worker.fetch(new Request(`https://${env.PRODUCTION_HOST}/health`),
      { ...env, ENVIRONMENT: "production" }, { waitUntil() {} })).status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Threads bindings are exposed but validated only on Threads paths", async () => {
  const runtime = selectRuntime(env.PRODUCTION_HOST, env);
  assert.equal(runtime.threadsMedia, env.THREADS_MEDIA);
  assert.equal(runtime.threadsCaptureQueue, env.THREADS_CAPTURE_QUEUE);
  assert.equal(runtime.threadsMediaQueue, env.THREADS_MEDIA_QUEUE);
  assert.equal(runtime.threadsAppId, env.THREADS_APP_ID);
  assert.equal(runtime.threadsAppSecret, env.THREADS_APP_SECRET);
  assert.equal(runtime.threadsTokenKey, env.THREADS_TOKEN_KEY);
  assert.equal(runtime.threadsCaptureQueueName, env.THREADS_CAPTURE_QUEUE_NAME);
  assert.equal(runtime.threadsMediaQueueName, env.THREADS_MEDIA_QUEUE_NAME);
  assert.equal(runtime.threadsCaptureDlqName, env.THREADS_CAPTURE_DLQ_NAME);
  assert.equal(runtime.threadsMediaDlqName, env.THREADS_MEDIA_DLQ_NAME);

  const repositoryOnly = /** @type {Record<string, any>} */ ({ ...env });
  for (const key of Object.keys(repositoryOnly)) if (key.startsWith("THREADS_")) delete repositoryOnly[key];
  assert.equal((await handleRequest(new Request(`https://${env.PRODUCTION_HOST}/health`),
    /** @type {any} */ (repositoryOnly), { waitUntil() {} })).status, 200);
  assert.equal((await handleRequest(new Request(`https://${env.PRODUCTION_HOST}/threads`),
    /** @type {any} */ (repositoryOnly), { waitUntil() {} })).status, 503);
});

test("authenticated app CSP adds only same-origin media while login CSP is unchanged", () => {
  assert.equal(securityHeaders("app", "report-only").get("content-security-policy"),
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' https://github.com https://avatars.githubusercontent.com; media-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; report-uri /csp-report");
  assert.equal(securityHeaders("login", "report-only").get("content-security-policy"),
    "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; connect-src 'none'; report-uri /csp-report");
});

/** @param {unknown} body */
function queueMessage(body) {
  /** @type {{ body: unknown, acked: number, retried: { delaySeconds: number }[], ack(): void, retry(options: { delaySeconds: number }): void }} */
  const message = {
    body, acked: 0, retried: [],
    ack() { this.acked += 1; },
    /** @param {{ delaySeconds: number }} options */
    retry(options) { this.retried.push(options); },
  };
  return message;
}

test("Queue routing validates and settles every message independently for all four names", async () => {
  const eventEnv = {
    ...env,
    PROD_DB: {
      prepare() { throw new Error("temporary storage failure"); },
      batch() { throw new Error("temporary storage failure"); },
    },
  };
  const cases = [
    [env.THREADS_CAPTURE_QUEUE_NAME,
      { version: 1, type: "resolve-post", postId: "post-1", generation: 1, cursor: null }],
    [env.THREADS_MEDIA_QUEUE_NAME,
      { version: 1, type: "retry-media", postId: "post-1", generation: 1, mediaId: "media-1" }],
    [env.THREADS_CAPTURE_DLQ_NAME,
      { version: 1, type: "resolve-post", postId: "post-1", generation: 1, cursor: null }],
    [env.THREADS_MEDIA_DLQ_NAME,
      { version: 1, type: "retry-media", postId: "post-1", generation: 1, mediaId: "media-1" }],
  ];
  for (const [queue, body] of cases) {
    const invalid = queueMessage({ token: "private", text: "private" });
    const transient = queueMessage(body);
    await handleThreadsQueue({ queue, messages: [invalid, transient] }, eventEnv,
      { waitUntil() {} }, async () => { throw new Error("provider not expected"); });
    assert.equal(invalid.acked, 1);
    assert.deepEqual(invalid.retried, []);
    assert.equal(transient.acked, 0);
    assert.deepEqual(transient.retried, [{ delaySeconds: 1 }]);
  }

  const untouched = queueMessage(cases[0][1]);
  await assert.rejects(handleThreadsQueue({ queue: "unknown", messages: [untouched] }, eventEnv,
    { waitUntil() {} }, fetch), /threads_queue_not_configured/);
  assert.equal(untouched.acked, 0);
  assert.deepEqual(untouched.retried, []);
});

test("scheduled refresh is registered with waitUntil and exact daily cron", async () => {
  const scheduledEnv = {
    ...env,
    PROD_DB: {
      prepare() {
        return { first: async () => null,
          all: async () => ({ success: true, results: [] }) };
      },
      batch() { throw new Error("batch not expected"); },
    },
    PROVIDER_FIXTURE: { fetch: async () => { throw new Error("provider not expected"); } },
  };
  /** @type {Promise<unknown>[]} */
  const promises = [];
  /** @type {{ waitUntil(promise: Promise<unknown>): void }} */
  const context = { waitUntil(promise) {
    promises.push(promise);
  } };
  assert.deepEqual(await handleThreadsScheduled(scheduledEnv, context,
    scheduledEnv.PROVIDER_FIXTURE.fetch, 1_800_000_000),
  { refreshed: false, reconnectRequired: true });
  assert.equal(promises.length, 1);
  assert.deepEqual(await promises[0], { refreshed: false, reconnectRequired: true });
  assert.throws(() => worker.scheduled({ cron: "1 3 * * *", scheduledTime: 0 },
    scheduledEnv, context), /threads_schedule_not_configured/);
  await worker.scheduled({ cron: "0 3 * * *", scheduledTime: 1_800_000_000_000 },
    scheduledEnv, context);
});
