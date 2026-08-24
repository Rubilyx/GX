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
  "upload_lease", "upload_started_at", "pending_r2_key", "upload_recovering",
];
const PROFILE_KEYS = [
  "author_id", "username", "status", "r2_key", "content_type", "bytes", "etag",
  "error_code", "attempt_count", "upload_lease", "upload_started_at", "pending_r2_key",
  "upload_recovering", "cleanup_lease", "cleanup_started_at",
];
const CONSERVATIVE_ID = /^[A-Za-z0-9_-]+$/;
const LEASE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** @param {string} value */
function conservativeId(value) {
  if (typeof value !== "string" || !CONSERVATIVE_ID.test(value))
    throw new AppError("storage_unavailable", 503);
  return value;
}

/** @param {string} value */
function uploadLease(value) {
  if (typeof value !== "string" || !LEASE_UUID.test(value))
    throw new AppError("storage_unavailable", 503);
  return value;
}

/** @param {{ postId: string, sourceMediaId: string, kind: string, ordinal: number }} input */
function entryPrefix(input) {
  if (!["image", "video", "video_thumbnail"].includes(input.kind) ||
    !Number.isSafeInteger(input.ordinal) || input.ordinal < 0)
    throw new AppError("storage_unavailable", 503);
  return `threads/posts/${conservativeId(input.postId)}/${
    conservativeId(input.sourceMediaId)}/${input.kind}-${input.ordinal}`;
}

/** @param {{ postId: string, sourceMediaId: string, kind: string, ordinal: number }} input
 * @param {string} lease */
export function entryKey(input, lease) { return `${entryPrefix(input)}/${uploadLease(lease)}`; }

/** @param {string} key
 * @param {{ postId: string, sourceMediaId: string, kind: string, ordinal: number }} input */
export function validEntryKey(key, input) {
  const prefix = `${entryPrefix(input)}/`;
  return typeof key === "string" && key.startsWith(prefix) &&
    LEASE_UUID.test(key.slice(prefix.length));
}

/** @param {string} authorId */
function profilePrefix(authorId) {
  return `threads/authors/${conservativeId(authorId)}/profile`;
}

/** @param {string} authorId @param {string} lease */
export function profileKey(authorId, lease) {
  return `${profilePrefix(authorId)}/${uploadLease(lease)}`;
}

/** @param {string} key @param {string} authorId */
export function validProfileKey(key, authorId) {
  const prefix = `${profilePrefix(authorId)}/`;
  return typeof key === "string" && key.startsWith(prefix) &&
    LEASE_UUID.test(key.slice(prefix.length));
}

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
    !(nullable(row.pending_r2_key) || typeof row.pending_r2_key === "string" &&
      row.pending_r2_key) ||
    ![0, 1].includes(row.upload_recovering) ||
    nullable(row.upload_lease) !== nullable(row.upload_started_at) ||
    nullable(row.upload_lease) !== nullable(row.pending_r2_key) ||
    row.upload_recovering === 1 && nullable(row.upload_lease))
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
    !(nullable(row.pending_r2_key) || typeof row.pending_r2_key === "string" &&
      row.pending_r2_key) ||
    ![0, 1].includes(row.upload_recovering) ||
    nullable(row.upload_lease) !== nullable(row.upload_started_at) ||
    nullable(row.upload_lease) !== nullable(row.pending_r2_key) ||
    row.upload_recovering === 1 && nullable(row.upload_lease) ||
    !(nullable(row.cleanup_lease) || typeof row.cleanup_lease === "string" && row.cleanup_lease) ||
    !(nullable(row.cleanup_started_at) || Number.isSafeInteger(row.cleanup_started_at) &&
      row.cleanup_started_at >= 0) ||
    nullable(row.cleanup_lease) !== nullable(row.cleanup_started_at) ||
    row.status !== "deleting" && !nullable(row.cleanup_lease) ||
    row.status === "deleting" && !nullable(row.upload_lease))
    throw new AppError("storage_unavailable", 503);
  if (typeof row.pending_r2_key === "string" &&
    !validProfileKey(row.pending_r2_key, row.author_id))
    throw new AppError("storage_unavailable", 503);
  if (row.r2_key !== null && row.r2_key !== undefined) {
    if (typeof row.r2_key !== "string" || !validProfileKey(row.r2_key, row.author_id))
      throw new AppError("storage_unavailable", 503);
    validateStoredContentType(row.content_type); d1NonnegativeInteger(row.bytes);
    validateStoredEtag(row.etag);
  }
  return row;
}

/** @param {any} db @param {Record<string, any>} message
 * @param {Record<string, any>} row @param {Record<string, any>} profile
 * @param {number} now */
export async function updateClaimedProfileMetadata(db, message, row, profile, now) {
  if (profile.id !== row.author_id || typeof profile.username !== "string" ||
    !profile.username || !(profile.name === null || typeof profile.name === "string"))
    throw new AppError("threads_provider_protocol_error", 502);
  const changes = mutationChanges(await db.prepare(
    `UPDATE threads_authors SET username = ?, display_name = ?, updated_at = ?
     WHERE threads_user_id = ? AND profile_media_status = 'pending'
       AND profile_upload_lease = ? AND profile_upload_started_at = ?
       AND profile_pending_r2_key = ? AND profile_upload_recovering = 0
       AND profile_cleanup_lease IS NULL AND EXISTS (
         SELECT 1 FROM threads_entries entry JOIN threads_posts post
           ON post.id = entry.threads_post_id
         WHERE entry.author_id = threads_authors.threads_user_id
           AND entry.threads_post_id = ? AND post.sync_generation = ?
           AND post.status <> 'deleting'
       )`,
  ).bind(profile.username, profile.name ?? profile.username, now, row.author_id,
    row.upload_lease, row.upload_started_at, row.pending_r2_key,
    message.postId, message.generation).run());
  if (changes > 1) throw new AppError("storage_unavailable", 503);
  return changes === 1;
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
       media.upload_started_at, media.pending_r2_key, media.upload_recovering
     FROM threads_media media
     JOIN threads_entries entry ON entry.id = media.entry_id
     JOIN threads_posts post ON post.id = entry.threads_post_id
     JOIN threads_sync_jobs job ON job.threads_post_id = post.id
       AND job.generation = post.sync_generation
     WHERE media.id = ? AND entry.threads_post_id = ?
       AND (? IS NULL OR media.entry_id = ?)
       AND post.sync_generation = ? AND post.status <> 'deleting'`,
  ).bind(message.mediaId, message.postId, entry, entry, message.generation).first();
  if (row === null) return null;
  const parsed = entryRow(row);
  const identity = { postId: message.postId, sourceMediaId: parsed.source_media_id,
    kind: parsed.kind, ordinal: parsed.ordinal };
  if (parsed.r2_key !== null && !validEntryKey(parsed.r2_key, identity) ||
    parsed.pending_r2_key !== null && !validEntryKey(parsed.pending_r2_key, identity))
    throw new AppError("storage_unavailable", 503);
  return parsed;
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
       author.profile_pending_r2_key AS pending_r2_key,
       author.profile_upload_recovering AS upload_recovering,
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

/** Strict author/profile read that is independent of any triggering post or generation.
 * @param {any} db @param {string} authorId */
export async function readGlobalProfileMedia(db, authorId) {
  requiredString(authorId);
  const row = await db.prepare(
    `SELECT author.threads_user_id AS author_id, author.username,
       author.profile_media_status AS status, author.profile_r2_key AS r2_key,
       author.profile_content_type AS content_type, author.profile_bytes AS bytes,
       author.profile_etag AS etag, author.profile_error_code AS error_code,
       author.profile_attempt_count AS attempt_count,
       author.profile_upload_lease AS upload_lease,
       author.profile_upload_started_at AS upload_started_at,
       author.profile_pending_r2_key AS pending_r2_key,
       author.profile_upload_recovering AS upload_recovering,
       author.profile_cleanup_lease AS cleanup_lease,
       author.profile_cleanup_started_at AS cleanup_started_at
     FROM threads_authors author WHERE author.threads_user_id = ?`,
  ).bind(authorId).first();
  return row === null ? null : profileRow(row);
}

/** @param {any} db @param {Record<string, any>} message @param {Record<string, any>} row
 * @param {number} now @param {string} lease @param {string} pendingKey */
export async function claimEntryUpload(db, message, row, now, lease, pendingKey) {
  if (pendingKey !== entryKey({ postId: message.postId,
    sourceMediaId: row.source_media_id, kind: row.kind, ordinal: row.ordinal }, lease))
    throw new AppError("storage_unavailable", 503);
  const changes = mutationChanges(await db.prepare(
    `UPDATE threads_media SET status = 'pending', error_code = NULL,
       attempt_count = attempt_count + 1, upload_lease = ?, upload_started_at = ?,
       pending_r2_key = ?, upload_recovering = 0, updated_at = ?
     WHERE id = ? AND entry_id = ? AND status = ? AND attempt_count = ?
       AND status IN ('pending','error') AND upload_lease IS NULL
       AND upload_recovering = 0 AND EXISTS (
         SELECT 1 FROM threads_entries entry JOIN threads_posts post
           ON post.id = entry.threads_post_id
         JOIN threads_sync_jobs job ON job.threads_post_id = post.id
           AND job.generation = post.sync_generation
         WHERE entry.id = threads_media.entry_id AND entry.threads_post_id = ?
           AND post.sync_generation = ? AND post.status <> 'deleting'
       )`,
  ).bind(lease, now, pendingKey, now, row.media_id, row.entry_id, row.status, row.attempt_count,
    message.postId, message.generation).run());
  if (changes > 1) throw new AppError("storage_unavailable", 503);
  return changes === 1;
}

/** @param {any} db @param {Record<string, any>} message @param {Record<string, any>} row
 * @param {number} now @param {string} lease @param {string} pendingKey */
export async function claimProfileUpload(db, message, row, now, lease, pendingKey) {
  if (pendingKey !== profileKey(row.author_id, lease))
    throw new AppError("storage_unavailable", 503);
  const changes = mutationChanges(await db.prepare(
    `UPDATE threads_authors SET profile_media_status = 'pending',
       profile_error_code = NULL, profile_attempt_count = profile_attempt_count + 1,
       profile_upload_lease = ?, profile_upload_started_at = ?,
       profile_pending_r2_key = ?, profile_upload_recovering = 0, updated_at = ?
     WHERE threads_user_id = ? AND profile_media_status = ?
       AND profile_media_status IN ('pending','error')
       AND profile_upload_lease IS NULL AND profile_upload_recovering = 0
       AND profile_cleanup_lease IS NULL AND EXISTS (
         SELECT 1 FROM threads_entries entry JOIN threads_posts post
           ON post.id = entry.threads_post_id
         JOIN threads_sync_jobs job ON job.threads_post_id = post.id
           AND job.generation = post.sync_generation
         WHERE entry.author_id = threads_authors.threads_user_id
           AND entry.threads_post_id = ? AND post.sync_generation = ?
           AND post.status <> 'deleting'
       )`,
  ).bind(lease, now, pendingKey, now, row.author_id, row.status,
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
  if (object.key !== row.pending_r2_key)
    throw new AppError("storage_unavailable", 503);
  const changes = mutationChanges(await db.prepare(
    `UPDATE threads_media SET status = 'ready', r2_key = pending_r2_key, content_type = ?,
       bytes = ?, etag = ?, error_code = NULL, upload_lease = NULL,
       upload_started_at = NULL, pending_r2_key = NULL, upload_recovering = 0,
       updated_at = ?
     WHERE id = ? AND entry_id = ? AND status = 'pending' AND upload_lease = ?
       AND upload_started_at = ? AND pending_r2_key = ? AND upload_recovering = 0
       AND EXISTS (
         SELECT 1 FROM threads_entries entry JOIN threads_posts post
           ON post.id = entry.threads_post_id
         JOIN threads_sync_jobs job ON job.threads_post_id = post.id
           AND job.generation = post.sync_generation
         WHERE entry.id = threads_media.entry_id AND entry.threads_post_id = ?
           AND post.sync_generation = ? AND post.status <> 'deleting'
       )`,
  ).bind(object.contentType, object.size, object.httpEtag, now,
    row.media_id, row.entry_id, row.upload_lease, row.upload_started_at,
    row.pending_r2_key, message.postId,
    message.generation).run());
  if (changes > 1) throw new AppError("storage_unavailable", 503);
  return changes === 1;
}

/** @param {any} db @param {Record<string, any>} message @param {Record<string, any>} row
 * @param {{ key: string, size: number, httpEtag: string, contentType: string }} object
 * @param {number} now */
export async function readyProfileUpload(db, message, row, object, now) {
  if (object.key !== row.pending_r2_key)
    throw new AppError("storage_unavailable", 503);
  const changes = mutationChanges(await db.prepare(
    `UPDATE threads_authors SET profile_media_status = 'ready',
       profile_r2_key = profile_pending_r2_key,
       profile_content_type = ?, profile_bytes = ?, profile_etag = ?,
       profile_error_code = NULL, profile_refreshed_at = ?,
       profile_upload_lease = NULL, profile_upload_started_at = NULL,
       profile_pending_r2_key = NULL, profile_upload_recovering = 0, updated_at = ?
     WHERE threads_user_id = ? AND profile_media_status = 'pending'
       AND profile_upload_lease = ? AND profile_upload_started_at = ?
       AND profile_pending_r2_key = ? AND profile_upload_recovering = 0
       AND profile_cleanup_lease IS NULL AND EXISTS (
       SELECT 1 FROM threads_entries entry JOIN threads_posts post
         ON post.id = entry.threads_post_id
       JOIN threads_sync_jobs job ON job.threads_post_id = post.id
         AND job.generation = post.sync_generation
       WHERE entry.author_id = threads_authors.threads_user_id
         AND entry.threads_post_id = ? AND post.sync_generation = ?
         AND post.status <> 'deleting'
     )`,
  ).bind(object.contentType, object.size, object.httpEtag, now, now,
    row.author_id, row.upload_lease, row.upload_started_at, row.pending_r2_key,
    message.postId, message.generation).run());
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
       upload_started_at = NULL, pending_r2_key = NULL, upload_recovering = 0,
       updated_at = ?
     WHERE id = ? AND entry_id = ? AND status = 'pending' AND upload_lease = ?
       AND upload_started_at = ? AND pending_r2_key = ? AND upload_recovering = 0
       AND EXISTS (
         SELECT 1 FROM threads_entries entry JOIN threads_posts post
           ON post.id = entry.threads_post_id
         JOIN threads_sync_jobs job ON job.threads_post_id = post.id
           AND job.generation = post.sync_generation
         WHERE entry.id = threads_media.entry_id AND entry.threads_post_id = ?
           AND post.sync_generation = ? AND post.status <> 'deleting'
       )`,
  ).bind(code, now, row.media_id, row.entry_id, row.upload_lease,
    row.upload_started_at, row.pending_r2_key,
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
       profile_upload_started_at = NULL, profile_pending_r2_key = NULL,
       profile_upload_recovering = 0, updated_at = ?
     WHERE threads_user_id = ? AND profile_media_status = 'pending'
       AND profile_upload_lease = ? AND profile_upload_started_at = ?
       AND profile_pending_r2_key = ? AND profile_upload_recovering = 0
       AND profile_cleanup_lease IS NULL AND EXISTS (
       SELECT 1 FROM threads_entries entry JOIN threads_posts post
         ON post.id = entry.threads_post_id
       JOIN threads_sync_jobs job ON job.threads_post_id = post.id
         AND job.generation = post.sync_generation
       WHERE entry.author_id = threads_authors.threads_user_id
         AND entry.threads_post_id = ? AND post.sync_generation = ?
         AND post.status <> 'deleting'
     )`,
  ).bind(code, now, row.author_id, row.upload_lease, row.upload_started_at,
    row.pending_r2_key,
    message.postId, message.generation).run());
  if (changes > 1) throw new AppError("storage_unavailable", 503);
  return changes === 1;
}

/** @param {any} db @param {Record<string, any>} message @param {Record<string, any>} row
 * @param {number} now */
export async function releaseEntryUpload(db, message, row, now) {
  const changes = mutationChanges(await db.prepare(
    `UPDATE threads_media SET upload_lease = NULL, upload_started_at = NULL,
       pending_r2_key = NULL, upload_recovering = 0, status = 'pending', updated_at = ?
     WHERE id = ? AND entry_id = ? AND status = 'pending' AND upload_lease = ?
       AND upload_started_at = ? AND pending_r2_key = ? AND upload_recovering = 0
       AND EXISTS (
         SELECT 1 FROM threads_entries entry JOIN threads_posts post
           ON post.id = entry.threads_post_id
         JOIN threads_sync_jobs job ON job.threads_post_id = post.id
           AND job.generation = post.sync_generation
         WHERE entry.id = threads_media.entry_id AND entry.threads_post_id = ?
           AND post.sync_generation = ? AND post.status <> 'deleting'
       )`,
  ).bind(now, row.media_id, row.entry_id, row.upload_lease,
    row.upload_started_at, row.pending_r2_key,
    message.postId, message.generation).run());
  if (changes > 1) throw new AppError("storage_unavailable", 503);
}

/** @param {any} db @param {Record<string, any>} message @param {Record<string, any>} row
 * @param {number} now */
export async function releaseProfileUpload(db, message, row, now) {
  const changes = mutationChanges(await db.prepare(
    `UPDATE threads_authors SET profile_upload_lease = NULL,
       profile_upload_started_at = NULL, profile_pending_r2_key = NULL,
       profile_upload_recovering = 0, profile_media_status = 'pending', updated_at = ?
     WHERE threads_user_id = ? AND profile_media_status = 'pending'
       AND profile_upload_lease = ? AND profile_upload_started_at = ?
       AND profile_pending_r2_key = ? AND profile_upload_recovering = 0
       AND profile_cleanup_lease IS NULL AND EXISTS (
         SELECT 1 FROM threads_entries entry JOIN threads_posts post
           ON post.id = entry.threads_post_id
         JOIN threads_sync_jobs job ON job.threads_post_id = post.id
           AND job.generation = post.sync_generation
         WHERE entry.author_id = threads_authors.threads_user_id
           AND entry.threads_post_id = ? AND post.sync_generation = ?
           AND post.status <> 'deleting'
       )`,
  ).bind(now, row.author_id, row.upload_lease, row.upload_started_at,
    row.pending_r2_key,
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
       AND media.upload_started_at = ? AND media.pending_r2_key = ?
       AND media.upload_recovering = 0
       AND entry.threads_post_id = ? AND post.sync_generation = ?
       AND post.status <> 'deleting'`,
  ).bind(row.media_id, row.entry_id, row.upload_lease, row.upload_started_at,
    row.pending_r2_key,
    message.postId, message.generation).first();
  return d1NonnegativeInteger(exactRow(value, ["count"]).count) === 1;
}

/** @param {any} db @param {Record<string, any>} message @param {Record<string, any>} row */
export async function ownsProfileUpload(db, message, row) {
  const value = await db.prepare(
    `SELECT COUNT(*) AS count FROM threads_authors author
     WHERE author.threads_user_id = ? AND author.profile_upload_lease = ?
       AND author.profile_upload_started_at = ? AND author.profile_pending_r2_key = ?
       AND author.profile_upload_recovering = 0
       AND author.profile_media_status = 'pending' AND author.profile_cleanup_lease IS NULL
       AND EXISTS (
         SELECT 1 FROM threads_entries entry JOIN threads_posts post
           ON post.id = entry.threads_post_id
         JOIN threads_sync_jobs job ON job.threads_post_id = post.id
           AND job.generation = post.sync_generation
         WHERE entry.author_id = author.threads_user_id AND entry.threads_post_id = ?
           AND post.sync_generation = ? AND post.status <> 'deleting'
       )`,
  ).bind(row.author_id, row.upload_lease, row.upload_started_at, row.pending_r2_key,
    message.postId, message.generation).first();
  return d1NonnegativeInteger(exactRow(value, ["count"]).count) === 1;
}

/** @param {any} db @param {Record<string, any>} message @param {Record<string, any>} row
 * @param {number} now @param {string} recoveryLease */
export async function claimEntryUploadRecovery(db, message, row, now, recoveryLease) {
  if (row.upload_lease === null || row.pending_r2_key === null ||
    row.upload_recovering !== 0) return false;
  uploadLease(recoveryLease);
  if (recoveryLease === row.upload_lease) return false;
  const cutoff = now - UPLOAD_STALE_SECONDS;
  if (row.upload_started_at > cutoff) return false;
  const changes = mutationChanges(await db.prepare(
    `UPDATE threads_media SET upload_lease = ?, upload_started_at = ?,
       upload_recovering = 1, updated_at = ?
     WHERE id = ? AND entry_id = ? AND upload_lease = ? AND upload_started_at = ?
       AND pending_r2_key = ? AND upload_started_at <= ?
       AND upload_recovering = 0 AND status IN ('pending','error') AND EXISTS (
         SELECT 1 FROM threads_entries entry JOIN threads_posts post
           ON post.id = entry.threads_post_id
         JOIN threads_sync_jobs job ON job.threads_post_id = post.id
           AND job.generation = post.sync_generation
         WHERE entry.id = threads_media.entry_id AND entry.threads_post_id = ?
           AND post.sync_generation = ? AND post.status <> 'deleting'
       )`,
  ).bind(recoveryLease, now, now, row.media_id, row.entry_id, row.upload_lease,
    row.upload_started_at, row.pending_r2_key, cutoff,
    message.postId, message.generation).run());
  if (changes > 1) throw new AppError("storage_unavailable", 503);
  return changes === 1;
}

/** @param {any} db @param {Record<string, any>} message @param {Record<string, any>} row
 * @param {number} now */
export async function finishEntryUploadRecovery(db, message, row, now) {
  if (row.upload_recovering !== 1 || row.upload_lease === null ||
    row.upload_started_at === null || row.pending_r2_key === null)
    throw new AppError("storage_unavailable", 503);
  const changes = mutationChanges(await db.prepare(
    `UPDATE threads_media SET upload_lease = NULL, upload_started_at = NULL,
       pending_r2_key = NULL, upload_recovering = 0, status = 'pending', updated_at = ?
     WHERE id = ? AND entry_id = ? AND status IN ('pending','error')
       AND upload_lease = ? AND upload_started_at = ? AND pending_r2_key = ?
       AND upload_recovering = 1
       AND EXISTS (
         SELECT 1 FROM threads_entries entry JOIN threads_posts post
           ON post.id = entry.threads_post_id
         JOIN threads_sync_jobs job ON job.threads_post_id = post.id
           AND job.generation = post.sync_generation
         WHERE entry.id = threads_media.entry_id AND entry.threads_post_id = ?
           AND post.sync_generation = ? AND post.status <> 'deleting'
       )`,
  ).bind(now, row.media_id, row.entry_id, row.upload_lease,
    row.upload_started_at, row.pending_r2_key, message.postId,
    message.generation).run());
  if (changes > 1) throw new AppError("storage_unavailable", 503);
  return changes === 1;
}

/** @param {any} db @param {Record<string, any>} message @param {Record<string, any>} row
 * @param {number} now @param {string} recoveryLease */
export async function claimProfileUploadRecovery(db, message, row, now, recoveryLease) {
  if (row.upload_lease === null || row.pending_r2_key === null ||
    row.upload_recovering !== 0) return false;
  uploadLease(recoveryLease);
  if (recoveryLease === row.upload_lease) return false;
  const cutoff = now - UPLOAD_STALE_SECONDS;
  if (row.upload_started_at > cutoff) return false;
  const changes = mutationChanges(await db.prepare(
    `UPDATE threads_authors SET profile_upload_lease = ?,
       profile_upload_started_at = ?, profile_upload_recovering = 1, updated_at = ?
     WHERE threads_user_id = ? AND profile_media_status IN ('pending','error')
       AND profile_upload_lease = ? AND profile_upload_started_at = ?
       AND profile_pending_r2_key = ? AND profile_upload_started_at <= ?
       AND profile_upload_recovering = 0 AND profile_cleanup_lease IS NULL
       AND EXISTS (
         SELECT 1 FROM threads_entries entry JOIN threads_posts post
           ON post.id = entry.threads_post_id
         JOIN threads_sync_jobs job ON job.threads_post_id = post.id
           AND job.generation = post.sync_generation
         WHERE entry.author_id = threads_authors.threads_user_id
           AND entry.threads_post_id = ? AND post.sync_generation = ?
           AND post.status <> 'deleting'
       )`,
  ).bind(recoveryLease, now, now, row.author_id, row.upload_lease,
    row.upload_started_at, row.pending_r2_key, cutoff,
    message.postId, message.generation).run());
  if (changes > 1) throw new AppError("storage_unavailable", 503);
  return changes === 1;
}

/** @param {any} db @param {Record<string, any>} message @param {Record<string, any>} row
 * @param {number} now */
export async function finishProfileUploadRecovery(db, message, row, now) {
  if (row.upload_recovering !== 1 || row.upload_lease === null ||
    row.upload_started_at === null || row.pending_r2_key === null)
    throw new AppError("storage_unavailable", 503);
  const changes = mutationChanges(await db.prepare(
    `UPDATE threads_authors SET profile_upload_lease = NULL,
       profile_upload_started_at = NULL, profile_pending_r2_key = NULL,
       profile_upload_recovering = 0, profile_media_status = 'pending', updated_at = ?
     WHERE threads_user_id = ? AND profile_media_status IN ('pending','error')
       AND profile_upload_lease = ? AND profile_upload_started_at = ?
       AND profile_pending_r2_key = ? AND profile_upload_recovering = 1
       AND profile_cleanup_lease IS NULL AND EXISTS (
         SELECT 1 FROM threads_entries entry JOIN threads_posts post
           ON post.id = entry.threads_post_id
         JOIN threads_sync_jobs job ON job.threads_post_id = post.id
           AND job.generation = post.sync_generation
         WHERE entry.author_id = threads_authors.threads_user_id
           AND entry.threads_post_id = ? AND post.sync_generation = ?
           AND post.status <> 'deleting'
       )`,
  ).bind(now, row.author_id, row.upload_lease, row.upload_started_at,
    row.pending_r2_key, message.postId, message.generation).run());
  if (changes > 1) throw new AppError("storage_unavailable", 503);
  return changes === 1;
}

/** @param {any} bucket @param {string} key */
export async function deleteUncommittedUpload(bucket, key) {
  try { await bucket.delete(key); }
  catch { throw new AppError("media_storage_unavailable", 503); }
}

/** @param {Record<string, any>} message @param {any} dependencies
 * @param {Record<string, any> | null} [recoveredRow] */
export async function terminalizeEntryDeadLetter(message, dependencies,
  recoveredRow = null) {
  const row = recoveredRow ?? await readEntryMedia(dependencies.db, message);
  if (!row || row.status === "ready") return;
  const now = inputTimestamp(dependencies.nowSeconds);
  const recovering = recoveredRow === null ? 0 : 1;
  if (recoveredRow === null && row.upload_lease !== null)
    throw new AppError("media_upload_in_progress", 503);
  if (recoveredRow !== null && (row.upload_recovering !== 1 ||
    row.upload_lease === null || row.upload_started_at === null ||
    row.pending_r2_key === null)) throw new AppError("storage_unavailable", 503);
  const entry = message.type === "retry-media" ? null : message.entryId;
  const changes = mutationChanges(await dependencies.db.prepare(
    `UPDATE threads_media SET status = 'error',
       error_code = 'media_retries_exhausted', upload_lease = NULL,
       upload_started_at = NULL, pending_r2_key = NULL, upload_recovering = 0,
       updated_at = ?
     WHERE id = ? AND entry_id = ? AND status IN ('pending','error')
       AND ((? = 0 AND upload_recovering = 0 AND upload_lease IS NULL
           AND upload_started_at IS NULL AND pending_r2_key IS NULL)
         OR (? = 1 AND upload_recovering = 1 AND upload_lease = ?
           AND upload_started_at = ? AND pending_r2_key = ?))
       AND (? IS NULL OR entry_id = ?) AND EXISTS (
         SELECT 1 FROM threads_entries entry JOIN threads_posts post
           ON post.id = entry.threads_post_id
         JOIN threads_sync_jobs job ON job.threads_post_id = post.id
           AND job.generation = post.sync_generation
         WHERE entry.id = threads_media.entry_id AND entry.threads_post_id = ?
           AND post.sync_generation = ? AND post.status <> 'deleting'
       )`,
  ).bind(now, row.media_id, row.entry_id, recovering, recovering,
    row.upload_lease, row.upload_started_at, row.pending_r2_key, entry, entry,
    message.postId, message.generation).run());
  if (changes > 1) throw new AppError("storage_unavailable", 503);
  if (changes === 1) await recalculateMediaStatus(dependencies, message);
}

/** @param {Record<string, any>} message @param {any} dependencies
 * @param {Record<string, any> | null} [recoveredRow] */
export async function terminalizeProfileDeadLetter(message, dependencies,
  recoveredRow = null) {
  const row = recoveredRow ?? await readProfileMedia(dependencies.db, message);
  if (!row || row.status === "ready" || row.status === "deleting") return;
  const now = inputTimestamp(dependencies.nowSeconds);
  const recovering = recoveredRow === null ? 0 : 1;
  if (recoveredRow === null && row.upload_lease !== null)
    throw new AppError("media_upload_in_progress", 503);
  if (recoveredRow !== null && (row.upload_recovering !== 1 ||
    row.upload_lease === null || row.upload_started_at === null ||
    row.pending_r2_key === null)) throw new AppError("storage_unavailable", 503);
  const changes = mutationChanges(await dependencies.db.prepare(
    `UPDATE threads_authors SET profile_media_status = 'error',
       profile_error_code = 'media_retries_exhausted', profile_upload_lease = NULL,
       profile_upload_started_at = NULL, profile_pending_r2_key = NULL,
       profile_upload_recovering = 0, updated_at = ?
     WHERE threads_user_id = ? AND profile_media_status IN ('pending','error')
       AND ((? = 0 AND profile_upload_recovering = 0
           AND profile_upload_lease IS NULL AND profile_upload_started_at IS NULL
           AND profile_pending_r2_key IS NULL)
         OR (? = 1 AND profile_upload_recovering = 1
           AND profile_upload_lease = ? AND profile_upload_started_at = ?
           AND profile_pending_r2_key = ?))
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
  ).bind(now, row.author_id, recovering, recovering,
    row.upload_lease, row.upload_started_at, row.pending_r2_key,
    message.postId, message.generation).run());
  if (changes > 1) throw new AppError("storage_unavailable", 503);
  if (changes === 1) await recalculateMediaStatus(dependencies, message);
}
