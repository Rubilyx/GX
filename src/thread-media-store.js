import { AppError } from "./domain.js";
import { validateStoredContentType, validateStoredEtag } from "./thread-media-download.js";
import {
  d1NonnegativeInteger, exactRow, inputTimestamp, mutationChanges, requiredString,
} from "./threads-storage.js";

export const MEDIA_ACK = Object.freeze({ action: "ack" });
export const MEDIA_RETRY = Object.freeze({ action: "retry", delaySeconds: 1 });
export const UPLOAD_STALE_SECONDS = 960;
const TRANSIENT_CODES = new Set([
  "storage_unavailable", "threads_provider_unavailable", "threads_rate_limited",
  "media_storage_unavailable", "media_upload_in_progress",
]);
const ENTRY_KEYS = [
  "media_id", "entry_id", "source_media_id", "kind", "ordinal", "status",
  "r2_key", "content_type", "bytes", "etag", "error_code", "attempt_count",
  "upload_lease", "upload_started_at",
];
const PROFILE_KEYS = [
  "author_id", "username", "status", "r2_key", "content_type", "bytes", "etag",
  "error_code", "attempt_count", "upload_lease", "upload_started_at", "cleanup_lease",
  "cleanup_started_at",
];


/** @param {{ postId: string, sourceMediaId: string, kind: string, ordinal: number }} input */
export function entryKey(input) {
  return `threads/posts/${input.postId}/${input.sourceMediaId}/${input.kind}-${input.ordinal}`;
}
/** @param {string} authorId */
export function profileKey(authorId) { return `threads/authors/${authorId}/profile`; }

/** @param {unknown} value */
function nullable(value) {
  return value === null || value === undefined;
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
    !Number.isSafeInteger(row.attempt_count) || row.attempt_count < 0 ||
    !(nullable(row.upload_lease) || typeof row.upload_lease === "string" && row.upload_lease) ||
    !(nullable(row.upload_started_at) || Number.isSafeInteger(row.upload_started_at) &&
      row.upload_started_at >= 0) ||
    nullable(row.upload_lease) !== nullable(row.upload_started_at))
    throw new AppError("storage_unavailable", 503);
  if (row.status === "ready") {
    requiredString(row.r2_key); validateStoredContentType(row.content_type);
    d1NonnegativeInteger(row.bytes); validateStoredEtag(row.etag);
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
    !(nullable(row.error_code) || typeof row.error_code === "string") ||
    !Number.isSafeInteger(row.attempt_count) || row.attempt_count < 0 ||
    !(nullable(row.upload_lease) || typeof row.upload_lease === "string" && row.upload_lease) ||
    !(nullable(row.upload_started_at) || Number.isSafeInteger(row.upload_started_at) &&
      row.upload_started_at >= 0) ||
    nullable(row.upload_lease) !== nullable(row.upload_started_at) ||
    !(nullable(row.cleanup_lease) || typeof row.cleanup_lease === "string" && row.cleanup_lease) ||
    !(nullable(row.cleanup_started_at) || Number.isSafeInteger(row.cleanup_started_at) &&
      row.cleanup_started_at >= 0) ||
    nullable(row.cleanup_lease) !== nullable(row.cleanup_started_at) ||
    row.status !== "deleting" && !nullable(row.cleanup_lease) ||
    row.status === "deleting" && !nullable(row.upload_lease))
    throw new AppError("storage_unavailable", 503);
  if (row.status === "ready") {
    if (row.r2_key !== profileKey(row.author_id))
      throw new AppError("storage_unavailable", 503);
    validateStoredContentType(row.content_type); d1NonnegativeInteger(row.bytes);
    validateStoredEtag(row.etag);
  }
  return row;
}



/** @param {unknown} error */
export function mediaRetryResult(error) {
  if (!(error instanceof AppError)) return MEDIA_RETRY;
  if (!TRANSIENT_CODES.has(error.code)) return null;
  const raw = error.code === "threads_rate_limited" ? error.details.retryAfter : 1;
  const delay = typeof raw === "number" && Number.isFinite(raw) ? Math.trunc(raw) : 1;
  return { action: "retry", delaySeconds: Math.max(1, Math.min(900, delay)) };
}



/** @param {any} db @param {Record<string, any>} message */
export async function readEntryMedia(db, message) {
  const entry = message.type === "retry-media" ? null : message.entryId;
  const row = await db.prepare(
    `SELECT media.id AS media_id, media.entry_id, media.source_media_id, media.kind,
       media.ordinal, media.status, media.r2_key, media.content_type, media.bytes,
       media.etag, media.error_code, media.attempt_count, media.upload_lease,
       media.upload_started_at
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
export async function readProfileMedia(db, message) {
  const row = await db.prepare(
    `SELECT author.threads_user_id AS author_id, author.username,
       author.profile_media_status AS status, author.profile_r2_key AS r2_key,
       author.profile_content_type AS content_type, author.profile_bytes AS bytes,
       author.profile_etag AS etag, author.profile_error_code AS error_code,
       author.profile_attempt_count AS attempt_count,
       author.profile_upload_lease AS upload_lease,
       author.profile_upload_started_at AS upload_started_at,
       author.profile_cleanup_lease AS cleanup_lease,
       author.profile_cleanup_started_at AS cleanup_started_at
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

/** @param {any} db @param {Record<string, any>} message @param {Record<string, any>} row
 * @param {number} now @param {string} lease */
export async function claimEntryUpload(db, message, row, now, lease) {
  const changes = mutationChanges(await db.prepare(
    `UPDATE threads_media SET status = 'pending', error_code = NULL,
       attempt_count = attempt_count + 1, upload_lease = ?, upload_started_at = ?,
       updated_at = ?
     WHERE id = ? AND entry_id = ? AND status = ? AND attempt_count = ?
       AND status IN ('pending','error') AND upload_lease IS NULL AND EXISTS (
         SELECT 1 FROM threads_entries entry JOIN threads_posts post
           ON post.id = entry.threads_post_id
         JOIN threads_sync_jobs job ON job.threads_post_id = post.id
           AND job.generation = post.sync_generation
         WHERE entry.id = threads_media.entry_id AND entry.threads_post_id = ?
           AND post.sync_generation = ? AND post.status <> 'deleting'
       )`,
  ).bind(lease, now, now, row.media_id, row.entry_id, row.status, row.attempt_count,
    message.postId, message.generation).run());
  if (changes > 1) throw new AppError("storage_unavailable", 503);
  return changes === 1;
}

/** @param {any} db @param {Record<string, any>} message @param {Record<string, any>} row
 * @param {number} now @param {string} lease */
export async function claimProfileUpload(db, message, row, now, lease) {
  const changes = mutationChanges(await db.prepare(
    `UPDATE threads_authors SET profile_media_status = 'pending',
       profile_error_code = NULL, profile_attempt_count = profile_attempt_count + 1,
       profile_upload_lease = ?, profile_upload_started_at = ?, updated_at = ?
     WHERE threads_user_id = ? AND profile_media_status = ?
       AND profile_media_status IN ('pending','error')
       AND profile_upload_lease IS NULL AND profile_cleanup_lease IS NULL AND EXISTS (
         SELECT 1 FROM threads_entries entry JOIN threads_posts post
           ON post.id = entry.threads_post_id
         JOIN threads_sync_jobs job ON job.threads_post_id = post.id
           AND job.generation = post.sync_generation
         WHERE entry.author_id = threads_authors.threads_user_id
           AND entry.threads_post_id = ? AND post.sync_generation = ?
           AND post.status <> 'deleting'
       )`,
  ).bind(lease, now, now, row.author_id, row.status,
    message.postId, message.generation).run());
  if (changes > 1) throw new AppError("storage_unavailable", 503);
  return changes === 1;
}

/** @param {any} dependencies @param {Record<string, any>} message */
export async function recalculateMediaStatus(dependencies, message) {
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
export async function readyEntryUpload(db, message, row, object, now) {
  const changes = mutationChanges(await db.prepare(
    `UPDATE threads_media SET status = 'ready', r2_key = ?, content_type = ?,
       bytes = ?, etag = ?, error_code = NULL, upload_lease = NULL,
       upload_started_at = NULL, updated_at = ?
     WHERE id = ? AND entry_id = ? AND status = 'pending' AND upload_lease = ?
       AND EXISTS (
         SELECT 1 FROM threads_entries entry JOIN threads_posts post
           ON post.id = entry.threads_post_id
         JOIN threads_sync_jobs job ON job.threads_post_id = post.id
           AND job.generation = post.sync_generation
         WHERE entry.id = threads_media.entry_id AND entry.threads_post_id = ?
           AND post.sync_generation = ? AND post.status <> 'deleting'
       )`,
  ).bind(object.key, object.contentType, object.size, object.httpEtag, now,
    row.media_id, row.entry_id, row.upload_lease, message.postId,
    message.generation).run());
  if (changes > 1) throw new AppError("storage_unavailable", 503);
  return changes === 1;
}

/** @param {any} db @param {Record<string, any>} message @param {Record<string, any>} row
 * @param {{ key: string, size: number, httpEtag: string, contentType: string }} object
 * @param {number} now */
export async function readyProfileUpload(db, message, row, object, now) {
  const changes = mutationChanges(await db.prepare(
    `UPDATE threads_authors SET profile_media_status = 'ready', profile_r2_key = ?,
       profile_content_type = ?, profile_bytes = ?, profile_etag = ?,
       profile_error_code = NULL, profile_refreshed_at = ?,
       profile_upload_lease = NULL, profile_upload_started_at = NULL, updated_at = ?
     WHERE threads_user_id = ? AND profile_media_status = 'pending'
       AND profile_upload_lease = ? AND profile_cleanup_lease IS NULL AND EXISTS (
       SELECT 1 FROM threads_entries entry JOIN threads_posts post
         ON post.id = entry.threads_post_id
       JOIN threads_sync_jobs job ON job.threads_post_id = post.id
         AND job.generation = post.sync_generation
       WHERE entry.author_id = threads_authors.threads_user_id
         AND entry.threads_post_id = ? AND post.sync_generation = ?
         AND post.status <> 'deleting'
     )`,
  ).bind(object.key, object.contentType, object.size, object.httpEtag, now, now,
    row.author_id, row.upload_lease, message.postId, message.generation).run());
  if (changes > 1) throw new AppError("storage_unavailable", 503);
  return changes === 1;
}

/** @param {unknown} error */
export function terminalMediaCode(error) {
  if (!(error instanceof AppError)) return "threads_media_unavailable";
  if (error.code === "threads_post_unavailable" ||
    error.code === "threads_provider_protocol_error") return "threads_media_unavailable";
  return error.code;
}

/** @param {any} db @param {Record<string, any>} message @param {Record<string, any>} row
 * @param {string} code @param {number} now */
export async function failEntryUpload(db, message, row, code, now) {
  const changes = mutationChanges(await db.prepare(
    `UPDATE threads_media SET status = 'error', error_code = ?, upload_lease = NULL,
       upload_started_at = NULL, updated_at = ?
     WHERE id = ? AND entry_id = ? AND status = 'pending' AND upload_lease = ?
       AND EXISTS (
         SELECT 1 FROM threads_entries entry JOIN threads_posts post
           ON post.id = entry.threads_post_id
         JOIN threads_sync_jobs job ON job.threads_post_id = post.id
           AND job.generation = post.sync_generation
         WHERE entry.id = threads_media.entry_id AND entry.threads_post_id = ?
           AND post.sync_generation = ? AND post.status <> 'deleting'
       )`,
  ).bind(code, now, row.media_id, row.entry_id, row.upload_lease,
    message.postId, message.generation).run());
  if (changes > 1) throw new AppError("storage_unavailable", 503);
  return changes === 1;
}

/** @param {any} db @param {Record<string, any>} message @param {Record<string, any>} row
 * @param {string} code @param {number} now */
export async function failProfileUpload(db, message, row, code, now) {
  const changes = mutationChanges(await db.prepare(
    `UPDATE threads_authors SET profile_media_status = 'error',
       profile_error_code = ?, profile_upload_lease = NULL,
       profile_upload_started_at = NULL, updated_at = ?
     WHERE threads_user_id = ? AND profile_media_status = 'pending'
       AND profile_upload_lease = ? AND profile_cleanup_lease IS NULL AND EXISTS (
       SELECT 1 FROM threads_entries entry JOIN threads_posts post
         ON post.id = entry.threads_post_id
       JOIN threads_sync_jobs job ON job.threads_post_id = post.id
         AND job.generation = post.sync_generation
       WHERE entry.author_id = threads_authors.threads_user_id
         AND entry.threads_post_id = ? AND post.sync_generation = ?
         AND post.status <> 'deleting'
     )`,
  ).bind(code, now, row.author_id, row.upload_lease,
    message.postId, message.generation).run());
  if (changes > 1) throw new AppError("storage_unavailable", 503);
  return changes === 1;
}

/** @param {any} db @param {Record<string, any>} message @param {Record<string, any>} row
 * @param {number} now */
export async function releaseEntryUpload(db, message, row, now) {
  const changes = mutationChanges(await db.prepare(
    `UPDATE threads_media SET upload_lease = NULL, upload_started_at = NULL,
       status = 'pending', updated_at = ?
     WHERE id = ? AND entry_id = ? AND status = 'pending' AND upload_lease = ?
       AND EXISTS (
         SELECT 1 FROM threads_entries entry JOIN threads_posts post
           ON post.id = entry.threads_post_id
         JOIN threads_sync_jobs job ON job.threads_post_id = post.id
           AND job.generation = post.sync_generation
         WHERE entry.id = threads_media.entry_id AND entry.threads_post_id = ?
           AND post.sync_generation = ? AND post.status <> 'deleting'
       )`,
  ).bind(now, row.media_id, row.entry_id, row.upload_lease,
    message.postId, message.generation).run());
  if (changes > 1) throw new AppError("storage_unavailable", 503);
}

/** @param {any} db @param {Record<string, any>} message @param {Record<string, any>} row
 * @param {number} now */
export async function releaseProfileUpload(db, message, row, now) {
  const changes = mutationChanges(await db.prepare(
    `UPDATE threads_authors SET profile_upload_lease = NULL,
       profile_upload_started_at = NULL, profile_media_status = 'pending', updated_at = ?
     WHERE threads_user_id = ? AND profile_media_status = 'pending'
       AND profile_upload_lease = ? AND profile_cleanup_lease IS NULL AND EXISTS (
         SELECT 1 FROM threads_entries entry JOIN threads_posts post
           ON post.id = entry.threads_post_id
         JOIN threads_sync_jobs job ON job.threads_post_id = post.id
           AND job.generation = post.sync_generation
         WHERE entry.author_id = threads_authors.threads_user_id
           AND entry.threads_post_id = ? AND post.sync_generation = ?
           AND post.status <> 'deleting'
       )`,
  ).bind(now, row.author_id, row.upload_lease,
    message.postId, message.generation).run());
  if (changes > 1) throw new AppError("storage_unavailable", 503);
}

/** @param {any} db @param {Record<string, any>} message @param {Record<string, any>} row */
export async function ownsEntryUpload(db, message, row) {
  const value = await db.prepare(
    `SELECT COUNT(*) AS count FROM threads_media media
     JOIN threads_entries entry ON entry.id = media.entry_id
     JOIN threads_posts post ON post.id = entry.threads_post_id
     JOIN threads_sync_jobs job ON job.threads_post_id = post.id
       AND job.generation = post.sync_generation
     WHERE media.id = ? AND media.entry_id = ? AND media.upload_lease = ?
       AND entry.threads_post_id = ? AND post.sync_generation = ?
       AND post.status <> 'deleting'`,
  ).bind(row.media_id, row.entry_id, row.upload_lease,
    message.postId, message.generation).first();
  return d1NonnegativeInteger(exactRow(value, ["count"]).count) === 1;
}

/** @param {any} db @param {Record<string, any>} message @param {Record<string, any>} row */
export async function ownsProfileUpload(db, message, row) {
  const value = await db.prepare(
    `SELECT COUNT(*) AS count FROM threads_authors author
     WHERE author.threads_user_id = ? AND author.profile_upload_lease = ?
       AND author.profile_media_status = 'pending' AND author.profile_cleanup_lease IS NULL
       AND EXISTS (
         SELECT 1 FROM threads_entries entry JOIN threads_posts post
           ON post.id = entry.threads_post_id
         JOIN threads_sync_jobs job ON job.threads_post_id = post.id
           AND job.generation = post.sync_generation
         WHERE entry.author_id = author.threads_user_id AND entry.threads_post_id = ?
           AND post.sync_generation = ? AND post.status <> 'deleting'
       )`,
  ).bind(row.author_id, row.upload_lease,
    message.postId, message.generation).first();
  return d1NonnegativeInteger(exactRow(value, ["count"]).count) === 1;
}

/** @param {any} db @param {Record<string, any>} message @param {Record<string, any>} row
 * @param {number} now */
export async function canDeleteFailedEntryUpload(db, message, row, now) {
  const owned = mutationChanges(await db.prepare(
    `UPDATE threads_media SET upload_started_at = ?, updated_at = ?
     WHERE id = ? AND entry_id = ? AND status = 'pending' AND upload_lease = ?
       AND EXISTS (
         SELECT 1 FROM threads_entries entry JOIN threads_posts post
           ON post.id = entry.threads_post_id
         JOIN threads_sync_jobs job ON job.threads_post_id = post.id
           AND job.generation = post.sync_generation
         WHERE entry.id = threads_media.entry_id AND entry.threads_post_id = ?
           AND post.sync_generation = ? AND post.status <> 'deleting'
       )`,
  ).bind(now, now, row.media_id, row.entry_id, row.upload_lease,
    message.postId, message.generation).run());
  if (owned > 1) throw new AppError("storage_unavailable", 503);
  if (owned === 1) return true;
  const state = await db.prepare(
    `SELECT post.status AS post_status, media.status AS media_status,
       media.upload_lease
     FROM threads_media media
     JOIN threads_entries entry ON entry.id = media.entry_id
     JOIN threads_posts post ON post.id = entry.threads_post_id
     WHERE media.id = ? AND media.entry_id = ? AND entry.threads_post_id = ?`,
  ).bind(row.media_id, row.entry_id, message.postId).first();
  if (state === null) return true;
  const current = exactRow(state, ["post_status", "media_status", "upload_lease"]);
  if (!["pending", "collecting", "ready", "partial", "error", "deleting"]
    .includes(current.post_status) || !["pending", "ready", "error"].includes(current.media_status) ||
    !(current.upload_lease === null || typeof current.upload_lease === "string" &&
      current.upload_lease)) throw new AppError("storage_unavailable", 503);
  if (current.media_status === "ready" || current.upload_lease !== null &&
    current.upload_lease !== row.upload_lease) return false;
  return current.post_status === "deleting";
}

/** @param {any} db @param {Record<string, any>} message @param {Record<string, any>} row
 * @param {number} now */
export async function canDeleteFailedProfileUpload(db, message, row, now) {
  const owned = mutationChanges(await db.prepare(
    `UPDATE threads_authors SET profile_upload_started_at = ?, updated_at = ?
     WHERE threads_user_id = ? AND profile_media_status = 'pending'
       AND profile_upload_lease = ? AND profile_cleanup_lease IS NULL AND EXISTS (
         SELECT 1 FROM threads_entries entry JOIN threads_posts post
           ON post.id = entry.threads_post_id
         JOIN threads_sync_jobs job ON job.threads_post_id = post.id
           AND job.generation = post.sync_generation
         WHERE entry.author_id = threads_authors.threads_user_id
           AND entry.threads_post_id = ? AND post.sync_generation = ?
           AND post.status <> 'deleting'
       )`,
  ).bind(now, now, row.author_id, row.upload_lease,
    message.postId, message.generation).run());
  if (owned > 1) throw new AppError("storage_unavailable", 503);
  if (owned === 1) return true;
  const value = await db.prepare(
    `SELECT profile_media_status AS status, profile_upload_lease AS upload_lease
     FROM threads_authors WHERE threads_user_id = ?`,
  ).bind(row.author_id).first();
  if (value === null) return true;
  const current = exactRow(value, ["status", "upload_lease"]);
  if (!["pending", "ready", "error", "deleting"].includes(current.status) ||
    !(current.upload_lease === null || typeof current.upload_lease === "string" &&
      current.upload_lease)) throw new AppError("storage_unavailable", 503);
  if (current.status === "ready" || current.upload_lease !== null &&
    current.upload_lease !== row.upload_lease) return false;
  return !await hasLiveAuthorReference(db, row.author_id);
}

/** @param {any} db @param {Record<string, any>} message @param {Record<string, any>} row
 * @param {number} now */
export async function clearEntryUploadForRetry(db, message, row, now) {
  if (row.upload_lease === null) return true;
  const cutoff = now - UPLOAD_STALE_SECONDS;
  if (row.upload_started_at > cutoff) return false;
  const changes = mutationChanges(await db.prepare(
    `UPDATE threads_media SET upload_lease = NULL, upload_started_at = NULL,
       status = 'pending', updated_at = ?
     WHERE id = ? AND entry_id = ? AND upload_lease = ? AND upload_started_at = ?
       AND upload_started_at <= ?
       AND status IN ('pending','error') AND EXISTS (
         SELECT 1 FROM threads_entries entry JOIN threads_posts post
           ON post.id = entry.threads_post_id
         JOIN threads_sync_jobs job ON job.threads_post_id = post.id
           AND job.generation = post.sync_generation
         WHERE entry.id = threads_media.entry_id AND entry.threads_post_id = ?
           AND post.sync_generation = ? AND post.status <> 'deleting'
       )`,
  ).bind(now, row.media_id, row.entry_id, row.upload_lease,
    row.upload_started_at, cutoff,
    message.postId, message.generation).run());
  if (changes > 1) throw new AppError("storage_unavailable", 503);
  return changes === 1;
}

/** @param {any} bucket @param {string} key */
export async function deleteUncommittedUpload(bucket, key) {
  try { await bucket.delete(key); }
  catch { throw new AppError("media_storage_unavailable", 503); }
}

/** @param {any} db @param {string} authorId */
export async function hasLiveAuthorReference(db, authorId) {
  const value = await db.prepare(
    `SELECT COUNT(*) AS count FROM threads_entries entry
     JOIN threads_posts post ON post.id = entry.threads_post_id
     WHERE entry.author_id = ? AND post.status <> 'deleting'`,
  ).bind(authorId).first();
  const row = exactRow(value, ["count"]);
  return d1NonnegativeInteger(row.count) > 0;
}



/** @param {Record<string, any>} message @param {any} dependencies */
export async function terminalizeEntryDeadLetter(message, dependencies) {
  const row = await readEntryMedia(dependencies.db, message);
  if (!row || row.status === "ready") return;
  const now = inputTimestamp(dependencies.nowSeconds);
  const cutoff = now - UPLOAD_STALE_SECONDS;
  if (row.upload_lease !== null && row.upload_started_at > cutoff)
    throw new AppError("media_upload_in_progress", 503);
  const entry = message.type === "retry-media" ? null : message.entryId;
  const changes = mutationChanges(await dependencies.db.prepare(
    `UPDATE threads_media SET status = 'error',
       error_code = 'media_retries_exhausted', upload_lease = NULL,
       upload_started_at = NULL, updated_at = ?
     WHERE id = ? AND entry_id = ? AND status IN ('pending','error')
       AND ((? IS NULL AND upload_lease IS NULL AND upload_started_at IS NULL)
         OR (upload_lease = ? AND upload_started_at = ? AND upload_started_at <= ?))
       AND (? IS NULL OR entry_id = ?) AND EXISTS (
         SELECT 1 FROM threads_entries entry JOIN threads_posts post
           ON post.id = entry.threads_post_id
         JOIN threads_sync_jobs job ON job.threads_post_id = post.id
           AND job.generation = post.sync_generation
         WHERE entry.id = threads_media.entry_id AND entry.threads_post_id = ?
           AND post.sync_generation = ? AND post.status <> 'deleting'
       )`,
  ).bind(now, row.media_id, row.entry_id,
    row.upload_lease, row.upload_lease, row.upload_started_at, cutoff, entry, entry,
    message.postId, message.generation).run());
  if (changes > 1) throw new AppError("storage_unavailable", 503);
  if (changes === 1) await recalculateMediaStatus(dependencies, message);
}

/** @param {Record<string, any>} message @param {any} dependencies */
export async function terminalizeProfileDeadLetter(message, dependencies) {
  const row = await readProfileMedia(dependencies.db, message);
  if (!row || row.status === "ready" || row.status === "deleting") return;
  const now = inputTimestamp(dependencies.nowSeconds);
  const cutoff = now - UPLOAD_STALE_SECONDS;
  if (row.upload_lease !== null && row.upload_started_at > cutoff)
    throw new AppError("media_upload_in_progress", 503);
  const changes = mutationChanges(await dependencies.db.prepare(
    `UPDATE threads_authors SET profile_media_status = 'error',
       profile_error_code = 'media_retries_exhausted', profile_upload_lease = NULL,
       profile_upload_started_at = NULL, updated_at = ?
     WHERE threads_user_id = ? AND profile_media_status IN ('pending','error')
       AND ((? IS NULL AND profile_upload_lease IS NULL
           AND profile_upload_started_at IS NULL)
         OR (profile_upload_lease = ? AND profile_upload_started_at = ?
           AND profile_upload_started_at <= ?))
       AND profile_cleanup_lease IS NULL
       AND EXISTS (
         SELECT 1 FROM threads_entries entry JOIN threads_posts post
           ON post.id = entry.threads_post_id
         JOIN threads_sync_jobs job ON job.threads_post_id = post.id
           AND job.generation = post.sync_generation
         WHERE entry.author_id = threads_authors.threads_user_id
           AND entry.threads_post_id = ? AND post.sync_generation = ?
           AND post.status <> 'deleting'
       )`,
  ).bind(now, row.author_id,
    row.upload_lease, row.upload_lease, row.upload_started_at, cutoff,
    message.postId, message.generation).run());
  if (changes > 1) throw new AppError("storage_unavailable", 503);
  if (changes === 1) await recalculateMediaStatus(dependencies, message);
}
