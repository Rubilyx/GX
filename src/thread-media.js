import { AppError } from "./domain.js";
import { cleanupDeletingProfile, deleteReferencedObject } from "./thread-media-cleanup.js";
import {
  IMAGE_TYPES, VIDEO_TYPES, ThreadsMediaWriteError, downloadThreadsMedia,
  mediaMaximumBytes,
} from "./thread-media-download.js";
import {
  MEDIA_ACK, canDeleteFailedEntryUpload, canDeleteFailedProfileUpload,
  claimEntryUpload, claimProfileUpload, clearEntryUploadForRetry,
  deleteUncommittedUpload, entryKey, failEntryUpload, failProfileUpload,
  hasLiveAuthorReference, mediaRetryResult, ownsEntryUpload, ownsProfileUpload,
  profileKey, readEntryMedia, readProfileMedia, readyEntryUpload, readyProfileUpload,
  recalculateMediaStatus, releaseEntryUpload, releaseProfileUpload,
  terminalMediaCode, terminalizeEntryDeadLetter, terminalizeProfileDeadLetter,
} from "./thread-media-store.js";
import { fetchThreadsMedia, fetchThreadsProfile } from "./threads-api.js";
import { validateMediaMessage } from "./threads-domain.js";
import { inputTimestamp } from "./threads-storage.js";

export { deleteThreadsArchive } from "./thread-media-cleanup.js";
export { parseSingleRange, serveThreadsMedia } from "./thread-media-response.js";

/** @param {unknown} value */
function accessToken(value) {
  const token = value && typeof value === "object" && !Array.isArray(value) ?
    /** @type {Record<string, unknown>} */ (value).accessToken : null;
  if (typeof token !== "string" || !token)
    throw new AppError("threads_reconnect_required", 401);
  return token;
}

/** @param {any} bucket @param {string} key */
async function deleteFailedWrite(bucket, key) {
  try { await bucket.delete(key); }
  catch { throw new AppError("media_storage_unavailable", 503); }
}

/** @param {Record<string, any>} message @param {any} dependencies */
async function archiveEntry(message, dependencies) {
  const now = inputTimestamp(dependencies.nowSeconds);
  let row = await readEntryMedia(dependencies.db, message);
  if (!row) return;
  if (row.status === "ready") {
    await recalculateMediaStatus(dependencies, message); return;
  }
  if (row.upload_lease !== null) {
    if (message.type !== "retry-media")
      throw new AppError("media_upload_in_progress", 503);
    if (!await clearEntryUploadForRetry(dependencies.db, message, row, now))
      throw new AppError("media_upload_in_progress", 503);
    row = await readEntryMedia(dependencies.db, message);
    if (!row || row.status === "ready") {
      if (row?.status === "ready") await recalculateMediaStatus(dependencies, message);
      return;
    }
  }
  const lease = crypto.randomUUID();
  if (!await claimEntryUpload(dependencies.db, message, row, now, lease))
    throw new AppError("media_upload_in_progress", 503);
  row = { ...row, upload_lease: lease, upload_started_at: now };
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
    if (!await ownsEntryUpload(dependencies.db, message, row)) return;
    const key = entryKey({ postId: message.postId,
      sourceMediaId: row.source_media_id, kind: row.kind, ordinal: row.ordinal });
    const object = await downloadThreadsMedia(dependencies.bucket, dependencies.fetcher, {
      url, key, expected, maximumBytes: mediaMaximumBytes(dependencies.maximumBytes),
      signal: dependencies.signal,
    });
    if (await readyEntryUpload(dependencies.db, message, row, object, now)) {
      await recalculateMediaStatus(dependencies, message);
    } else if (!await readEntryMedia(dependencies.db, message)) {
      await deleteUncommittedUpload(dependencies.bucket, object.key);
    }
  } catch (error) {
    if (error instanceof ThreadsMediaWriteError &&
      await canDeleteFailedEntryUpload(dependencies.db, message, row, now))
      await deleteFailedWrite(dependencies.bucket, error.written.key);
    const retry = mediaRetryResult(error);
    if (retry) {
      await releaseEntryUpload(dependencies.db, message, row, now);
      throw error;
    }
    if (await failEntryUpload(dependencies.db, message, row,
      terminalMediaCode(error), now)) await recalculateMediaStatus(dependencies, message);
  }
}

/** @param {Record<string, any>} message @param {any} dependencies */
async function archiveProfile(message, dependencies) {
  const now = inputTimestamp(dependencies.nowSeconds);
  let row = await readProfileMedia(dependencies.db, message);
  if (!row) return;
  if (row.status === "ready") {
    await recalculateMediaStatus(dependencies, message); return;
  }
  if (row.status === "deleting") {
    await cleanupDeletingProfile(dependencies.db, dependencies.bucket, {
      author_id: row.author_id, r2_key: row.r2_key, cleanup_lease: row.cleanup_lease,
      cleanup_started_at: row.cleanup_started_at,
    }, now);
    row = await readProfileMedia(dependencies.db, message);
    if (!row) return;
    if (row.status === "ready") {
      await recalculateMediaStatus(dependencies, message); return;
    }
    if (row.status === "deleting")
      throw new AppError("media_upload_in_progress", 503);
  }
  if (row.upload_lease !== null) throw new AppError("media_upload_in_progress", 503);
  const lease = crypto.randomUUID();
  if (!await claimProfileUpload(dependencies.db, message, row, now, lease))
    throw new AppError("media_upload_in_progress", 503);
  row = { ...row, upload_lease: lease, upload_started_at: now };
  try {
    const token = accessToken(await dependencies.getAccessToken());
    const profile = await fetchThreadsProfile(dependencies.fetcher, {
      accessToken: token, username: row.username, signal: dependencies.signal,
    });
    if (profile.id !== row.author_id)
      throw new AppError("threads_provider_protocol_error", 502);
    if (!profile.profilePictureUrl) throw new AppError("threads_media_unavailable", 404);
    if (!await ownsProfileUpload(dependencies.db, message, row)) return;
    const object = await downloadThreadsMedia(dependencies.bucket, dependencies.fetcher, {
      url: profile.profilePictureUrl, key: profileKey(row.author_id), expected: IMAGE_TYPES,
      maximumBytes: mediaMaximumBytes(dependencies.maximumBytes), signal: dependencies.signal,
    });
    if (await readyProfileUpload(dependencies.db, message, row, object, now)) {
      await recalculateMediaStatus(dependencies, message);
    } else if (!await hasLiveAuthorReference(dependencies.db, row.author_id)) {
      await deleteUncommittedUpload(dependencies.bucket, object.key);
    }
  } catch (error) {
    if (error instanceof ThreadsMediaWriteError &&
      await canDeleteFailedProfileUpload(dependencies.db, message, row, now))
      await deleteFailedWrite(dependencies.bucket, error.written.key);
    const retry = mediaRetryResult(error);
    if (retry) {
      await releaseProfileUpload(dependencies.db, message, row, now);
      throw error;
    }
    if (await failProfileUpload(dependencies.db, message, row,
      terminalMediaCode(error), now)) await recalculateMediaStatus(dependencies, message);
  }
}

/** @param {unknown} rawMessage @param {any} dependencies */
export async function handleThreadsMediaMessage(rawMessage, dependencies) {
  let message;
  try { message = /** @type {Record<string, any>} */ (validateMediaMessage(rawMessage)); }
  catch { return MEDIA_ACK; }
  try {
    if (message.type === "archive-profile") await archiveProfile(message, dependencies);
    else if (message.type === "delete-object")
      await deleteReferencedObject(message, dependencies);
    else await archiveEntry(message, dependencies);
    return MEDIA_ACK;
  } catch (error) { return mediaRetryResult(error) ?? MEDIA_ACK; }
}

/** @param {unknown} rawMessage @param {any} dependencies */
export async function handleThreadsMediaDeadLetter(rawMessage, dependencies) {
  let message;
  try { message = /** @type {Record<string, any>} */ (validateMediaMessage(rawMessage)); }
  catch { return MEDIA_ACK; }
  if (message.type === "delete-object") return MEDIA_ACK;
  try {
    if (message.type === "archive-profile")
      await terminalizeProfileDeadLetter(message, dependencies);
    else await terminalizeEntryDeadLetter(message, dependencies);
    return MEDIA_ACK;
  } catch (error) { return mediaRetryResult(error) ?? MEDIA_ACK; }
}
