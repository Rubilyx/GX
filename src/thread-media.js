import { AppError } from "./domain.js";
import { cleanupDeletingProfile, deleteReferencedObject } from "./thread-media-cleanup.js";
import {
  IMAGE_TYPES, VIDEO_TYPES, ThreadsMediaPutUncertainError, ThreadsMediaWriteError,
  downloadThreadsMedia, mediaMaximumBytes,
} from "./thread-media-download.js";
import {
  MEDIA_ACK, claimEntryUpload, claimEntryUploadRecovery, claimProfileUpload,
  claimProfileUploadRecovery,
  deleteUncommittedUpload, entryKey, failEntryUpload, failProfileUpload,
  finishEntryUploadRecovery,
  mediaRetryResult, ownsEntryUpload, ownsProfileUpload,
  profileKey, readEntryMedia, readProfileMedia, readyEntryUpload, readyProfileUpload,
  recalculateMediaStatus, releaseEntryUpload, releaseProfileUpload,
  restoreEntryUploadRecovery, restoreProfileUploadRecovery,
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

/** @param {Record<string, any>} message @param {any} dependencies @param {string} key */
async function reconcileEntryPut(message, dependencies, key) {
  const current = await readEntryMedia(dependencies.db, message);
  if (current?.status === "ready") {
    if (current.r2_key !== key)
      await deleteUncommittedUpload(dependencies.bucket, key);
    await recalculateMediaStatus(dependencies, message);
    return true;
  }
  if (current?.pending_r2_key === key) return false;
  await deleteUncommittedUpload(dependencies.bucket, key);
  return true;
}

/** @param {Record<string, any>} message @param {any} dependencies @param {string} key */
async function reconcileProfilePut(message, dependencies, key) {
  const current = await readProfileMedia(dependencies.db, message);
  if (current?.status === "ready") {
    if (current.r2_key !== key)
      await deleteUncommittedUpload(dependencies.bucket, key);
    await recalculateMediaStatus(dependencies, message);
    return true;
  }
  if (current?.pending_r2_key === key) return false;
  await deleteUncommittedUpload(dependencies.bucket, key);
  return true;
}

/** @param {Record<string, any>} message @param {any} dependencies
 * @param {Record<string, any>} row
 * @param {{ key: string, size: number, httpEtag: string, contentType: string }} object
 * @param {number} now */
async function persistEntryReady(message, dependencies, row, object, now) {
  let committed;
  try {
    committed = await readyEntryUpload(dependencies.db, message, row, object, now);
  } catch (error) {
    if (await reconcileEntryPut(message, dependencies, object.key)) return;
    throw error;
  }
  if (committed) {
    await recalculateMediaStatus(dependencies, message);
    return;
  }
  if (!await reconcileEntryPut(message, dependencies, object.key))
    throw new AppError("media_storage_unavailable", 503);
}

/** @param {Record<string, any>} message @param {any} dependencies
 * @param {Record<string, any>} row
 * @param {{ key: string, size: number, httpEtag: string, contentType: string }} object
 * @param {number} now */
async function persistProfileReady(message, dependencies, row, object, now) {
  let committed;
  try {
    committed = await readyProfileUpload(dependencies.db, message, row, object, now);
  } catch (error) {
    if (await reconcileProfilePut(message, dependencies, object.key)) return;
    throw error;
  }
  if (committed) {
    await recalculateMediaStatus(dependencies, message);
    return;
  }
  if (!await reconcileProfilePut(message, dependencies, object.key))
    throw new AppError("media_storage_unavailable", 503);
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
    const recoveryLease = crypto.randomUUID();
    if (!await claimEntryUploadRecovery(dependencies.db, message, row, now,
      recoveryLease))
      throw new AppError("media_upload_in_progress", 503);
    try { await deleteUncommittedUpload(dependencies.bucket, row.pending_r2_key); }
    catch (error) {
      await restoreEntryUploadRecovery(dependencies.db, message, row, recoveryLease, now);
      throw error;
    }
    if (!await finishEntryUploadRecovery(dependencies.db, message, row, recoveryLease, now))
      throw new AppError("media_upload_in_progress", 503);
    row = await readEntryMedia(dependencies.db, message);
    if (!row || row.status === "ready") {
      if (row?.status === "ready") await recalculateMediaStatus(dependencies, message);
      return;
    }
  }
  const lease = crypto.randomUUID();
  const pendingKey = entryKey({ postId: message.postId,
    sourceMediaId: row.source_media_id, kind: row.kind, ordinal: row.ordinal }, lease);
  if (!await claimEntryUpload(dependencies.db, message, row, now, lease, pendingKey))
    throw new AppError("media_upload_in_progress", 503);
  row = { ...row, upload_lease: lease, upload_started_at: now,
    pending_r2_key: pendingKey };
  let object;
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
    object = await downloadThreadsMedia(dependencies.bucket, dependencies.fetcher, {
      url, key: row.pending_r2_key, expected,
      maximumBytes: mediaMaximumBytes(dependencies.maximumBytes),
      signal: dependencies.signal,
    });
  } catch (error) {
    if (error instanceof ThreadsMediaPutUncertainError) {
      if (await reconcileEntryPut(message, dependencies, error.key)) return;
      throw error;
    }
    if (error instanceof ThreadsMediaWriteError) {
      await deleteFailedWrite(dependencies.bucket, error.written.key);
      if (mediaRetryResult(error)) throw error;
    }
    const retry = mediaRetryResult(error);
    if (retry) {
      await releaseEntryUpload(dependencies.db, message, row, now);
      throw error;
    }
    if (await failEntryUpload(dependencies.db, message, row,
      terminalMediaCode(error), now)) await recalculateMediaStatus(dependencies, message);
    return;
  }
  await persistEntryReady(message, dependencies, row, object, now);
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
  const pendingKey = profileKey(row.author_id, lease);
  if (!await claimProfileUpload(dependencies.db, message, row, now, lease, pendingKey))
    throw new AppError("media_upload_in_progress", 503);
  row = { ...row, upload_lease: lease, upload_started_at: now,
    pending_r2_key: pendingKey };
  let object;
  try {
    const token = accessToken(await dependencies.getAccessToken());
    const profile = await fetchThreadsProfile(dependencies.fetcher, {
      accessToken: token, username: row.username, signal: dependencies.signal,
    });
    if (profile.id !== row.author_id)
      throw new AppError("threads_provider_protocol_error", 502);
    if (!profile.profilePictureUrl) throw new AppError("threads_media_unavailable", 404);
    if (!await ownsProfileUpload(dependencies.db, message, row)) return;
    object = await downloadThreadsMedia(dependencies.bucket, dependencies.fetcher, {
      url: profile.profilePictureUrl, key: row.pending_r2_key,
      expected: IMAGE_TYPES,
      maximumBytes: mediaMaximumBytes(dependencies.maximumBytes), signal: dependencies.signal,
    });
  } catch (error) {
    if (error instanceof ThreadsMediaPutUncertainError) {
      if (await reconcileProfilePut(message, dependencies, error.key)) return;
      throw error;
    }
    if (error instanceof ThreadsMediaWriteError) {
      await deleteFailedWrite(dependencies.bucket, error.written.key);
      if (mediaRetryResult(error)) throw error;
    }
    const retry = mediaRetryResult(error);
    if (retry) {
      await releaseProfileUpload(dependencies.db, message, row, now);
      throw error;
    }
    if (await failProfileUpload(dependencies.db, message, row,
      terminalMediaCode(error), now)) await recalculateMediaStatus(dependencies, message);
    return;
  }
  await persistProfileReady(message, dependencies, row, object, now);
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

/** @param {Record<string, any>} message @param {any} dependencies */
async function deadEntry(message, dependencies) {
  const row = await readEntryMedia(dependencies.db, message);
  if (!row || row.status === "ready" || row.upload_lease === null) {
    await terminalizeEntryDeadLetter(message, dependencies); return;
  }
  const now = inputTimestamp(dependencies.nowSeconds);
  const recoveryLease = crypto.randomUUID();
  if (!await claimEntryUploadRecovery(dependencies.db, message, row, now,
    recoveryLease))
    throw new AppError("media_upload_in_progress", 503);
  try { await deleteUncommittedUpload(dependencies.bucket, row.pending_r2_key); }
  catch (error) {
    await restoreEntryUploadRecovery(dependencies.db, message, row, recoveryLease, now);
    throw error;
  }
  await terminalizeEntryDeadLetter(message, dependencies,
    { ...row, upload_lease: recoveryLease, upload_started_at: now });
}

/** @param {Record<string, any>} message @param {any} dependencies */
async function deadProfile(message, dependencies) {
  const row = await readProfileMedia(dependencies.db, message);
  if (!row || row.status === "ready" || row.status === "deleting" ||
    row.upload_lease === null) {
    await terminalizeProfileDeadLetter(message, dependencies); return;
  }
  const now = inputTimestamp(dependencies.nowSeconds);
  const recoveryLease = crypto.randomUUID();
  if (!await claimProfileUploadRecovery(dependencies.db, message, row, now,
    recoveryLease))
    throw new AppError("media_upload_in_progress", 503);
  try { await deleteUncommittedUpload(dependencies.bucket, row.pending_r2_key); }
  catch (error) {
    await restoreProfileUploadRecovery(dependencies.db, message, row, recoveryLease, now);
    throw error;
  }
  await terminalizeProfileDeadLetter(message, dependencies,
    { ...row, upload_lease: recoveryLease, upload_started_at: now });
}

/** @param {unknown} rawMessage @param {any} dependencies */
export async function handleThreadsMediaDeadLetter(rawMessage, dependencies) {
  let message;
  try { message = /** @type {Record<string, any>} */ (validateMediaMessage(rawMessage)); }
  catch { return MEDIA_ACK; }
  if (message.type === "delete-object") return MEDIA_ACK;
  try {
    if (message.type === "archive-profile") await deadProfile(message, dependencies);
    else await deadEntry(message, dependencies);
    return MEDIA_ACK;
  } catch (error) { return mediaRetryResult(error) ?? MEDIA_ACK; }
}
