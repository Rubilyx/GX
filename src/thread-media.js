import { AppError } from "./domain.js";
import { fetchThreadsMedia, fetchThreadsProfile } from "./threads-api.js";
import { validateCaptureMessage, validateMediaMessage } from "./threads-domain.js";
import {
  d1NonnegativeInteger, exactRow, inputTimestamp,
  mutationBatch, mutationChanges, requiredString, selectRows, storageError,
} from "./threads-storage.js";

const ACK = Object.freeze({ action: "ack" });
const RETRY = Object.freeze({ action: "retry", delaySeconds: 1 });
const CDN_SUFFIXES = Object.freeze([".cdninstagram.com", ".fbcdn.net"]);
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const VIDEO_TYPES = new Set(["video/mp4", "video/webm"]);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const TRANSIENT_CODES = new Set([
  "storage_unavailable", "threads_provider_unavailable", "threads_rate_limited",
  "media_storage_unavailable",
]);
const DEFAULT_MAXIMUM_BYTES = 5 * 1024 ** 3;
const ENTRY_KEYS = [
  "media_id", "entry_id", "source_media_id", "kind", "ordinal", "status",
  "r2_key", "content_type", "bytes", "etag", "error_code", "attempt_count",
];
const PROFILE_KEYS = [
  "author_id", "username", "status", "r2_key", "content_type", "bytes", "etag",
  "error_code",
];
const READ_KEYS = ["r2_key", "content_type", "bytes", "etag"];

/** @param {{ postId: string, sourceMediaId: string, kind: string, ordinal: number }} input */
function entryKey(input) {
  return `threads/posts/${input.postId}/${input.sourceMediaId}/${input.kind}-${input.ordinal}`;
}
/** @param {string} authorId */
function profileKey(authorId) { return `threads/authors/${authorId}/profile`; }

/** @param {unknown} value */
function nullable(value) {
  return value === null || value === undefined;
}

/** @param {unknown} value */
function storedEtag(value) {
  if (typeof value !== "string" || !/^"[\x21\x23-\x7e]*"$/.test(value))
    throw new AppError("storage_unavailable", 503);
  return value;
}

/** @param {unknown} value */
function storedContentType(value) {
  if (typeof value !== "string" || !IMAGE_TYPES.has(value) && !VIDEO_TYPES.has(value))
    throw new AppError("storage_unavailable", 503);
  return value;
}

/** @param {unknown} value */
function entryRow(value) {
  const row = exactRow(value, ENTRY_KEYS);
  if (typeof row.media_id !== "string" || !row.media_id ||
    typeof row.entry_id !== "string" || !row.entry_id ||
    typeof row.source_media_id !== "string" || !row.source_media_id ||
    !["image", "video", "video_thumbnail"].includes(row.kind) ||
    !Number.isSafeInteger(row.ordinal) || row.ordinal < 0 ||
    !["pending", "ready", "error"].includes(row.status) ||
    !(nullable(row.r2_key) || typeof row.r2_key === "string" && row.r2_key) ||
    !(nullable(row.content_type) || typeof row.content_type === "string") ||
    !(nullable(row.bytes) || Number.isSafeInteger(row.bytes) && row.bytes >= 0) ||
    !(nullable(row.etag) || typeof row.etag === "string") ||
    !(nullable(row.error_code) || typeof row.error_code === "string") ||
    !Number.isSafeInteger(row.attempt_count) || row.attempt_count < 0)
    throw new AppError("storage_unavailable", 503);
  if (row.status === "ready") {
    requiredString(row.r2_key); storedContentType(row.content_type);
    d1NonnegativeInteger(row.bytes); storedEtag(row.etag);
  }
  return row;
}

/** @param {unknown} value */
function profileRow(value) {
  const row = exactRow(value, PROFILE_KEYS);
  if (typeof row.author_id !== "string" || !row.author_id ||
    typeof row.username !== "string" || !row.username ||
    !["pending", "ready", "error", "deleting"].includes(row.status) ||
    !(nullable(row.r2_key) || typeof row.r2_key === "string" && row.r2_key) ||
    !(nullable(row.content_type) || typeof row.content_type === "string") ||
    !(nullable(row.bytes) || Number.isSafeInteger(row.bytes) && row.bytes >= 0) ||
    !(nullable(row.etag) || typeof row.etag === "string") ||
    !(nullable(row.error_code) || typeof row.error_code === "string"))
    throw new AppError("storage_unavailable", 503);
  if (row.status === "ready") {
    if (row.r2_key !== profileKey(row.author_id))
      throw new AppError("storage_unavailable", 503);
    storedContentType(row.content_type); d1NonnegativeInteger(row.bytes);
    storedEtag(row.etag);
  }
  return row;
}

/** @param {unknown} value */
function accessToken(value) {
  const token = value && typeof value === "object" && !Array.isArray(value) ?
    /** @type {Record<string, unknown>} */ (value).accessToken : null;
  if (typeof token !== "string" || !token)
    throw new AppError("threads_reconnect_required", 401);
  return token;
}

/** @param {unknown} value */
function maximumBytes(value) {
  if (value === undefined) return DEFAULT_MAXIMUM_BYTES;
  if (!Number.isSafeInteger(value) || /** @type {number} */ (value) < 1)
    throw new AppError("invalid_media_limit", 500);
  return /** @type {number} */ (value);
}

/** @param {URL} url */
function validCdnUrl(url) {
  const hostname = url.hostname.toLowerCase();
  return url.protocol === "https:" && !url.username && !url.password && !url.port &&
    CDN_SUFFIXES.some((suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix));
}

/** @param {ReadableStream<Uint8Array> | null} body */
function cancelUnused(body) { if (body) void body.cancel().catch(() => {}); }

/** @param {unknown} error */
function retryResult(error) {
  if (!(error instanceof AppError)) return RETRY;
  if (!TRANSIENT_CODES.has(error.code)) return null;
  const raw = error.code === "threads_rate_limited" ? error.details.retryAfter : 1;
  const delay = typeof raw === "number" && Number.isFinite(raw) ? Math.trunc(raw) : 1;
  return { action: "retry", delaySeconds: Math.max(1, Math.min(900, delay)) };
}

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
  storedEtag(result.httpEtag);
  return /** @type {{ key: string, size: number, httpEtag: string }} */ (result);
}

/** @param {any} bucket @param {typeof fetch} fetcher @param {{ url: string, key: string,
 * expected: Set<string>, maximumBytes: number, signal?: AbortSignal }} input */
async function download(bucket, fetcher, input) {
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
  const counted = source.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      if (!(chunk instanceof Uint8Array))
        throw new AppError("invalid_media_stream", 400);
      count += chunk.byteLength;
      if (count > input.maximumBytes) throw new AppError("media_too_large", 413);
      controller.enqueue(chunk);
    },
  }));
  let result;
  try {
    result = putResult(await bucket.put(input.key, counted, {
      httpMetadata: { contentType },
    }));
  } catch (error) {
    cancelUnused(counted);
    throw error instanceof AppError ? error :
      new AppError("media_storage_unavailable", 503);
  }
  if (result.key !== input.key || result.size !== count) {
    try { await bucket.delete(input.key); }
    catch { throw new AppError("media_storage_unavailable", 503); }
    throw new AppError("media_storage_unavailable", 503);
  }
  if (declared !== null && count !== declared) {
    try { await bucket.delete(input.key); }
    catch { throw new AppError("media_storage_unavailable", 503); }
    throw new AppError("media_byte_mismatch", 400);
  }
  return { key: result.key, size: result.size, httpEtag: result.httpEtag, contentType };
}

/** @param {any} db @param {Record<string, any>} message */
async function readEntry(db, message) {
  const entry = message.type === "retry-media" ? null : message.entryId;
  const row = await db.prepare(
    `SELECT media.id AS media_id, media.entry_id, media.source_media_id, media.kind,
       media.ordinal, media.status, media.r2_key, media.content_type, media.bytes,
       media.etag, media.error_code, media.attempt_count
     FROM threads_media media
     JOIN threads_entries entry ON entry.id = media.entry_id
     JOIN threads_posts post ON post.id = entry.threads_post_id
     JOIN threads_sync_jobs job ON job.threads_post_id = post.id
       AND job.generation = post.sync_generation
     WHERE media.id = ? AND entry.threads_post_id = ?
       AND (? IS NULL OR media.entry_id = ?)
       AND post.sync_generation = ? AND post.status <> 'deleting'`,
  ).bind(message.mediaId, message.postId, entry, entry, message.generation).first();
  return row === null ? null : entryRow(row);
}

/** @param {any} db @param {Record<string, any>} message */
async function readProfile(db, message) {
  const row = await db.prepare(
    `SELECT author.threads_user_id AS author_id, author.username,
       author.profile_media_status AS status, author.profile_r2_key AS r2_key,
       author.profile_content_type AS content_type, author.profile_bytes AS bytes,
       author.profile_etag AS etag, author.profile_error_code AS error_code
     FROM threads_authors author
     WHERE author.threads_user_id = ? AND EXISTS (
       SELECT 1 FROM threads_entries entry
       JOIN threads_posts post ON post.id = entry.threads_post_id
       JOIN threads_sync_jobs job ON job.threads_post_id = post.id
         AND job.generation = post.sync_generation
       WHERE entry.author_id = author.threads_user_id AND entry.threads_post_id = ?
         AND post.sync_generation = ? AND post.status <> 'deleting'
     )`,
  ).bind(message.authorId, message.postId, message.generation).first();
  return row === null ? null : profileRow(row);
}

/** @param {any} db @param {Record<string, any>} message @param {Record<string, any>} row @param {number} now */
async function claimEntry(db, message, row, now) {
  const changes = mutationChanges(await db.prepare(
    `UPDATE threads_media SET status = 'pending', error_code = NULL,
       attempt_count = attempt_count + 1, updated_at = ?
     WHERE id = ? AND entry_id = ? AND status = ? AND attempt_count = ?
       AND status IN ('pending','error') AND EXISTS (
         SELECT 1 FROM threads_entries entry JOIN threads_posts post
           ON post.id = entry.threads_post_id
         JOIN threads_sync_jobs job ON job.threads_post_id = post.id
           AND job.generation = post.sync_generation
         WHERE entry.id = threads_media.entry_id AND entry.threads_post_id = ?
           AND post.sync_generation = ? AND post.status <> 'deleting'
       )`,
  ).bind(now, row.media_id, row.entry_id, row.status, row.attempt_count,
    message.postId, message.generation).run());
  if (changes > 1) throw new AppError("storage_unavailable", 503);
  return changes === 1;
}

/** @param {any} db @param {Record<string, any>} message @param {Record<string, any>} row @param {number} now */
async function claimProfile(db, message, row, now) {
  const changes = mutationChanges(await db.prepare(
    `UPDATE threads_authors SET profile_media_status = 'pending',
       profile_error_code = NULL, updated_at = ?
     WHERE threads_user_id = ? AND profile_media_status = ?
       AND profile_media_status IN ('pending','error') AND EXISTS (
         SELECT 1 FROM threads_entries entry JOIN threads_posts post
           ON post.id = entry.threads_post_id
         JOIN threads_sync_jobs job ON job.threads_post_id = post.id
           AND job.generation = post.sync_generation
         WHERE entry.author_id = threads_authors.threads_user_id
           AND entry.threads_post_id = ? AND post.sync_generation = ?
           AND post.status <> 'deleting'
       )`,
  ).bind(now, row.author_id, row.status, message.postId, message.generation).run());
  if (changes > 1) throw new AppError("storage_unavailable", 503);
  return changes === 1;
}

/** @param {any} dependencies @param {Record<string, any>} message */
async function recalculate(dependencies, message) {
  if (typeof dependencies.recalculateStatus !== "function")
    throw new AppError("storage_unavailable", 503);
  await dependencies.recalculateStatus(dependencies.db, {
    postId: message.postId, generation: message.generation,
    nowSeconds: inputTimestamp(dependencies.nowSeconds),
  });
}

/** @param {any} db @param {Record<string, any>} message @param {Record<string, any>} row
 * @param {{ key: string, size: number, httpEtag: string, contentType: string }} object
 * @param {number} now */
async function readyEntry(db, message, row, object, now) {
  const changes = mutationChanges(await db.prepare(
    `UPDATE threads_media SET status = 'ready', r2_key = ?, content_type = ?,
       bytes = ?, etag = ?, error_code = NULL, updated_at = ?
     WHERE id = ? AND entry_id = ? AND status = 'pending' AND attempt_count = ?
       AND EXISTS (
         SELECT 1 FROM threads_entries entry JOIN threads_posts post
           ON post.id = entry.threads_post_id
         JOIN threads_sync_jobs job ON job.threads_post_id = post.id
           AND job.generation = post.sync_generation
         WHERE entry.id = threads_media.entry_id AND entry.threads_post_id = ?
           AND post.sync_generation = ? AND post.status <> 'deleting'
       )`,
  ).bind(object.key, object.contentType, object.size, object.httpEtag, now,
    row.media_id, row.entry_id, row.attempt_count + 1, message.postId,
    message.generation).run());
  if (changes > 1) throw new AppError("storage_unavailable", 503);
  return changes === 1;
}

/** @param {any} db @param {Record<string, any>} message @param {Record<string, any>} row
 * @param {{ key: string, size: number, httpEtag: string, contentType: string }} object
 * @param {number} now */
async function readyProfile(db, message, row, object, now) {
  const changes = mutationChanges(await db.prepare(
    `UPDATE threads_authors SET profile_media_status = 'ready', profile_r2_key = ?,
       profile_content_type = ?, profile_bytes = ?, profile_etag = ?,
       profile_error_code = NULL, profile_refreshed_at = ?, updated_at = ?
     WHERE threads_user_id = ? AND profile_media_status = 'pending' AND EXISTS (
       SELECT 1 FROM threads_entries entry JOIN threads_posts post
         ON post.id = entry.threads_post_id
       JOIN threads_sync_jobs job ON job.threads_post_id = post.id
         AND job.generation = post.sync_generation
       WHERE entry.author_id = threads_authors.threads_user_id
         AND entry.threads_post_id = ? AND post.sync_generation = ?
         AND post.status <> 'deleting'
     )`,
  ).bind(object.key, object.contentType, object.size, object.httpEtag, now, now,
    row.author_id, message.postId, message.generation).run());
  if (changes > 1) throw new AppError("storage_unavailable", 503);
  return changes === 1;
}

/** @param {unknown} error */
function terminalCode(error) {
  if (!(error instanceof AppError)) return "threads_media_unavailable";
  if (error.code === "threads_post_unavailable" ||
    error.code === "threads_provider_protocol_error") return "threads_media_unavailable";
  return error.code;
}

/** @param {any} db @param {Record<string, any>} message @param {Record<string, any>} row
 * @param {string} code @param {number} now */
async function failEntry(db, message, row, code, now) {
  const changes = mutationChanges(await db.prepare(
    `UPDATE threads_media SET status = 'error', error_code = ?, updated_at = ?
     WHERE id = ? AND entry_id = ? AND status = 'pending' AND attempt_count = ?
       AND EXISTS (
         SELECT 1 FROM threads_entries entry JOIN threads_posts post
           ON post.id = entry.threads_post_id
         JOIN threads_sync_jobs job ON job.threads_post_id = post.id
           AND job.generation = post.sync_generation
         WHERE entry.id = threads_media.entry_id AND entry.threads_post_id = ?
           AND post.sync_generation = ? AND post.status <> 'deleting'
       )`,
  ).bind(code, now, row.media_id, row.entry_id, row.attempt_count + 1,
    message.postId, message.generation).run());
  if (changes > 1) throw new AppError("storage_unavailable", 503);
  return changes === 1;
}

/** @param {any} db @param {Record<string, any>} message @param {Record<string, any>} row
 * @param {string} code @param {number} now */
async function failProfile(db, message, row, code, now) {
  const changes = mutationChanges(await db.prepare(
    `UPDATE threads_authors SET profile_media_status = 'error',
       profile_error_code = ?, updated_at = ?
     WHERE threads_user_id = ? AND profile_media_status = 'pending' AND EXISTS (
       SELECT 1 FROM threads_entries entry JOIN threads_posts post
         ON post.id = entry.threads_post_id
       JOIN threads_sync_jobs job ON job.threads_post_id = post.id
         AND job.generation = post.sync_generation
       WHERE entry.author_id = threads_authors.threads_user_id
         AND entry.threads_post_id = ? AND post.sync_generation = ?
         AND post.status <> 'deleting'
     )`,
  ).bind(code, now, row.author_id, message.postId, message.generation).run());
  if (changes > 1) throw new AppError("storage_unavailable", 503);
  return changes === 1;
}

/** @param {any} bucket @param {string} key */
async function deleteUncommitted(bucket, key) {
  try { await bucket.delete(key); }
  catch { throw new AppError("media_storage_unavailable", 503); }
}

/** @param {any} db @param {string} authorId */
async function hasLiveAuthorReference(db, authorId) {
  const value = await db.prepare(
    `SELECT COUNT(*) AS count FROM threads_entries entry
     JOIN threads_posts post ON post.id = entry.threads_post_id
     WHERE entry.author_id = ? AND post.status <> 'deleting'`,
  ).bind(authorId).first();
  const row = exactRow(value, ["count"]);
  return d1NonnegativeInteger(row.count) > 0;
}

/** @param {Record<string, any>} message @param {any} dependencies */
async function archiveEntry(message, dependencies) {
  const now = inputTimestamp(dependencies.nowSeconds);
  const row = await readEntry(dependencies.db, message);
  if (!row || row.status === "ready") return;
  if (!await claimEntry(dependencies.db, message, row, now)) return;
  try {
    const token = accessToken(await dependencies.getAccessToken());
    const media = await fetchThreadsMedia(dependencies.fetcher, {
      accessToken: token, mediaId: row.source_media_id, signal: dependencies.signal,
    });
    if (media.id !== row.source_media_id)
      throw new AppError("threads_provider_protocol_error", 502);
    let url;
    let expected;
    if (row.kind === "image") {
      if (media.mediaType !== "IMAGE") throw new AppError("invalid_media_mime", 400);
      url = media.mediaUrl; expected = IMAGE_TYPES;
    } else if (row.kind === "video") {
      if (media.mediaType !== "VIDEO") throw new AppError("invalid_media_mime", 400);
      url = media.mediaUrl; expected = VIDEO_TYPES;
    } else {
      if (media.mediaType !== "VIDEO") throw new AppError("invalid_media_mime", 400);
      url = media.thumbnailUrl; expected = IMAGE_TYPES;
    }
    if (!url) throw new AppError("threads_media_unavailable", 404);
    const key = entryKey({
      postId: message.postId, sourceMediaId: row.source_media_id,
      kind: row.kind, ordinal: row.ordinal,
    });
    const object = await download(dependencies.bucket, dependencies.fetcher, {
      url, key, expected, maximumBytes: maximumBytes(dependencies.maximumBytes),
      signal: dependencies.signal,
    });
    if (await readyEntry(dependencies.db, message, row, object, now)) {
      await recalculate(dependencies, message);
    } else if (!await readEntry(dependencies.db, message)) {
      await deleteUncommitted(dependencies.bucket, object.key);
    }
  } catch (error) {
    const retry = retryResult(error);
    if (retry) throw error;
    if (await failEntry(dependencies.db, message, row, terminalCode(error), now))
      await recalculate(dependencies, message);
  }
}

/** @param {Record<string, any>} message @param {any} dependencies */
async function archiveProfile(message, dependencies) {
  const now = inputTimestamp(dependencies.nowSeconds);
  const row = await readProfile(dependencies.db, message);
  if (!row || row.status === "ready" || row.status === "deleting") return;
  if (!await claimProfile(dependencies.db, message, row, now)) return;
  try {
    const token = accessToken(await dependencies.getAccessToken());
    const profile = await fetchThreadsProfile(dependencies.fetcher, {
      accessToken: token, username: row.username, signal: dependencies.signal,
    });
    if (profile.id !== row.author_id)
      throw new AppError("threads_provider_protocol_error", 502);
    if (!profile.profilePictureUrl)
      throw new AppError("threads_media_unavailable", 404);
    const object = await download(dependencies.bucket, dependencies.fetcher, {
      url: profile.profilePictureUrl, key: profileKey(row.author_id), expected: IMAGE_TYPES,
      maximumBytes: maximumBytes(dependencies.maximumBytes), signal: dependencies.signal,
    });
    if (await readyProfile(dependencies.db, message, row, object, now)) {
      await recalculate(dependencies, message);
    } else if (!await hasLiveAuthorReference(dependencies.db, row.author_id)) {
      await deleteUncommitted(dependencies.bucket, object.key);
    }
  } catch (error) {
    const retry = retryResult(error);
    if (retry) throw error;
    if (await failProfile(dependencies.db, message, row, terminalCode(error), now))
      await recalculate(dependencies, message);
  }
}

/** @param {any} db @param {string} key */
async function referencedObject(db, key) {
  const rows = selectRows(await db.prepare(
    `SELECT 'entry' AS object_type, post.id AS owner_id,
       media.source_media_id, media.kind, media.ordinal, media.r2_key
     FROM threads_media media JOIN threads_entries entry ON entry.id = media.entry_id
     JOIN threads_posts post ON post.id = entry.threads_post_id
     WHERE media.r2_key = ?
     UNION ALL
     SELECT 'profile' AS object_type, author.threads_user_id AS owner_id,
       NULL AS source_media_id, NULL AS kind, NULL AS ordinal,
       author.profile_r2_key AS r2_key
     FROM threads_authors author WHERE author.profile_r2_key = ?`,
  ).bind(key, key).all(), [
    "object_type", "owner_id", "source_media_id", "kind", "ordinal", "r2_key",
  ]);
  if (rows.length > 1) throw new AppError("storage_unavailable", 503);
  if (rows.length === 0) return false;
  const row = rows[0];
  if (typeof row.owner_id !== "string" || !row.owner_id || row.r2_key !== key)
    throw new AppError("storage_unavailable", 503);
  if (row.object_type === "profile") {
    if (key !== profileKey(row.owner_id) || row.source_media_id !== null ||
      row.kind !== null || row.ordinal !== null)
      throw new AppError("storage_unavailable", 503);
  } else if (row.object_type === "entry") {
    if (typeof row.source_media_id !== "string" || !row.source_media_id ||
      !["image", "video", "video_thumbnail"].includes(row.kind) ||
      !Number.isSafeInteger(row.ordinal) || row.ordinal < 0 || key !== entryKey({
        postId: row.owner_id, sourceMediaId: row.source_media_id,
        kind: row.kind, ordinal: row.ordinal,
      })) throw new AppError("storage_unavailable", 503);
  } else throw new AppError("storage_unavailable", 503);
  return true;
}

/** @param {Record<string, any>} message @param {any} dependencies */
async function deleteObject(message, dependencies) {
  if (!await referencedObject(dependencies.db, message.objectKey)) return;
  try { await dependencies.bucket.delete(message.objectKey); }
  catch { throw new AppError("media_storage_unavailable", 503); }
}

/** @param {unknown} rawMessage @param {any} dependencies */
export async function handleThreadsMediaMessage(rawMessage, dependencies) {
  let message;
  try { message = /** @type {Record<string, any>} */ (validateMediaMessage(rawMessage)); }
  catch { return ACK; }
  try {
    if (message.type === "archive-profile") await archiveProfile(message, dependencies);
    else if (message.type === "delete-object") await deleteObject(message, dependencies);
    else await archiveEntry(message, dependencies);
    return ACK;
  } catch (error) { return retryResult(error) ?? ACK; }
}

/** @param {Record<string, any>} message @param {any} dependencies */
async function deadEntry(message, dependencies) {
  const row = await readEntry(dependencies.db, message);
  if (!row || row.status === "ready") return;
  const entry = message.type === "retry-media" ? null : message.entryId;
  const changes = mutationChanges(await dependencies.db.prepare(
    `UPDATE threads_media SET status = 'error',
       error_code = 'media_retries_exhausted', updated_at = ?
     WHERE id = ? AND entry_id = ? AND status IN ('pending','error')
       AND (? IS NULL OR entry_id = ?) AND EXISTS (
         SELECT 1 FROM threads_entries entry JOIN threads_posts post
           ON post.id = entry.threads_post_id
         JOIN threads_sync_jobs job ON job.threads_post_id = post.id
           AND job.generation = post.sync_generation
         WHERE entry.id = threads_media.entry_id AND entry.threads_post_id = ?
           AND post.sync_generation = ? AND post.status <> 'deleting'
       )`,
  ).bind(inputTimestamp(dependencies.nowSeconds), row.media_id, row.entry_id,
    entry, entry, message.postId, message.generation).run());
  if (changes > 1) throw new AppError("storage_unavailable", 503);
  if (changes === 1) await recalculate(dependencies, message);
}

/** @param {Record<string, any>} message @param {any} dependencies */
async function deadProfile(message, dependencies) {
  const row = await readProfile(dependencies.db, message);
  if (!row || row.status === "ready" || row.status === "deleting") return;
  const changes = mutationChanges(await dependencies.db.prepare(
    `UPDATE threads_authors SET profile_media_status = 'error',
       profile_error_code = 'media_retries_exhausted', updated_at = ?
     WHERE threads_user_id = ? AND profile_media_status IN ('pending','error')
       AND EXISTS (
         SELECT 1 FROM threads_entries entry JOIN threads_posts post
           ON post.id = entry.threads_post_id
         JOIN threads_sync_jobs job ON job.threads_post_id = post.id
           AND job.generation = post.sync_generation
         WHERE entry.author_id = threads_authors.threads_user_id
           AND entry.threads_post_id = ? AND post.sync_generation = ?
           AND post.status <> 'deleting'
       )`,
  ).bind(inputTimestamp(dependencies.nowSeconds), row.author_id,
    message.postId, message.generation).run());
  if (changes > 1) throw new AppError("storage_unavailable", 503);
  if (changes === 1) await recalculate(dependencies, message);
}

/** @param {unknown} rawMessage @param {any} dependencies */
export async function handleThreadsMediaDeadLetter(rawMessage, dependencies) {
  let message;
  try { message = /** @type {Record<string, any>} */ (validateMediaMessage(rawMessage)); }
  catch { return ACK; }
  if (message.type === "delete-object") return ACK;
  try {
    if (message.type === "archive-profile") await deadProfile(message, dependencies);
    else await deadEntry(message, dependencies);
    return ACK;
  } catch (error) { return retryResult(error) ?? ACK; }
}

/** @param {string | null} rawRange @param {number} size */
export function parseSingleRange(rawRange, size) {
  if (!Number.isSafeInteger(size) || size < 0)
    throw new AppError("invalid_media_range", 416);
  if (rawRange === null) return null;
  if (typeof rawRange !== "string") throw new AppError("invalid_media_range", 416);
  const match = /^bytes=(\d*)-(\d*)$/.exec(rawRange);
  if (!match || rawRange.includes(",") || match[1] === "" && match[2] === "")
    throw new AppError("invalid_media_range", 416);
  let start;
  let end;
  if (match[1] === "") {
    if (!/^\d+$/.test(match[2]) || !Number.isSafeInteger(Number(match[2])))
      throw new AppError("invalid_media_range", 416);
    const suffix = Number(match[2]);
    if (suffix <= 0 || size === 0) throw new AppError("invalid_media_range", 416);
    start = Math.max(0, size - suffix); end = size - 1;
  } else {
    if (!Number.isSafeInteger(Number(match[1])) ||
      match[2] !== "" && !Number.isSafeInteger(Number(match[2])))
      throw new AppError("invalid_media_range", 416);
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
    if (start >= size || end < start) throw new AppError("invalid_media_range", 416);
  }
  return {
    offset: start, length: end - start + 1,
    contentRange: `bytes ${start}-${end}/${size}`,
  };
}

/** @param {unknown} value */
function readableRow(value) {
  const row = exactRow(value, READ_KEYS);
  if (typeof row.r2_key !== "string" || !row.r2_key)
    throw new AppError("storage_unavailable", 503);
  storedContentType(row.content_type); d1NonnegativeInteger(row.bytes);
  storedEtag(row.etag);
  return /** @type {{ r2_key: string, content_type: string, bytes: number, etag: string }} */ (row);
}

/** @param {any} db @param {string} postId @param {string} mediaId */
async function readStoredMedia(db, postId, mediaId) {
  const entry = await db.prepare(
    `SELECT media.r2_key, media.content_type, media.bytes, media.etag
     FROM threads_media media JOIN threads_entries entry ON entry.id = media.entry_id
     JOIN threads_posts post ON post.id = entry.threads_post_id
     WHERE entry.threads_post_id = ? AND media.id = ? AND media.status = 'ready'
       AND media.r2_key IS NOT NULL AND media.content_type IS NOT NULL
       AND media.bytes IS NOT NULL AND media.etag IS NOT NULL
       AND post.status <> 'deleting'`,
  ).bind(postId, mediaId).first();
  if (entry !== null) return readableRow(entry);
  const profile = await db.prepare(
    `SELECT author.profile_r2_key AS r2_key,
       author.profile_content_type AS content_type, author.profile_bytes AS bytes,
       author.profile_etag AS etag
     FROM threads_authors author
     WHERE author.threads_user_id = ? AND author.profile_media_status = 'ready'
       AND author.profile_r2_key IS NOT NULL AND author.profile_content_type IS NOT NULL
       AND author.profile_bytes IS NOT NULL AND author.profile_etag IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM threads_entries entry JOIN threads_posts post
           ON post.id = entry.threads_post_id
         WHERE entry.threads_post_id = ? AND entry.author_id = author.threads_user_id
           AND post.status <> 'deleting'
       )`,
  ).bind(mediaId, postId).first();
  return profile === null ? null : readableRow(profile);
}

/** @param {Request} request */
function mediaPath(request) {
  let url;
  try { url = new URL(request.url); }
  catch { return null; }
  if (url.search || url.hash) return null;
  const match = /^\/threads\/([^/]+)\/media\/([^/]+)$/.exec(url.pathname);
  if (!match) return null;
  try {
    const postId = decodeURIComponent(match[1]);
    const mediaId = decodeURIComponent(match[2]);
    if (!postId || !mediaId || /[\/\\]/.test(postId) || /[\/\\]/.test(mediaId)) return null;
    return { postId, mediaId };
  } catch { return null; }
}

/** @param {{ content_type: string, etag: string }} row @param {number} length */
function mediaHeaders(row, length) {
  return new Headers({
    "Accept-Ranges": "bytes", "Cache-Control": "private, no-cache",
    "Content-Disposition": "inline", "Content-Length": String(length),
    "Content-Type": row.content_type, ETag: row.etag,
    "X-Content-Type-Options": "nosniff",
  });
}

/** @param {Request} request @param {any} dependencies */
export async function serveThreadsMedia(request, dependencies) {
  if (!(request instanceof Request) || !["GET", "HEAD"].includes(request.method))
    return new Response(null, { status: 404 });
  const path = mediaPath(request);
  if (!path) return new Response(null, { status: 404 });
  let row;
  try { row = await readStoredMedia(dependencies.db, path.postId, path.mediaId); }
  catch { return new Response(null, { status: 404 }); }
  if (!row) return new Response(null, { status: 404 });
  let range;
  try { range = parseSingleRange(request.headers.get("range"), row.bytes); }
  catch {
    return new Response(null, { status: 416, headers: {
      "Accept-Ranges": "bytes", "Cache-Control": "private, no-cache",
      "Content-Range": `bytes */${row.bytes}`,
      "X-Content-Type-Options": "nosniff",
    } });
  }
  const length = range?.length ?? row.bytes;
  const headers = mediaHeaders(row, length);
  if (range) headers.set("Content-Range", range.contentRange);
  let object;
  try {
    object = request.method === "HEAD" ? await dependencies.bucket.head(row.r2_key) :
      await dependencies.bucket.get(row.r2_key, range ? {
        range: { offset: range.offset, length: range.length },
      } : undefined);
  } catch { return new Response(null, { status: 503, headers: {
    "Cache-Control": "private, no-cache", "X-Content-Type-Options": "nosniff",
  } }); }
  if (!object) return new Response(null, { status: 404 });
  if (request.method === "HEAD") return new Response(null, {
    status: range ? 206 : 200, headers,
  });
  if (!(object.body instanceof ReadableStream))
    return new Response(null, { status: 404 });
  return new Response(object.body, { status: range ? 206 : 200, headers });
}

/** @param {any} db @param {string} postId */
async function deletingPost(db, postId) {
  const value = await db.prepare(
    "SELECT status FROM threads_posts WHERE id = ?",
  ).bind(postId).first();
  if (value === null) return null;
  const row = exactRow(value, ["status"]);
  if (!["pending", "collecting", "ready", "partial", "error", "deleting"]
    .includes(row.status)) throw new AppError("storage_unavailable", 503);
  return row.status;
}

/** @param {any} db @param {string} postId */
async function deletionRows(db, postId) {
  const media = selectRows(await db.prepare(
    `SELECT media.source_media_id, media.kind, media.ordinal, media.r2_key
     FROM threads_media media JOIN threads_entries entry ON entry.id = media.entry_id
     JOIN threads_posts post ON post.id = entry.threads_post_id
     WHERE entry.threads_post_id = ? AND post.status = 'deleting'
       AND media.status = 'ready' AND media.r2_key IS NOT NULL
     ORDER BY media.r2_key`,
  ).bind(postId).all(), ["source_media_id", "kind", "ordinal", "r2_key"]);
  for (const row of media) {
    if (typeof row.source_media_id !== "string" || !row.source_media_id ||
      !["image", "video", "video_thumbnail"].includes(row.kind) ||
      !Number.isSafeInteger(row.ordinal) || row.ordinal < 0 ||
      row.r2_key !== entryKey({
        postId, sourceMediaId: row.source_media_id, kind: row.kind,
        ordinal: row.ordinal,
      })) throw new AppError("storage_unavailable", 503);
  }
  const authors = selectRows(await db.prepare(
    `SELECT DISTINCT entry.author_id FROM threads_entries entry
     JOIN threads_posts post ON post.id = entry.threads_post_id
     WHERE entry.threads_post_id = ? AND post.status = 'deleting'
     ORDER BY entry.author_id`,
  ).bind(postId).all(), ["author_id"]);
  for (const row of authors) if (typeof row.author_id !== "string" || !row.author_id)
    throw new AppError("storage_unavailable", 503);
  return { media, authors: authors.map((row) => /** @type {string} */ (row.author_id)) };
}

/** @param {any} db @param {string} postId @param {string[]} authors */
async function cascadeArchive(db, postId, authors) {
  const statements = [db.prepare(
    "DELETE FROM threads_posts WHERE id = ? AND status = 'deleting'",
  ).bind(postId)];
  if (authors.length > 0) {
    const placeholders = authors.map(() => "?").join(",");
    statements.push(db.prepare(
      `UPDATE threads_authors SET profile_media_status = 'deleting'
       WHERE threads_user_id IN (${placeholders}) AND profile_r2_key IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM threads_entries
           WHERE author_id = threads_authors.threads_user_id
         )`,
    ).bind(...authors));
    statements.push(db.prepare(
      `DELETE FROM threads_authors
       WHERE threads_user_id IN (${placeholders}) AND profile_r2_key IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM threads_entries
           WHERE author_id = threads_authors.threads_user_id
         )`,
    ).bind(...authors));
  }
  const changes = mutationBatch(await db.batch(statements), statements.length);
  if (changes.slice(1).some((count) => count > authors.length))
    throw new AppError("storage_unavailable", 503);
}

/** @param {any} db @param {any} bucket */
async function sweepDeletingProfiles(db, bucket) {
  const rows = selectRows(await db.prepare(
    `SELECT threads_user_id AS author_id, profile_r2_key AS r2_key
     FROM threads_authors WHERE profile_media_status = 'deleting'
       AND profile_r2_key IS NOT NULL
     ORDER BY threads_user_id`,
  ).all(), ["author_id", "r2_key"]);
  for (const row of rows) {
    if (typeof row.author_id !== "string" || !row.author_id ||
      row.r2_key !== profileKey(row.author_id))
      throw new AppError("storage_unavailable", 503);
    try { await bucket.delete(row.r2_key); }
    catch { throw new AppError("media_storage_unavailable", 503); }
    const changes = mutationChanges(await db.prepare(
      `DELETE FROM threads_authors
       WHERE threads_user_id = ? AND profile_media_status = 'deleting'
         AND profile_r2_key = ? AND NOT EXISTS (
           SELECT 1 FROM threads_entries
           WHERE author_id = threads_authors.threads_user_id
         )`,
    ).bind(row.author_id, row.r2_key).run());
    if (changes > 1) throw new AppError("storage_unavailable", 503);
  }
}

/** @param {unknown} rawMessage @param {{ db: any, bucket: any }} dependencies */
export async function deleteThreadsArchive(rawMessage, dependencies) {
  let message;
  try {
    message = validateCaptureMessage(rawMessage);
    if (message.type !== "delete-archive") return ACK;
  } catch { return ACK; }
  try {
    const postId = requiredString(message.postId);
    if (await deletingPost(dependencies.db, postId) === "deleting") {
      const rows = await deletionRows(dependencies.db, postId);
      for (const row of rows.media) {
        try { await dependencies.bucket.delete(row.r2_key); }
        catch { throw new AppError("media_storage_unavailable", 503); }
      }
      await cascadeArchive(dependencies.db, postId, rows.authors);
    }
    await sweepDeletingProfiles(dependencies.db, dependencies.bucket);
    return ACK;
  } catch (error) { return retryResult(storageError(error)) ?? RETRY; }
}
