import modulePreloads from "../public/modulepreload.json" with { type: "json" };
import {
  authenticatePin, createCsrfToken, createSession, hashClientIp,
  requireAuthenticatedMutation, verifySession,
} from "./auth.js";
import { AppError, CATEGORIES, parseListQuery } from "./domain.js";
import { renderIndexPage, renderLoginPage, renderRepositoryPage } from "./html.js";
import {
  collectRepository, deleteRepository, getRepository, listRepositories, refreshRepository,
  updateRepository,
} from "./repositories.js";
import { parseCspReport, parseTelemetry, recordTelemetry } from "./telemetry.js";

const REPOSITORY_PATH = /^\/repositories\/([0-9a-f-]+)(?:\/(refresh|delete))?$/;
const ASSET_PATH = /^\/assets\/([^/]+)\/([^/]+)$/;
const ASSETS = new Set([
  "layers.css", "tokens.css", "core.css", "login.css", "repositories.css",
  "app.js", "dom.js", "repo-capture.js", "repo-filter.js", "repo-panel.js", "favicon.svg",
]);
const FLASH = new Set([
  "repository_created", "repository_already_saved", "repository_updated",
  "repository_refreshed", "repository_analysis_error", "repository_deleted",
]);
const COOKIE_EXPIRED = "__Host-repo_atlas_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0";
const LOGIN_CSP = "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; connect-src 'none'; report-uri /csp-report";
const APP_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
const TRUSTED_TYPES_CSP = "require-trusted-types-for 'script'; trusted-types 'none'";

/**
 * @typedef {object} Runtime
 * @property {"production"} environment
 * @property {D1Database} db
 * @property {string} productionHost
 * @property {string} allowedOrigin
 * @property {string} pinSalt
 * @property {string} pinDigest
 * @property {string} ipHmacKey
 * @property {string} sessionSigningKey
 * @property {string} openAiApiKey
 * @property {string} openAiModel
 * @property {string} releaseId
 * @property {string} trustedTypesMode
 * @property {RateLimit | undefined} reportRateLimiter
 */

/**
 * @typedef {object} RuntimeEnv
 * @property {string} PRODUCTION_HOST
 * @property {unknown} PROD_DB
 * @property {string} PROD_PIN_SALT
 * @property {string} PROD_PIN_DIGEST
 * @property {string} PROD_IP_HMAC_KEY
 * @property {string} PROD_SESSION_KEY
 * @property {string} OPENAI_API_KEY
 * @property {string} OPENAI_MODEL
 * @property {string} RELEASE_ID
 * @property {string} TRUSTED_TYPES_MODE
 * @property {{ fetch(request: Request): Promise<Response> }} [ASSETS]
 * @property {RateLimit} [REPORT_RATE_LIMITER]
 * @property {string} [ENVIRONMENT]
 * @property {{ fetch(request: Request): Promise<Response> }} [PROVIDER_FIXTURE]
 */

function hostError() {
  const error = new Error("host_not_allowed");
  error.name = "AppError";
  return error;
}

/** @param {string} hostname @param {RuntimeEnv} env @returns {Runtime} */
export function selectRuntime(hostname, env) {
  const testLoopback = env.ENVIRONMENT === "test" &&
    (hostname === "localhost" || hostname === "127.0.0.1");
  const production = hostname === env.PRODUCTION_HOST || testLoopback;
  if (!production) throw hostError();
  return {
    environment: "production",
    db: /** @type {D1Database} */ (env.PROD_DB),
    productionHost: env.PRODUCTION_HOST,
    allowedOrigin: `https://${hostname}`,
    pinSalt: env.PROD_PIN_SALT,
    pinDigest: env.PROD_PIN_DIGEST,
    ipHmacKey: env.PROD_IP_HMAC_KEY,
    sessionSigningKey: env.PROD_SESSION_KEY,
    openAiApiKey: env.OPENAI_API_KEY,
    openAiModel: env.OPENAI_MODEL,
    releaseId: env.RELEASE_ID,
    trustedTypesMode: env.TRUSTED_TYPES_MODE,
    reportRateLimiter: env.REPORT_RATE_LIMITER,
  };
}

/** @param {string} [pageKind] @param {string} [trustedTypesMode] */
export function securityHeaders(pageKind, trustedTypesMode) {
  const result = new Headers({
    "Cache-Control": "no-store",
    "Referrer-Policy": "same-origin",
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
    "X-Content-Type-Options": "nosniff",
    "Permissions-Policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  });
  if (pageKind === "login") result.set("Content-Security-Policy", LOGIN_CSP);
  if (pageKind === "app") {
    result.set("Content-Security-Policy", trustedTypesMode === "enforce"
      ? `${APP_CSP}; ${TRUSTED_TYPES_CSP}; report-uri /csp-report`
      : `${APP_CSP}; report-uri /csp-report`);
    if (trustedTypesMode !== "enforce")
      result.set("Content-Security-Policy-Report-Only", `${TRUSTED_TYPES_CSP}; report-uri /csp-report`);
  }
  return result;
}

/** @param {string | null} type @param {Record<string, string>} [extra] @param {string} [pageKind] @param {string} [trustedTypesMode] */
function headers(type, extra = {}, pageKind, trustedTypesMode) {
  const value = securityHeaders(pageKind, trustedTypesMode);
  if (type) value.set("Content-Type", type);
  for (const [name, content] of Object.entries(extra)) value.set(name, content);
  return value;
}

/** @param {unknown} value @param {number} [status] @param {Record<string, string>} [extra] */
const json = (value, status = 200, extra = {}) => new Response(JSON.stringify(value), {
  status, headers: headers("application/json; charset=utf-8", extra),
});
/** @param {string} value @param {number} [status] @param {Record<string, string>} [extra] @param {string} [pageKind] @param {string} [trustedTypesMode] */
const html = (value, status = 200, extra = {}, pageKind, trustedTypesMode) => new Response(value, {
  status, headers: headers("text/html; charset=utf-8", extra, pageKind, trustedTypesMode),
});
/** @param {string} location @param {Record<string, string>} [extra] */
const redirect = (location, extra = {}) => new Response(null, {
  status: 303, headers: headers(null, { Location: location, ...extra }),
});
/** @param {number} status @param {Record<string, string>} [extra] */
const empty = (status, extra = {}) => new Response(null, { status, headers: headers(null, extra) });
/** @param {number} status @param {string} value @param {Record<string, string>} [extra] */
const plain = (status, value, extra = {}) => new Response(value, {
  status, headers: headers("text/plain; charset=utf-8", extra),
});

/** @param {string} value @param {string} delimiter @returns {string[] | null} */
function splitHeader(value, delimiter) {
  const parts = [];
  let part = "";
  let quoted = false;
  let escaped = false;
  for (const character of value) {
    if (escaped) { part += character; escaped = false; }
    else if (quoted && character === "\\") { part += character; escaped = true; }
    else if (character === '"') { part += character; quoted = !quoted; }
    else if (!quoted && character === delimiter) { parts.push(part); part = ""; }
    else part += character;
  }
  if (quoted || escaped) return null;
  parts.push(part);
  return parts;
}

/** @param {Request} request */
function enhanced(request) {
  const ranges = splitHeader(request.headers.get("Accept") ?? "", ",");
  if (!ranges) return false;
  let accepted = false;
  for (const range of ranges) {
    const parts = splitHeader(range, ";");
    if (!parts) return false;
    const [mediaType, ...parameters] = parts;
    if (mediaType.trim().toLowerCase() !== "application/json") continue;
    const quality = parameters.filter((parameter) =>
      parameter.split("=", 1)[0].trim().toLowerCase() === "q");
    if (!quality.length) { accepted = true; continue; }
    if (quality.length !== 1) return false;
    const value = quality[0].slice(quality[0].indexOf("=") + 1).trim();
    if (!/^(?:0(?:\.\d{1,3})?|1(?:\.0{1,3})?)$/.test(value)) return false;
    if (Number(value) > 0) accepted = true;
  }
  return accepted;
}

/** @param {string} code @param {number} status @returns {never} */
function appError(code, status) {
  throw new AppError(code, status);
}

/** @param {unknown} error @param {boolean} wantsJson @param {Runtime} runtime @param {string} pathname */
function safeErrorResponse(error, wantsJson, runtime, pathname) {
  const safe = error instanceof AppError ? error : new AppError("internal_error", 500);
  const retryAfter = safe.details?.retryAfter;
  /** @type {Record<string, string>} */
  const extra = {};
  if (typeof retryAfter === "number" && Number.isFinite(retryAfter) &&
    Number.isInteger(retryAfter) && retryAfter > 0) extra["Retry-After"] = String(retryAfter);
  if (wantsJson) return json({ errorCode: safe.code }, safe.status, extra);
  if (pathname === "/session")
    return html(renderLoginPage({ releaseId: runtime.releaseId, errorCode: safe.code }),
      safe.status, extra, "login", runtime.trustedTypesMode);
  return plain(safe.status, safe.code, extra);
}

/** @param {Request} request @param {number} maximumBytes */
async function readBody(request, maximumBytes) {
  const lengthHeader = request.headers.get("Content-Length");
  if (lengthHeader !== null) {
    if (!/^\d+$/.test(lengthHeader)) appError("invalid_body_length", 400);
    if (Number(lengthHeader) > maximumBytes) appError("body_too_large", 413);
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximumBytes) {
      try { void reader.cancel().catch(() => {}); } catch {}
      try { reader.releaseLock(); } catch {}
      appError("body_too_large", 413);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

/** @param {Request} request @param {number} maximumBytes @param {Set<string>} allowedFields @returns {Promise<FormData>} */
async function parseForm(request, maximumBytes, allowedFields) {
  const contentType = request.headers.get("Content-Type") ?? "";
  const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
  const bytes = await readBody(request, maximumBytes);
  if (mediaType !== "application/x-www-form-urlencoded" && mediaType !== "multipart/form-data")
    appError("unsupported_media_type", 415);
  let form = new FormData();
  try {
    if (mediaType === "application/x-www-form-urlencoded") {
      form = new FormData();
      for (const [name, value] of new URLSearchParams(new TextDecoder().decode(bytes)))
        form.append(name, value);
    } else {
      form = await new Request("https://form.invalid", {
        method: "POST", headers: { "Content-Type": contentType }, body: bytes,
      }).formData();
    }
  } catch { appError("invalid_form", 400); }
  for (const name of form.keys()) {
    if (!allowedFields.has(name) || form.getAll(name).length !== 1) appError("invalid_form", 400);
  }
  return form;
}

/** @param {Request} request @param {number} maximumBytes @param {Set<string>} mediaTypes @param {string} errorCode */
async function parseJsonBody(request, maximumBytes, mediaTypes, errorCode) {
  const mediaType = (request.headers.get("Content-Type") ?? "").split(";", 1)[0].trim().toLowerCase();
  const bytes = await readBody(request, maximumBytes);
  if (!mediaTypes.has(mediaType)) appError("unsupported_media_type", 415);
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { appError(errorCode, 400); }
}

/** @param {string | null} raw @param {string} allowedOrigin @param {string} errorCode */
function pageRoute(raw, allowedOrigin, errorCode) {
  try {
    if (!raw) appError(errorCode, 400);
    const url = new URL(raw);
    if (url.origin !== allowedOrigin || url.username || url.password) appError(errorCode, 400);
    if (url.pathname === "/" || url.pathname === "/login" || url.pathname === "/health")
      return url.pathname;
    if (/^\/repositories\/[^/]+$/.test(url.pathname)) return "/repositories/:id";
  } catch (error) {
    if (error instanceof AppError) throw error;
  }
  appError(errorCode, 400);
}

/** @param {unknown} report */
function cspDocumentUri(report) {
  if (Array.isArray(report)) {
    if (report.length !== 1 || !report[0] || typeof report[0] !== "object" || Array.isArray(report[0]))
      appError("invalid_csp_report", 400);
    const body = /** @type {Record<string, unknown>} */ (report[0]).body;
    if (!body || typeof body !== "object" || Array.isArray(body)) appError("invalid_csp_report", 400);
    const documentUri = /** @type {Record<string, unknown>} */ (body).documentURL;
    if (typeof documentUri !== "string") appError("invalid_csp_report", 400);
    return documentUri;
  }
  if (!report || typeof report !== "object" || Array.isArray(report))
    appError("invalid_csp_report", 400);
  const body = /** @type {Record<string, unknown>} */ (report)["csp-report"];
  if (!body || typeof body !== "object" || Array.isArray(body)) appError("invalid_csp_report", 400);
  const documentUri = /** @type {Record<string, unknown>} */ (body)["document-uri"];
  if (typeof documentUri !== "string") appError("invalid_csp_report", 400);
  return documentUri;
}

/** @param {RateLimit | undefined} limiter @param {string} key */
async function checkReportLimit(limiter, key) {
  if (!limiter || typeof limiter.limit !== "function") appError("report_unavailable", 503);
  let result;
  try { result = await limiter.limit({ key }); }
  catch { appError("report_unavailable", 503); }
  if (!result || typeof result !== "object" || typeof result.success !== "boolean")
    appError("report_unavailable", 503);
  if (!result.success) appError("report_rate_limited", 429);
}

/** @param {Runtime} runtime @param {{ releaseId: string, routeTemplate: string, eventType: string, metricName: string, valueBucket: string, dimension: string }} event @param {number} nowSeconds */
async function storeTelemetry(runtime, event, nowSeconds) {
  try { await recordTelemetry(runtime.db, event, nowSeconds); }
  catch { appError("telemetry_unavailable", 503); }
}

/** @param {Request} request @param {Runtime} runtime */
async function telemetryRoute(request, runtime) {
  if (request.headers.get("Origin") !== runtime.allowedOrigin) appError("session_expired", 401);
  const session = await sessionFor(request, runtime);
  if (!session) appError("session_expired", 401);
  const routeTemplate = pageRoute(request.headers.get("Referer"), runtime.allowedOrigin, "invalid_telemetry");
  await checkReportLimit(runtime.reportRateLimiter, `telemetry:${session.nonce}`);
  const raw = await parseJsonBody(request, 4_096, new Set(["application/json"]), "invalid_telemetry");
  const event = parseTelemetry(raw, routeTemplate, runtime.releaseId);
  await storeTelemetry(runtime, event, Math.floor(Date.now() / 1_000));
  return empty(204);
}

/** @param {Request} request @param {Runtime} runtime */
async function cspReportRoute(request, runtime) {
  const ip = request.headers.get("CF-Connecting-IP") ?? "";
  if (!ip) appError("report_unavailable", 503);
  let ipHash;
  try { ipHash = await hashClientIp(ip, runtime.ipHmacKey); }
  catch { appError("report_unavailable", 503); }
  await checkReportLimit(runtime.reportRateLimiter, `csp:${ipHash}`);
  const raw = await parseJsonBody(request, 16_384,
    new Set(["application/csp-report", "application/reports+json"]), "invalid_csp_report");
  const routeTemplate = pageRoute(cspDocumentUri(raw), runtime.allowedOrigin, "invalid_csp_report");
  const event = parseCspReport(raw, routeTemplate, runtime.releaseId);
  await storeTelemetry(runtime, event, Math.floor(Date.now() / 1_000));
  return empty(204);
}

/** @param {FormData} form @param {string} name */
function requiredString(form, name) {
  const value = form.get(name);
  if (typeof value !== "string") appError("invalid_form", 400);
  return value;
}

/** @param {Request} request @param {Runtime} runtime */
async function sessionFor(request, runtime) {
  return verifySession(
    request.headers.get("Cookie"), Math.floor(Date.now() / 1_000), runtime.sessionSigningKey,
  );
}

/** @param {URL} url @param {Set<string>} allowedKeys */
function flashFrom(url, allowedKeys) {
  for (const key of url.searchParams.keys()) {
    if (!allowedKeys.has(key) || url.searchParams.getAll(key).length !== 1)
      appError("invalid_list_query", 400);
  }
  const flash = url.searchParams.get("flash") ?? "";
  if (flash && !FLASH.has(flash)) appError("invalid_list_query", 400);
  return flash;
}

/** @param {URL} url */
function indexQuery(url) {
  const flash = flashFrom(url, new Set(["q", "category", "tag", "page", "flash"]));
  const clean = new URL(url);
  clean.searchParams.delete("flash");
  return { filters: parseListQuery(clean), flash };
}

/** @param {Runtime} runtime @param {typeof fetch} fetcher */
function dependencies(runtime, fetcher) {
  return { fetcher, openAiApiKey: runtime.openAiApiKey, openAiModel: runtime.openAiModel };
}

/** @param {string} method @param {string} pathname @param {RegExpExecArray | null} match */
function knownRoute(method, pathname, match) {
  const fixed = new Map([
    ["/health", ["GET"]], ["/login", ["GET"]], ["/session", ["POST"]],
    ["/session/logout", ["POST"]], ["/", ["GET"]], ["/repositories", ["POST"]],
    ["/telemetry", ["POST"]], ["/csp-report", ["POST"]],
  ]);
  const allowed = fixed.get(pathname) ?? (match ? (match[2] ? ["POST"] : ["GET", "POST"]) : null);
  if (!allowed) return null;
  if (!allowed.includes(method)) return empty(405, { Allow: allowed.join(", ") });
  return false;
}

/** @param {Request} request @param {RuntimeEnv} env @param {Runtime} runtime @param {RegExpExecArray} match */
async function serveAsset(request, env, runtime, match) {
  if (request.method !== "GET") return empty(405, { Allow: "GET" });
  const [, releaseId, filename] = match;
  if (releaseId !== runtime.releaseId || !ASSETS.has(filename)) return plain(404, "Not Found");
  const url = new URL(request.url);
  url.pathname = `/assets/${filename}`;
  url.search = "";
  if (!env.ASSETS) return plain(404, "Not Found");
  const result = await env.ASSETS.fetch(new Request(url, request));
  if (!result.ok) return plain(404, "Not Found");
  const response = new Response(result.body, result);
  for (const [name, value] of securityHeaders()) response.headers.set(name, value);
  response.headers.set("Content-Type", filename.endsWith(".css")
    ? "text/css; charset=utf-8" : filename.endsWith(".svg")
      ? "image/svg+xml" : "text/javascript; charset=utf-8");
  response.headers.set("Cache-Control", "public, max-age=31536000, immutable");
  response.headers.set("Vary", "Accept-Encoding");
  response.headers.set("X-Content-Type-Options", "nosniff");
  return response;
}

/** @param {Request} request @param {Runtime} runtime */
async function loginRoute(request, runtime) {
  if (request.headers.get("Origin") !== runtime.allowedOrigin) appError("session_expired", 401);
  const form = await parseForm(request, 4_096, new Set(["pin"]));
  const pin = requiredString(form, "pin");
  const nowSeconds = Math.floor(Date.now() / 1_000);
  try {
    await authenticatePin(runtime.db, {
      pin, ip: request.headers.get("CF-Connecting-IP") ?? "", nowSeconds,
      pinSalt: runtime.pinSalt, pinDigest: runtime.pinDigest, ipHmacKey: runtime.ipHmacKey,
    });
  } catch (error) {
    if (error instanceof AppError && error.code === "auth_locked" && error.details.scope === "global") {
      try { await recordTelemetry(runtime.db, {
        releaseId: runtime.releaseId, routeTemplate: "/login", eventType: "auth_global_lock",
        metricName: "none", valueBucket: "none", dimension: "none",
      }, nowSeconds); } catch {}
    }
    throw error;
  }
  const { cookie } = await createSession(nowSeconds, runtime.sessionSigningKey);
  return redirect("/", { "Set-Cookie": cookie });
}

/** @param {URL} url @param {Runtime} runtime @param {any} session */
async function renderIndex(url, runtime, session) {
  const { filters, flash } = indexQuery(url);
  const result = await listRepositories(runtime.db, filters);
  return html(renderIndexPage({
    releaseId: runtime.releaseId, modulePreloads,
    csrfToken: await createCsrfToken(session, runtime.sessionSigningKey),
    repositories: result.repositories, filters, categories: CATEGORIES,
    availableTags: result.availableTags, page: result.page, totalPages: result.totalPages, flash,
  }), 200, {}, "app", runtime.trustedTypesMode);
}

/** @param {URL} url @param {Runtime} runtime @param {any} session @param {string} id @param {boolean} wantsJson */
async function renderRepository(url, runtime, session, id, wantsJson) {
  const flash = flashFrom(url, new Set(["flash"]));
  const repository = await getRepository(runtime.db, id);
  if (!repository) appError("repository_not_found", 404);
  if (wantsJson) return json({ repository });
  return html(renderRepositoryPage({
    releaseId: runtime.releaseId, modulePreloads,
    csrfToken: await createCsrfToken(session, runtime.sessionSigningKey),
    repository, categories: CATEGORIES, flash,
  }), 200, {}, "app", runtime.trustedTypesMode);
}

/** @param {{ repositoryId: string, analysisStatus: string, errorCode: string | null }} result */
function captureJson(result) {
  return {
    repositoryId: result.repositoryId,
    analysisStatus: result.analysisStatus,
    errorCode: result.errorCode,
  };
}

/** @param {Request} request @param {Runtime} runtime @param {typeof fetch} fetcher @param {string} id @param {string} action @param {boolean} wantsJson */
async function mutate(request, runtime, fetcher, id, action, wantsJson) {
  const schema = action === "edit" ? new Set(["csrf", "personalNote", "primaryCategory", "tags"])
    : new Set(["csrf", "confirm"]);
  const form = await parseForm(request, 16_384, schema);
  await requireAuthenticatedMutation(request, runtime, form);
  if (action !== "edit" && requiredString(form, "confirm") !== "yes")
    appError("confirmation_required", 400);
  if (action === "edit") {
    const rawTags = requiredString(form, "tags");
    const repository = await updateRepository(runtime.db, id, {
      personalNote: requiredString(form, "personalNote"),
      primaryCategory: requiredString(form, "primaryCategory"),
      tags: rawTags.trim() ? rawTags.split(",").map((tag) => tag.trim()) : [],
    });
    if (!repository) appError("repository_not_found", 404);
    return wantsJson ? json({ repository }) : redirect(`/repositories/${id}?flash=repository_updated`);
  }
  if (action === "refresh") {
    const result = await refreshRepository(runtime.db, id, dependencies(runtime, fetcher));
    return wantsJson ? json(captureJson(result)) : redirect(
      `/repositories/${id}?flash=${result.analysisStatus === "error" ? "repository_analysis_error" : "repository_refreshed"}`,
    );
  }
  if (!await deleteRepository(runtime.db, id)) appError("repository_not_found", 404);
  return wantsJson ? json({ repositoryId: id }) : redirect("/?flash=repository_deleted");
}

/**
 * @param {Request} request
 * @param {RuntimeEnv} env
 * @param {unknown} context
 * @param {typeof fetch} fetcher
 */
async function dispatchRequest(request, env, context, fetcher) {
  const url = new URL(request.url);
  let runtime;
  try { runtime = selectRuntime(url.hostname, env); }
  catch { return plain(404, "Not Found"); }
  if (env.ENVIRONMENT === "test" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1"))
    runtime.allowedOrigin = url.origin;
  const wantsJson = enhanced(request);
  const assetMatch = ASSET_PATH.exec(url.pathname);
  if (assetMatch) {
    try {
      if (url.search) appError("invalid_query", 400);
      return await serveAsset(request, env, runtime, assetMatch);
    } catch (error) { return safeErrorResponse(error, wantsJson, runtime, url.pathname); }
  }
  const repositoryMatch = REPOSITORY_PATH.exec(url.pathname);
  const methodResult = knownRoute(request.method, url.pathname, repositoryMatch);
  if (methodResult) return methodResult;
  if (methodResult === null) return plain(404, "Not Found");

  try {
    const queryRoute = request.method === "GET" &&
      (url.pathname === "/" || (repositoryMatch && !repositoryMatch[2]));
    if (url.search && !queryRoute) appError("invalid_query", 400);
    if (request.method === "GET" && url.pathname === "/health")
      return json({ status: "ok", releaseId: runtime.releaseId });
    if (request.method === "GET" && url.pathname === "/login") {
      flashFrom(url, new Set());
      return html(renderLoginPage({ releaseId: runtime.releaseId, errorCode: "" }),
        200, {}, "login", runtime.trustedTypesMode);
    }
    if (request.method === "POST" && url.pathname === "/session") return await loginRoute(request, runtime);
    if (request.method === "POST" && url.pathname === "/telemetry")
      return await telemetryRoute(request, runtime);
    if (request.method === "POST" && url.pathname === "/csp-report")
      return await cspReportRoute(request, runtime);

    const session = await sessionFor(request, runtime);
    if (!session) {
      if (wantsJson) return json({ errorCode: "session_expired" }, 401);
      if (request.method === "GET") return redirect("/login");
      appError("session_expired", 401);
    }
    if (request.method === "GET" && url.pathname === "/") return await renderIndex(url, runtime, session);
    if (request.method === "POST" && url.pathname === "/session/logout") {
      const form = await parseForm(request, 16_384, new Set(["csrf"]));
      await requireAuthenticatedMutation(request, runtime, form);
      return redirect("/login", { "Set-Cookie": COOKIE_EXPIRED });
    }
    if (request.method === "POST" && url.pathname === "/repositories") {
      const form = await parseForm(request, 16_384, new Set(["csrf", "url"]));
      await requireAuthenticatedMutation(request, runtime, form);
      const result = await collectRepository(
        runtime.db, requiredString(form, "url"), dependencies(runtime, fetcher),
      );
      if (wantsJson) return json(captureJson(result));
      const flash = result.duplicate ? "repository_already_saved"
        : result.analysisStatus === "error" ? "repository_analysis_error" : "repository_created";
      return redirect(`/repositories/${result.repositoryId}?flash=${flash}`);
    }
    if (!repositoryMatch) return plain(404, "Not Found");
    const [, id, action] = repositoryMatch;
    if (request.method === "GET") return await renderRepository(url, runtime, session, id, wantsJson);
    return await mutate(request, runtime, fetcher, id, action ?? "edit", wantsJson);
  } catch (error) {
    return safeErrorResponse(error, wantsJson, runtime, url.pathname);
  }
}

/** @param {string} pathname */
function safeRouteTemplate(pathname) {
  if (ASSET_PATH.test(pathname)) return "/assets/:release/:file";
  const repository = REPOSITORY_PATH.exec(pathname);
  if (repository) return repository[2] ? `/repositories/:id/${repository[2]}` : "/repositories/:id";
  if (new Set([
    "/health", "/login", "/session", "/session/logout", "/", "/repositories",
    "/telemetry", "/csp-report",
  ]).has(pathname)) return pathname;
  return "unmatched";
}

/** @param {number} status */
function safeHttpStatus(status) {
  if (status >= 200 && status < 400) return "none";
  if (status === 400 || status === 413 || status === 415) return "bad_request";
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "not_found";
  if (status === 405) return "method_not_allowed";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limited";
  return "server_error";
}

/** @param {number} status */
function safeProviderStatus(status) {
  if (status >= 200 && status < 300) return "ok";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  return "error";
}

/**
 * @param {typeof fetch} fetcher
 * @param {{ githubStatus: string, openAiStatus: string }} state
 */
function observedFetcher(fetcher, state) {
  /** @param {RequestInfo | URL} input @param {RequestInit} [init] */
  return async (input, init) => {
    /** @type {"" | "githubStatus" | "openAiStatus"} */
    let field = "";
    try {
      const hostname = new URL(input instanceof Request ? input.url : String(input)).hostname;
      if (hostname === "api.github.com") field = "githubStatus";
      if (hostname === "api.openai.com") field = "openAiStatus";
    } catch {}
    try {
      const response = await fetcher(input, init);
      if (field) state[field] = safeProviderStatus(response.status);
      return response;
    } catch (error) {
      if (field) state[field] = "error";
      throw error;
    }
  };
}

/**
 * @param {Request} request
 * @param {RuntimeEnv} env
 * @param {unknown} [context]
 * @param {typeof fetch} [fetcher]
 */
export async function handleRequest(request, env, context, fetcher = globalThis.fetch) {
  const startedAt = Date.now();
  const state = { githubStatus: "none", openAiStatus: "none" };
  let response;
  try { response = await dispatchRequest(request, env, context, observedFetcher(fetcher, state)); }
  catch { response = plain(500, "internal_error"); }
  const record = {
    requestId: crypto.randomUUID(),
    routeTemplate: safeRouteTemplate(new URL(request.url).pathname),
    status: response.status,
    latencyMs: Math.max(0, Date.now() - startedAt),
    githubStatus: state.githubStatus,
    openAiStatus: state.openAiStatus,
    errorCode: safeHttpStatus(response.status),
  };
  try { console.log(record); } catch {}
  return response;
}

export default {
  /** @param {Request} request @param {RuntimeEnv} env @param {unknown} context */
  fetch(request, env, context) {
    const fixture = env.ENVIRONMENT === "test" ? env.PROVIDER_FIXTURE : undefined;
    if (env.ENVIRONMENT === "test" && (!fixture || typeof fixture.fetch !== "function"))
      return new Response("Service Unavailable", { status: 503 });
    const fetcher = /** @type {typeof globalThis.fetch} */ (fixture && typeof fixture.fetch === "function"
      ? fixture.fetch.bind(fixture) : globalThis.fetch);
    return handleRequest(request, env, context, fetcher);
  },
};
