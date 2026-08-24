import { AppError } from "./domain.js";

const ROUTES = new Set([
  "/login", "/", "/repositories/:id", "/repositories/:id/notes", "/health",
  "/threads", "/threads/:id", "/threads/:id/sync", "/threads/:id/delete",
  "/threads/:id/media/:mediaId", "/threads/:id/media/:mediaId/retry",
  "/threads/connect", "/threads/oauth/callback", "/threads/disconnect",
]);
const CLIENT_CODES = new Set(["network_error", "invalid_response", "dialog_error", "other"]);
const DIRECTIVES = new Set([
  "script-src", "script-src-elem", "style-src", "img-src", "media-src", "connect-src",
  "form-action", "frame-ancestors", "base-uri", "require-trusted-types-for", "trusted-types",
]);
const TELEMETRY_KEYS = new Set(["eventType", "metricName", "value", "code"]);
const AGGREGATE_KEYS = new Set([
  "releaseId", "routeTemplate", "eventType", "metricName", "valueBucket", "dimension",
]);
const EVENT_TYPES = new Set([
  "navigation", "web_vital", "client_error", "csp_violation", "auth_global_lock",
]);
const METRIC_NAMES = new Set(["navigation_duration", "LCP", "INP", "CLS", "none"]);
const VALUE_BUCKETS = new Set([
  "<100", "100-299", "300-999", "1000-2999", ">=3000",
  "good", "needs-improvement", "poor", "none",
]);
const ORIGIN_CATEGORIES = new Set(["self", "github", "openai", "other"]);

/** @returns {never} */
function invalidTelemetry() { throw new AppError("invalid_telemetry", 400); }
/** @returns {never} */
function invalidCspReport() { throw new AppError("invalid_csp_report", 400); }
/** @param {unknown} value */
function object(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
/** @param {string} routeTemplate @param {string} releaseId @param {() => never} invalid */
function validateContext(routeTemplate, releaseId, invalid) {
  if (!ROUTES.has(routeTemplate) || typeof releaseId !== "string" || !releaseId || releaseId.length > 128)
    invalid();
}

/** @param {number} value */
function durationBucket(value) {
  if (value < 100) return "<100";
  if (value < 300) return "100-299";
  if (value < 1_000) return "300-999";
  if (value < 3_000) return "1000-2999";
  return ">=3000";
}

/** @param {string} metric @param {number} value */
function vitalBucket(metric, value) {
  const [good, poor] = metric === "LCP" ? [2_500, 4_000]
    : metric === "INP" ? [200, 500] : metric === "CLS" ? [0.1, 0.25] : [NaN, NaN];
  if (Number.isNaN(good)) invalidTelemetry();
  return value <= good ? "good" : value > poor ? "poor" : "needs-improvement";
}

/**
 * @param {unknown} raw
 * @param {string} routeTemplate
 * @param {string} releaseId
 */
export function parseTelemetry(raw, routeTemplate, releaseId) {
  validateContext(routeTemplate, releaseId, invalidTelemetry);
  if (!object(raw)) invalidTelemetry();
  const input = /** @type {Record<string, unknown>} */ (raw);
  if (!["eventType", "metricName", "value"].every((key) => Object.hasOwn(input, key)) ||
    Object.keys(input).some((key) => !TELEMETRY_KEYS.has(key))) invalidTelemetry();
  const { eventType, metricName, value } = input;
  if (typeof eventType !== "string" || typeof metricName !== "string" ||
    typeof value !== "number" || !Number.isFinite(value) || value < 0) invalidTelemetry();
  let valueBucket;
  let dimension = "none";
  if (eventType === "navigation") {
    if (metricName !== "navigation_duration" || Object.hasOwn(input, "code")) invalidTelemetry();
    valueBucket = durationBucket(value);
  } else if (eventType === "web_vital") {
    if (!new Set(["LCP", "INP", "CLS"]).has(metricName) || Object.hasOwn(input, "code")) invalidTelemetry();
    valueBucket = vitalBucket(metricName, value);
  } else if (eventType === "client_error") {
    if (metricName !== "none" || value !== 0 || !Object.hasOwn(input, "code") ||
      typeof input.code !== "string") invalidTelemetry();
    valueBucket = "none";
    dimension = CLIENT_CODES.has(input.code) ? input.code : "other";
  } else invalidTelemetry();
  return { releaseId, routeTemplate, eventType, metricName, valueBucket, dimension };
}

/** @param {string} blockedUri @param {string} documentUri */
function originCategory(blockedUri, documentUri) {
  try {
    const blocked = new URL(blockedUri);
    const document = new URL(documentUri);
    if (blocked.origin === document.origin) return "self";
    if (blocked.hostname === "github.com" || blocked.hostname.endsWith(".github.com")) return "github";
    if (blocked.hostname === "openai.com" || blocked.hostname.endsWith(".openai.com")) return "openai";
  } catch {}
  return "other";
}

/**
 * @param {unknown} raw
 * @param {string} routeTemplate
 * @param {string} releaseId
 */
export function parseCspReport(raw, routeTemplate, releaseId) {
  validateContext(routeTemplate, releaseId, invalidCspReport);
  /** @type {Record<string, unknown>} */
  let body;
  let directive;
  let blockedUri;
  let documentUri;
  if (Array.isArray(raw)) {
    if (raw.length !== 1 || !object(raw[0])) invalidCspReport();
    const report = /** @type {Record<string, unknown>} */ (raw[0]);
    if (!Object.hasOwn(report, "type") || !Object.hasOwn(report, "body") ||
      report.type !== "csp-violation" || !object(report.body)) invalidCspReport();
    body = /** @type {Record<string, unknown>} */ (report.body);
    if (!["effectiveDirective", "blockedURL", "documentURL"]
      .every((key) => Object.hasOwn(body, key))) invalidCspReport();
    directive = body.effectiveDirective;
    blockedUri = body.blockedURL;
    documentUri = body.documentURL;
  } else {
    const envelope = /** @type {Record<string, unknown>} */ (raw);
    if (!object(raw) || !Object.hasOwn(envelope, "csp-report") ||
      !object(envelope["csp-report"]))
      invalidCspReport();
    body = /** @type {Record<string, unknown>} */ (envelope["csp-report"]);
    if ((!Object.hasOwn(body, "violated-directive") &&
      !Object.hasOwn(body, "effective-directive")) ||
      !Object.hasOwn(body, "blocked-uri") || !Object.hasOwn(body, "document-uri"))
      invalidCspReport();
    const violated = Object.hasOwn(body, "violated-directive")
      ? body["violated-directive"] : undefined;
    const effective = Object.hasOwn(body, "effective-directive")
      ? body["effective-directive"] : undefined;
    directive = violated ?? effective;
    blockedUri = body["blocked-uri"];
    documentUri = body["document-uri"];
  }
  if (typeof directive !== "string" || typeof blockedUri !== "string" || typeof documentUri !== "string")
    invalidCspReport();
  const normalizedDirective = directive.trim().split(/\s+/, 1)[0];
  if (!normalizedDirective) invalidCspReport();
  const safeDirective = DIRECTIVES.has(normalizedDirective) ? normalizedDirective : "other";
  return {
    releaseId, routeTemplate, eventType: "csp_violation", metricName: "none",
    valueBucket: "none", dimension: `${safeDirective}:${originCategory(blockedUri, documentUri)}`,
  };
}

/** @param {unknown} candidate */
function validateAggregate(candidate) {
  if (!object(candidate)) invalidTelemetry();
  const event = /** @type {Record<string, unknown>} */ (candidate);
  const keys = Object.keys(event);
  if (keys.length !== AGGREGATE_KEYS.size || keys.some((key) => !AGGREGATE_KEYS.has(key)))
    invalidTelemetry();
  const { releaseId, routeTemplate, eventType, metricName, valueBucket, dimension } = event;
  if (typeof releaseId !== "string" || typeof routeTemplate !== "string" ||
    typeof eventType !== "string" || typeof metricName !== "string" ||
    typeof valueBucket !== "string" || typeof dimension !== "string" ||
    !EVENT_TYPES.has(eventType) || !METRIC_NAMES.has(metricName) ||
    !VALUE_BUCKETS.has(valueBucket)) invalidTelemetry();
  validateContext(routeTemplate, releaseId, invalidTelemetry);
  const exact = eventType === "navigation"
    ? metricName === "navigation_duration" && dimension === "none" &&
      new Set(["<100", "100-299", "300-999", "1000-2999", ">=3000"]).has(valueBucket)
    : eventType === "web_vital"
      ? new Set(["LCP", "INP", "CLS"]).has(metricName) && dimension === "none" &&
        new Set(["good", "needs-improvement", "poor"]).has(valueBucket)
      : eventType === "client_error"
        ? metricName === "none" && valueBucket === "none" && CLIENT_CODES.has(dimension)
        : eventType === "csp_violation"
          ? metricName === "none" && valueBucket === "none" && (() => {
            const parts = dimension.split(":");
            const [directive, origin] = parts;
            return parts.length === 2 && Boolean(directive) && Boolean(origin) &&
              (DIRECTIVES.has(directive) || directive === "other") &&
              ORIGIN_CATEGORIES.has(origin);
          })()
          : routeTemplate === "/login" && metricName === "none" &&
            valueBucket === "none" && dimension === "none";
  if (!exact) invalidTelemetry();
  return /** @type {{ releaseId: string, routeTemplate: string, eventType: string, metricName: string, valueBucket: string, dimension: string }} */ (candidate);
}

/** @param {D1Database} db @param {{ releaseId: string, routeTemplate: string, eventType: string, metricName: string, valueBucket: string, dimension: string }} event @param {number} nowSeconds */
export async function recordTelemetry(db, event, nowSeconds) {
  if (!Number.isFinite(nowSeconds) || !Number.isInteger(nowSeconds) || nowSeconds < 0)
    invalidTelemetry();
  const date = new Date(nowSeconds * 1_000);
  if (Number.isNaN(date.valueOf())) invalidTelemetry();
  const safeEvent = validateAggregate(event);
  const day = date.toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) invalidTelemetry();
  const results = await db.batch([
    db.prepare(`DELETE FROM telemetry_daily WHERE rowid IN (
      SELECT rowid FROM telemetry_daily WHERE day <= date(?, '-30 days') LIMIT 100
    )`).bind(day),
    db.prepare(`INSERT INTO telemetry_daily
      (day, release_id, route_template, event_type, metric_name, value_bucket, dimension, count)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(day, release_id, route_template, event_type, metric_name, value_bucket, dimension)
      DO UPDATE SET count = count + 1`).bind(
      day, safeEvent.releaseId, safeEvent.routeTemplate, safeEvent.eventType,
      safeEvent.metricName, safeEvent.valueBucket, safeEvent.dimension,
    ),
  ]);
  if (!Array.isArray(results) || results.length !== 2 ||
    results.some((result) => !result || result.success !== true)) throw new Error("telemetry_storage_unavailable");
}
