import assert from "node:assert/strict";
import test from "node:test";

import {
  assertQueueConsumerReadback, assertScheduleReadback, assertVersionContinuity,
  normalizeVersionBindings, normalizeVersionReadback, queueIdFromReadback,
} from "../../scripts/cloudflare-readback.mjs";

const VERSION_ID = "095f00a7-23a7-43b7-a227-e4c97cab5f22";
const QUEUE_ID = "0123456789abcdef0123456789abcdef";
const CONSUMER_ID = "fedcba9876543210fedcba9876543210";
const D1_ID = "5e031f7f-52cc-495a-9cd9-e080bd0090ac";
const REQUIRED_SECRETS = [
  "OPENAI_API_KEY", "PROD_IP_HMAC_KEY", "PROD_PIN_DIGEST", "PROD_PIN_SALT",
  "PROD_SESSION_KEY", "THREADS_APP_SECRET", "THREADS_TOKEN_KEY",
];
const EXPECTED_VARS = {
  ENVIRONMENT: "deployed",
  OPENAI_MODEL: "gpt-5.6-terra-2026-08-01",
  PRODUCTION_HOST: "gx.zra.workers.dev",
  RELEASE_ID: "a".repeat(40),
  THREADS_APP_ID: "123456789012345",
  THREADS_CAPTURE_DLQ_NAME: "gx-threads-capture-dlq",
  THREADS_CAPTURE_QUEUE_NAME: "gx-threads-capture",
  THREADS_MEDIA_DLQ_NAME: "gx-threads-media-dlq",
  THREADS_MEDIA_QUEUE_NAME: "gx-threads-media",
  TRUSTED_TYPES_MODE: "report-only",
};
const CONFIG = {
  assets: { binding: "ASSETS", directory: "./public", run_worker_first: true },
  d1_databases: [{ binding: "PROD_DB", database_id: D1_ID, database_name: "gx-production", migrations_dir: "migrations" }],
  ratelimits: [{ name: "REPORT_RATE_LIMITER", namespace_id: "2001", simple: { limit: 60, period: 60 } }],
  r2_buckets: [{ binding: "THREADS_MEDIA", bucket_name: "gx-threads-media" }],
  queues: { producers: [
    { binding: "THREADS_CAPTURE_QUEUE", queue: "gx-threads-capture" },
    { binding: "THREADS_MEDIA_QUEUE", queue: "gx-threads-media" },
  ] },
  secrets: { required: REQUIRED_SECRETS },
};

/** @param {Record<string, any>} [overrides] */
function version(overrides = {}) {
  return {
    id: VERSION_ID,
    annotations: { "workers/tag": "a".repeat(40) },
    resources: { bindings: [
      ...Object.entries(EXPECTED_VARS).map(([name, text]) => ({ type: "plain_text", name, text })),
      { type: "queue", name: "THREADS_MEDIA_QUEUE", queue_name: "gx-threads-media" },
      { type: "secret_text", name: "THREADS_TOKEN_KEY" },
      { type: "assets", name: "ASSETS" },
      { type: "d1", name: "PROD_DB", id: D1_ID },
      { type: "r2_bucket", name: "THREADS_MEDIA", bucket_name: "gx-threads-media" },
      { type: "ratelimit", name: "REPORT_RATE_LIMITER", namespace_id: "2001", simple: { limit: 60, period: 60 } },
      { type: "queue", name: "THREADS_CAPTURE_QUEUE", queue_name: "gx-threads-capture" },
      ...REQUIRED_SECRETS.filter((name) => name !== "THREADS_TOKEN_KEY")
        .map((name) => ({ type: "secret_text", name })),
    ] },
    ...overrides,
  };
}

const exactOptions = { config: CONFIG, expectedVars: EXPECTED_VARS };

/** @param {unknown} result @param {Record<string, any>} [overrides] */
function envelope(result, overrides = {}) {
  return { success: true, errors: [], messages: [], result, ...overrides };
}

test("normalizes an exact raw Worker version into one stable complete snapshot", () => {
  const snapshot = normalizeVersionBindings(version(), exactOptions, "version_invalid");
  assert.deepEqual(snapshot, {
    versionId: VERSION_ID,
    bindings: {
      assets: { name: "ASSETS" },
      d1: { name: "PROD_DB", id: D1_ID },
      queueProducers: [
        { name: "THREADS_CAPTURE_QUEUE", queueName: "gx-threads-capture" },
        { name: "THREADS_MEDIA_QUEUE", queueName: "gx-threads-media" },
      ],
      r2: { name: "THREADS_MEDIA", bucketName: "gx-threads-media" },
      rateLimit: { name: "REPORT_RATE_LIMITER", namespaceId: "2001", limit: 60, period: 60 },
      secretNames: REQUIRED_SECRETS,
      vars: EXPECTED_VARS,
    },
  });
});

test("normalizes a real version-detail envelope and rejects extra or malformed detail results", () => {
  assert.equal(normalizeVersionReadback(envelope(version()), exactOptions,
    "detail_invalid").versionId, VERSION_ID);
  for (const value of [
    envelope(version(), { unknown: true }),
    envelope(null),
    envelope(version(), { errors: [{ code: 1 }] }),
  ]) assert.throws(() => normalizeVersionReadback(value, exactOptions, "detail_invalid"), /detail_invalid/);
});

test("version normalization rejects unknown, duplicate, extra, malformed, and value-drifted bindings", () => {
  const cases = [
    { resources: { bindings: [...version().resources.bindings, { type: "kv_namespace", name: "EXTRA" }] } },
    { resources: { bindings: [...version().resources.bindings, { type: "queue", name: "THREADS_MEDIA_QUEUE", queue_name: "gx-threads-media" }] } },
    { resources: { bindings: version().resources.bindings.filter((row) => row.name !== "THREADS_APP_SECRET") } },
    { resources: { bindings: version().resources.bindings.map((row) => row.name === "THREADS_MEDIA" ? { ...row, bucket_name: "gx-wrong" } : row) } },
    { resources: { bindings: version().resources.bindings.map((row) => row.name === "THREADS_APP_ID" ? { ...row, text: "000" } : row) } },
    { resources: { bindings: {} } },
    { id: QUEUE_ID },
  ];
  for (const value of cases)
    assert.throws(() => normalizeVersionBindings(version(value), exactOptions, "version_invalid"), /version_invalid/);
});

test("normalizes an existing active version with exact protected vars and bounded baseline values", () => {
  const protectedVars = Object.fromEntries(Object.entries(EXPECTED_VARS).filter(([name]) =>
    name.startsWith("THREADS_")));
  assert.equal(normalizeVersionBindings(version(), { config: CONFIG, protectedVars },
    "active_invalid").bindings.vars.THREADS_APP_ID, EXPECTED_VARS.THREADS_APP_ID);
  const invalid = version({ resources: { bindings: version().resources.bindings.map((row) =>
    row.name === "OPENAI_MODEL" ? { ...row, text: "mutable-latest" } : row) } });
  assert.throws(() => normalizeVersionBindings(invalid, { config: CONFIG, protectedVars },
    "active_invalid"), /active_invalid/);
});

test("version continuity compares both immutable ID and the complete normalized binding snapshot", () => {
  const initial = normalizeVersionBindings(version(), exactOptions, "version_invalid");
  assert.deepEqual(assertVersionContinuity(version(), exactOptions, initial, "continuity_invalid"), initial);
  assert.throws(() => assertVersionContinuity(
    version({ id: "195f00a7-23a7-43b7-a227-e4c97cab5f22" }), exactOptions, initial,
    "continuity_invalid",
  ), /continuity_invalid/);
  const changed = version({ resources: { bindings: version().resources.bindings.map((row) =>
    row.name === "REPORT_RATE_LIMITER" ? { ...row, simple: { limit: 61, period: 60 } } : row) } });
  assert.throws(() => assertVersionContinuity(changed, exactOptions, initial, "continuity_invalid"), /continuity_invalid/);
});

test("accepts one exact raw schedule envelope and rejects extra schedules or malformed envelopes", () => {
  assert.deepEqual(assertScheduleReadback(envelope({ schedules: [{
    cron: "0 3 * * *", created_on: "2026-08-24T00:00:00Z", modified_on: "2026-08-24T00:00:00Z",
  }] }), "0 3 * * *", "schedule_invalid"), { cron: "0 3 * * *" });
  const cases = [
    envelope({ schedules: [{ cron: "0 3 * * *" }, { cron: "0 4 * * *" }] }),
    envelope({ schedules: [{ cron: "0 4 * * *" }] }),
    envelope({ schedules: [{ cron: "0 3 * * *" }], extra: true }),
    envelope({ schedules: [{ cron: "0 3 * * *" }] }, { success: false, errors: [{ code: 1 }] }),
    { success: true, errors: [], result: { schedules: [{ cron: "0 3 * * *" }] }, unknown: true },
  ];
  for (const value of cases)
    assert.throws(() => assertScheduleReadback(value, "0 3 * * *", "schedule_invalid"), /schedule_invalid/);
});

test("resolves exactly one API-shaped Queue row and rejects duplicate, extra, and malformed rows", () => {
  const queue = { queue_id: QUEUE_ID.toUpperCase(), queue_name: "gx-threads-media", consumers: [], producers: [] };
  assert.equal(queueIdFromReadback(envelope([queue], { result_info: { page: 1, per_page: 20 } }),
    "gx-threads-media", "queue_invalid"), QUEUE_ID);
  for (const value of [
    envelope([]), envelope([queue, { ...queue }]), envelope([{ ...queue, queue_name: "gx-wrong" }]),
    envelope([{ ...queue, queue_id: "0".repeat(31) }]),
    envelope([{ ...queue, queue_id: "0".repeat(33) }]),
    envelope([{ ...queue, queue_id: VERSION_ID }]),
    envelope([{ ...queue, queue_id: `${"0".repeat(31)}g` }]),
    envelope([queue], { errors: [{}] }),
  ]) assert.throws(() => queueIdFromReadback(value, "gx-threads-media", "queue_invalid"), /queue_invalid/);
});

test("validates raw script_name consumers and treats only an empty DLQ string as none", () => {
  const base = {
    consumer_id: CONSUMER_ID.toUpperCase(),
    type: "worker",
    script_name: "gx",
    dead_letter_queue: "",
    settings: { batch_size: 1, max_retries: 0, max_wait_time_ms: 5_000 },
  };
  const expected = { queue: "gx-threads-media-dlq", max_batch_size: 1, max_retries: 0 };
  assert.deepEqual(assertQueueConsumerReadback(envelope([base]), expected, "consumer_invalid"), {
    queue: expected.queue, scriptName: "gx", deadLetterQueue: null, batchSize: 1, maxRetries: 0,
  });
  assert.deepEqual(assertQueueConsumerReadback(envelope([{ ...base,
    dead_letter_queue: "gx-threads-media-dlq", settings: { ...base.settings, max_retries: 3 },
  }]), { queue: "gx-threads-media", max_batch_size: 1, max_retries: 3,
    dead_letter_queue: "gx-threads-media-dlq" }, "consumer_invalid").deadLetterQueue,
  "gx-threads-media-dlq");
  const cases = [
    [{ ...base, script_name: "other" }],
    [{ ...base, script_name: undefined, script: "gx" }],
    [{ ...base, dead_letter_queue: null }],
    [{ ...base, settings: { ...base.settings, batch_size: 2 } }],
    [{ ...base, settings: { ...base.settings, max_retries: 1 } }],
    [base, { ...base, consumer_id: "1".repeat(32) }],
    [{ ...base, type: "http_pull" }],
  ];
  for (const result of cases)
    assert.throws(() => assertQueueConsumerReadback(envelope(result), expected, "consumer_invalid"), /consumer_invalid/);
  for (const consumerId of ["0".repeat(31), "0".repeat(33), VERSION_ID, `${"0".repeat(31)}g`])
    assert.throws(() => assertQueueConsumerReadback(envelope([{ ...base, consumer_id: consumerId }]),
      expected, "consumer_invalid"), /consumer_invalid/);
});
