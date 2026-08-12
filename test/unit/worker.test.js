import assert from "node:assert/strict";
import test from "node:test";
import worker, { handleRequest, selectRuntime } from "../../src/worker.js";

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
