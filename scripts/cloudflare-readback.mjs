const WORKER_VERSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const QUEUE_RESOURCE_ID = /^[0-9a-f]{32}$/i;
const RELEASE_ID = /^[0-9a-f]{40}$/;
const MODEL = /^gpt-5\.6-terra(?:-[a-z0-9._-]*[a-z0-9])?$/;
const ALLOWED_BINDING_TYPES = new Set([
  "assets", "d1", "queue", "r2_bucket", "ratelimit", "secret_text", "plain_text",
]);
const PRODUCTION_VAR_NAMES = [
  "ENVIRONMENT", "OPENAI_MODEL", "PRODUCTION_HOST", "RELEASE_ID", "THREADS_APP_ID",
  "THREADS_CAPTURE_DLQ_NAME", "THREADS_CAPTURE_QUEUE_NAME", "THREADS_MEDIA_DLQ_NAME",
  "THREADS_MEDIA_QUEUE_NAME", "TRUSTED_TYPES_MODE",
];
const ENVELOPE_KEYS = new Set(["errors", "messages", "result", "result_info", "success"]);

/** @param {unknown} value @returns {value is Record<string, any>} */
function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

/** @param {string} errorCode */
function invalid(errorCode) { throw new Error(errorCode); }

/** @param {unknown} envelope @param {string} errorCode */
function cloudflareResult(envelope, errorCode) {
  if (!plainObject(envelope)) invalid(errorCode);
  const value = /** @type {Record<string, any>} */ (envelope);
  const keys = Object.keys(value);
  if (keys.some((key) => !ENVELOPE_KEYS.has(key)) || value.success !== true ||
      !Array.isArray(value.errors) || value.errors.length !== 0 || !Object.hasOwn(value, "result") ||
      (Object.hasOwn(value, "messages") && !Array.isArray(value.messages)) ||
      (Object.hasOwn(value, "result_info") && !plainObject(value.result_info))) invalid(errorCode);
  return value.result;
}

/** @param {any[]} bindings @param {string} type */
const bindingsOf = (bindings, type) => bindings.filter((binding) =>
  plainObject(binding) && /** @type {Record<string, any>} */ (binding).type === type);

/** @param {Record<string, string>} value @returns {Record<string, string>} */
function sortedObject(value) {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0));
}

/**
 * @param {unknown} rawVersion
 * @param {{ config: Record<string, any>, expectedVars?: Record<string, string>, protectedVars?: Record<string, string> }} options
 * @param {string} errorCode
 */
export function normalizeVersionBindings(rawVersion, options, errorCode) {
  if (!plainObject(rawVersion) || !plainObject(options) || !plainObject(options.config))
    invalid(errorCode);
  const version = /** @type {Record<string, any>} */ (rawVersion);
  const config = options.config;
  const bindings = version.resources?.bindings;
  if (!WORKER_VERSION_ID.test(version.id) || !Array.isArray(bindings) ||
      bindings.some((binding) => !plainObject(binding) || !ALLOWED_BINDING_TYPES.has(binding.type)))
    invalid(errorCode);

  const assets = bindingsOf(bindings, "assets");
  const d1 = bindingsOf(bindings, "d1");
  const rateLimits = bindingsOf(bindings, "ratelimit");
  const r2 = bindingsOf(bindings, "r2_bucket");
  const queues = bindingsOf(bindings, "queue");
  const secrets = bindingsOf(bindings, "secret_text");
  const variables = bindingsOf(bindings, "plain_text");
  const expectedAssets = config.assets;
  const expectedD1 = config.d1_databases;
  const expectedRateLimits = config.ratelimits;
  const expectedR2 = config.r2_buckets;
  const expectedQueues = config.queues?.producers;
  const expectedSecrets = config.secrets?.required;
  if (!plainObject(expectedAssets) || !Array.isArray(expectedD1) || expectedD1.length !== 1 ||
      !Array.isArray(expectedRateLimits) || expectedRateLimits.length !== 1 ||
      !Array.isArray(expectedR2) || expectedR2.length !== 1 ||
      !Array.isArray(expectedQueues) || expectedQueues.length !== 2 ||
      !Array.isArray(expectedSecrets) || expectedSecrets.length !== 7) invalid(errorCode);

  if (assets.length !== 1 || assets[0].name !== expectedAssets.binding ||
      d1.length !== 1 || d1[0].name !== expectedD1[0].binding || d1[0].id !== expectedD1[0].database_id ||
      rateLimits.length !== 1 || rateLimits[0].name !== expectedRateLimits[0].name ||
      rateLimits[0].namespace_id !== expectedRateLimits[0].namespace_id ||
      rateLimits[0].simple?.limit !== expectedRateLimits[0].simple?.limit ||
      rateLimits[0].simple?.period !== expectedRateLimits[0].simple?.period ||
      r2.length !== 1 || r2[0].name !== expectedR2[0].binding ||
      r2[0].bucket_name !== expectedR2[0].bucket_name) invalid(errorCode);

  const expectedQueueMap = new Map(expectedQueues.map((/** @type {any} */ row) =>
    [row.binding, row.queue]));
  if (expectedQueueMap.size !== 2 || queues.length !== 2 ||
      new Set(queues.map((row) => row.name)).size !== queues.length ||
      queues.some((row) => expectedQueueMap.get(row.name) !== row.queue_name)) invalid(errorCode);
  const secretNames = secrets.map((row) => row.name).sort();
  const sortedExpectedSecrets = [...expectedSecrets].sort();
  if (secretNames.some((name) => typeof name !== "string") ||
      new Set(secretNames).size !== secretNames.length ||
      JSON.stringify(secretNames) !== JSON.stringify(sortedExpectedSecrets)) invalid(errorCode);

  if (variables.length !== PRODUCTION_VAR_NAMES.length ||
      new Set(variables.map((row) => row.name)).size !== variables.length ||
      variables.some((row) => typeof row.name !== "string" || typeof row.text !== "string"))
    invalid(errorCode);
  const variableMap = /** @type {Map<string, string>} */ (new Map(
    variables.map((row) => [row.name, row.text]),
  ));
  if (PRODUCTION_VAR_NAMES.some((name) => !variableMap.has(name))) invalid(errorCode);
  const normalizedVars = sortedObject(Object.fromEntries(variableMap));
  if (options.expectedVars !== undefined) {
    if (!plainObject(options.expectedVars) ||
        JSON.stringify(normalizedVars) !== JSON.stringify(sortedObject(options.expectedVars))) invalid(errorCode);
  } else {
    if (!plainObject(options.protectedVars)) invalid(errorCode);
    const protectedVars = /** @type {Record<string, string>} */ (options.protectedVars);
    if (Object.keys(protectedVars).length !== 5 ||
        Object.entries(protectedVars).some(([name, value]) =>
          !name.startsWith("THREADS_") || normalizedVars[name] !== value) ||
        normalizedVars.ENVIRONMENT !== "deployed" ||
        normalizedVars.PRODUCTION_HOST !== "gx.zra.workers.dev" ||
        !RELEASE_ID.test(normalizedVars.RELEASE_ID) || !MODEL.test(normalizedVars.OPENAI_MODEL) ||
        !["report-only", "enforce"].includes(normalizedVars.TRUSTED_TYPES_MODE)) invalid(errorCode);
  }

  return {
    versionId: version.id,
    bindings: {
      assets: { name: assets[0].name },
      d1: { name: d1[0].name, id: d1[0].id },
      queueProducers: queues.map((row) => ({ name: row.name, queueName: row.queue_name }))
        .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
      r2: { name: r2[0].name, bucketName: r2[0].bucket_name },
      rateLimit: {
        name: rateLimits[0].name,
        namespaceId: rateLimits[0].namespace_id,
        limit: rateLimits[0].simple.limit,
        period: rateLimits[0].simple.period,
      },
      secretNames,
      vars: normalizedVars,
    },
  };
}

/**
 * @param {unknown} envelope
 * @param {{ config: Record<string, any>, expectedVars?: Record<string, string>, protectedVars?: Record<string, string> }} options
 * @param {string} errorCode
 */
export function normalizeVersionReadback(envelope, options, errorCode) {
  return normalizeVersionBindings(cloudflareResult(envelope, errorCode), options, errorCode);
}

/**
 * @param {unknown} rawVersion
 * @param {{ config: Record<string, any>, expectedVars?: Record<string, string>, protectedVars?: Record<string, string> }} options
 * @param {unknown} expectedSnapshot
 * @param {string} errorCode
 */
export function assertVersionContinuity(rawVersion, options, expectedSnapshot, errorCode) {
  const actual = normalizeVersionBindings(rawVersion, options, errorCode);
  if (!plainObject(expectedSnapshot) || JSON.stringify(actual) !== JSON.stringify(expectedSnapshot))
    invalid(errorCode);
  return actual;
}

/** @param {unknown} envelope @param {string} expectedCron @param {string} errorCode */
export function assertScheduleReadback(envelope, expectedCron, errorCode) {
  const result = cloudflareResult(envelope, errorCode);
  if (!plainObject(result) || Object.keys(result).length !== 1 || !Array.isArray(result.schedules) ||
      result.schedules.length !== 1 || !plainObject(result.schedules[0])) invalid(errorCode);
  const schedule = result.schedules[0];
  const allowed = new Set(["created_on", "cron", "modified_on"]);
  if (Object.keys(schedule).some((key) => !allowed.has(key)) || schedule.cron !== expectedCron ||
      (Object.hasOwn(schedule, "created_on") && typeof schedule.created_on !== "string") ||
      (Object.hasOwn(schedule, "modified_on") && typeof schedule.modified_on !== "string"))
    invalid(errorCode);
  return { cron: schedule.cron };
}

/** @param {unknown} envelope @param {string} expectedQueue @param {string} errorCode */
export function queueIdFromReadback(envelope, expectedQueue, errorCode) {
  const result = cloudflareResult(envelope, errorCode);
  if (!Array.isArray(result) || result.length !== 1 || !plainObject(result[0]) ||
      result[0].queue_name !== expectedQueue || !QUEUE_RESOURCE_ID.test(result[0].queue_id)) invalid(errorCode);
  return result[0].queue_id.toLowerCase();
}

/**
 * @param {unknown} envelope
 * @param {{ queue: string, max_batch_size: number, max_retries: number, dead_letter_queue?: string }} expected
 * @param {string} errorCode
 */
export function assertQueueConsumerReadback(envelope, expected, errorCode) {
  const result = cloudflareResult(envelope, errorCode);
  if (!plainObject(expected) || !Array.isArray(result) || result.length !== 1 ||
      !plainObject(result[0])) invalid(errorCode);
  const consumer = result[0];
  const settings = consumer.settings;
  const expectedDlq = expected.dead_letter_queue ?? "";
  if (!QUEUE_RESOURCE_ID.test(consumer.consumer_id) || consumer.type !== "worker" || consumer.script_name !== "gx" ||
      typeof consumer.dead_letter_queue !== "string" || consumer.dead_letter_queue !== expectedDlq ||
      !plainObject(settings) || !Number.isSafeInteger(settings.batch_size) ||
      settings.batch_size !== expected.max_batch_size || !Number.isSafeInteger(settings.max_retries) ||
      settings.max_retries !== expected.max_retries) invalid(errorCode);
  return {
    queue: expected.queue,
    scriptName: consumer.script_name,
    deadLetterQueue: consumer.dead_letter_queue || null,
    batchSize: settings.batch_size,
    maxRetries: settings.max_retries,
  };
}
