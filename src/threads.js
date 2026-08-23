import { AppError } from "./domain.js";
import {
  extractThreadsLinks, normalizeThreadsUrl, validateCaptureMessage, validateMediaMessage,
} from "./threads-domain.js";

const POST_STATUSES = new Set(["pending", "collecting", "ready", "partial", "error", "deleting"]);
const JOB_STATUSES = new Set([
  "queued", "resolving", "collecting", "media_pending", "ready", "partial", "error",
]);
const ACTIVE_JOBS = new Set(["queued", "resolving", "collecting", "media_pending"]);
const MEDIA_TYPES = new Set(["TEXT_POST", "IMAGE", "VIDEO", "CAROUSEL_ALBUM", "REPOST_FACADE"]);
const MEDIA_KINDS = new Set(["image", "video", "video_thumbnail"]);

/** @returns {never} */
function invalidStorage() { throw new AppError("storage_unavailable", 503); }
/** @param {unknown} error */
function storageError(error) {
  return error instanceof AppError ? error : new AppError("storage_unavailable", 503);
}
/** @param {unknown} value */
function nonnegativeInteger(value) {
  if (!Number.isInteger(value) || /** @type {number} */ (value) < 0) invalidStorage();
  return /** @type {number} */ (value);
}
/** @param {unknown} value */
function positiveInteger(value) {
  if (!Number.isSafeInteger(value) || /** @type {number} */ (value) < 1)
    throw new AppError("invalid_threads_state", 400);
  return /** @type {number} */ (value);
}
/** @param {unknown} value */
function timestamp(value) {
  if (!Number.isSafeInteger(value) || /** @type {number} */ (value) < 0)
    throw new AppError("invalid_threads_state", 400);
  return /** @type {number} */ (value);
}
/** @param {unknown} value @param {string[]} keys */
function exactRow(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key))) invalidStorage();
  return /** @type {Record<string, any>} */ (value);
}
/** @param {unknown} value @param {string[]} keys */
function selectRows(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    /** @type {any} */ (value).success !== true || !Array.isArray(/** @type {any} */ (value).results))
    invalidStorage();
  return /** @type {any[]} */ (/** @type {any} */ (value).results).map((row) => exactRow(row, keys));
}
/** @param {unknown} value */
function mutationChanges(value) {
  const changes = /** @type {any} */ (value)?.meta?.changes;
  if (/** @type {any} */ (value)?.success !== true || !Number.isInteger(changes) || changes < 0)
    invalidStorage();
  return changes;
}
/** @param {unknown} value @param {number} expected */
function mutationBatch(value, expected) {
  if (!Array.isArray(value) || value.length !== expected) invalidStorage();
  return value.map(mutationChanges);
}
/** @param {unknown} value */
function requiredString(value) {
  if (typeof value !== "string" || !value) throw new AppError("invalid_threads_state", 400);
  return value.normalize("NFC");
}
/** @param {unknown} value */
function nullableString(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new AppError("invalid_threads_state", 400);
  return value.normalize("NFC");
}
/** @param {unknown} value */
function providerMedia(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AppError("threads_provider_protocol_error", 502);
  const media = /** @type {Record<string, any>} */ (value);
  if (typeof media.id !== "string" || !media.id || typeof media.ownerId !== "string" ||
    !media.ownerId || typeof media.username !== "string" || typeof media.text !== "string" ||
    typeof media.permalink !== "string" || typeof media.timestamp !== "string" ||
    !MEDIA_TYPES.has(media.mediaType) || !Array.isArray(media.children))
    throw new AppError("threads_provider_protocol_error", 502);
  return media;
}
/** @param {unknown} value */
function providerProfile(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AppError("threads_provider_protocol_error", 502);
  const profile = /** @type {Record<string, any>} */ (value);
  if (typeof profile.id !== "string" || !profile.id || typeof profile.username !== "string" ||
    !profile.username || !(profile.name === null || typeof profile.name === "string") ||
    !(profile.profilePictureUrl === null || typeof profile.profilePictureUrl === "string"))
    throw new AppError("threads_provider_protocol_error", 502);
  return profile;
}

const SYNC_ROW_KEYS = [
  "id", "status", "error_code", "sync_generation", "job_status", "job_error_code",
];
/** @param {any} row */
function validateSyncRow(row) {
  if (row === null) return null;
  row = exactRow(row, SYNC_ROW_KEYS);
  if (typeof row.id !== "string" || !row.id || !POST_STATUSES.has(row.status) ||
    !Number.isInteger(row.sync_generation) || row.sync_generation < 1 ||
    !(row.error_code === null || typeof row.error_code === "string") ||
    !(row.job_status === null || JOB_STATUSES.has(row.job_status)) ||
    !(row.job_error_code === null || typeof row.job_error_code === "string")) invalidStorage();
  return row;
}
/** @param {any} db @param {string} shortcode */
async function loadSyncRow(db, shortcode) {
  return validateSyncRow(await db.prepare(
    `SELECT p.id, p.status, p.error_code, p.sync_generation,
       j.status AS job_status, j.error_code AS job_error_code
     FROM threads_posts p
     LEFT JOIN threads_sync_jobs j
       ON j.threads_post_id = p.id AND j.generation = p.sync_generation
     WHERE p.shortcode = ?`,
  ).bind(shortcode).first());
}
/** @param {any} db @param {string} postId @param {number} generation @param {number} nowSeconds */
async function recordQueueFailure(db, postId, generation, nowSeconds) {
  const changes = mutationBatch(await db.batch([
    db.prepare(
      `UPDATE threads_sync_jobs SET status = 'error', error_code = 'queue_unavailable',
         completed_at = ?, updated_at = ?
       WHERE threads_post_id = ? AND generation = ?`,
    ).bind(nowSeconds, nowSeconds, postId, generation),
    db.prepare(
      `UPDATE threads_posts SET
         status = CASE WHEN EXISTS (
           SELECT 1 FROM threads_entries WHERE threads_post_id = ? AND kind = 'root'
         ) THEN 'partial' ELSE 'error' END,
         error_code = 'queue_unavailable', updated_at = ?
       WHERE id = ? AND sync_generation = ?`,
    ).bind(postId, nowSeconds, postId, generation),
  ]), 2);
  if (changes.some((count) => count > 1) || changes[0] !== changes[1]) invalidStorage();
}
/** @param {any} queue @param {Record<string, unknown>} message */
async function sendCapture(queue, message) {
  validateCaptureMessage(message);
  if (!queue || typeof queue.send !== "function") throw new AppError("queue_unavailable", 503);
  try { await queue.send(message); }
  catch { throw new AppError("queue_unavailable", 503); }
}
/** @param {any} queue @param {Record<string, unknown>} message */
async function sendMedia(queue, message) {
  validateMediaMessage(message);
  if (!queue || typeof queue.send !== "function") throw new AppError("queue_unavailable", 503);
  try { await queue.send(message); return true; }
  catch { return false; }
}

/** @param {any} db @param {any} captureQueue @param {unknown} rawUrl @param {number} nowSeconds */
export async function createThreadsSync(db, captureQueue, rawUrl, nowSeconds) {
  const normalized = normalizeThreadsUrl(rawUrl);
  const now = timestamp(nowSeconds);
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await loadSyncRow(db, normalized.shortcode);
      let postId;
      let generation;
      if (!current) {
        postId = crypto.randomUUID();
        generation = 1;
        const jobId = crypto.randomUUID();
        const changes = mutationBatch(await db.batch([
          db.prepare(
            `INSERT INTO threads_posts
               (id, shortcode, submitted_url, canonical_url, status, sync_generation,
                created_at, updated_at)
             VALUES (?, ?, ?, ?, 'pending', 1, ?, ?)
             ON CONFLICT(shortcode) DO NOTHING`,
          ).bind(postId, normalized.shortcode, normalized.submittedUrl,
            normalized.canonicalUrl, now, now),
          db.prepare(
            `INSERT INTO threads_sync_jobs
               (id, threads_post_id, generation, status, queued_at, updated_at)
             SELECT ?, ?, 1, 'queued', ?, ?
             WHERE EXISTS (SELECT 1 FROM threads_posts WHERE id = ?)`,
          ).bind(jobId, postId, now, now, postId),
        ]), 2);
        if (changes.some((count) => count > 1) || changes[0] !== changes[1]) invalidStorage();
        if (changes[0] === 0) continue;
      } else {
        postId = current.id;
        generation = current.sync_generation;
        if (current.status === "deleting") throw new AppError("threads_archive_deleting", 409);
        if (current.job_status && ACTIVE_JOBS.has(current.job_status)) {
          return { threadsPostId: postId, generation, duplicate: true, status: current.status };
        }
        const next = generation + 1;
        if (!Number.isSafeInteger(next)) invalidStorage();
        const changes = mutationBatch(await db.batch([
          db.prepare(
            `UPDATE threads_posts
             SET sync_generation = ?, status = 'pending', error_code = NULL, updated_at = ?
             WHERE id = ? AND sync_generation = ? AND status <> 'deleting'
               AND NOT EXISTS (
                 SELECT 1 FROM threads_sync_jobs
                 WHERE threads_post_id = ? AND generation = ?
                   AND status IN ('queued','resolving','collecting','media_pending')
               )`,
          ).bind(next, now, postId, generation, postId, generation),
          db.prepare(
            `INSERT INTO threads_sync_jobs
               (id, threads_post_id, generation, status, queued_at, updated_at)
             SELECT ?, ?, ?, 'queued', ?, ?
             WHERE EXISTS (
               SELECT 1 FROM threads_posts WHERE id = ? AND sync_generation = ?
             )`,
          ).bind(crypto.randomUUID(), postId, next, now, now, postId, next),
        ]), 2);
        if (changes.some((count) => count > 1) || changes[0] !== changes[1]) invalidStorage();
        if (changes[0] === 0) continue;
        generation = next;
      }
      const message = {
        version: 1, type: "resolve-post", postId, generation, cursor: null,
      };
      try { await sendCapture(captureQueue, message); }
      catch (error) {
        await recordQueueFailure(db, postId, generation, now);
        throw error;
      }
      return { threadsPostId: postId, generation, duplicate: false, status: "pending" };
    }
    invalidStorage();
  } catch (error) { throw storageError(error); }
}

const JOB_ROW_KEYS = [
  "post_id", "generation", "status", "profile_cursor", "conversation_cursor",
  "pending_quote_count", "expected_entry_count", "expected_media_count",
  "ready_media_count", "failed_media_count", "error_code", "root_author_id",
  "threads_media_id", "canonical_url",
];
/** @param {any} row */
function mapJobRow(row) {
  if (row === null) return null;
  row = exactRow(row, JOB_ROW_KEYS);
  if (typeof row.post_id !== "string" || !row.post_id || !Number.isInteger(row.generation) ||
    row.generation < 1 || !JOB_STATUSES.has(row.status) ||
    !(row.profile_cursor === null || typeof row.profile_cursor === "string") ||
    !(row.conversation_cursor === null || typeof row.conversation_cursor === "string") ||
    !(row.error_code === null || typeof row.error_code === "string") ||
    !(row.root_author_id === null || typeof row.root_author_id === "string") ||
    !(row.threads_media_id === null || typeof row.threads_media_id === "string") ||
    !(row.canonical_url === null || typeof row.canonical_url === "string")) invalidStorage();
  for (const key of ["pending_quote_count", "expected_entry_count", "expected_media_count",
    "ready_media_count", "failed_media_count"]) nonnegativeInteger(row[key]);
  return {
    postId: row.post_id, generation: row.generation, status: row.status,
    profileCursor: row.profile_cursor, conversationCursor: row.conversation_cursor,
    pendingQuoteCount: row.pending_quote_count, expectedEntryCount: row.expected_entry_count,
    expectedMediaCount: row.expected_media_count, readyMediaCount: row.ready_media_count,
    failedMediaCount: row.failed_media_count, errorCode: row.error_code,
    rootAuthorId: row.root_author_id, threadsMediaId: row.threads_media_id,
    canonicalUrl: row.canonical_url,
  };
}

/** @param {any} db @param {string} postId @param {number} generation @param {string} status */
export async function claimThreadsJob(db, postId, generation, status) {
  requiredString(postId); positiveInteger(generation);
  if (!new Set(["resolving", "collecting"]).has(status))
    throw new AppError("invalid_threads_state", 400);
  try {
    const row = await db.prepare(
      `UPDATE threads_sync_jobs AS j SET
         status = ?, started_at = COALESCE(started_at, unixepoch()), updated_at = unixepoch()
       WHERE threads_post_id = ? AND generation = ?
         AND status IN ('queued','resolving','collecting')
         AND EXISTS (
           SELECT 1 FROM threads_posts p
           WHERE p.id = j.threads_post_id AND p.sync_generation = j.generation
             AND p.status <> 'deleting'
         )
       RETURNING
         threads_post_id AS post_id, generation, status, profile_cursor,
         conversation_cursor, pending_quote_count, expected_entry_count,
         expected_media_count, ready_media_count, failed_media_count, error_code,
         (SELECT root_author_id FROM threads_posts WHERE id = threads_post_id) AS root_author_id,
         (SELECT threads_media_id FROM threads_posts WHERE id = threads_post_id) AS threads_media_id,
         (SELECT canonical_url FROM threads_posts WHERE id = threads_post_id) AS canonical_url`,
    ).bind(status, postId, generation).first();
    return mapJobRow(row);
  } catch (error) { throw storageError(error); }
}

/** @param {any} db @param {Record<string, any>} profile @param {string} postId @param {number} generation @param {number} now */
function authorStatement(db, profile, postId, generation, now) {
  return db.prepare(
    `INSERT INTO threads_authors
       (threads_user_id, username, display_name, created_at, updated_at)
     SELECT ?, ?, ?, ?, ?
     WHERE EXISTS (
       SELECT 1 FROM threads_posts
       WHERE id = ? AND sync_generation = ? AND status <> 'deleting'
     )
     ON CONFLICT(threads_user_id) DO UPDATE SET
       username = excluded.username, display_name = excluded.display_name,
       updated_at = excluded.updated_at`,
  ).bind(profile.id, profile.username, profile.name ?? profile.username, now, now,
    postId, generation);
}
/** @param {any} db @param {Record<string, any>} entry @param {"root"|"author_reply"} kind @param {string} postId @param {number} generation @param {number} now */
function primaryEntryStatement(db, entry, kind, postId, generation, now) {
  return db.prepare(
    `INSERT INTO threads_entries
       (id, threads_post_id, source_media_id, kind, author_id, text, permalink,
        published_at, media_type, alt_text, nested_quote_permalink,
        first_seen_at, last_seen_at, created_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?
     WHERE EXISTS (
       SELECT 1 FROM threads_posts
       WHERE id = ? AND sync_generation = ? AND status <> 'deleting'
     )
     ON CONFLICT(threads_post_id, source_media_id)
       WHERE kind IN ('root','author_reply')
     DO UPDATE SET last_seen_at = excluded.last_seen_at`,
  ).bind(
    crypto.randomUUID(), postId, entry.id, kind, entry.ownerId, entry.text,
    entry.permalink, entry.timestamp, entry.mediaType, entry.altText ?? null,
    now, now, now, postId, generation,
  );
}
/** @param {any} db @param {Record<string, any>} entry @param {string} kind @param {string} postId @param {number} generation @param {number} now @param {string | null} parentId */
function linkStatements(db, entry, kind, postId, generation, now, parentId = null) {
  return extractThreadsLinks(entry.text, entry.linkAttachmentUrl).map((link) => db.prepare(
    `INSERT INTO threads_links (id, entry_id, url, source, ordinal)
     SELECT ?, e.id, ?, ?, ? FROM threads_entries e
     WHERE e.threads_post_id = ? AND e.source_media_id = ? AND e.kind = ?
       AND (? IS NULL OR e.parent_entry_id = ?)
       AND EXISTS (
         SELECT 1 FROM threads_posts
         WHERE id = ? AND sync_generation = ? AND status <> 'deleting'
       )
     ON CONFLICT(entry_id, url) DO NOTHING`,
  ).bind(crypto.randomUUID(), link.url, link.source, link.ordinal,
    postId, entry.id, kind, parentId, parentId, postId, generation));
}

/** @param {any} db @param {{ postId: string, generation: number, profile: unknown, root: unknown, profileCursor?: string | null, conversationCursor?: string | null, nowSeconds: number }} input */
export async function saveResolvedThreadsRoot(db, input) {
  const postId = requiredString(input?.postId);
  const generation = positiveInteger(input?.generation);
  const now = timestamp(input?.nowSeconds);
  const profile = providerProfile(input?.profile);
  const root = providerMedia(input?.root);
  if (profile.id !== root.ownerId) throw new AppError("threads_provider_protocol_error", 502);
  const profileCursor = nullableString(input?.profileCursor);
  const conversationCursor = nullableString(input?.conversationCursor);
  try {
    const duplicate = await db.prepare(
      "SELECT id FROM threads_posts WHERE threads_media_id = ? AND id <> ? ORDER BY created_at, id LIMIT 1",
    ).bind(root.id, postId).first();
    if (duplicate !== null) {
      const owner = exactRow(duplicate, ["id"]);
      if (typeof owner.id !== "string" || !owner.id) invalidStorage();
      await markThreadsJobError(db, {
        postId, generation, errorCode: "threads_archive_duplicate", nowSeconds: now,
      });
      return false;
    }
    const statements = [
      authorStatement(db, profile, postId, generation, now),
      db.prepare(
        `UPDATE threads_posts SET
           threads_media_id = ?, canonical_url = ?, root_author_id = ?,
           status = 'collecting', error_code = NULL, updated_at = ?
         WHERE id = ? AND sync_generation = ? AND status <> 'deleting'
           AND (threads_media_id IS NULL OR threads_media_id = ?)
           AND NOT EXISTS (
             SELECT 1 FROM threads_posts other
             WHERE other.threads_media_id = ? AND other.id <> ?
           )`,
      ).bind(root.id, root.permalink, profile.id, now, postId, generation,
        root.id, root.id, postId),
      db.prepare(
        `UPDATE threads_sync_jobs SET
           status = 'collecting', profile_cursor = ?, conversation_cursor = ?,
           pending_quote_count = pending_quote_count + CASE WHEN ? IS NOT NULL AND NOT EXISTS (
             SELECT 1 FROM threads_entries
             WHERE threads_post_id = ? AND source_media_id = ? AND kind = 'root'
           ) THEN 1 ELSE 0 END,
           updated_at = ?
         WHERE threads_post_id = ? AND generation = ?
           AND EXISTS (
             SELECT 1 FROM threads_posts
             WHERE id = ? AND sync_generation = ? AND status <> 'deleting'
               AND threads_media_id = ?
           )`,
      ).bind(profileCursor, conversationCursor, root.quotedPostId ?? null, postId, root.id,
        now, postId, generation,
        postId, generation, root.id),
      primaryEntryStatement(db, root, "root", postId, generation, now),
      ...linkStatements(db, root, "root", postId, generation, now),
    ];
    const changes = mutationBatch(await db.batch(statements), statements.length);
    if (changes.some((count) => count > 1)) invalidStorage();
    return changes[1] === 1 && changes[2] === 1 && changes[3] === 1;
  } catch (error) { throw storageError(error); }
}

/** @param {any} db @param {{ postId: string, generation: number, entries: unknown[], nextCursor?: string | null, nowSeconds: number }} input */
export async function saveThreadsConversationPage(db, input) {
  const postId = requiredString(input?.postId);
  const generation = positiveInteger(input?.generation);
  const now = timestamp(input?.nowSeconds);
  if (!Array.isArray(input?.entries)) throw new AppError("invalid_threads_state", 400);
  const entries = input.entries.map(providerMedia);
  const nextCursor = nullableString(input?.nextCursor);
  try {
    const post = await db.prepare(
      "SELECT root_author_id FROM threads_posts WHERE id = ? AND sync_generation = ? AND status <> 'deleting'",
    ).bind(postId, generation).first();
    if (post === null) return { accepted: 0, nextCursor };
    const root = exactRow(post, ["root_author_id"]);
    if (typeof root.root_author_id !== "string" || !root.root_author_id) invalidStorage();
    const accepted = entries.filter((entry) => entry.ownerId === root.root_author_id);
    const statements = [];
    for (const entry of accepted) {
      if (entry.quotedPostId) {
        statements.push(db.prepare(
          `UPDATE threads_sync_jobs SET pending_quote_count = pending_quote_count + 1,
             updated_at = ?
           WHERE threads_post_id = ? AND generation = ?
             AND NOT EXISTS (
               SELECT 1 FROM threads_entries
               WHERE threads_post_id = ? AND source_media_id = ?
                 AND kind IN ('root','author_reply')
             )`,
        ).bind(now, postId, generation, postId, entry.id));
      }
      statements.push(primaryEntryStatement(db, entry, "author_reply", postId, generation, now));
      statements.push(...linkStatements(db, entry, "author_reply", postId, generation, now));
    }
    statements.push(db.prepare(
      `UPDATE threads_sync_jobs SET status = 'collecting', conversation_cursor = ?, updated_at = ?
       WHERE threads_post_id = ? AND generation = ?
         AND EXISTS (
           SELECT 1 FROM threads_posts
           WHERE id = ? AND sync_generation = ? AND status <> 'deleting'
         )`,
    ).bind(nextCursor, now, postId, generation, postId, generation));
    const changes = mutationBatch(await db.batch(statements), statements.length);
    if (changes.some((count) => count > 1)) invalidStorage();
    const cursorChanged = changes.at(-1) === 1;
    return { accepted: cursorChanged ? accepted.length : 0, nextCursor };
  } catch (error) { throw storageError(error); }
}

/** @param {any} db @param {{ postId: string, generation: number, parentEntryId: string, profile: unknown, quote: unknown, nowSeconds: number }} input */
export async function saveThreadsQuote(db, input) {
  const postId = requiredString(input?.postId);
  const parentId = requiredString(input?.parentEntryId);
  const generation = positiveInteger(input?.generation);
  const now = timestamp(input?.nowSeconds);
  const profile = providerProfile(input?.profile);
  const quote = providerMedia(input?.quote);
  if (profile.id !== quote.ownerId) throw new AppError("threads_provider_protocol_error", 502);
  try {
    const statements = [
      db.prepare(
        `UPDATE threads_sync_jobs SET
           pending_quote_count = CASE WHEN pending_quote_count > 0
             THEN pending_quote_count - 1 ELSE 0 END,
           updated_at = ?
         WHERE threads_post_id = ? AND generation = ?
           AND NOT EXISTS (
             SELECT 1 FROM threads_entries
             WHERE threads_post_id = ? AND parent_entry_id = ?
               AND source_media_id = ? AND kind = 'quote'
           )
           AND EXISTS (
             SELECT 1 FROM threads_entries
             WHERE id = ? AND threads_post_id = ? AND kind IN ('root','author_reply')
           )
           AND EXISTS (
             SELECT 1 FROM threads_posts
             WHERE id = ? AND sync_generation = ? AND status <> 'deleting'
           )`,
      ).bind(now, postId, generation, postId, parentId, quote.id,
        parentId, postId, postId, generation),
      authorStatement(db, profile, postId, generation, now),
      db.prepare(
        `INSERT INTO threads_entries
           (id, threads_post_id, source_media_id, kind, parent_entry_id,
            source_parent_media_id, author_id, text, permalink, published_at,
            media_type, alt_text, nested_quote_permalink,
            first_seen_at, last_seen_at, created_at)
         SELECT ?, ?, ?, 'quote', ?, parent.source_media_id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         FROM threads_entries parent
         WHERE parent.id = ? AND parent.threads_post_id = ?
           AND parent.kind IN ('root','author_reply')
           AND EXISTS (
             SELECT 1 FROM threads_posts
             WHERE id = ? AND sync_generation = ? AND status <> 'deleting'
           )
         ON CONFLICT(threads_post_id, parent_entry_id, source_media_id)
           WHERE kind = 'quote'
         DO UPDATE SET last_seen_at = excluded.last_seen_at`,
      ).bind(
        crypto.randomUUID(), postId, quote.id, parentId, quote.ownerId, quote.text,
        quote.permalink, quote.timestamp, quote.mediaType, quote.altText ?? null,
        quote.nestedQuotePermalink ?? null, now, now, now,
        parentId, postId, postId, generation,
      ),
      ...linkStatements(db, quote, "quote", postId, generation, now, parentId),
    ];
    const changes = mutationBatch(await db.batch(statements), statements.length);
    if (changes.some((count) => count > 1)) invalidStorage();
    return changes[2] === 1;
  } catch (error) { throw storageError(error); }
}

const POST_READ_KEYS = [
  "id", "canonical_url", "status", "error_code", "root_author_id", "author_username",
  "author_display_name", "profile_media_status", "profile_r2_key", "profile_content_type",
  "profile_etag", "profile_bytes", "profile_error_code", "reply_count", "sync_generation",
  "expected_entry_count", "expected_media_count", "ready_media_count", "failed_media_count",
  "created_at", "updated_at",
];
/** @param {any} row */
function validatePostRead(row) {
  row = exactRow(row, POST_READ_KEYS);
  if (typeof row.id !== "string" || !row.id || !POST_STATUSES.has(row.status) ||
    !(row.canonical_url === null || typeof row.canonical_url === "string") ||
    !(row.error_code === null || typeof row.error_code === "string") ||
    !(row.root_author_id === null || typeof row.root_author_id === "string") ||
    !(row.author_username === null || typeof row.author_username === "string") ||
    !(row.author_display_name === null || typeof row.author_display_name === "string") ||
    !(row.profile_media_status === null || ["pending", "ready", "error"].includes(row.profile_media_status)) ||
    !(row.profile_r2_key === null || typeof row.profile_r2_key === "string") ||
    !(row.profile_content_type === null || typeof row.profile_content_type === "string") ||
    !(row.profile_etag === null || typeof row.profile_etag === "string") ||
    !(row.profile_bytes === null || Number.isInteger(row.profile_bytes) && row.profile_bytes >= 0) ||
    !(row.profile_error_code === null || typeof row.profile_error_code === "string")) invalidStorage();
  for (const key of ["reply_count", "sync_generation", "expected_entry_count",
    "expected_media_count", "ready_media_count", "failed_media_count", "created_at", "updated_at"])
    nonnegativeInteger(row[key]);
  if (row.sync_generation < 1) invalidStorage();
  return row;
}
const POST_SELECT = `
  p.id, p.canonical_url, p.status, p.error_code, p.root_author_id,
  a.username AS author_username, a.display_name AS author_display_name,
  a.profile_media_status, a.profile_r2_key, a.profile_content_type,
  a.profile_etag, a.profile_bytes, a.profile_error_code,
  (SELECT COUNT(*) FROM threads_entries replies
   WHERE replies.threads_post_id = p.id AND replies.kind = 'author_reply') AS reply_count,
  p.sync_generation,
  COALESCE(j.expected_entry_count, 0) AS expected_entry_count,
  COALESCE(j.expected_media_count, 0) AS expected_media_count,
  COALESCE(j.ready_media_count, 0) AS ready_media_count,
  COALESCE(j.failed_media_count, 0) AS failed_media_count,
  p.created_at, p.updated_at`;
const ENTRY_KEYS = [
  "id", "threads_post_id", "source_media_id", "kind", "parent_entry_id", "author_id",
  "text", "permalink", "published_at", "media_type", "alt_text",
  "nested_quote_permalink", "username", "display_name", "profile_media_status",
  "profile_r2_key", "profile_content_type", "profile_etag", "profile_bytes",
  "profile_error_code",
];
const ENTRY_SELECT = `
  e.id, e.threads_post_id, e.source_media_id, e.kind, e.parent_entry_id, e.author_id,
  e.text, e.permalink, e.published_at, e.media_type, e.alt_text,
  e.nested_quote_permalink, a.username, a.display_name, a.profile_media_status,
  a.profile_r2_key, a.profile_content_type, a.profile_etag, a.profile_bytes,
  a.profile_error_code`;
/** @param {any} db @param {any[]} rows */
async function mapEntryRows(db, rows) {
  const ids = rows.map((row) => row.id);
  const linksByEntry = new Map();
  const mediaByEntry = new Map();
  if (ids.length) {
    const marks = ids.map(() => "?").join(",");
    const [linksResult, mediaResult] = await Promise.all([
      db.prepare(
        `SELECT entry_id, url, source, ordinal FROM threads_links
         WHERE entry_id IN (${marks}) ORDER BY entry_id, ordinal, url`,
      ).bind(...ids).all(),
      db.prepare(
        `SELECT id, entry_id, source_media_id, kind, ordinal, alt_text, status,
           r2_key, content_type, bytes, etag, error_code
         FROM threads_media WHERE entry_id IN (${marks})
         ORDER BY entry_id, ordinal, kind, id`,
      ).bind(...ids).all(),
    ]);
    for (const link of selectRows(linksResult, ["entry_id", "url", "source", "ordinal"])) {
      if (typeof link.entry_id !== "string" || typeof link.url !== "string" ||
        !["body", "attachment"].includes(link.source)) invalidStorage();
      nonnegativeInteger(link.ordinal);
      if (!linksByEntry.has(link.entry_id)) linksByEntry.set(link.entry_id, []);
      linksByEntry.get(link.entry_id).push({ url: link.url, source: link.source, ordinal: link.ordinal });
    }
    for (const item of selectRows(mediaResult, [
      "id", "entry_id", "source_media_id", "kind", "ordinal", "alt_text", "status",
      "r2_key", "content_type", "bytes", "etag", "error_code",
    ])) {
      if (typeof item.id !== "string" || typeof item.entry_id !== "string" ||
        typeof item.source_media_id !== "string" || !MEDIA_KINDS.has(item.kind) ||
        !["pending", "ready", "error"].includes(item.status) ||
        !(item.alt_text === null || typeof item.alt_text === "string") ||
        !(item.r2_key === null || typeof item.r2_key === "string") ||
        !(item.content_type === null || typeof item.content_type === "string") ||
        !(item.bytes === null || Number.isInteger(item.bytes) && item.bytes >= 0) ||
        !(item.etag === null || typeof item.etag === "string") ||
        !(item.error_code === null || typeof item.error_code === "string")) invalidStorage();
      nonnegativeInteger(item.ordinal);
      if (!mediaByEntry.has(item.entry_id)) mediaByEntry.set(item.entry_id, []);
      mediaByEntry.get(item.entry_id).push({
        id: item.id, sourceMediaId: item.source_media_id, kind: item.kind,
        ordinal: item.ordinal, altText: item.alt_text, status: item.status,
        contentType: item.content_type, bytes: item.bytes,
        etag: item.etag, errorCode: item.error_code,
      });
    }
  }
  const mapped = new Map();
  for (let row of rows) {
    row = exactRow(row, ENTRY_KEYS);
    if (typeof row.id !== "string" || !row.id || typeof row.threads_post_id !== "string" ||
      typeof row.source_media_id !== "string" || !["root", "author_reply", "quote"].includes(row.kind) ||
      !(row.parent_entry_id === null || typeof row.parent_entry_id === "string") ||
      typeof row.author_id !== "string" || typeof row.text !== "string" ||
      !(row.permalink === null || typeof row.permalink === "string") ||
      typeof row.published_at !== "string" || !MEDIA_TYPES.has(row.media_type) ||
      !(row.alt_text === null || typeof row.alt_text === "string") ||
      !(row.nested_quote_permalink === null || typeof row.nested_quote_permalink === "string") ||
      typeof row.username !== "string" || typeof row.display_name !== "string" ||
      !["pending", "ready", "error"].includes(row.profile_media_status) ||
      !(row.profile_r2_key === null || typeof row.profile_r2_key === "string") ||
      !(row.profile_content_type === null || typeof row.profile_content_type === "string") ||
      !(row.profile_etag === null || typeof row.profile_etag === "string") ||
      !(row.profile_bytes === null || Number.isInteger(row.profile_bytes) && row.profile_bytes >= 0) ||
      !(row.profile_error_code === null || typeof row.profile_error_code === "string") ||
      Number.isNaN(Date.parse(row.published_at))) invalidStorage();
    const author = {
      id: row.author_id, username: row.username, displayName: row.display_name,
      profileMedia: {
        status: row.profile_media_status,
        contentType: row.profile_content_type, etag: row.profile_etag,
        bytes: row.profile_bytes, errorCode: row.profile_error_code,
      },
    };
    mapped.set(row.id, {
      id: row.id, sourceMediaId: row.source_media_id, kind: row.kind,
      parentEntryId: row.parent_entry_id, author, text: row.text,
      permalink: row.permalink, publishedAt: row.published_at,
      mediaType: row.media_type, altText: row.alt_text,
      nestedQuotePermalink: row.nested_quote_permalink,
      links: linksByEntry.get(row.id) ?? [], media: mediaByEntry.get(row.id) ?? [],
      quote: null,
    });
  }
  for (const entry of mapped.values()) {
    if (entry.kind === "quote" && entry.parentEntryId && mapped.has(entry.parentEntryId))
      mapped.get(entry.parentEntryId).quote = entry;
  }
  return mapped;
}
/** @param {any} post @param {Map<string, any>} entries */
function mapArchive(post, entries) {
  const root = [...entries.values()].find((entry) =>
    entry.kind === "root" && entry.parentEntryId === null) ?? null;
  const firstReplies = [...entries.values()].filter((entry) => entry.kind === "author_reply")
    .sort((left, right) => left.publishedAt.localeCompare(right.publishedAt) ||
      left.sourceMediaId.localeCompare(right.sourceMediaId));
  const author = root?.author ?? (post.root_author_id ? {
    id: post.root_author_id, username: post.author_username,
    displayName: post.author_display_name,
    profileMedia: {
      status: post.profile_media_status,
      contentType: post.profile_content_type, etag: post.profile_etag,
      bytes: post.profile_bytes, errorCode: post.profile_error_code,
    },
  } : null);
  return {
    id: post.id, canonicalUrl: post.canonical_url, status: post.status,
    errorCode: post.error_code, author, root, quote: root?.quote ?? null,
    firstReplies, replyCount: post.reply_count,
    mediaProgress: {
      expected: post.expected_media_count, ready: post.ready_media_count,
      failed: post.failed_media_count,
      pending: Math.max(0, post.expected_media_count - post.ready_media_count - post.failed_media_count),
    },
    syncGeneration: post.sync_generation, createdAt: post.created_at, updatedAt: post.updated_at,
  };
}

/** @param {any} db @param {{ page?: number }} options */
export async function listThreadsArchives(db, options = {}) {
  const requested = Number.isSafeInteger(options.page) && /** @type {number} */ (options.page) > 0
    ? /** @type {number} */ (options.page) : 1;
  try {
    const countRow = exactRow(await db.prepare(
      "SELECT COUNT(*) AS count FROM threads_posts",
    ).first(), ["count"]);
    const total = nonnegativeInteger(countRow.count);
    const totalPages = Math.max(1, Math.ceil(total / 10));
    const page = Math.min(requested, totalPages);
    const result = await db.prepare(
      `SELECT ${POST_SELECT}
       FROM threads_posts p
       LEFT JOIN threads_authors a ON a.threads_user_id = p.root_author_id
       LEFT JOIN threads_sync_jobs j
         ON j.threads_post_id = p.id AND j.generation = p.sync_generation
       ORDER BY p.created_at DESC, p.id DESC LIMIT 10 OFFSET ?`,
    ).bind((page - 1) * 10).all();
    const posts = selectRows(result, POST_READ_KEYS).map(validatePostRead);
    const byPost = new Map(posts.map((post) => [post.id, new Map()]));
    if (posts.length) {
      const marks = posts.map(() => "?").join(",");
      const entryResult = await db.prepare(
        `WITH ranked AS (
           SELECT id, ROW_NUMBER() OVER (
             PARTITION BY threads_post_id ORDER BY published_at, source_media_id
           ) AS reply_number
           FROM threads_entries
           WHERE threads_post_id IN (${marks}) AND kind = 'author_reply'
         ), selected AS (
           SELECT id FROM threads_entries
           WHERE threads_post_id IN (${marks}) AND kind = 'root'
           UNION ALL SELECT id FROM ranked WHERE reply_number <= 3
         )
         SELECT ${ENTRY_SELECT}
         FROM threads_entries e
         JOIN threads_authors a ON a.threads_user_id = e.author_id
         WHERE e.id IN (SELECT id FROM selected)
            OR (e.kind = 'quote' AND e.parent_entry_id IN (SELECT id FROM selected))
         ORDER BY e.threads_post_id, e.published_at, e.source_media_id, e.id`,
      ).bind(...posts.map((post) => post.id), ...posts.map((post) => post.id)).all();
      const entries = selectRows(entryResult, ENTRY_KEYS);
      const mapped = await mapEntryRows(db, entries);
      for (const [id, entry] of mapped) {
        const source = entries.find((row) => row.id === id);
        const postEntries = source ? byPost.get(source.threads_post_id) : undefined;
        if (!postEntries) invalidStorage();
        postEntries.set(id, entry);
      }
    }
    return { archives: posts.map((post) => {
      const entries = byPost.get(post.id);
      if (!entries) invalidStorage();
      return mapArchive(post, entries);
    }), page, totalPages, total };
  } catch (error) { throw storageError(error); }
}

/** @param {any} db @param {string} id @param {{ repliesPage?: number }} options */
export async function getThreadsArchive(db, id, options = {}) {
  requiredString(id);
  const requested = Number.isSafeInteger(options.repliesPage) && /** @type {number} */ (options.repliesPage) > 0
    ? /** @type {number} */ (options.repliesPage) : 1;
  try {
    const postRaw = await db.prepare(
      `SELECT ${POST_SELECT}
       FROM threads_posts p
       LEFT JOIN threads_authors a ON a.threads_user_id = p.root_author_id
       LEFT JOIN threads_sync_jobs j
         ON j.threads_post_id = p.id AND j.generation = p.sync_generation
       WHERE p.id = ?`,
    ).bind(id).first();
    if (postRaw === null) return null;
    const post = validatePostRead(postRaw);
    const totalReplies = post.reply_count;
    const totalReplyPages = Math.max(1, Math.ceil(totalReplies / 20));
    const repliesPage = Math.min(requested, totalReplyPages);
    const entryResult = await db.prepare(
      `WITH selected AS (
       SELECT id FROM threads_entries
         WHERE threads_post_id = ? AND kind = 'root'
         UNION ALL
         SELECT id FROM (
           SELECT id FROM threads_entries
           WHERE threads_post_id = ? AND kind = 'author_reply'
           ORDER BY published_at, source_media_id LIMIT 20 OFFSET ?
         )
       )
       SELECT ${ENTRY_SELECT}
       FROM threads_entries e
       JOIN threads_authors a ON a.threads_user_id = e.author_id
       WHERE e.id IN (SELECT id FROM selected)
          OR (e.kind = 'quote' AND e.parent_entry_id IN (SELECT id FROM selected))
       ORDER BY e.published_at, e.source_media_id, e.id`,
    ).bind(id, id, (repliesPage - 1) * 20).all();
    const rows = selectRows(entryResult, ENTRY_KEYS);
    const entries = await mapEntryRows(db, rows);
    const archive = mapArchive(post, entries);
    const replies = [...entries.values()].filter((entry) => entry.kind === "author_reply")
      .sort((left, right) => left.publishedAt.localeCompare(right.publishedAt) ||
        left.sourceMediaId.localeCompare(right.sourceMediaId));
    return { archive, replies, repliesPage, totalReplyPages, totalReplies };
  } catch (error) { throw storageError(error); }
}

/** @param {any} db @param {{ postId: string, generation: number, errorCode: string, nowSeconds: number }} input */
export async function markThreadsJobError(db, input) {
  const postId = requiredString(input?.postId);
  const generation = positiveInteger(input?.generation);
  const errorCode = requiredString(input?.errorCode);
  const now = timestamp(input?.nowSeconds);
  try {
    const changes = mutationBatch(await db.batch([
      db.prepare(
        `UPDATE threads_sync_jobs SET status = 'error', error_code = ?,
           completed_at = ?, updated_at = ?
         WHERE threads_post_id = ? AND generation = ?
           AND EXISTS (
             SELECT 1 FROM threads_posts
             WHERE id = ? AND sync_generation = ? AND status <> 'deleting'
           )`,
      ).bind(errorCode, now, now, postId, generation, postId, generation),
      db.prepare(
        `UPDATE threads_posts SET
           status = CASE WHEN EXISTS (
             SELECT 1 FROM threads_entries
             WHERE threads_post_id = ? AND kind = 'root'
           ) THEN 'partial' ELSE 'error' END,
           error_code = ?, updated_at = ?
         WHERE id = ? AND sync_generation = ? AND status <> 'deleting'`,
      ).bind(postId, errorCode, now, postId, generation),
    ]), 2);
    if (changes.some((count) => count > 1) || changes[0] !== changes[1]) invalidStorage();
    return changes[0] === 1;
  } catch (error) { throw storageError(error); }
}

const AGGREGATE_KEYS = [
  "post_status", "job_status", "error_code", "expected_media_count", "root_count",
  "entry_count", "media_count", "ready_count", "failed_count", "pending_count",
];
/** @param {any} db @param {string} postId @param {number} generation */
async function aggregateRow(db, postId, generation) {
  const row = await db.prepare(
    `SELECT p.status AS post_status, j.status AS job_status, j.error_code,
       j.expected_media_count,
       (SELECT COUNT(*) FROM threads_entries e
        WHERE e.threads_post_id = p.id AND e.kind = 'root') AS root_count,
       (SELECT COUNT(*) FROM threads_entries e
        WHERE e.threads_post_id = p.id) AS entry_count,
       (SELECT COUNT(*) FROM threads_media m JOIN threads_entries e ON e.id = m.entry_id
        WHERE e.threads_post_id = p.id) +
       (SELECT COUNT(DISTINCT e.author_id) FROM threads_entries e
        WHERE e.threads_post_id = p.id) AS media_count,
       (SELECT COUNT(*) FROM threads_media m JOIN threads_entries e ON e.id = m.entry_id
        WHERE e.threads_post_id = p.id AND m.status = 'ready') +
       (SELECT COUNT(DISTINCT e.author_id) FROM threads_entries e
        JOIN threads_authors a ON a.threads_user_id = e.author_id
        WHERE e.threads_post_id = p.id AND a.profile_media_status = 'ready') AS ready_count,
       (SELECT COUNT(*) FROM threads_media m JOIN threads_entries e ON e.id = m.entry_id
        WHERE e.threads_post_id = p.id AND m.status = 'error') +
       (SELECT COUNT(DISTINCT e.author_id) FROM threads_entries e
        JOIN threads_authors a ON a.threads_user_id = e.author_id
        WHERE e.threads_post_id = p.id AND a.profile_media_status = 'error') AS failed_count,
       (SELECT COUNT(*) FROM threads_media m JOIN threads_entries e ON e.id = m.entry_id
        WHERE e.threads_post_id = p.id AND m.status = 'pending') +
       (SELECT COUNT(DISTINCT e.author_id) FROM threads_entries e
        JOIN threads_authors a ON a.threads_user_id = e.author_id
        WHERE e.threads_post_id = p.id AND a.profile_media_status = 'pending') AS pending_count
     FROM threads_posts p JOIN threads_sync_jobs j
       ON j.threads_post_id = p.id AND j.generation = ?
     WHERE p.id = ? AND p.sync_generation = ? AND p.status <> 'deleting'`,
  ).bind(generation, postId, generation).first();
  if (row === null) return null;
  const result = exactRow(row, AGGREGATE_KEYS);
  if (!POST_STATUSES.has(result.post_status) || !JOB_STATUSES.has(result.job_status) ||
    !(result.error_code === null || typeof result.error_code === "string")) invalidStorage();
  for (const key of ["expected_media_count", "root_count", "entry_count", "media_count",
    "ready_count", "failed_count", "pending_count"]) nonnegativeInteger(result[key]);
  return result;
}

/** @param {any} db @param {{ postId: string, generation: number, nowSeconds: number }} input */
export async function recalculateThreadsStatus(db, input) {
  const postId = requiredString(input?.postId);
  const generation = positiveInteger(input?.generation);
  const now = timestamp(input?.nowSeconds);
  try {
    const aggregate = await aggregateRow(db, postId, generation);
    if (!aggregate) return { status: "stale", ready: 0, failed: 0, expected: 0 };
    let status;
    if (aggregate.root_count === 0) status = "error";
    else if (aggregate.pending_count > 0) status = "media_pending";
    else if (aggregate.failed_count > 0 || aggregate.error_code !== null) status = "partial";
    else status = "ready";
    const postStatus = status === "media_pending" ? "collecting" : status;
    const completed = status === "ready" || status === "partial" || status === "error" ? now : null;
    const changes = mutationBatch(await db.batch([
      db.prepare(
        `UPDATE threads_sync_jobs SET status = ?, expected_entry_count = ?,
           expected_media_count = ?, ready_media_count = ?, failed_media_count = ?,
           completed_at = ?, updated_at = ?
         WHERE threads_post_id = ? AND generation = ?
           AND EXISTS (
             SELECT 1 FROM threads_posts
             WHERE id = ? AND sync_generation = ? AND status <> 'deleting'
           )`,
      ).bind(status, aggregate.entry_count, aggregate.media_count,
        aggregate.ready_count, aggregate.failed_count, completed, now,
        postId, generation, postId, generation),
      db.prepare(
        `UPDATE threads_posts SET status = ?,
           error_code = CASE WHEN ? IN ('ready','collecting') THEN NULL ELSE
             COALESCE(?, 'threads_media_partial') END,
           last_successful_sync_at = CASE WHEN ? IN ('ready','partial') THEN ?
             ELSE last_successful_sync_at END,
           updated_at = ?
         WHERE id = ? AND sync_generation = ? AND status <> 'deleting'`,
      ).bind(postStatus, postStatus, aggregate.error_code, postStatus, now, now, postId, generation),
    ]), 2);
    if (changes.some((count) => count > 1) || changes[0] !== changes[1]) invalidStorage();
    if (changes[0] === 0) return { status: "stale", ready: 0, failed: 0, expected: 0 };
    return { status, ready: aggregate.ready_count, failed: aggregate.failed_count,
      expected: aggregate.media_count };
  } catch (error) { throw storageError(error); }
}

/** @param {unknown} value */
function mediaDescriptor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AppError("invalid_threads_state", 400);
  const item = /** @type {Record<string, any>} */ (value);
  if (typeof item.entryId !== "string" || !item.entryId ||
    typeof item.sourceMediaId !== "string" || !item.sourceMediaId ||
    !MEDIA_KINDS.has(item.kind) || !Number.isSafeInteger(item.ordinal) || item.ordinal < 0 ||
    !(item.altText === null || typeof item.altText === "string") ||
    typeof item.sourceUrl !== "string" || !item.sourceUrl)
    throw new AppError("invalid_threads_state", 400);
  return item;
}
/** @param {unknown} value */
function profileDescriptor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AppError("invalid_threads_state", 400);
  const item = /** @type {Record<string, any>} */ (value);
  if (typeof item.authorId !== "string" || !item.authorId ||
    typeof item.sourceUrl !== "string" || !item.sourceUrl)
    throw new AppError("invalid_threads_state", 400);
  return item;
}

/** @param {any} db @param {any} mediaQueue @param {{ postId: string, generation: number, media?: unknown[], profiles?: unknown[], nowSeconds: number }} input */
export async function finalizeThreadsContent(db, mediaQueue, input) {
  const postId = requiredString(input?.postId);
  const generation = positiveInteger(input?.generation);
  const now = timestamp(input?.nowSeconds);
  if (!Array.isArray(input?.media ?? []) || !Array.isArray(input?.profiles ?? []))
    throw new AppError("invalid_threads_state", 400);
  const media = (input.media ?? []).map(mediaDescriptor);
  const profiles = (input.profiles ?? []).map(profileDescriptor);
  try {
    const barrierRaw = await db.prepare(
      `SELECT j.status, j.profile_cursor, j.conversation_cursor, j.pending_quote_count
       FROM threads_sync_jobs j JOIN threads_posts p ON p.id = j.threads_post_id
       WHERE j.threads_post_id = ? AND j.generation = ?
         AND p.sync_generation = j.generation AND p.status <> 'deleting'`,
    ).bind(postId, generation).first();
    if (barrierRaw === null) return { status: "stale", ready: 0, failed: 0, expected: 0 };
    const barrier = exactRow(barrierRaw,
      ["status", "profile_cursor", "conversation_cursor", "pending_quote_count"]);
    if (!JOB_STATUSES.has(barrier.status) ||
      !(barrier.profile_cursor === null || typeof barrier.profile_cursor === "string") ||
      !(barrier.conversation_cursor === null || typeof barrier.conversation_cursor === "string"))
      invalidStorage();
    nonnegativeInteger(barrier.pending_quote_count);
    if (barrier.status === "media_pending" || barrier.status === "ready" ||
      barrier.status === "partial" || barrier.status === "error") {
      const aggregate = await aggregateRow(db, postId, generation);
      return aggregate ? { status: barrier.status, ready: aggregate.ready_count,
        failed: aggregate.failed_count, expected: aggregate.media_count } :
        { status: "stale", ready: 0, failed: 0, expected: 0 };
    }
    if (barrier.profile_cursor !== null || barrier.conversation_cursor !== null ||
      barrier.pending_quote_count !== 0) {
      return { status: "collecting", ready: 0, failed: 0, expected: 0 };
    }
    const uniqueProfiles = [...new Map(profiles.map((item) => [item.authorId, item])).values()];
    const statements = media.map((item) => db.prepare(
      `INSERT INTO threads_media
         (id, entry_id, source_media_id, kind, ordinal, alt_text, status, created_at, updated_at)
       SELECT ?, e.id, ?, ?, ?, ?, 'pending', ?, ?
       FROM threads_entries e
       WHERE e.id = ? AND e.threads_post_id = ?
       ON CONFLICT(entry_id, source_media_id, kind, ordinal) DO NOTHING`,
    ).bind(crypto.randomUUID(), item.sourceMediaId, item.kind, item.ordinal,
      item.altText ?? null, now, now, item.entryId, postId));
    const profileIds = new Set(uniqueProfiles.map((item) => item.authorId));
    const authorRows = selectRows(await db.prepare(
      `SELECT DISTINCT e.author_id, a.profile_media_status
       FROM threads_entries e JOIN threads_authors a ON a.threads_user_id = e.author_id
       WHERE e.threads_post_id = ? ORDER BY e.author_id`,
    ).bind(postId).all(), ["author_id", "profile_media_status"]);
    for (const author of authorRows) {
      if (typeof author.author_id !== "string" ||
        !["pending", "ready", "error"].includes(author.profile_media_status)) invalidStorage();
      if (!profileIds.has(author.author_id) && author.profile_media_status === "pending") {
        statements.push(db.prepare(
          `UPDATE threads_authors SET profile_media_status = 'error',
             profile_error_code = 'threads_profile_unavailable', updated_at = ?
           WHERE threads_user_id = ? AND profile_media_status = 'pending'`,
        ).bind(now, author.author_id));
      }
    }
    statements.push(db.prepare(
      `UPDATE threads_sync_jobs SET status = 'media_pending', content_completed_at = ?,
         expected_entry_count = (
           SELECT COUNT(*) FROM threads_entries WHERE threads_post_id = ?
         ),
         expected_media_count = (
           SELECT COUNT(*) FROM threads_media m JOIN threads_entries e ON e.id = m.entry_id
           WHERE e.threads_post_id = ?
         ) + (
           SELECT COUNT(DISTINCT author_id) FROM threads_entries WHERE threads_post_id = ?
         ), updated_at = ?
       WHERE threads_post_id = ? AND generation = ?
         AND status IN ('queued','resolving','collecting')
         AND profile_cursor IS NULL AND conversation_cursor IS NULL
         AND pending_quote_count = 0
         AND EXISTS (
           SELECT 1 FROM threads_posts
           WHERE id = ? AND sync_generation = ? AND status <> 'deleting'
         )`,
    ).bind(now, postId, postId, postId, now, postId, generation, postId, generation));
    const changes = mutationBatch(await db.batch(statements), statements.length);
    if (changes.some((count) => count > 1)) invalidStorage();
    if (changes.at(-1) !== 1) return { status: "stale", ready: 0, failed: 0, expected: 0 };
    for (let index = 0; index < media.length; index += 1) {
      if (changes[index] !== 1) continue;
      const item = media[index];
      const row = exactRow(await db.prepare(
        `SELECT id FROM threads_media
         WHERE entry_id = ? AND source_media_id = ? AND kind = ? AND ordinal = ?`,
      ).bind(item.entryId, item.sourceMediaId, item.kind, item.ordinal).first(), ["id"]);
      if (typeof row.id !== "string" || !row.id) invalidStorage();
      if (!await sendMedia(mediaQueue, {
        version: 1, type: "archive-entry-media", postId, generation,
        entryId: item.entryId, mediaId: row.id, sourceUrl: item.sourceUrl,
      })) {
        const changed = mutationChanges(await db.prepare(
          `UPDATE threads_media SET status = 'error', error_code = 'queue_unavailable',
             updated_at = ? WHERE id = ? AND status = 'pending'`,
        ).bind(now, row.id).run());
        if (changed > 1) invalidStorage();
      }
    }
    for (const item of uniqueProfiles) {
      const author = authorRows.find((row) => row.author_id === item.authorId);
      if (!author || author.profile_media_status !== "pending") continue;
      if (!await sendMedia(mediaQueue, {
        version: 1, type: "archive-profile", postId, generation,
        authorId: item.authorId, sourceUrl: item.sourceUrl,
      })) {
        const changed = mutationChanges(await db.prepare(
          `UPDATE threads_authors SET profile_media_status = 'error',
             profile_error_code = 'queue_unavailable', updated_at = ?
           WHERE threads_user_id = ? AND profile_media_status = 'pending'`,
        ).bind(now, item.authorId).run());
        if (changed > 1) invalidStorage();
      }
    }
    return recalculateThreadsStatus(db, { postId, generation, nowSeconds: now });
  } catch (error) { throw storageError(error); }
}

/** @param {any} db @param {any} captureQueue @param {string} postId @param {number} nowSeconds */
export async function startThreadsDeletion(db, captureQueue, postId, nowSeconds) {
  requiredString(postId);
  const now = timestamp(nowSeconds);
  try {
    const current = await db.prepare("SELECT status FROM threads_posts WHERE id = ?").bind(postId).first();
    if (current === null) throw new AppError("threads_archive_not_found", 404);
    const row = exactRow(current, ["status"]);
    if (!POST_STATUSES.has(row.status)) invalidStorage();
    if (row.status === "deleting")
      return { threadsPostId: postId, status: "deleting", duplicate: true };
    const changed = mutationChanges(await db.prepare(
      `UPDATE threads_posts SET status = 'deleting', error_code = NULL, updated_at = ?
       WHERE id = ? AND status <> 'deleting'`,
    ).bind(now, postId).run());
    if (changed !== 1) invalidStorage();
    try {
      await sendCapture(captureQueue, { version: 1, type: "delete-archive", postId });
    } catch (error) {
      const recorded = mutationChanges(await db.prepare(
        `UPDATE threads_posts SET error_code = 'queue_unavailable', updated_at = ?
         WHERE id = ? AND status = 'deleting'`,
      ).bind(now, postId).run());
      if (recorded !== 1) invalidStorage();
      throw error;
    }
    return { threadsPostId: postId, status: "deleting", duplicate: false };
  } catch (error) { throw storageError(error); }
}
