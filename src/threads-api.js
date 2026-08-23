import { AppError } from "./domain.js";
import { normalizeThreadsUrl } from "./threads-domain.js";

/** @typedef {(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>} Fetcher */
/** @typedef {{ id: string, username: string, name: string | null, profilePictureUrl: string | null }} ThreadsProfile */
/** @typedef {{ id: string, ownerId: string, username: string, text: string, permalink: string, timestamp: string, mediaType: "TEXT_POST" | "IMAGE" | "VIDEO" | "CAROUSEL_ALBUM" | "REPOST_FACADE", mediaUrl: string | null, thumbnailUrl: string | null, children: string[], quotedPostId: string | null, linkAttachmentUrl: string | null, altText: string | null, rootPostId: string | null, repliedToId: string | null }} ThreadsMedia */
/** @typedef {{ data: ThreadsMedia[], nextCursor: string | null }} ThreadsPage */

export const THREADS_SCOPES = Object.freeze([
  "threads_basic", "threads_profile_discovery", "threads_read_replies",
]);

const GRAPH = "https://graph.threads.net/v1.0";
const JSON_MAXIMUM_BYTES = 1_048_576;
const PROFILE_FIELDS = "id,username,name,threads_profile_picture_url";
const MEDIA_FIELDS = [
  "id", "media_product_type", "media_type", "media_url", "permalink", "owner",
  "username", "text", "timestamp", "shortcode", "thumbnail_url", "children",
  "is_quote_post", "quoted_post", "link_attachment_url", "alt_text", "root_post", "replied_to",
].join(",");
const MEDIA_TYPES = new Set(["TEXT_POST", "IMAGE", "VIDEO", "CAROUSEL_ALBUM", "REPOST_FACADE"]);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

/** @param {unknown} value @param {readonly string[]} keys */
function exactKnownKeys(value, keys) {
  if (!plainObject(value) || Object.keys(value).some((key) => !keys.includes(key)))
    throw protocolError();
  return value;
}

/** @returns {never} */
function protocolError() { throw new AppError("threads_provider_protocol_error", 502); }

/** @param {unknown} value */
function providerId(value) {
  if (typeof value !== "string" || !value || value.length > 256) protocolError();
  return value;
}

/** @param {unknown} value @param {boolean} [nullable] */
function providerString(value, nullable = false) {
  if (value === undefined && nullable) return null;
  if (value === null && nullable) return null;
  if (typeof value !== "string") protocolError();
  return value;
}

/** @param {unknown} value */
function safeHttpsUrl(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value || value.length > 4_096) protocolError();
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) protocolError();
    return url.href;
  } catch { protocolError(); }
}

/** @param {unknown} value */
function isoTimestamp(value) {
  if (typeof value !== "string") protocolError();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z|[+-]\d{4})$/.exec(value);
  if (!match) protocolError();
  const [, year, month, day, hour, minute, second, zone] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)));
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() + 1 !== Number(month) ||
    date.getUTCDate() !== Number(day) || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 ||
    (zone !== "Z" && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(3)) > 59))) protocolError();
  return value;
}

/** @param {Response} response @param {number} maximumBytes */
export async function readJsonAtMost(response, maximumBytes = JSON_MAXIMUM_BYTES) {
  if (!(response instanceof Response) || !Number.isSafeInteger(maximumBytes) || maximumBytes < 0)
    protocolError();
  const body = response.body;
  if (!body) protocolError();
  const reader = body.getReader();
  const bytes = new Uint8Array(maximumBytes + 1);
  let length = 0;
  try {
    while (length <= maximumBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) protocolError();
      const take = Math.min(value.byteLength, maximumBytes + 1 - length);
      bytes.set(value.subarray(0, take), length);
      length += take;
      if (take !== value.byteLength || length > maximumBytes) {
        void reader.cancel().catch(() => {});
        protocolError();
      }
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length))); }
  catch { protocolError(); }
}

/** @param {Response} response */
function threadsProviderError(response) {
  const retry = response.headers.get("retry-after");
  /** @type {Record<string, string | number>} */
  const retryAfter = {};
  if (retry !== null && /^\d+$/.test(retry) && Number.isSafeInteger(Number(retry)))
    retryAfter.retryAfter = Number(retry);
  if (response.status === 429) return new AppError("threads_rate_limited", 429, retryAfter);
  if (response.status === 401 || response.status === 403) return new AppError("threads_reconnect_required", response.status);
  if (response.status === 404) return new AppError("threads_post_unavailable", 404);
  return new AppError("threads_provider_unavailable", 503);
}

/** @param {unknown} error */
function threadsError(error) {
  if (error instanceof AppError) return error;
  return new AppError("threads_provider_unavailable", 503);
}

/** @param {ReadableStream<Uint8Array> | null} body */
function cancelUnused(body) { if (body) void body.cancel().catch(() => {}); }

/** @param {Fetcher} fetcher @param {URL} url @param {RequestInit} init */
async function request(fetcher, url, init) {
  let response;
  try { response = await fetcher(url, { ...init, redirect: "manual" }); }
  catch (error) { throw threadsError(error); }
  if (!(response instanceof Response)) throw new AppError("threads_provider_unavailable", 503);
  return response;
}

/** @param {Fetcher} fetcher @param {string} path @param {URLSearchParams} query @param {string} accessToken @param {AbortSignal | undefined} signal */
async function graphGet(fetcher, path, query, accessToken, signal) {
  const url = new URL(`${GRAPH}/${path}`);
  url.search = query.toString();
  const response = await request(fetcher, url, { headers: { Authorization: `Bearer ${providerId(accessToken)}` }, signal });
  if (!response.ok) {
    cancelUnused(response.body);
    throw threadsProviderError(response);
  }
  return readJsonAtMost(response, JSON_MAXIMUM_BYTES);
}

/** @param {unknown} value */
function childIds(value) {
  if (value === undefined || value === null) return [];
  const children = exactKnownKeys(value, ["data"]);
  if (!Array.isArray(children.data)) protocolError();
  return children.data.map((item) => providerId(exactKnownKeys(item, ["id"]).id));
}

/** @param {unknown} value @param {string} field */
function relatedId(value, field) {
  if (value === undefined || value === null) return null;
  return providerId(exactKnownKeys(value, ["id"])[field === "id" ? "id" : field]);
}

/** @param {unknown} value @returns {ThreadsMedia} */
function mapMedia(value) {
  const raw = exactKnownKeys(value, [
    "id", "media_product_type", "media_type", "media_url", "permalink", "owner", "username",
    "text", "timestamp", "shortcode", "thumbnail_url", "children", "is_quote_post", "quoted_post",
    "link_attachment_url", "alt_text", "root_post", "replied_to",
  ]);
  if (raw.media_product_type !== "THREADS" || typeof raw.media_type !== "string" || !MEDIA_TYPES.has(raw.media_type) ||
    typeof raw.username !== "string" || typeof raw.text !== "string" || typeof raw.shortcode !== "string" || !raw.shortcode)
    protocolError();
  const owner = exactKnownKeys(raw.owner, ["id"]);
  const permalink = safeHttpsUrl(raw.permalink);
  if (!permalink) protocolError();
  let normalizedPermalink;
  try { normalizedPermalink = normalizeThreadsUrl(permalink); }
  catch { protocolError(); }
  if (normalizedPermalink.kind !== "canonical" || !normalizedPermalink.canonicalUrl) protocolError();
  if (raw.is_quote_post !== undefined && typeof raw.is_quote_post !== "boolean") protocolError();
  const quotedPostId = relatedId(raw.quoted_post, "id");
  if (raw.is_quote_post === true && !quotedPostId) protocolError();
  return {
    id: providerId(raw.id), ownerId: providerId(owner.id), username: raw.username, text: raw.text,
    permalink: normalizedPermalink.canonicalUrl, timestamp: isoTimestamp(raw.timestamp),
    mediaType: /** @type {ThreadsMedia["mediaType"]} */ (raw.media_type),
    mediaUrl: safeHttpsUrl(raw.media_url), thumbnailUrl: safeHttpsUrl(raw.thumbnail_url),
    children: childIds(raw.children), quotedPostId, linkAttachmentUrl: safeHttpsUrl(raw.link_attachment_url),
    altText: providerString(raw.alt_text, true), rootPostId: relatedId(raw.root_post, "id"),
    repliedToId: relatedId(raw.replied_to, "id"),
  };
}

/** @param {unknown} value @param {string} path @returns {ThreadsPage} */
function mapPage(value, path) {
  const raw = exactKnownKeys(value, ["data", "paging"]);
  if (!Array.isArray(raw.data)) protocolError();
  let nextCursor = null;
  if (raw.paging !== undefined && raw.paging !== null) {
    const paging = exactKnownKeys(raw.paging, ["next"]);
    if (paging.next !== undefined && paging.next !== null) {
      if (typeof paging.next !== "string") protocolError();
      let next;
      try { next = new URL(paging.next); } catch { protocolError(); }
      if (next.origin !== "https://graph.threads.net" || next.pathname !== `/v1.0/${path}` ||
        [...next.searchParams.keys()].length !== 1 || next.searchParams.getAll("after").length !== 1)
        protocolError();
      nextCursor = providerId(next.searchParams.get("after"));
    }
  }
  return { data: raw.data.map(mapMedia), nextCursor };
}

/** @param {Fetcher} fetcher @param {{ clientId: string, clientSecret: string, redirectUri: string, code: string, signal?: AbortSignal }} input */
export async function exchangeThreadsCode(fetcher, input) {
  try {
    const form = new URLSearchParams({ client_id: providerId(input?.clientId), client_secret: providerId(input?.clientSecret), grant_type: "authorization_code", redirect_uri: providerId(input?.redirectUri), code: providerId(input?.code) });
    const response = await request(fetcher, new URL(`${GRAPH}/oauth/access_token`), { method: "POST", body: form, signal: input?.signal });
    if (!response.ok) { cancelUnused(response.body); throw threadsProviderError(response); }
    const raw = exactKnownKeys(await readJsonAtMost(response, JSON_MAXIMUM_BYTES), ["access_token", "user_id"]);
    return { accessToken: providerId(raw.access_token), userId: providerId(raw.user_id) };
  } catch (error) { throw threadsError(error); }
}

/** @param {Fetcher} fetcher @param {{ clientSecret: string, accessToken: string, signal?: AbortSignal }} input */
export async function exchangeLongLivedThreadsToken(fetcher, input) {
  return tokenExchange(fetcher, "access_token", new URLSearchParams({ grant_type: "th_exchange_token", client_secret: providerId(input?.clientSecret), access_token: providerId(input?.accessToken) }), input?.signal);
}

/** @param {Fetcher} fetcher @param {{ accessToken: string, signal?: AbortSignal }} input */
export async function refreshThreadsAccessToken(fetcher, input) {
  return tokenExchange(fetcher, "refresh_access_token", new URLSearchParams({ grant_type: "th_refresh_token", access_token: providerId(input?.accessToken) }), input?.signal);
}

/** @param {Fetcher} fetcher @param {string} path @param {URLSearchParams} query @param {AbortSignal | undefined} signal */
async function tokenExchange(fetcher, path, query, signal) {
  try {
    const url = new URL(`${GRAPH}/${path}`); url.search = query.toString();
    const response = await request(fetcher, url, { signal });
    if (!response.ok) { cancelUnused(response.body); throw threadsProviderError(response); }
    const raw = exactKnownKeys(await readJsonAtMost(response, JSON_MAXIMUM_BYTES), ["access_token", "token_type", "expires_in"]);
    const expiresIn = raw.expires_in;
    if (typeof raw.token_type !== "string" || !raw.token_type || typeof expiresIn !== "number" || !Number.isSafeInteger(expiresIn) || expiresIn <= 0)
      protocolError();
    return { accessToken: providerId(raw.access_token), tokenType: raw.token_type, expiresIn };
  } catch (error) { throw threadsError(error); }
}

/** @param {Fetcher} fetcher @param {{ accessToken: string, username: string, signal?: AbortSignal }} input @returns {Promise<ThreadsProfile>} */
export async function fetchThreadsProfile(fetcher, input) {
  try {
    const raw = exactKnownKeys(await graphGet(fetcher, "profile_lookup", new URLSearchParams({ fields: PROFILE_FIELDS, username: providerId(input?.username) }), providerId(input?.accessToken), input?.signal), ["id", "username", "name", "threads_profile_picture_url"]);
    if (typeof raw.username !== "string" || !raw.username) protocolError();
    return { id: providerId(raw.id), username: raw.username, name: providerString(raw.name, true), profilePictureUrl: safeHttpsUrl(raw.threads_profile_picture_url) };
  } catch (error) { throw threadsError(error); }
}

/** @param {Fetcher} fetcher @param {{ accessToken: string, username: string, after?: string | null, signal?: AbortSignal }} input @returns {Promise<ThreadsPage>} */
export async function fetchThreadsProfilePostsPage(fetcher, input) {
  try {
    const query = new URLSearchParams({ fields: MEDIA_FIELDS, username: providerId(input?.username) });
    if (input?.after !== undefined && input.after !== null) query.set("after", providerId(input.after));
    return mapPage(await graphGet(fetcher, "profile_posts", query, providerId(input?.accessToken), input?.signal), "profile_posts");
  } catch (error) { throw threadsError(error); }
}

/** @param {Fetcher} fetcher @param {{ accessToken: string, mediaId: string, signal?: AbortSignal }} input @returns {Promise<ThreadsMedia>} */
export async function fetchThreadsMedia(fetcher, input) {
  try {
    return mapMedia(await graphGet(fetcher, providerId(input?.mediaId), new URLSearchParams({ fields: MEDIA_FIELDS }), providerId(input?.accessToken), input?.signal));
  } catch (error) { throw threadsError(error); }
}

/** @param {Fetcher} fetcher @param {{ accessToken: string, mediaId: string, after?: string | null, signal?: AbortSignal }} input @returns {Promise<ThreadsPage>} */
export async function fetchThreadsConversationPage(fetcher, input) {
  try {
    const id = providerId(input?.mediaId);
    const query = new URLSearchParams({ fields: MEDIA_FIELDS });
    if (input?.after !== undefined && input.after !== null) query.set("after", providerId(input.after));
    return mapPage(await graphGet(fetcher, `${id}/conversation`, query, providerId(input?.accessToken), input?.signal), `${id}/conversation`);
  } catch (error) { throw threadsError(error); }
}

/** @param {Fetcher} fetcher @param {{ kind: "canonical" | "short", submittedUrl: string, canonicalUrl: string | null, username: string | null, shortcode: string }} normalized @param {AbortSignal} [signal] */
export async function resolveThreadsPostUrl(fetcher, normalized, signal) {
  try {
    if (!plainObject(normalized) || (normalized.kind !== "canonical" && normalized.kind !== "short"))
      protocolError();
    if (normalized.kind === "canonical") return normalized;
    let current = normalizeThreadsUrl(normalized.submittedUrl);
    if (current.kind !== "short") protocolError();
    for (let redirects = 0; redirects < 3; redirects += 1) {
      const response = await request(fetcher, new URL(current.submittedUrl), { method: "GET", signal });
      if (!REDIRECTS.has(response.status)) { cancelUnused(response.body); throw new AppError("threads_post_unavailable", 404); }
      const location = response.headers.get("location");
      cancelUnused(response.body);
      if (!location) throw new AppError("threads_post_unavailable", 404);
      let next;
      try { next = normalizeThreadsUrl(new URL(location, current.submittedUrl).href); }
      catch { throw new AppError("threads_post_unavailable", 404); }
      if (next.kind === "canonical") return next;
      current = next;
    }
    throw new AppError("threads_post_unavailable", 404);
  } catch (error) { throw threadsError(error); }
}
