import { AppError } from "./domain.js";
import {
  MEDIA_ACK, MEDIA_RETRY, UPLOAD_STALE_SECONDS, entryKey, mediaRetryResult, profileKey,
} from "./thread-media-store.js";
import { validateCaptureMessage } from "./threads-domain.js";
import {
  exactRow, inputTimestamp, mutationBatch, mutationChanges, requiredString, selectRows,
  storageError,
} from "./threads-storage.js";

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
export async function deleteReferencedObject(message, dependencies) {
  if (!await referencedObject(dependencies.db, message.objectKey)) return;
  try { await dependencies.bucket.delete(message.objectKey); }
  catch { throw new AppError("media_storage_unavailable", 503); }
}

/** @param {any} db @param {string} postId */
async function deletingPost(db, postId) {
  const value = await db.prepare("SELECT status FROM threads_posts WHERE id = ?")
    .bind(postId).first();
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
      row.r2_key !== entryKey({ postId, sourceMediaId: row.source_media_id,
        kind: row.kind, ordinal: row.ordinal }))
      throw new AppError("storage_unavailable", 503);
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
      `UPDATE threads_authors SET profile_media_status = 'deleting',
         profile_upload_lease = NULL, profile_upload_started_at = NULL,
         profile_cleanup_lease = NULL, profile_cleanup_started_at = NULL
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

/** @param {any} db @param {string} authorId @param {string | null} key
 * @param {string | null} priorLease @param {number | null} priorStarted
 * @param {string} lease @param {number} now */
async function claimProfileCleanup(db, authorId, key, priorLease, priorStarted, lease, now) {
  const cutoff = now - UPLOAD_STALE_SECONDS;
  const changes = mutationChanges(await db.prepare(
    `UPDATE threads_authors SET profile_cleanup_lease = ?, profile_cleanup_started_at = ?
     WHERE threads_user_id = ? AND profile_media_status = 'deleting'
       AND profile_upload_lease IS NULL
       AND ((? IS NULL AND profile_cleanup_lease IS NULL
           AND profile_cleanup_started_at IS NULL)
         OR (profile_cleanup_lease = ? AND profile_cleanup_started_at = ?
           AND profile_cleanup_started_at <= ?))
       AND ((? IS NULL AND profile_r2_key IS NULL) OR profile_r2_key = ?)`,
  ).bind(lease, now, authorId, priorLease, priorLease, priorStarted, cutoff,
    key, key).run());
  if (changes > 1) throw new AppError("storage_unavailable", 503);
  return changes === 1;
}

/** @param {any} db @param {string} authorId @param {string} lease @param {number} started */
async function releaseProfileCleanup(db, authorId, lease, started) {
  const changes = mutationChanges(await db.prepare(
    `UPDATE threads_authors SET profile_cleanup_lease = NULL,
       profile_cleanup_started_at = NULL
     WHERE threads_user_id = ? AND profile_media_status = 'deleting'
       AND profile_cleanup_lease = ? AND profile_cleanup_started_at = ?`,
  ).bind(authorId, lease, started).run());
  if (changes > 1) throw new AppError("storage_unavailable", 503);
}

/** @param {any} db @param {any} bucket @param {{ author_id: string,
 * r2_key: string | null, cleanup_lease?: string | null,
 * cleanup_started_at?: number | null }} row @param {number} now
 * @param {boolean} [retryBusy] */
export async function cleanupDeletingProfile(db, bucket, row, now, retryBusy = true) {
  const cutoff = now - UPLOAD_STALE_SECONDS;
  if (row.cleanup_lease && (!(Number.isSafeInteger(row.cleanup_started_at)) ||
    /** @type {number} */ (row.cleanup_started_at) > cutoff)) {
    if (retryBusy) throw new AppError("media_upload_in_progress", 503);
    return "busy";
  }
  if (row.r2_key !== null && row.r2_key !== profileKey(row.author_id))
    throw new AppError("storage_unavailable", 503);
  const lease = crypto.randomUUID();
  if (!await claimProfileCleanup(db, row.author_id, row.r2_key,
    row.cleanup_lease ?? null, row.cleanup_started_at ?? null, lease, now)) {
    if (retryBusy) throw new AppError("media_upload_in_progress", 503);
    return "busy";
  }
  try {
    if (row.r2_key !== null) {
      try { await bucket.delete(row.r2_key); }
      catch { throw new AppError("media_storage_unavailable", 503); }
    }
    const changes = mutationBatch(await db.batch([
      db.prepare(
        `DELETE FROM threads_authors
         WHERE threads_user_id = ? AND profile_media_status = 'deleting'
           AND profile_cleanup_lease = ? AND profile_cleanup_started_at = ?
           AND NOT EXISTS (
             SELECT 1 FROM threads_entries
             WHERE author_id = threads_authors.threads_user_id
           )`,
      ).bind(row.author_id, lease, now),
      db.prepare(
        `UPDATE threads_authors SET profile_media_status = 'pending',
           profile_r2_key = NULL, profile_content_type = NULL, profile_bytes = NULL,
           profile_etag = NULL, profile_error_code = NULL, profile_refreshed_at = NULL,
           profile_upload_lease = NULL, profile_upload_started_at = NULL,
           profile_cleanup_lease = NULL, profile_cleanup_started_at = NULL
         WHERE threads_user_id = ? AND profile_media_status = 'deleting'
           AND profile_cleanup_lease = ? AND profile_cleanup_started_at = ?
           AND EXISTS (
             SELECT 1 FROM threads_entries
             WHERE author_id = threads_authors.threads_user_id
           )`,
      ).bind(row.author_id, lease, now),
    ]), 2);
    if (changes[0] + changes[1] !== 1 || changes.some((count) => count > 1))
      throw new AppError("storage_unavailable", 503);
    return changes[1] === 1 ? "pending" : "deleted";
  } catch (error) {
    try { await releaseProfileCleanup(db, row.author_id, lease, now); } catch {}
    throw error;
  }
}

/** @param {any} db @param {any} bucket @param {number} now */
async function sweepDeletingProfiles(db, bucket, now) {
  const rows = selectRows(await db.prepare(
    `SELECT threads_user_id AS author_id, profile_r2_key AS r2_key,
       profile_cleanup_lease AS cleanup_lease,
       profile_cleanup_started_at AS cleanup_started_at
     FROM threads_authors WHERE profile_media_status = 'deleting'
     ORDER BY threads_user_id`,
  ).all(), ["author_id", "r2_key", "cleanup_lease", "cleanup_started_at"]);
  for (const row of rows) {
    if (typeof row.author_id !== "string" || !row.author_id ||
      !(row.r2_key === null || typeof row.r2_key === "string") ||
      !(row.cleanup_lease === null || typeof row.cleanup_lease === "string") ||
      !(row.cleanup_started_at === null || Number.isSafeInteger(row.cleanup_started_at) &&
        row.cleanup_started_at >= 0)) throw new AppError("storage_unavailable", 503);
    await cleanupDeletingProfile(db, bucket, {
      author_id: row.author_id, r2_key: row.r2_key, cleanup_lease: row.cleanup_lease,
      cleanup_started_at: row.cleanup_started_at,
    }, now, false);
  }
}

/** @param {unknown} rawMessage
 * @param {{ db: any, bucket: any, nowSeconds?: number }} dependencies */
export async function deleteThreadsArchive(rawMessage, dependencies) {
  let message;
  try {
    message = validateCaptureMessage(rawMessage);
    if (message.type !== "delete-archive") return MEDIA_ACK;
  } catch { return MEDIA_ACK; }
  try {
    const postId = requiredString(message.postId);
    const now = dependencies.nowSeconds === undefined ? Math.floor(Date.now() / 1_000) :
      inputTimestamp(dependencies.nowSeconds);
    if (await deletingPost(dependencies.db, postId) === "deleting") {
      const rows = await deletionRows(dependencies.db, postId);
      for (const row of rows.media) {
        try { await dependencies.bucket.delete(row.r2_key); }
        catch { throw new AppError("media_storage_unavailable", 503); }
      }
      await cascadeArchive(dependencies.db, postId, rows.authors);
    }
    await sweepDeletingProfiles(dependencies.db, dependencies.bucket, now);
    return MEDIA_ACK;
  } catch (error) { return mediaRetryResult(storageError(error)) ?? MEDIA_RETRY; }
}
