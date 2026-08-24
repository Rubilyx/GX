import { AppError } from "./domain.js";
import { extractThreadsLinks } from "./threads-domain.js";

export const POST_STATUSES = new Set([
  "pending", "collecting", "ready", "partial", "error", "deleting",
]);
export const JOB_STATUSES = new Set([
  "queued", "resolving", "collecting", "media_pending", "ready", "partial", "error",
]);
export const ACTIVE_JOBS = new Set(["queued", "resolving", "collecting", "media_pending"]);
export const MEDIA_TYPES = new Set([
  "TEXT_POST", "IMAGE", "VIDEO", "CAROUSEL_ALBUM", "REPOST_FACADE",
]);
export const MEDIA_KINDS = new Set(["image", "video", "video_thumbnail"]);
const MAX_CAPTURE_PAGES = 10_000;

/** @returns {never} */
export function invalidStorage() { throw new AppError("storage_unavailable", 503); }
/** @param {unknown} error */
export function storageError(error) {
  return error instanceof AppError ? error : new AppError("storage_unavailable", 503);
}
/** @param {unknown} value */
export function d1NonnegativeInteger(value) {
  if (!Number.isSafeInteger(value) || /** @type {number} */ (value) < 0) invalidStorage();
  return /** @type {number} */ (value);
}
/** @param {unknown} value */
export function inputPositiveInteger(value) {
  if (!Number.isSafeInteger(value) || /** @type {number} */ (value) < 1)
    throw new AppError("invalid_threads_state", 400);
  return /** @type {number} */ (value);
}
/** @param {unknown} value */
export function inputTimestamp(value) {
  if (!Number.isSafeInteger(value) || /** @type {number} */ (value) < 0)
    throw new AppError("invalid_threads_state", 400);
  return /** @type {number} */ (value);
}
/** @param {unknown} value @param {string[]} keys */
export function exactRow(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key))) invalidStorage();
  return /** @type {Record<string, any>} */ (value);
}
/** @param {unknown} value @param {string[]} keys */
export function selectRows(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    /** @type {any} */ (value).success !== true || !Array.isArray(/** @type {any} */ (value).results))
    invalidStorage();
  return /** @type {any[]} */ (/** @type {any} */ (value).results)
    .map((row) => exactRow(row, keys));
}
/** @param {unknown} value */
export function mutationChanges(value) {
  const changes = /** @type {any} */ (value)?.meta?.changes;
  if (/** @type {any} */ (value)?.success !== true || !Number.isSafeInteger(changes) || changes < 0)
    invalidStorage();
  return changes;
}
/** @param {unknown} value @param {number} expected */
export function mutationBatch(value, expected) {
  if (!Array.isArray(value) || value.length !== expected) invalidStorage();
  return value.map(mutationChanges);
}
/** @param {unknown} value */
export function requiredString(value) {
  if (typeof value !== "string" || !value) throw new AppError("invalid_threads_state", 400);
  return value.normalize("NFC");
}
/** @param {unknown} value */
export function nullableString(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new AppError("invalid_threads_state", 400);
  return value.normalize("NFC");
}
/** @param {unknown} value */
function canonicalProviderTimestamp(value) {
  if (typeof value !== "string") throw new AppError("threads_provider_protocol_error", 502);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new AppError("threads_provider_protocol_error", 502);
  return new Date(milliseconds).toISOString();
}
/** @param {unknown} value @returns {Record<string, any>} */
export function providerMedia(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AppError("threads_provider_protocol_error", 502);
  const media = /** @type {Record<string, any>} */ (value);
  if (typeof media.id !== "string" || !media.id || typeof media.ownerId !== "string" ||
    !media.ownerId || typeof media.username !== "string" || typeof media.text !== "string" ||
    typeof media.permalink !== "string" || !MEDIA_TYPES.has(media.mediaType) ||
    !Array.isArray(media.children) || !(media.quotedPostId === null ||
      typeof media.quotedPostId === "string" && media.quotedPostId))
    throw new AppError("threads_provider_protocol_error", 502);
  return /** @type {Record<string, any>} */ ({
    ...media, timestamp: canonicalProviderTimestamp(media.timestamp),
  });
}
/** @param {unknown} value */
export function providerProfile(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AppError("threads_provider_protocol_error", 502);
  const profile = /** @type {Record<string, any>} */ (value);
  if (typeof profile.id !== "string" || !profile.id || typeof profile.username !== "string" ||
    !profile.username || !(profile.name === null || typeof profile.name === "string") ||
    !(profile.profilePictureUrl === null || typeof profile.profilePictureUrl === "string"))
    throw new AppError("threads_provider_protocol_error", 502);
  return profile;
}

const MEDIA_DESCRIPTOR_KEYS = [
  "entrySourceMediaId", "sourceMediaId", "kind", "ordinal", "altText",
];
/** @param {unknown} value */
function mediaDescriptor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length !== MEDIA_DESCRIPTOR_KEYS.length ||
    Object.keys(value).some((key) => !MEDIA_DESCRIPTOR_KEYS.includes(key)))
    throw new AppError("invalid_threads_state", 400);
  const item = /** @type {Record<string, any>} */ (value);
  if (typeof item.entrySourceMediaId !== "string" || !item.entrySourceMediaId ||
    typeof item.sourceMediaId !== "string" || !item.sourceMediaId ||
    !MEDIA_KINDS.has(item.kind) || !Number.isSafeInteger(item.ordinal) || item.ordinal < 0 ||
    !(item.altText === null || typeof item.altText === "string"))
    throw new AppError("invalid_threads_state", 400);
  return {
    entrySourceMediaId: item.entrySourceMediaId.normalize("NFC"),
    sourceMediaId: item.sourceMediaId.normalize("NFC"), kind: item.kind,
    ordinal: item.ordinal, altText: item.altText === null ? null : item.altText.normalize("NFC"),
  };
}
/** @param {unknown} value */
function mediaDescriptors(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new AppError("invalid_threads_state", 400);
  return value.map(mediaDescriptor);
}
/** @param {unknown} value */
function boundedOptionalPermalink(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value || value.length > 4_096)
    throw new AppError("invalid_threads_state", 400);
  return value.normalize("NFC");
}

/** @param {any} db @param {Record<string, any>} profile @param {string} postId @param {number} generation @param {number} now @param {string | null} [requiredMediaId] @param {string | null} [workParentId] @param {string | null} [workClaim] @param {string | null} [captureLease] */
function authorStatement(db, profile, postId, generation, now, requiredMediaId = null,
  workParentId = null, workClaim = null, captureLease = null) {
  return db.prepare(
    `INSERT INTO threads_authors
       (threads_user_id, username, display_name, created_at, updated_at)
     SELECT ?, ?, ?, ?, ?
     WHERE EXISTS (
       SELECT 1 FROM threads_posts
       WHERE id = ? AND sync_generation = ? AND status <> 'deleting'
         AND (? IS NULL OR threads_media_id = ?)
         AND (? IS NULL OR EXISTS (
           SELECT 1 FROM threads_sync_jobs capture
           WHERE capture.threads_post_id = threads_posts.id
             AND capture.generation = ? AND capture.capture_lease = ?
         ))
         AND (? IS NULL OR EXISTS (
           SELECT 1 FROM threads_entries work
           WHERE work.id = ? AND work.threads_post_id = threads_posts.id
             AND work.quote_status = 'error' AND work.quote_error_code = ?
         ))
     )
     ON CONFLICT(threads_user_id) DO UPDATE SET
       username = excluded.username, display_name = excluded.display_name,
       profile_media_status = CASE
         WHEN threads_authors.profile_media_status = 'deleting' THEN 'deleting'
         ELSE 'pending' END,
       profile_error_code = CASE
         WHEN threads_authors.profile_media_status = 'deleting'
           THEN threads_authors.profile_error_code ELSE NULL END,
       updated_at = excluded.updated_at`,
  ).bind(profile.id, profile.username, profile.name ?? profile.username, now, now,
    postId, generation, requiredMediaId, requiredMediaId,
    captureLease, generation, captureLease,
    workClaim, workParentId, workClaim);
}
/** @param {any} db @param {Record<string, any>} entry @param {"root"|"author_reply"} kind @param {string} postId @param {number} generation @param {number} now @param {string | null} [requiredMediaId] @param {string} [entryId] @param {string | null} [captureLease] */
function primaryEntryStatement(db, entry, kind, postId, generation, now,
  requiredMediaId = null, entryId = crypto.randomUUID(), captureLease = null) {
  const quotedPostId = entry.quotedPostId ?? null;
  return db.prepare(
    `INSERT INTO threads_entries
       (id, threads_post_id, source_media_id, kind, author_id, text, permalink,
        published_at, media_type, alt_text, nested_quote_permalink,
        quoted_post_id, quote_status, quote_error_code, quote_generation,
        first_seen_at, last_seen_at, created_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?,
       CASE WHEN ? IS NULL THEN 'none' ELSE 'pending' END, NULL,
       CASE WHEN ? IS NULL THEN NULL ELSE ? END, ?, ?, ?
     WHERE EXISTS (
       SELECT 1 FROM threads_posts
       WHERE id = ? AND sync_generation = ? AND status <> 'deleting'
         AND (? IS NULL OR threads_media_id = ?)
         AND (? IS NULL OR EXISTS (
           SELECT 1 FROM threads_sync_jobs capture
           WHERE capture.threads_post_id = threads_posts.id
             AND capture.generation = ? AND capture.capture_lease = ?
         ))
     )
     ON CONFLICT(threads_post_id, source_media_id)
       WHERE kind IN ('root','author_reply')
     DO UPDATE SET last_seen_at = excluded.last_seen_at`,
  ).bind(
    entryId, postId, entry.id, kind, entry.ownerId, entry.text,
    entry.permalink, entry.timestamp, entry.mediaType, entry.altText ?? null,
    quotedPostId, quotedPostId, quotedPostId, generation, now, now, now,
    postId, generation, requiredMediaId, requiredMediaId,
    captureLease, generation, captureLease,
  );
}

/** @param {any} db @param {Record<string, any>} entry @param {"root"|"author_reply"} kind @param {string} postId @param {number} generation @param {number} now @param {string | null} [captureLease] */
function rearmQuoteStatements(db, entry, kind, postId, generation, now,
  captureLease = null) {
  if (!entry.quotedPostId) return [];
  const predicate = `EXISTS (
    SELECT 1 FROM threads_entries work
    WHERE work.threads_post_id = ? AND work.source_media_id = ? AND work.kind = ?
      AND work.quoted_post_id = ? AND work.quote_status IN ('pending','error')
      AND work.quote_generation <> ?
  ) AND EXISTS (
    SELECT 1 FROM threads_posts post
    WHERE post.id = ? AND post.sync_generation = ? AND post.status <> 'deleting'
      AND (? IS NULL OR EXISTS (
        SELECT 1 FROM threads_sync_jobs capture
        WHERE capture.threads_post_id = post.id AND capture.generation = ?
          AND capture.capture_lease = ?
      ))
  )`;
  return [
    db.prepare(
      `UPDATE threads_sync_jobs SET pending_quote_count = pending_quote_count + 1,
         updated_at = ?
       WHERE threads_post_id = ? AND generation = ?
         AND ${predicate}`,
    ).bind(now, postId, generation, postId, entry.id, kind, entry.quotedPostId,
      generation, postId, generation, captureLease, generation, captureLease),
    db.prepare(
      `UPDATE threads_entries SET quote_status = 'pending', quote_error_code = NULL,
         quote_generation = ?, last_seen_at = ?
       WHERE threads_post_id = ? AND source_media_id = ? AND kind = ?
         AND quoted_post_id = ? AND quote_status IN ('pending','error')
         AND quote_generation <> ?
         AND EXISTS (
           SELECT 1 FROM threads_posts post JOIN threads_sync_jobs job
             ON job.threads_post_id = post.id AND job.generation = post.sync_generation
           WHERE post.id = ? AND post.sync_generation = ? AND post.status <> 'deleting'
             AND (? IS NULL OR job.capture_lease = ?)
         )`,
    ).bind(generation, now, postId, entry.id, kind, entry.quotedPostId,
      generation, postId, generation, captureLease, captureLease),
  ];
}
/** @param {any} db @param {Record<string, any>} entry @param {string} kind @param {string} postId @param {number} generation @param {string | null} parentId @param {string | null} [requiredMediaId] @param {string | null} [workParentId] @param {string | null} [workClaim] @param {string | null} [captureLease] */
function linkStatements(db, entry, kind, postId, generation, parentId = null,
  requiredMediaId = null, workParentId = null, workClaim = null, captureLease = null) {
  return extractThreadsLinks(entry.text, entry.linkAttachmentUrl).map((link) => db.prepare(
    `INSERT INTO threads_links (id, entry_id, url, source, ordinal)
     SELECT ?, e.id, ?, ?, ? FROM threads_entries e
     WHERE e.threads_post_id = ? AND e.source_media_id = ? AND e.kind = ?
       AND (? IS NULL OR e.parent_entry_id = ?)
       AND EXISTS (
         SELECT 1 FROM threads_posts
         WHERE id = ? AND sync_generation = ? AND status <> 'deleting'
           AND (? IS NULL OR threads_media_id = ?)
           AND (? IS NULL OR EXISTS (
             SELECT 1 FROM threads_sync_jobs capture
             WHERE capture.threads_post_id = threads_posts.id
               AND capture.generation = ? AND capture.capture_lease = ?
           ))
           AND (? IS NULL OR EXISTS (
             SELECT 1 FROM threads_entries work
             WHERE work.id = ? AND work.threads_post_id = threads_posts.id
               AND work.quote_status = 'error' AND work.quote_error_code = ?
           ))
       )
     ON CONFLICT(entry_id, url) DO NOTHING`,
  ).bind(crypto.randomUUID(), link.url, link.source, link.ordinal,
    postId, entry.id, kind, parentId, parentId, postId, generation,
    requiredMediaId, requiredMediaId, captureLease, generation, captureLease,
    workClaim, workParentId, workClaim));
}

/** @param {any} db @param {Record<string, any>} item @param {"root"|"author_reply"|"quote"} entryKind @param {string} postId @param {number} generation @param {number} now @param {string | null} [parentId] @param {string | null} [requiredMediaId] @param {string | null} [workParentId] @param {string | null} [workClaim] @param {string | null} [captureLease] */
function pendingMediaStatement(db, item, entryKind, postId, generation, now,
  parentId = null, requiredMediaId = null, workParentId = null, workClaim = null,
  captureLease = null) {
  return db.prepare(
    `INSERT INTO threads_media
       (id, entry_id, source_media_id, kind, ordinal, alt_text, status,
        created_at, updated_at)
     SELECT ?, entry.id, ?, ?, ?, ?, 'pending', ?, ?
     FROM threads_entries entry
     WHERE entry.threads_post_id = ? AND entry.source_media_id = ? AND entry.kind = ?
       AND (? IS NULL OR entry.parent_entry_id = ?)
       AND EXISTS (
         SELECT 1 FROM threads_posts post
         WHERE post.id = ? AND post.sync_generation = ? AND post.status <> 'deleting'
           AND (? IS NULL OR post.threads_media_id = ?)
           AND (? IS NULL OR EXISTS (
             SELECT 1 FROM threads_sync_jobs capture
             WHERE capture.threads_post_id = post.id AND capture.generation = ?
               AND capture.capture_lease = ?
           ))
           AND (? IS NULL OR EXISTS (
             SELECT 1 FROM threads_entries work
             WHERE work.id = ? AND work.threads_post_id = post.id
               AND work.quote_status = 'error' AND work.quote_error_code = ?
           ))
       )
     ON CONFLICT(entry_id, source_media_id, kind, ordinal) DO NOTHING`,
  ).bind(
    crypto.randomUUID(), item.sourceMediaId, item.kind, item.ordinal, item.altText,
    now, now, postId, item.entrySourceMediaId, entryKind, parentId, parentId,
    postId, generation, requiredMediaId, requiredMediaId,
    captureLease, generation, captureLease,
    workClaim, workParentId, workClaim,
  );
}

/** @param {any} db @param {string} postId @param {number} generation @param {"root"|"author_reply"} kind @param {Record<string, any>[]} entries */
async function pendingQuoteWork(db, postId, generation, kind, entries) {
  const sourceIds = [...new Set(entries.map((entry) => entry.id))];
  if (sourceIds.length === 0) return [];
  const rows = selectRows(await db.prepare(
    `SELECT id AS parent_entry_id, source_media_id, quoted_post_id
     FROM threads_entries
     WHERE threads_post_id = ? AND kind = ? AND quote_status = 'pending'
       AND quote_generation = ?
       AND source_media_id IN (${sourceIds.map(() => "?").join(",")})`,
  ).bind(postId, kind, generation, ...sourceIds).all(), [
    "parent_entry_id", "source_media_id", "quoted_post_id",
  ]);
  const bySource = new Map();
  for (const row of rows) {
    if (typeof row.parent_entry_id !== "string" || !row.parent_entry_id ||
      typeof row.source_media_id !== "string" || !row.source_media_id ||
      typeof row.quoted_post_id !== "string" || !row.quoted_post_id) invalidStorage();
    bySource.set(row.source_media_id, {
      parentEntryId: row.parent_entry_id, quoteId: row.quoted_post_id,
    });
  }
  return sourceIds.flatMap((sourceId) => bySource.has(sourceId) ? [bySource.get(sourceId)] : []);
}

/** @param {any} db @param {{ postId: string, generation: number }} input */
export async function listThreadsPendingQuoteWork(db, input) {
  const postId = requiredString(input?.postId);
  const generation = inputPositiveInteger(input?.generation);
  try {
    const rows = selectRows(await db.prepare(
      `SELECT entry.id AS parent_entry_id, entry.quoted_post_id
       FROM threads_entries entry
       JOIN threads_posts post ON post.id = entry.threads_post_id
       JOIN threads_sync_jobs job ON job.threads_post_id = post.id
         AND job.generation = post.sync_generation
       WHERE entry.threads_post_id = ? AND entry.kind IN ('root','author_reply')
         AND entry.quote_status = 'pending' AND entry.quote_generation = ?
         AND job.generation = ? AND post.sync_generation = ? AND post.status <> 'deleting'
         AND job.profile_completed = 1 AND job.conversation_started = 1
         AND job.capture_lease IS NULL
       ORDER BY entry.id, entry.quoted_post_id`,
    ).bind(postId, generation, generation, generation).all(), [
      "parent_entry_id", "quoted_post_id",
    ]);
    return rows.map((row) => {
      if (typeof row.parent_entry_id !== "string" || !row.parent_entry_id ||
        typeof row.quoted_post_id !== "string" || !row.quoted_post_id) invalidStorage();
      return { parentEntryId: row.parent_entry_id, quoteId: row.quoted_post_id };
    });
  } catch (error) { throw storageError(error); }
}

const CANDIDATE_KEYS = [
  "id", "threads_media_id", "sync_generation", "status", "created_at",
  "job_generation", "job_status",
];
/** @param {any} row */
function candidateRow(row) {
  row = exactRow(row, CANDIDATE_KEYS);
  if (typeof row.id !== "string" || !row.id ||
    !(row.threads_media_id === null || typeof row.threads_media_id === "string") ||
    !Number.isSafeInteger(row.sync_generation) || row.sync_generation < 1 ||
    !POST_STATUSES.has(row.status) || !Number.isSafeInteger(row.job_generation) ||
    row.job_generation < 1 || !JOB_STATUSES.has(row.job_status)) invalidStorage();
  d1NonnegativeInteger(row.created_at);
  return row;
}
/** @param {any} left @param {any} right */
function precedes(left, right) {
  return left.created_at < right.created_at ||
    (left.created_at === right.created_at && left.id.localeCompare(right.id) < 0);
}
/** @param {any} db @param {string} postId @param {number} generation @param {number} now */
function duplicateStatements(db, postId, generation, now) {
  return [
    db.prepare(
      `UPDATE threads_sync_jobs SET status = 'error',
         error_code = 'threads_archive_duplicate', completed_at = ?, updated_at = ?
       WHERE threads_post_id = ? AND generation = ?
         AND EXISTS (
           SELECT 1 FROM threads_posts
           WHERE id = ? AND sync_generation = ? AND status <> 'deleting'
         )`,
    ).bind(now, now, postId, generation, postId, generation),
    db.prepare(
      `UPDATE threads_posts SET status = 'error',
         error_code = 'threads_archive_duplicate', updated_at = ?
       WHERE id = ? AND sync_generation = ? AND status <> 'deleting'`,
    ).bind(now, postId, generation),
  ];
}
/** @param {any} db @param {any} winner @param {any} loser @param {string} providerId @param {string} claim @param {number} now @param {string} captureLease */
function ownerCorrectionStatements(db, winner, loser, providerId, claim, now,
  captureLease) {
  const winnerClaim = `EXISTS (
    SELECT 1 FROM threads_posts winner
    JOIN threads_sync_jobs winner_job
      ON winner_job.threads_post_id = winner.id
      AND winner_job.generation = winner.sync_generation
    WHERE winner.id = ? AND winner.threads_media_id = ?
      AND winner.sync_generation = ? AND winner.status <> 'deleting'
      AND winner_job.status IN ('queued','resolving','collecting')
      AND winner_job.capture_lease = ?
  )`;
  return [
    db.prepare(
      `UPDATE threads_posts AS winner SET threads_media_id = ?
       WHERE id = ? AND threads_media_id IS NULL AND sync_generation = ? AND status = ?
         AND status <> 'deleting'
         AND EXISTS (
           SELECT 1 FROM threads_sync_jobs winner_job
           WHERE winner_job.threads_post_id = winner.id
             AND winner_job.generation = ? AND winner_job.generation = winner.sync_generation
             AND winner_job.status = ?
             AND winner_job.status IN ('queued','resolving','collecting')
             AND winner_job.capture_lease = ?
         )
         AND EXISTS (
           SELECT 1 FROM threads_posts loser
           JOIN threads_sync_jobs loser_job
             ON loser_job.threads_post_id = loser.id
             AND loser_job.generation = loser.sync_generation
           WHERE loser.id = ? AND loser.threads_media_id = ?
             AND loser.sync_generation = ? AND loser.status = ?
             AND loser.status <> 'deleting'
             AND loser_job.generation = ? AND loser_job.status = ?
         )`,
    ).bind(claim, winner.id, winner.sync_generation, winner.status,
      winner.job_generation, winner.job_status, captureLease,
      loser.id, providerId, loser.sync_generation, loser.status,
      loser.job_generation, loser.job_status),
    db.prepare(
      `UPDATE threads_sync_jobs SET status = 'error',
         error_code = 'threads_archive_duplicate', completed_at = ?, updated_at = ?
       WHERE threads_post_id = ? AND generation = ?
         AND EXISTS (
           SELECT 1 FROM threads_posts loser
           WHERE loser.id = ? AND loser.threads_media_id = ?
             AND loser.sync_generation = ? AND loser.status <> 'deleting'
         ) AND ${winnerClaim}`,
    ).bind(now, now, loser.id, loser.sync_generation,
      loser.id, providerId, loser.sync_generation,
      winner.id, claim, winner.sync_generation, captureLease),
    db.prepare(
      `UPDATE threads_posts SET status = 'error',
         error_code = 'threads_archive_duplicate', updated_at = ?
       WHERE id = ? AND threads_media_id = ? AND sync_generation = ?
         AND status <> 'deleting' AND ${winnerClaim}`,
    ).bind(now, loser.id, providerId, loser.sync_generation,
      winner.id, claim, winner.sync_generation, captureLease),
    db.prepare(
      `UPDATE threads_posts SET threads_media_id = NULL
       WHERE id = ? AND threads_media_id = ? AND sync_generation = ?
         AND status = 'error' AND error_code = 'threads_archive_duplicate'
         AND ${winnerClaim}`,
    ).bind(loser.id, providerId, loser.sync_generation,
      winner.id, claim, winner.sync_generation, captureLease),
  ];
}
/** @param {any} db @param {string} postId @param {number} generation @param {number} now */
export async function markDuplicateArchive(db, postId, generation, now) {
  const changes = mutationBatch(await db.batch(
    duplicateStatements(db, postId, generation, now),
  ), 2);
  if (changes.some((count) => count > 1) || changes[0] !== changes[1]) invalidStorage();
  return changes[0] === 1;
}

/** @param {any} db @param {{ postId: string, generation: number, expectedProfileCursor?: string | null, profile: unknown, root: unknown, profileCursor?: string | null, conversationCursor?: string | null, media?: unknown[], nowSeconds: number }} input */
export async function saveResolvedThreadsRoot(db, input) {
  const postId = requiredString(input?.postId);
  const generation = inputPositiveInteger(input?.generation);
  const expectedCursor = nullableString(input?.expectedProfileCursor);
  nullableString(input?.profileCursor); nullableString(input?.conversationCursor);
  const now = inputTimestamp(input?.nowSeconds);
  const profile = providerProfile(input?.profile);
  const root = providerMedia(input?.root);
  if (profile.id !== root.ownerId) throw new AppError("threads_provider_protocol_error", 502);
  const media = mediaDescriptors(input?.media);
  if (media.some((item) => item.entrySourceMediaId !== root.id))
    throw new AppError("invalid_threads_state", 400);
  try {
    const candidates = selectRows(await db.prepare(
      `SELECT p.id, p.threads_media_id, p.sync_generation, p.status, p.created_at,
         j.generation AS job_generation, j.status AS job_status
       FROM threads_posts p LEFT JOIN threads_sync_jobs j
         ON j.threads_post_id = p.id AND j.generation = p.sync_generation
       WHERE p.id = ? OR p.threads_media_id = ? ORDER BY p.created_at, p.id`,
    ).bind(postId, root.id).all(), CANDIDATE_KEYS).map(candidateRow);
    const current = candidates.find((row) => row.id === postId);
    if (!current || current.sync_generation !== generation || current.status === "deleting")
      return { applied: false, quoteWork: [] };
    const owner = candidates.find((row) => row.id !== postId && row.threads_media_id === root.id);
    const captureLease = `capture:${crypto.randomUUID()}`;
    const ownerPredicate = owner ? `AND EXISTS (
      SELECT 1 FROM threads_posts owner_post JOIN threads_sync_jobs owner_job
        ON owner_job.threads_post_id = owner_post.id
        AND owner_job.generation = owner_post.sync_generation
      WHERE owner_post.id = ? AND owner_post.threads_media_id = ?
        AND owner_post.sync_generation = ? AND owner_post.status = ?
        AND owner_job.generation = ? AND owner_job.status = ?
    )` : `AND NOT EXISTS (
      SELECT 1 FROM threads_posts owner_post
      WHERE owner_post.threads_media_id = ? AND owner_post.id <> ?
    )`;
    const leaseBindings = owner ? [
      owner.id, root.id, owner.sync_generation, owner.status,
      owner.job_generation, owner.job_status,
    ] : [root.id, postId];
    const leaseStatement = db.prepare(
      `UPDATE threads_sync_jobs AS job SET capture_lease = ?, updated_at = ?
       WHERE threads_post_id = ? AND generation = ? AND status = ?
         AND status IN ('queued','resolving','collecting')
         AND profile_completed = 0 AND capture_lease IS NULL AND profile_cursor IS ?
         AND profile_page_count < ${MAX_CAPTURE_PAGES}
         AND EXISTS (
           SELECT 1 FROM threads_posts current_post
           WHERE current_post.id = job.threads_post_id
             AND current_post.sync_generation = job.generation
             AND current_post.status = ? AND current_post.status <> 'deleting'
             AND current_post.threads_media_id IS ?
             AND (current_post.threads_media_id IS NULL OR current_post.threads_media_id = ?)
             ${ownerPredicate}
         )`,
    ).bind(captureLease, now, postId, generation, current.job_status, expectedCursor,
      current.status, current.threads_media_id, root.id, ...leaseBindings);
    if (owner && precedes(owner, current)) {
      const statements = [
        leaseStatement,
        db.prepare(
          `UPDATE threads_posts SET status = 'error',
             error_code = 'threads_archive_duplicate', updated_at = ?
           WHERE id = ? AND sync_generation = ? AND status <> 'deleting'
             AND EXISTS (
               SELECT 1 FROM threads_sync_jobs job
               WHERE job.threads_post_id = threads_posts.id AND job.generation = ?
                 AND job.capture_lease = ?
             )`,
        ).bind(now, postId, generation, generation, captureLease),
        db.prepare(
          `UPDATE threads_sync_jobs SET status = 'error', capture_lease = NULL,
             error_code = 'threads_archive_duplicate', completed_at = ?, updated_at = ?
           WHERE threads_post_id = ? AND generation = ? AND capture_lease = ?`,
        ).bind(now, now, postId, generation, captureLease),
      ];
      const changes = mutationBatch(await db.batch(statements), statements.length);
      if (changes.some((count) => count > 1)) invalidStorage();
      if (changes[0] === 0) {
        if (changes.some((count) => count !== 0)) invalidStorage();
      } else if (changes.some((count) => count !== 1)) invalidStorage();
      return { applied: false, quoteWork: [] };
    }
    const claim = owner ? `claim:${root.id}` : null;
    const correction = owner ? ownerCorrectionStatements(
      db, current, owner, root.id, /** @type {string} */ (claim), now, captureLease,
    ) : [];
    const postStatement = owner ? db.prepare(
      `UPDATE threads_posts AS winner SET canonical_url = ?, root_author_id = ?,
         status = 'collecting', error_code = NULL, updated_at = ?
       WHERE id = ? AND threads_media_id = ? AND sync_generation = ?
         AND status <> 'deleting' AND EXISTS (
           SELECT 1 FROM threads_sync_jobs winner_job
           WHERE winner_job.threads_post_id = winner.id
             AND winner_job.generation = winner.sync_generation
             AND winner_job.capture_lease = ?
         )`,
    ).bind(root.permalink, profile.id, now, postId, claim, generation,
      captureLease) : db.prepare(
      `UPDATE threads_posts SET threads_media_id = ?, canonical_url = ?, root_author_id = ?,
         status = 'collecting', error_code = NULL, updated_at = ?
       WHERE id = ? AND sync_generation = ? AND status <> 'deleting'
         AND (threads_media_id IS NULL OR threads_media_id = ?)
         AND NOT EXISTS (
           SELECT 1 FROM threads_posts other
           WHERE other.threads_media_id = ? AND other.id <> ?
         ) AND EXISTS (
           SELECT 1 FROM threads_sync_jobs job
           WHERE job.threads_post_id = threads_posts.id AND job.generation = ?
             AND job.capture_lease = ?
         )`,
    ).bind(root.id, root.permalink, profile.id, now, postId, generation,
      root.id, root.id, postId, generation, captureLease);
    const requiredIdentity = owner ? claim : root.id;
    const rootEntryId = crypto.randomUUID();
    const quoteRearm = rearmQuoteStatements(
      db, root, "root", postId, generation, now, captureLease,
    );
    const statements = [
      leaseStatement,
      ...correction,
      authorStatement(db, profile, postId, generation, now, claim, null, null,
        captureLease),
      postStatement,
      primaryEntryStatement(
        db, root, "root", postId, generation, now, claim, rootEntryId, captureLease,
      ),
      ...quoteRearm,
      ...(root.quotedPostId ? [db.prepare(
        `UPDATE threads_sync_jobs SET pending_quote_count = pending_quote_count + 1,
           updated_at = ?
         WHERE threads_post_id = ? AND generation = ? AND capture_lease = ?
           AND EXISTS (
             SELECT 1 FROM threads_entries
             WHERE id = ? AND threads_post_id = ? AND kind = 'root'
               AND quoted_post_id = ? AND quote_status = 'pending'
               AND quote_generation = ?
           )`,
      ).bind(now, postId, generation, captureLease, rootEntryId, postId,
        root.quotedPostId, generation)] : []),
      ...linkStatements(db, root, "root", postId, generation, null, claim,
        null, null, captureLease),
      ...media.map((item) => pendingMediaStatement(
        db, item, "root", postId, generation, now, null, claim,
        null, null, captureLease,
      )),
      ...(owner ? [db.prepare(
        `UPDATE threads_posts AS winner SET threads_media_id = ?
         WHERE id = ? AND threads_media_id = ? AND sync_generation = ?
           AND status = 'collecting' AND error_code IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM threads_posts other
             WHERE other.threads_media_id = ? AND other.id <> winner.id
           ) AND EXISTS (
             SELECT 1 FROM threads_sync_jobs winner_job
             WHERE winner_job.threads_post_id = winner.id
               AND winner_job.generation = winner.sync_generation
               AND winner_job.capture_lease = ?
           )`,
      ).bind(root.id, postId, claim, generation, root.id, captureLease)] : []),
      db.prepare(
        `INSERT INTO threads_sync_cursors
           (threads_post_id, generation, phase, cursor, page_number, created_at)
         SELECT threads_post_id, generation, 'conversation', NULL, 1, ?
         FROM threads_sync_jobs
         WHERE threads_post_id = ? AND generation = ? AND capture_lease = ?
         ON CONFLICT DO NOTHING`,
      ).bind(now, postId, generation, captureLease),
      db.prepare(
        `UPDATE threads_sync_jobs SET status = 'collecting', profile_completed = 1,
           profile_page_count = profile_page_count + 1,
           profile_cursor = NULL, conversation_started = 0,
           conversation_completed = 0, conversation_cursor = NULL,
           capture_lease = NULL, updated_at = ?
         WHERE threads_post_id = ? AND generation = ? AND capture_lease = ?
           AND EXISTS (
             SELECT 1 FROM threads_posts post JOIN threads_entries entry
               ON entry.threads_post_id = post.id
             WHERE post.id = ? AND post.sync_generation = ?
               AND post.status <> 'deleting' AND post.threads_media_id = ?
               AND entry.source_media_id = ? AND entry.kind = 'root'
           )`,
      ).bind(now, postId, generation, captureLease, postId, generation,
        root.id, root.id),
    ];
    const changes = mutationBatch(await db.batch(statements), statements.length);
    if (changes.some((count) => count > 1)) invalidStorage();
    if (changes[0] === 0) {
      if (changes.some((count) => count !== 0)) invalidStorage();
      return { applied: false, quoteWork: [] };
    }
    const base = 1 + correction.length;
    for (const index of [0, base, base + 1, base + 2, changes.length - 1])
      if (changes[index] !== 1) invalidStorage();
    if (owner) {
      for (let index = 1; index <= correction.length; index += 1)
        if (changes[index] !== 1) invalidStorage();
      if (changes.at(-3) !== 1) invalidStorage();
    }
    if (changes.at(-2) !== 1) invalidStorage();
    if (quoteRearm.length && changes[base + 3] !== changes[base + 4]) invalidStorage();
    return { applied: true,
      quoteWork: await pendingQuoteWork(db, postId, generation, "root", [root]) };
  } catch (error) { throw storageError(error); }
}

/** @param {any} db @param {{ postId: string, generation: number, expectedCursor?: string | null, entries: unknown[], nextCursor?: string | null, media?: unknown[], nowSeconds: number }} input */
export async function saveThreadsConversationPage(db, input) {
  const postId = requiredString(input?.postId);
  const generation = inputPositiveInteger(input?.generation);
  const now = inputTimestamp(input?.nowSeconds);
  const expectedCursor = nullableString(input?.expectedCursor);
  if (!Array.isArray(input?.entries)) throw new AppError("invalid_threads_state", 400);
  const entries = input.entries.map(providerMedia);
  const media = mediaDescriptors(input?.media);
  const inputSources = new Set(entries.map((entry) => entry.id));
  if (media.some((item) => !inputSources.has(item.entrySourceMediaId)))
    throw new AppError("invalid_threads_state", 400);
  const nextCursor = nullableString(input?.nextCursor);
  try {
    const post = await db.prepare(
      "SELECT root_author_id FROM threads_posts WHERE id = ? AND sync_generation = ? AND status <> 'deleting'",
    ).bind(postId, generation).first();
    if (post === null)
      return { applied: false, accepted: 0, nextCursor, quoteWork: [] };
    const root = exactRow(post, ["root_author_id"]);
    if (typeof root.root_author_id !== "string" || !root.root_author_id) invalidStorage();
    const accepted = entries.filter((entry) => entry.ownerId === root.root_author_id);
    const acceptedSources = new Set(accepted.map((entry) => entry.id));
    if (media.some((item) => !acceptedSources.has(item.entrySourceMediaId)))
      throw new AppError("invalid_threads_state", 400);
    const captureLease = `capture:${crypto.randomUUID()}`;
    const statements = [db.prepare(
      `UPDATE threads_sync_jobs AS job SET capture_lease = ?, updated_at = ?
       WHERE threads_post_id = ? AND generation = ? AND status = 'collecting'
         AND profile_completed = 1 AND conversation_completed = 0
         AND capture_lease IS NULL AND conversation_cursor IS ?
         AND conversation_page_count < ${MAX_CAPTURE_PAGES}
         AND (? IS NULL OR NOT EXISTS (
           SELECT 1 FROM threads_sync_cursors seen
           WHERE seen.threads_post_id = job.threads_post_id
             AND seen.generation = job.generation AND seen.phase = 'conversation'
             AND seen.cursor = ?
         ))
         AND EXISTS (
           SELECT 1 FROM threads_posts post
           WHERE post.id = job.threads_post_id AND post.sync_generation = job.generation
             AND post.status <> 'deleting'
         )`,
    ).bind(captureLease, now, postId, generation, expectedCursor,
      nextCursor, nextCursor)];
    const rearmStarts = [];
    for (const entry of accepted) {
      const entryId = crypto.randomUUID();
      statements.push(primaryEntryStatement(
        db, entry, "author_reply", postId, generation, now, null, entryId,
        captureLease,
      ));
      const quoteRearm = rearmQuoteStatements(
        db, entry, "author_reply", postId, generation, now, captureLease,
      );
      if (quoteRearm.length) rearmStarts.push(statements.length);
      statements.push(...quoteRearm);
      if (entry.quotedPostId) statements.push(db.prepare(
        `UPDATE threads_sync_jobs SET pending_quote_count = pending_quote_count + 1,
           updated_at = ?
         WHERE threads_post_id = ? AND generation = ? AND capture_lease = ?
           AND EXISTS (
             SELECT 1 FROM threads_entries
             WHERE id = ? AND threads_post_id = ? AND kind = 'author_reply'
               AND quoted_post_id = ? AND quote_status = 'pending'
           )
           AND EXISTS (
             SELECT 1 FROM threads_posts WHERE id = ? AND sync_generation = ?
               AND status <> 'deleting'
           )`,
      ).bind(now, postId, generation, captureLease,
        entryId, postId, entry.quotedPostId,
        postId, generation));
      statements.push(...linkStatements(
        db, entry, "author_reply", postId, generation, null, null, null, null,
        captureLease,
      ));
    }
    for (const item of media) statements.push(pendingMediaStatement(
      db, item, "author_reply", postId, generation, now,
      null, null, null, null, captureLease,
    ));
    if (nextCursor !== null) statements.push(db.prepare(
      `INSERT INTO threads_sync_cursors
         (threads_post_id, generation, phase, cursor, page_number, created_at)
       SELECT job.threads_post_id, job.generation, 'conversation', ?,
         job.conversation_page_count + 2, ?
       FROM threads_sync_jobs job JOIN threads_posts post
         ON post.id = job.threads_post_id
       WHERE job.threads_post_id = ? AND job.generation = ?
         AND job.capture_lease = ? AND job.conversation_cursor IS ?
         AND post.sync_generation = job.generation AND post.status <> 'deleting'
       ON CONFLICT DO NOTHING`,
    ).bind(nextCursor, now, postId, generation, captureLease, expectedCursor));
    statements.push(db.prepare(
      `UPDATE threads_sync_jobs SET status = 'collecting', conversation_started = 1,
         conversation_completed = ?, conversation_cursor = ?,
         conversation_page_count = conversation_page_count + 1, capture_lease = NULL,
         updated_at = ?
       WHERE threads_post_id = ? AND generation = ? AND capture_lease = ?
         AND EXISTS (
           SELECT 1 FROM threads_posts
           WHERE id = ? AND sync_generation = ? AND status <> 'deleting'
         )`,
    ).bind(nextCursor === null ? 1 : 0, nextCursor, now, postId, generation,
      captureLease, postId, generation));
    const changes = mutationBatch(await db.batch(statements), statements.length);
    if (changes.some((count) => count > 1)) invalidStorage();
    if (changes[0] === 0) {
      if (changes.some((count) => count !== 0)) invalidStorage();
      const state = await db.prepare(
        `SELECT job.status, job.profile_completed, job.conversation_completed,
           job.capture_lease, job.conversation_cursor, job.conversation_page_count,
           CASE WHEN ? IS NULL THEN 0 ELSE EXISTS (
             SELECT 1 FROM threads_sync_cursors seen
             WHERE seen.threads_post_id = job.threads_post_id
               AND seen.generation = job.generation AND seen.phase = 'conversation'
               AND seen.cursor = ?
           ) END AS cursor_seen
         FROM threads_sync_jobs job JOIN threads_posts post
           ON post.id = job.threads_post_id
         WHERE job.threads_post_id = ? AND job.generation = ?
           AND post.sync_generation = job.generation AND post.status <> 'deleting'`,
      ).bind(nextCursor, nextCursor, postId, generation).first();
      if (state !== null) {
        const row = exactRow(state, ["status", "profile_completed",
          "conversation_completed", "capture_lease", "conversation_cursor",
          "conversation_page_count", "cursor_seen"]);
        const pageCount = d1NonnegativeInteger(row.conversation_page_count);
        if (row.status === "collecting" && row.profile_completed === 1 &&
          row.conversation_completed === 0 && row.capture_lease === null &&
          row.conversation_cursor === expectedCursor &&
          (pageCount >= MAX_CAPTURE_PAGES || row.cursor_seen === 1))
          throw new AppError("threads_provider_protocol_error", 502);
      }
      return { applied: false, accepted: 0, nextCursor, quoteWork: [] };
    }
    if (changes.at(-1) !== 1) invalidStorage();
    if (nextCursor !== null && changes.at(-2) !== 1) invalidStorage();
    for (const start of rearmStarts)
      if (changes[start] !== changes[start + 1]) invalidStorage();
    return { applied: true, accepted: accepted.length, nextCursor,
      quoteWork: await pendingQuoteWork(
        db, postId, generation, "author_reply", accepted,
      ) };
  } catch (error) { throw storageError(error); }
}

/** @param {any} db @param {{ postId: string, generation: number, parentEntryId: string, profile: unknown, quote: unknown, nestedQuotePermalink?: string | null, media?: unknown[], nowSeconds: number }} input */
export async function saveThreadsQuote(db, input) {
  const postId = requiredString(input?.postId);
  const parentId = requiredString(input?.parentEntryId);
  const generation = inputPositiveInteger(input?.generation);
  const now = inputTimestamp(input?.nowSeconds);
  const profile = providerProfile(input?.profile);
  const quote = providerMedia(input?.quote);
  if (profile.id !== quote.ownerId) throw new AppError("threads_provider_protocol_error", 502);
  const nestedQuotePermalink = boundedOptionalPermalink(input?.nestedQuotePermalink);
  const media = mediaDescriptors(input?.media);
  if (media.some((item) => item.entrySourceMediaId !== quote.id))
    throw new AppError("invalid_threads_state", 400);
  try {
    const claim = `claim:${crypto.randomUUID()}`;
    const statements = [
      db.prepare(
        `UPDATE threads_entries AS parent SET
           quote_status = 'error', quote_error_code = ?
         WHERE id = ? AND threads_post_id = ? AND kind IN ('root','author_reply')
           AND quoted_post_id = ? AND quote_status = 'pending' AND quote_error_code IS NULL
           AND quote_generation = ?
           AND EXISTS (
             SELECT 1 FROM threads_sync_jobs job
             JOIN threads_posts post ON post.id = job.threads_post_id
             WHERE job.threads_post_id = ? AND job.generation = ?
               AND job.pending_quote_count > 0
               AND job.profile_completed = 1 AND job.conversation_started = 1
               AND job.capture_lease IS NULL
               AND post.sync_generation = job.generation AND post.status <> 'deleting'
           )`,
      ).bind(claim, parentId, postId, quote.id, generation, postId, generation),
      authorStatement(db, profile, postId, generation, now, null, parentId, claim),
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
           AND parent.quoted_post_id = ? AND parent.quote_status = 'error'
           AND parent.quote_error_code = ? AND parent.quote_generation = ?
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
        nestedQuotePermalink, now, now, now,
        parentId, postId, quote.id, claim, generation, postId, generation,
      ),
      ...linkStatements(db, quote, "quote", postId, generation, parentId,
        null, parentId, claim),
      ...media.map((item) => pendingMediaStatement(
        db, item, "quote", postId, generation, now, parentId, null, parentId, claim,
      )),
      db.prepare(
        `UPDATE threads_sync_jobs SET pending_quote_count = pending_quote_count - 1,
           updated_at = ?
         WHERE threads_post_id = ? AND generation = ? AND pending_quote_count > 0
           AND EXISTS (
             SELECT 1 FROM threads_entries parent
             WHERE parent.id = ? AND parent.threads_post_id = ?
               AND parent.quoted_post_id = ? AND parent.quote_status = 'error'
               AND parent.quote_error_code = ? AND parent.quote_generation = ?
           )
           AND EXISTS (
             SELECT 1 FROM threads_posts
             WHERE id = ? AND sync_generation = ? AND status <> 'deleting'
           )`,
      ).bind(now, postId, generation, parentId, postId, quote.id, claim, generation,
        postId, generation),
      db.prepare(
        `UPDATE threads_entries AS parent SET quote_status = 'ready', quote_error_code = NULL
         WHERE id = ? AND threads_post_id = ? AND kind IN ('root','author_reply')
           AND quoted_post_id = ? AND quote_status = 'error' AND quote_error_code = ?
           AND quote_generation = ?
           AND EXISTS (
             SELECT 1 FROM threads_entries quote
             WHERE quote.threads_post_id = parent.threads_post_id
               AND quote.parent_entry_id = parent.id AND quote.source_media_id = ?
               AND quote.kind = 'quote'
           )
           AND EXISTS (
             SELECT 1 FROM threads_sync_jobs job
             JOIN threads_posts post ON post.id = job.threads_post_id
             WHERE job.threads_post_id = ? AND job.generation = ?
               AND job.profile_completed = 1 AND job.conversation_started = 1
               AND job.capture_lease IS NULL
               AND post.sync_generation = job.generation AND post.status <> 'deleting'
           )`,
      ).bind(parentId, postId, quote.id, claim, generation, quote.id, postId, generation),
    ];
    const changes = mutationBatch(await db.batch(statements), statements.length);
    if (changes.some((count) => count > 1)) invalidStorage();
    if (changes[0] === 0) {
      if (changes.some((count) => count !== 0)) invalidStorage();
      return false;
    }
    const decrement = changes.length - 2;
    for (const index of [0, 1, 2, decrement, changes.length - 1])
      if (changes[index] !== 1) invalidStorage();
    return true;
  } catch (error) { throw storageError(error); }
}

/** @param {any} db @param {{ postId: string, generation: number, parentEntryId: string, quoteId: string, errorCode: string, nowSeconds: number }} input */
export async function failThreadsQuote(db, input) {
  const postId = requiredString(input?.postId);
  const generation = inputPositiveInteger(input?.generation);
  const parentId = requiredString(input?.parentEntryId);
  const quoteId = requiredString(input?.quoteId);
  const errorCode = requiredString(input?.errorCode);
  const now = inputTimestamp(input?.nowSeconds);
  try {
    const claim = `claim:${crypto.randomUUID()}`;
    const statements = [
      db.prepare(
        `UPDATE threads_entries AS parent SET quote_status = 'error', quote_error_code = ?
         WHERE id = ? AND threads_post_id = ? AND kind IN ('root','author_reply')
           AND quoted_post_id = ? AND quote_status = 'pending' AND quote_error_code IS NULL
           AND quote_generation = ?
           AND EXISTS (
             SELECT 1 FROM threads_sync_jobs job
             JOIN threads_posts post ON post.id = job.threads_post_id
             WHERE job.threads_post_id = ? AND job.generation = ?
               AND job.pending_quote_count > 0
               AND job.profile_completed = 1 AND job.conversation_started = 1
               AND job.capture_lease IS NULL
               AND post.sync_generation = job.generation AND post.status <> 'deleting'
           )`,
      ).bind(claim, parentId, postId, quoteId, generation, postId, generation),
      db.prepare(
        `UPDATE threads_sync_jobs SET pending_quote_count = pending_quote_count - 1,
           updated_at = ?
         WHERE threads_post_id = ? AND generation = ? AND pending_quote_count > 0
           AND EXISTS (
             SELECT 1 FROM threads_entries parent
             WHERE parent.id = ? AND parent.threads_post_id = ?
               AND parent.quoted_post_id = ? AND parent.quote_status = 'error'
               AND parent.quote_error_code = ? AND parent.quote_generation = ?
           )
           AND EXISTS (
             SELECT 1 FROM threads_posts
             WHERE id = ? AND sync_generation = ? AND status <> 'deleting'
           )`,
      ).bind(now, postId, generation, parentId, postId, quoteId, claim, generation,
        postId, generation),
      db.prepare(
        `UPDATE threads_entries AS parent SET quote_error_code = ?
         WHERE id = ? AND threads_post_id = ? AND quoted_post_id = ?
           AND quote_status = 'error' AND quote_error_code = ?
           AND quote_generation = ?
           AND EXISTS (
             SELECT 1 FROM threads_sync_jobs job
             JOIN threads_posts post ON post.id = job.threads_post_id
             WHERE job.threads_post_id = ? AND job.generation = ?
               AND job.profile_completed = 1 AND job.conversation_started = 1
               AND job.capture_lease IS NULL
               AND post.sync_generation = job.generation AND post.status <> 'deleting'
           )`,
      ).bind(errorCode, parentId, postId, quoteId, claim, generation,
        postId, generation),
    ];
    const changes = mutationBatch(await db.batch(statements), statements.length);
    if (changes.some((count) => count > 1)) invalidStorage();
    if (changes[0] === 0) {
      if (changes.some((count) => count !== 0)) invalidStorage();
      return false;
    }
    if (changes.some((count) => count !== 1)) invalidStorage();
    return true;
  } catch (error) { throw storageError(error); }
}

/** @param {any} db @param {{ postId: string, generation: number, authorId: string,
 * profile: unknown, nowSeconds: number }} input */
export async function saveThreadsAuthorProfile(db, input) {
  const postId = requiredString(input?.postId);
  const generation = inputPositiveInteger(input?.generation);
  const authorId = requiredString(input?.authorId);
  const profile = providerProfile(input?.profile);
  const now = inputTimestamp(input?.nowSeconds);
  if (profile.id !== authorId)
    throw new AppError("threads_provider_protocol_error", 502);
  try {
    const changed = mutationChanges(await db.prepare(
      `UPDATE threads_authors SET username = ?, display_name = ?,
         profile_media_status = CASE WHEN profile_media_status = 'deleting'
           THEN 'deleting' ELSE 'pending' END,
         profile_error_code = CASE WHEN profile_media_status = 'deleting'
           THEN profile_error_code ELSE NULL END, updated_at = ?
       WHERE threads_user_id = ? AND EXISTS (
         SELECT 1 FROM threads_posts post
         WHERE post.id = ? AND post.sync_generation = ? AND post.status <> 'deleting'
           AND EXISTS (
             SELECT 1 FROM threads_entries entry
             WHERE entry.threads_post_id = post.id AND entry.author_id = ?
           )
       )`,
    ).bind(profile.username, profile.name ?? profile.username, now, authorId,
      postId, generation, authorId).run());
    if (changed > 1) invalidStorage();
    return changed === 1;
  } catch (error) { throw storageError(error); }
}

/** @param {any} db @param {{ postId: string, generation: number, authorId: string,
 * errorCode: string, nowSeconds: number }} input */
export async function failThreadsAuthorProfile(db, input) {
  const postId = requiredString(input?.postId);
  const generation = inputPositiveInteger(input?.generation);
  const authorId = requiredString(input?.authorId);
  const errorCode = requiredString(input?.errorCode);
  const now = inputTimestamp(input?.nowSeconds);
  try {
    const changed = mutationChanges(await db.prepare(
      `UPDATE threads_authors SET profile_media_status = 'error',
         profile_error_code = ?, updated_at = ?
       WHERE threads_user_id = ? AND profile_media_status <> 'deleting'
         AND profile_upload_lease IS NULL AND EXISTS (
           SELECT 1 FROM threads_entries entry JOIN threads_posts post
             ON post.id = entry.threads_post_id
           WHERE entry.author_id = threads_authors.threads_user_id
             AND entry.threads_post_id = ? AND post.sync_generation = ?
             AND post.status <> 'deleting'
         )`,
    ).bind(errorCode, now, authorId, postId, generation).run());
    if (changed > 1) invalidStorage();
    return changed === 1;
  } catch (error) { throw storageError(error); }
}

/** @param {any} db @param {{ postId: string, generation: number,
 * parentEntryId?: string | null, media: unknown[], nowSeconds: number }} input */
export async function saveThreadsMediaDescriptors(db, input) {
  const postId = requiredString(input?.postId);
  const generation = inputPositiveInteger(input?.generation);
  const parentEntryId = nullableString(input?.parentEntryId);
  const media = mediaDescriptors(input?.media);
  const now = inputTimestamp(input?.nowSeconds);
  if (media.length === 0) return 0;
  try {
    const statements = media.map((item) => db.prepare(
      `INSERT INTO threads_media
         (id, entry_id, source_media_id, kind, ordinal, alt_text, status,
          created_at, updated_at)
       SELECT ?, entry.id, ?, ?, ?, ?, 'pending', ?, ?
       FROM threads_entries entry JOIN threads_posts post
         ON post.id = entry.threads_post_id
       WHERE entry.threads_post_id = ? AND entry.source_media_id = ?
         AND entry.kind IN ('root','author_reply','quote')
         AND (? IS NULL OR entry.parent_entry_id = ?)
         AND post.sync_generation = ? AND post.status <> 'deleting'
       ON CONFLICT(entry_id, source_media_id, kind, ordinal) DO NOTHING`,
    ).bind(crypto.randomUUID(), item.sourceMediaId, item.kind, item.ordinal,
      item.altText, now, now, postId, item.entrySourceMediaId,
      parentEntryId, parentEntryId, generation));
    const changes = mutationBatch(await db.batch(statements), statements.length);
    if (changes.some((count) => count > 1)) invalidStorage();
    return changes.reduce((sum, count) => sum + count, 0);
  } catch (error) { throw storageError(error); }
}

/** @param {any} db @param {{ postId: string, generation: number,
 * parentEntryId: string, quoteId: string, permalink: string, nowSeconds: number }} input */
export async function saveThreadsNestedQuotePermalink(db, input) {
  const postId = requiredString(input?.postId);
  const generation = inputPositiveInteger(input?.generation);
  const parentEntryId = requiredString(input?.parentEntryId);
  const quoteId = requiredString(input?.quoteId);
  const permalink = boundedOptionalPermalink(input?.permalink);
  const now = inputTimestamp(input?.nowSeconds);
  if (permalink === null) throw new AppError("invalid_threads_state", 400);
  try {
    const changed = mutationChanges(await db.prepare(
      `UPDATE threads_entries SET nested_quote_permalink = ?, last_seen_at = ?
       WHERE threads_post_id = ? AND kind = 'quote' AND parent_entry_id = ?
         AND source_media_id = ? AND nested_quote_permalink IS NULL
         AND EXISTS (
           SELECT 1 FROM threads_posts WHERE id = ? AND sync_generation = ?
             AND status <> 'deleting'
         )`,
    ).bind(permalink, now, postId, parentEntryId, quoteId,
      postId, generation).run());
    if (changed > 1) invalidStorage();
    return changed === 1;
  } catch (error) { throw storageError(error); }
}
