import { AppError } from "./domain.js";

const CDN_SUFFIXES = Object.freeze([".cdninstagram.com", ".fbcdn.net"]);
export const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
export const VIDEO_TYPES = new Set(["video/mp4", "video/webm"]);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const DEFAULT_MAXIMUM_BYTES = 5 * 1024 ** 3;

export class ThreadsMediaWriteError extends AppError {
  /** @param {string} code @param {number} status
   * @param {{ key: string, size: number, httpEtag: string, contentType: string }} written */
  constructor(code, status, written) {
    super(code, status);
    this.written = written;
  }
}

export class ThreadsMediaPutUncertainError extends AppError {
  /** @param {string} key */
  constructor(key) {
    super("media_storage_unavailable", 503);
    this.key = key;
  }
}

/** @param {unknown} value */
export function validateStoredEtag(value) {
  if (typeof value !== "string" || !/^"[\x21\x23-\x7e]*"$/.test(value))
    throw new AppError("storage_unavailable", 503);
  return value;
}

/** @param {unknown} value */
export function validateStoredContentType(value) {
  if (typeof value !== "string" || !IMAGE_TYPES.has(value) && !VIDEO_TYPES.has(value))
    throw new AppError("storage_unavailable", 503);
  return value;
}

/** @param {unknown} value */
export function mediaMaximumBytes(value) {
  if (value === undefined) return DEFAULT_MAXIMUM_BYTES;
  if (!Number.isSafeInteger(value) || /** @type {number} */ (value) < 1)
    throw new AppError("invalid_media_limit", 500);
  return /** @type {number} */ (value);
}

/** @param {string} raw @param {boolean} redirect */
function rawUrlForm(raw, redirect) {
  if (raw.includes("\\")) return null;
  let authorityStart;
  if (raw.slice(0, 8).toLowerCase() === "https://" &&
    raw.length > 8 && raw[8] !== "/" && raw[8] !== "\\") authorityStart = 8;
  else if (redirect && raw.startsWith("//") && raw.length > 2 &&
    raw[2] !== "/" && raw[2] !== "\\") authorityStart = 2;
  else if (redirect && raw.startsWith("/") && !raw.startsWith("//"))
    return { authorityStart: null };
  else return null;
  return { authorityStart };
}

/** @param {string} raw @param {number} authorityStart */
function hasExplicitPort(raw, authorityStart) {
  const separators = [raw.indexOf("/", authorityStart),
    raw.indexOf("?", authorityStart), raw.indexOf("#", authorityStart)]
    .filter((index) => index >= 0);
  const authorityEnd = separators.length ? Math.min(...separators) : raw.length;
  const authority = raw.slice(authorityStart, authorityEnd);
  return authority.slice(authority.lastIndexOf("@") + 1).includes(":");
}

/** @param {URL} url */
function validCdnUrl(url) {
  const hostname = url.hostname.toLowerCase();
  return url.protocol === "https:" && !url.username && !url.password && !url.port &&
    CDN_SUFFIXES.some((suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix));
}

/** @param {ReadableStream<Uint8Array> | null} body */
function cancelUnused(body) { if (body) void body.cancel().catch(() => {}); }

/** @param {Response} response */
function responseError(response) {
  const retry = response.headers.get("retry-after");
  /** @type {Record<string, string | number>} */
  const details = {};
  if (retry !== null && /^\d+$/.test(retry) && Number.isSafeInteger(Number(retry)))
    details.retryAfter = Number(retry);
  if (response.status === 429) return new AppError("threads_rate_limited", 429, details);
  if (response.status === 408 || response.status >= 500)
    return new AppError("threads_provider_unavailable", 503);
  return new AppError("threads_media_unavailable", 404);
}

/** @param {typeof fetch} fetcher @param {string} rawUrl @param {AbortSignal | undefined} signal */
async function providerResponse(fetcher, rawUrl, signal) {
  let url;
  const initial = rawUrlForm(rawUrl, false);
  if (!initial || initial.authorityStart === null ||
    hasExplicitPort(rawUrl, initial.authorityStart))
    throw new AppError("invalid_media_url", 400);
  try { url = new URL(rawUrl); }
  catch { throw new AppError("invalid_media_url", 400); }
  for (let redirects = 0; ; redirects += 1) {
    if (!validCdnUrl(url)) throw new AppError("invalid_media_url", 400);
    let response;
    try { response = await fetcher(url, { method: "GET", redirect: "manual", signal }); }
    catch { throw new AppError("threads_provider_unavailable", 503); }
    if (!(response instanceof Response))
      throw new AppError("threads_provider_unavailable", 503);
    if (!REDIRECTS.has(response.status)) return response;
    cancelUnused(response.body);
    if (redirects >= 3) throw new AppError("invalid_media_redirect", 400);
    const location = response.headers.get("location");
    if (!location) throw new AppError("invalid_media_redirect", 400);
    const redirect = rawUrlForm(location, true);
    if (!redirect || redirect.authorityStart !== null &&
      hasExplicitPort(location, redirect.authorityStart))
      throw new AppError("invalid_media_redirect", 400);
    try { url = new URL(location, url); }
    catch { throw new AppError("invalid_media_redirect", 400); }
  }
}

/** @param {unknown} value */
function putResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AppError("media_storage_unavailable", 503);
  const result = /** @type {Record<string, unknown>} */ (value);
  if (typeof result.key !== "string" || !result.key ||
    !Number.isSafeInteger(result.size) || /** @type {number} */ (result.size) < 0 ||
    typeof result.httpEtag !== "string" || !result.httpEtag)
    throw new AppError("media_storage_unavailable", 503);
  validateStoredEtag(result.httpEtag);
  return /** @type {{ key: string, size: number, httpEtag: string }} */ (result);
}

/** @param {any} bucket @param {typeof fetch} fetcher @param {{ url: string, key: string,
 * expected: Set<string>, maximumBytes: number, signal?: AbortSignal }} input */
export async function downloadThreadsMedia(bucket, fetcher, input) {
  const response = await providerResponse(fetcher, input.url, input.signal);
  if (!response.ok) {
    cancelUnused(response.body);
    throw responseError(response);
  }
  const rawType = response.headers.get("content-type");
  const contentType = rawType?.split(";", 1)[0].trim().toLowerCase() ?? "";
  if (!input.expected.has(contentType)) {
    cancelUnused(response.body);
    throw new AppError("invalid_media_mime", 400);
  }
  const rawLength = response.headers.get("content-length");
  let declared = null;
  if (rawLength !== null) {
    if (!/^\d+$/.test(rawLength) || !Number.isSafeInteger(Number(rawLength))) {
      cancelUnused(response.body);
      throw new AppError("invalid_media_length", 400);
    }
    declared = Number(rawLength);
    if (declared > input.maximumBytes) {
      cancelUnused(response.body);
      throw new AppError("media_too_large", 413);
    }
  }
  const source = response.body ?? new ReadableStream({ start(controller) {
    controller.close();
  } });
  let count = 0;
  let sourceCompleted = false;
  /** @type {AppError | null} */
  let countedError = null;
  const counted = source.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      try {
        if (!(chunk instanceof Uint8Array))
          throw new AppError("invalid_media_stream", 400);
        count += chunk.byteLength;
        if (count > input.maximumBytes) throw new AppError("media_too_large", 413);
        if (declared !== null && count > declared)
          throw new AppError("media_byte_mismatch", 400);
        controller.enqueue(chunk);
      } catch (error) {
        countedError = error instanceof AppError ? error :
          new AppError("invalid_media_stream", 400);
        throw countedError;
      }
    },
    flush() { sourceCompleted = true; },
  }));
  let stored = counted;
  /** @type {AbortController | null} */
  let fixedLengthAbort = null;
  /** @type {Promise<{ ok: true } | { ok: false, error: unknown }> | null} */
  let fixedLengthOutcome = null;
  if (declared !== null && typeof FixedLengthStream === "function") {
    const fixed = new FixedLengthStream(declared);
    fixedLengthAbort = new AbortController();
    fixedLengthOutcome = counted.pipeTo(fixed.writable, {
      signal: fixedLengthAbort.signal,
    }).then(() => ({ ok: /** @type {const} */ (true) }),
      (error) => ({ ok: /** @type {const} */ (false), error }));
    stored = fixed.readable;
  }
  let rawResult;
  try {
    rawResult = await bucket.put(input.key, stored, {
      httpMetadata: { contentType },
      onlyIf: { etagDoesNotMatch: "*" },
    });
    const pump = await fixedLengthOutcome;
    if (pump && !pump.ok) throw pump.error;
  } catch (error) {
    if (fixedLengthAbort) fixedLengthAbort.abort(error);
    else cancelUnused(stored);
    await fixedLengthOutcome;
    if (countedError !== null) throw countedError;
    if (sourceCompleted && declared !== null && count !== declared)
      throw new AppError("media_byte_mismatch", 400);
    throw new ThreadsMediaPutUncertainError(input.key);
  }
  let result;
  try { result = putResult(rawResult); }
  catch { throw new ThreadsMediaPutUncertainError(input.key); }
  const written = { key: result.key, size: result.size,
    httpEtag: result.httpEtag, contentType };
  if (result.key !== input.key || result.size !== count)
    throw new ThreadsMediaWriteError("media_storage_unavailable", 503, written);
  if (declared !== null && count !== declared)
    throw new ThreadsMediaWriteError("media_byte_mismatch", 400, written);
  return written;
}
