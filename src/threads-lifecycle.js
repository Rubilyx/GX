import { AppError } from "./domain.js";
import {
  normalizeThreadsUrl, validateCaptureMessage, validateMediaMessage,
} from "./threads-domain.js";
import {
  ACTIVE_JOBS, d1NonnegativeInteger, exactRow, inputPositiveInteger,
  inputTimestamp, invalidStorage, JOB_STATUSES, MEDIA_KINDS, mutationBatch,
  mutationChanges, POST_STATUSES, requiredString, selectRows, storageError,
} from "./threads-storage.js";

const SYNC_ROW_KEYS = [
  "id", "status", "error_code", "sync_generation", "job_status", "job_error_code",
];
/** @param {any} row */
function validateSyncRow(row) {
  if (row === null) return null;
  row = exactRow(row, SYNC_ROW_KEYS);
  if (typeof row.id !== "string" || !row.id || !POST_STATUSES.has(row.status) ||
    !Number.isSafeInteger(row.sync_generation) || row.sync_generation < 1 ||
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
/** @param {any} queue @param {Record<string, unknown>} message */
async function sendCapture(queue, message) {
  try {
    const validated = validateCaptureMessage(message);
    if (!queue || typeof queue.send !== "function") throw new Error("queue_missing");
    await queue.send(validated);
  } catch { throw new AppError("queue_unavailable", 503); }
}
/** @param {any} queue @param {Record<string, unknown>} message */
async function sendMedia(queue, message) {
  try {
    const validated = validateMediaMessage(message);
    if (!queue || typeof queue.send !== "function") throw new Error("queue_missing");
    await queue.send(validated);
    return true;
  } catch { return false; }
}
/** @param {any} db @param {string} postId @param {number} generation @param {number} now */
async function recordQueueFailure(db, postId, generation, now) {
  const changes = mutationBatch(await db.batch([
    db.prepare(
      `UPDATE threads_sync_jobs SET status = 'error', error_code = 'queue_unavailable',
         completed_at = ?, updated_at = ?
       WHERE threads_post_id = ? AND generation = ?`,
    ).bind(now, now, postId, generation),
    db.prepare(
      `UPDATE threads_posts SET
         status = CASE WHEN EXISTS (
           SELECT 1 FROM threads_entries WHERE threads_post_id = ? AND kind = 'root'
         ) THEN 'partial' ELSE 'error' END,
         error_code = 'queue_unavailable', updated_at = ?
       WHERE id = ? AND sync_generation = ?`,
    ).bind(postId, now, postId, generation),
  ]), 2);
  if (changes.some((count) => count > 1) || changes[0] !== changes[1]) invalidStorage();
}

/** @param {any} db @param {any} captureQueue @param {unknown} rawUrl @param {number} nowSeconds */
export async function createThreadsSync(db, captureQueue, rawUrl, nowSeconds) {
  const normalized = normalizeThreadsUrl(rawUrl);
  const now = inputTimestamp(nowSeconds);
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await loadSyncRow(db, normalized.shortcode);
      let postId;
      let generation;
      if (!current) {
        postId = crypto.randomUUID();
        generation = 1;
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
          ).bind(crypto.randomUUID(), postId, now, now, postId),
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
      try {
        await sendCapture(captureQueue, {
          version: 1, type: "resolve-post", postId, generation, cursor: null,
        });
      } catch (error) {
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
  if (typeof row.post_id !== "string" || !row.post_id ||
    !Number.isSafeInteger(row.generation) || row.generation < 1 ||
    !JOB_STATUSES.has(row.status) ||
    !(row.profile_cursor === null || typeof row.profile_cursor === "string") ||
    !(row.conversation_cursor === null || typeof row.conversation_cursor === "string") ||
    !(row.error_code === null || typeof row.error_code === "string") ||
    !(row.root_author_id === null || typeof row.root_author_id === "string") ||
    !(row.threads_media_id === null || typeof row.threads_media_id === "string") ||
    !(row.canonical_url === null || typeof row.canonical_url === "string")) invalidStorage();
  for (const key of ["pending_quote_count", "expected_entry_count", "expected_media_count",
    "ready_media_count", "failed_media_count"]) d1NonnegativeInteger(row[key]);
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
  requiredString(postId); inputPositiveInteger(generation);
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

/** @param {any} db @param {{ postId: string, generation: number, errorCode: string, nowSeconds: number }} input */
export async function markThreadsJobError(db, input) {
  const postId = requiredString(input?.postId);
  const generation = inputPositiveInteger(input?.generation);
  const errorCode = requiredString(input?.errorCode);
  const now = inputTimestamp(input?.nowSeconds);
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

const STATE_KEYS = [
  "status", "profile_cursor", "conversation_cursor", "pending_quote_count",
  "content_completed_at", "expected_media_count", "ready_media_count",
  "failed_media_count", "error_code",
];
/** @param {any} db @param {string} postId @param {number} generation */
async function currentState(db, postId, generation) {
  const raw = await db.prepare(
    `SELECT j.status, j.profile_cursor, j.conversation_cursor, j.pending_quote_count,
       j.content_completed_at, j.expected_media_count, j.ready_media_count,
       j.failed_media_count, j.error_code
     FROM threads_sync_jobs j JOIN threads_posts p ON p.id = j.threads_post_id
     WHERE j.threads_post_id = ? AND j.generation = ?
       AND p.sync_generation = j.generation AND p.status <> 'deleting'`,
  ).bind(postId, generation).first();
  if (raw === null) return null;
  const row = exactRow(raw, STATE_KEYS);
  if (!JOB_STATUSES.has(row.status) ||
    !(row.profile_cursor === null || typeof row.profile_cursor === "string") ||
    !(row.conversation_cursor === null || typeof row.conversation_cursor === "string") ||
    !(row.content_completed_at === null || Number.isSafeInteger(row.content_completed_at) &&
      row.content_completed_at >= 0) ||
    !(row.error_code === null || typeof row.error_code === "string")) invalidStorage();
  for (const key of ["pending_quote_count", "expected_media_count", "ready_media_count",
    "failed_media_count"]) d1NonnegativeInteger(row[key]);
  return row;
}
const AGGREGATE_KEYS = [
  "error_code", "root_count", "entry_count", "media_count", "ready_count",
  "failed_count", "pending_count",
];
/** @param {any} db @param {string} postId @param {number} generation */
async function aggregateRow(db, postId, generation) {
  const row = await db.prepare(
    `SELECT j.error_code,
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
     WHERE p.id = ? AND p.sync_generation = ? AND p.status <> 'deleting'
       AND j.status = 'media_pending' AND j.content_completed_at IS NOT NULL
       AND j.profile_cursor IS NULL AND j.conversation_cursor IS NULL
       AND j.pending_quote_count = 0`,
  ).bind(generation, postId, generation).first();
  if (row === null) return null;
  const result = exactRow(row, AGGREGATE_KEYS);
  if (!(result.error_code === null || typeof result.error_code === "string")) invalidStorage();
  for (const key of ["root_count", "entry_count", "media_count", "ready_count",
    "failed_count", "pending_count"]) d1NonnegativeInteger(result[key]);
  return result;
}

/** @param {any} db @param {{ postId: string, generation: number, nowSeconds: number }} input */
export async function recalculateThreadsStatus(db, input) {
  const postId = requiredString(input?.postId);
  const generation = inputPositiveInteger(input?.generation);
  const now = inputTimestamp(input?.nowSeconds);
  try {
    const aggregate = await aggregateRow(db, postId, generation);
    if (!aggregate) {
      const state = await currentState(db, postId, generation);
      return state ? { status: state.status, ready: state.ready_media_count,
        failed: state.failed_media_count, expected: state.expected_media_count } :
        { status: "stale", ready: 0, failed: 0, expected: 0 };
    }
    let status;
    if (aggregate.root_count === 0) status = "error";
    else if (aggregate.failed_count > 0 || aggregate.error_code !== null) status = "partial";
    else if (aggregate.pending_count > 0) status = "media_pending";
    else status = "ready";
    const postStatus = status === "media_pending" ? "collecting" : status;
    const completed = status === "ready" || status === "partial" || status === "error" ? now : null;
    const changes = mutationBatch(await db.batch([
      db.prepare(
        `UPDATE threads_posts SET status = ?,
           error_code = CASE WHEN ? IN ('ready','collecting') THEN NULL ELSE
             COALESCE(?, 'threads_media_partial') END,
           last_successful_sync_at = CASE WHEN ? IN ('ready','partial') THEN ?
             ELSE last_successful_sync_at END, updated_at = ?
         WHERE id = ? AND sync_generation = ? AND status <> 'deleting'
           AND EXISTS (
             SELECT 1 FROM threads_sync_jobs WHERE threads_post_id = ? AND generation = ?
               AND status = 'media_pending' AND content_completed_at IS NOT NULL
               AND profile_cursor IS NULL AND conversation_cursor IS NULL
               AND pending_quote_count = 0
           )`,
      ).bind(postStatus, postStatus, aggregate.error_code, postStatus, now, now,
        postId, generation, postId, generation),
      db.prepare(
        `UPDATE threads_sync_jobs SET status = ?, expected_entry_count = ?,
           expected_media_count = ?, ready_media_count = ?, failed_media_count = ?,
           completed_at = ?, updated_at = ?
         WHERE threads_post_id = ? AND generation = ? AND status = 'media_pending'
           AND content_completed_at IS NOT NULL AND profile_cursor IS NULL
           AND conversation_cursor IS NULL AND pending_quote_count = 0
           AND EXISTS (
             SELECT 1 FROM threads_posts WHERE id = ? AND sync_generation = ?
               AND status <> 'deleting'
           )`,
      ).bind(status, aggregate.entry_count, aggregate.media_count,
        aggregate.ready_count, aggregate.failed_count, completed, now,
        postId, generation, postId, generation),
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

function finalizationGate() {
  return `EXISTS (
    SELECT 1 FROM threads_sync_jobs gate
    JOIN threads_posts gate_post ON gate_post.id = gate.threads_post_id
    WHERE gate.error_code = ? AND gate.threads_post_id = ? AND gate.generation = ?
      AND gate.status = 'media_pending'
      AND gate.content_completed_at IS NOT NULL
      AND gate.profile_cursor IS NULL AND gate.conversation_cursor IS NULL
      AND gate.pending_quote_count = 0
      AND gate_post.sync_generation = gate.generation
      AND gate_post.status <> 'deleting'
  )`;
}

/** @param {any} db @param {any} mediaQueue @param {{ postId: string, generation: number, media?: unknown[], profiles?: unknown[], nowSeconds: number }} input */
export async function finalizeThreadsContent(db, mediaQueue, input) {
  const postId = requiredString(input?.postId);
  const generation = inputPositiveInteger(input?.generation);
  const now = inputTimestamp(input?.nowSeconds);
  if (!Array.isArray(input?.media ?? []) || !Array.isArray(input?.profiles ?? []))
    throw new AppError("invalid_threads_state", 400);
  const media = (input.media ?? []).map(mediaDescriptor);
  const profiles = (input.profiles ?? []).map(profileDescriptor);
  try {
    const state = await currentState(db, postId, generation);
    if (!state) return { status: "stale", ready: 0, failed: 0, expected: 0 };
    if (["media_pending", "ready", "partial", "error"].includes(state.status)) {
      return { status: state.status, ready: state.ready_media_count,
        failed: state.failed_media_count, expected: state.expected_media_count };
    }
    if (state.profile_cursor !== null || state.conversation_cursor !== null ||
      state.pending_quote_count !== 0) {
      return { status: "collecting", ready: 0, failed: 0, expected: 0 };
    }
    const uniqueProfiles = [...new Map(profiles.map((item) => [item.authorId, item])).values()];
    const authorRows = selectRows(await db.prepare(
      `SELECT DISTINCT e.author_id, a.profile_media_status
       FROM threads_entries e JOIN threads_authors a ON a.threads_user_id = e.author_id
       WHERE e.threads_post_id = ? ORDER BY e.author_id`,
    ).bind(postId).all(), ["author_id", "profile_media_status"]);
    for (const author of authorRows) {
      if (typeof author.author_id !== "string" ||
        !["pending", "ready", "error"].includes(author.profile_media_status)) invalidStorage();
    }
    const profileIds = new Set(uniqueProfiles.map((item) => item.authorId));
    const leaseToken = `finalizing:${crypto.randomUUID()}`;
    const gate = finalizationGate();
    const statements = [db.prepare(
      `UPDATE threads_sync_jobs AS j SET status = 'media_pending', content_completed_at = ?,
         error_code = ?, updated_at = ?
       WHERE threads_post_id = ? AND generation = ?
         AND status IN ('queued','resolving','collecting')
         AND profile_cursor IS NULL AND conversation_cursor IS NULL
         AND pending_quote_count = 0
         AND EXISTS (
           SELECT 1 FROM threads_posts p WHERE p.id = j.threads_post_id
             AND p.sync_generation = j.generation AND p.status <> 'deleting'
         )`,
    ).bind(now, leaseToken, now, postId, generation)];
    for (const item of media) {
      statements.push(db.prepare(
        `INSERT INTO threads_media
           (id, entry_id, source_media_id, kind, ordinal, alt_text, status,
            created_at, updated_at)
         SELECT ?, e.id, ?, ?, ?, ?, 'pending', ?, ?
         FROM threads_entries e
         WHERE e.id = ? AND e.threads_post_id = ? AND ${gate}
         ON CONFLICT(entry_id, source_media_id, kind, ordinal) DO NOTHING`,
      ).bind(crypto.randomUUID(), item.sourceMediaId, item.kind, item.ordinal,
        item.altText ?? null, now, now, item.entryId, postId,
        leaseToken, postId, generation));
    }
    for (const author of authorRows) {
      if (!profileIds.has(author.author_id) && author.profile_media_status === "pending") {
        statements.push(db.prepare(
          `UPDATE threads_authors SET profile_media_status = 'error',
             profile_error_code = 'threads_profile_unavailable', updated_at = ?
           WHERE threads_user_id = ? AND profile_media_status = 'pending'
             AND ${gate}`,
        ).bind(now, author.author_id, leaseToken, postId, generation));
      }
    }
    statements.push(db.prepare(
      `UPDATE threads_posts SET status = 'collecting', error_code = NULL, updated_at = ?
       WHERE id = ? AND sync_generation = ? AND status <> 'deleting' AND ${gate}`,
    ).bind(now, postId, generation, leaseToken, postId, generation));
    statements.push(db.prepare(
      `UPDATE threads_sync_jobs SET
         expected_entry_count = (
           SELECT COUNT(*) FROM threads_entries WHERE threads_post_id = ?
         ),
         expected_media_count = (
           SELECT COUNT(*) FROM threads_media m JOIN threads_entries e ON e.id = m.entry_id
           WHERE e.threads_post_id = ?
         ) + (
           SELECT COUNT(DISTINCT author_id) FROM threads_entries WHERE threads_post_id = ?
         ), error_code = ?, updated_at = ?
       WHERE threads_post_id = ? AND generation = ? AND ${gate}`,
    ).bind(postId, postId, postId, state.error_code, now, postId, generation,
      leaseToken, postId, generation));
    const changes = mutationBatch(await db.batch(statements), statements.length);
    if (changes.some((count) => count > 1)) invalidStorage();
    if (changes[0] !== 1 || changes.at(-2) !== 1 || changes.at(-1) !== 1)
      return { status: "stale", ready: 0, failed: 0, expected: 0 };
    const mediaStart = 1;
    for (let index = 0; index < media.length; index += 1) {
      if (changes[mediaStart + index] !== 1) continue;
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
             updated_at = ? WHERE id = ? AND status = 'pending'
             AND EXISTS (
               SELECT 1 FROM threads_sync_jobs j JOIN threads_posts p
                 ON p.id = j.threads_post_id
               WHERE j.threads_post_id = ? AND j.generation = ?
                 AND j.status = 'media_pending' AND j.content_completed_at IS NOT NULL
                 AND j.profile_cursor IS NULL AND j.conversation_cursor IS NULL
                 AND j.pending_quote_count = 0 AND p.sync_generation = j.generation
                 AND p.status <> 'deleting'
             )`,
        ).bind(now, row.id, postId, generation).run());
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
           WHERE threads_user_id = ? AND profile_media_status = 'pending'
             AND EXISTS (
               SELECT 1 FROM threads_sync_jobs j JOIN threads_posts p
                 ON p.id = j.threads_post_id
               WHERE j.threads_post_id = ? AND j.generation = ?
                 AND j.status = 'media_pending' AND j.content_completed_at IS NOT NULL
                 AND j.profile_cursor IS NULL AND j.conversation_cursor IS NULL
                 AND j.pending_quote_count = 0 AND p.sync_generation = j.generation
                 AND p.status <> 'deleting'
             )`,
        ).bind(now, item.authorId, postId, generation).run());
        if (changed > 1) invalidStorage();
      }
    }
    return recalculateThreadsStatus(db, { postId, generation, nowSeconds: now });
  } catch (error) { throw storageError(error); }
}

/** @param {any} db @param {any} captureQueue @param {string} postId @param {number} nowSeconds */
export async function startThreadsDeletion(db, captureQueue, postId, nowSeconds) {
  requiredString(postId);
  const now = inputTimestamp(nowSeconds);
  try {
    const current = await db.prepare("SELECT status FROM threads_posts WHERE id = ?")
      .bind(postId).first();
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
