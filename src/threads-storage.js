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
    !Array.isArray(media.children)) throw new AppError("threads_provider_protocol_error", 502);
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

/** @param {any} db @param {Record<string, any>} profile @param {string} postId @param {number} generation @param {number} now @param {string | null} [requiredMediaId] */
function authorStatement(db, profile, postId, generation, now, requiredMediaId = null) {
  return db.prepare(
    `INSERT INTO threads_authors
       (threads_user_id, username, display_name, created_at, updated_at)
     SELECT ?, ?, ?, ?, ?
     WHERE EXISTS (
       SELECT 1 FROM threads_posts
       WHERE id = ? AND sync_generation = ? AND status <> 'deleting'
         AND (? IS NULL OR threads_media_id = ?)
     )
     ON CONFLICT(threads_user_id) DO UPDATE SET
       username = excluded.username, display_name = excluded.display_name,
       updated_at = excluded.updated_at`,
  ).bind(profile.id, profile.username, profile.name ?? profile.username, now, now,
    postId, generation, requiredMediaId, requiredMediaId);
}
/** @param {any} db @param {Record<string, any>} entry @param {"root"|"author_reply"} kind @param {string} postId @param {number} generation @param {number} now @param {string | null} [requiredMediaId] */
function primaryEntryStatement(db, entry, kind, postId, generation, now, requiredMediaId = null) {
  return db.prepare(
    `INSERT INTO threads_entries
       (id, threads_post_id, source_media_id, kind, author_id, text, permalink,
        published_at, media_type, alt_text, nested_quote_permalink,
        first_seen_at, last_seen_at, created_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?
     WHERE EXISTS (
       SELECT 1 FROM threads_posts
       WHERE id = ? AND sync_generation = ? AND status <> 'deleting'
         AND (? IS NULL OR threads_media_id = ?)
     )
     ON CONFLICT(threads_post_id, source_media_id)
       WHERE kind IN ('root','author_reply')
     DO UPDATE SET last_seen_at = excluded.last_seen_at`,
  ).bind(
    crypto.randomUUID(), postId, entry.id, kind, entry.ownerId, entry.text,
    entry.permalink, entry.timestamp, entry.mediaType, entry.altText ?? null,
    now, now, now, postId, generation, requiredMediaId, requiredMediaId,
  );
}
/** @param {any} db @param {Record<string, any>} entry @param {string} kind @param {string} postId @param {number} generation @param {string | null} parentId @param {string | null} [requiredMediaId] */
function linkStatements(db, entry, kind, postId, generation, parentId = null,
  requiredMediaId = null) {
  return extractThreadsLinks(entry.text, entry.linkAttachmentUrl).map((link) => db.prepare(
    `INSERT INTO threads_links (id, entry_id, url, source, ordinal)
     SELECT ?, e.id, ?, ?, ? FROM threads_entries e
     WHERE e.threads_post_id = ? AND e.source_media_id = ? AND e.kind = ?
       AND (? IS NULL OR e.parent_entry_id = ?)
       AND EXISTS (
         SELECT 1 FROM threads_posts
         WHERE id = ? AND sync_generation = ? AND status <> 'deleting'
           AND (? IS NULL OR threads_media_id = ?)
       )
     ON CONFLICT(entry_id, url) DO NOTHING`,
  ).bind(crypto.randomUUID(), link.url, link.source, link.ordinal,
    postId, entry.id, kind, parentId, parentId, postId, generation,
    requiredMediaId, requiredMediaId));
}

const CANDIDATE_KEYS = ["id", "threads_media_id", "sync_generation", "status", "created_at"];
/** @param {any} row */
function candidateRow(row) {
  row = exactRow(row, CANDIDATE_KEYS);
  if (typeof row.id !== "string" || !row.id ||
    !(row.threads_media_id === null || typeof row.threads_media_id === "string") ||
    !Number.isSafeInteger(row.sync_generation) || row.sync_generation < 1 ||
    !POST_STATUSES.has(row.status)) invalidStorage();
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
/** @param {any} db @param {any} winner @param {any} loser @param {string} providerId @param {string} claim @param {number} now */
function ownerCorrectionStatements(db, winner, loser, providerId, claim, now) {
  const winnerClaim = `EXISTS (
    SELECT 1 FROM threads_posts winner
    JOIN threads_sync_jobs winner_job
      ON winner_job.threads_post_id = winner.id
      AND winner_job.generation = winner.sync_generation
    WHERE winner.id = ? AND winner.threads_media_id = ?
      AND winner.sync_generation = ? AND winner.status <> 'deleting'
      AND winner_job.status IN ('queued','resolving','collecting')
  )`;
  return [
    db.prepare(
      `UPDATE threads_posts AS winner SET threads_media_id = ?
       WHERE id = ? AND threads_media_id IS NULL AND sync_generation = ?
         AND status <> 'deleting'
         AND EXISTS (
           SELECT 1 FROM threads_sync_jobs winner_job
           WHERE winner_job.threads_post_id = winner.id
             AND winner_job.generation = winner.sync_generation
             AND winner_job.status IN ('queued','resolving','collecting')
         )`,
    ).bind(claim, winner.id, winner.sync_generation),
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
      winner.id, claim, winner.sync_generation),
    db.prepare(
      `UPDATE threads_posts SET status = 'error',
         error_code = 'threads_archive_duplicate', updated_at = ?
       WHERE id = ? AND threads_media_id = ? AND sync_generation = ?
         AND status <> 'deleting' AND ${winnerClaim}`,
    ).bind(now, loser.id, providerId, loser.sync_generation,
      winner.id, claim, winner.sync_generation),
    db.prepare(
      `UPDATE threads_posts SET threads_media_id = NULL
       WHERE id = ? AND threads_media_id = ? AND sync_generation = ?
         AND status = 'error' AND error_code = 'threads_archive_duplicate'
         AND ${winnerClaim}`,
    ).bind(loser.id, providerId, loser.sync_generation,
      winner.id, claim, winner.sync_generation),
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

/** @param {any} db @param {{ postId: string, generation: number, profile: unknown, root: unknown, profileCursor?: string | null, conversationCursor?: string | null, nowSeconds: number }} input */
export async function saveResolvedThreadsRoot(db, input) {
  const postId = requiredString(input?.postId);
  const generation = inputPositiveInteger(input?.generation);
  const now = inputTimestamp(input?.nowSeconds);
  const profile = providerProfile(input?.profile);
  const root = providerMedia(input?.root);
  if (profile.id !== root.ownerId) throw new AppError("threads_provider_protocol_error", 502);
  const profileCursor = nullableString(input?.profileCursor);
  const conversationCursor = nullableString(input?.conversationCursor);
  try {
    const candidates = selectRows(await db.prepare(
      `SELECT id, threads_media_id, sync_generation, status, created_at
       FROM threads_posts WHERE id = ? OR threads_media_id = ? ORDER BY created_at, id`,
    ).bind(postId, root.id).all(), CANDIDATE_KEYS).map(candidateRow);
    const current = candidates.find((row) => row.id === postId);
    if (!current || current.sync_generation !== generation || current.status === "deleting") return false;
    const owner = candidates.find((row) => row.id !== postId && row.threads_media_id === root.id);
    if (owner && precedes(owner, current)) {
      await markDuplicateArchive(db, postId, generation, now);
      return false;
    }
    const claim = owner ? `claim:${root.id}` : null;
    const correction = owner
      ? ownerCorrectionStatements(db, current, owner, root.id,
        /** @type {string} */ (claim), now) : [];
    const postStatement = owner ? db.prepare(
      `UPDATE threads_posts AS winner SET
         canonical_url = ?, root_author_id = ?, status = 'collecting',
         error_code = NULL, updated_at = ?
       WHERE id = ? AND threads_media_id = ? AND sync_generation = ?
         AND status <> 'deleting'
         AND EXISTS (
           SELECT 1 FROM threads_sync_jobs winner_job
           WHERE winner_job.threads_post_id = winner.id
             AND winner_job.generation = winner.sync_generation
             AND winner_job.status IN ('queued','resolving','collecting')
         )`,
    ).bind(root.permalink, profile.id, now, postId, claim, generation) : db.prepare(
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
      root.id, root.id, postId);
    const requiredIdentity = owner ? claim : root.id;
    const statements = [
      ...correction,
      authorStatement(db, profile, postId, generation, now, claim),
      postStatement,
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
        now, postId, generation, postId, generation, requiredIdentity),
      primaryEntryStatement(db, root, "root", postId, generation, now, claim),
      ...linkStatements(db, root, "root", postId, generation, null, claim),
      ...(owner ? [db.prepare(
        `UPDATE threads_posts AS winner SET threads_media_id = ?
         WHERE id = ? AND threads_media_id = ? AND sync_generation = ?
           AND status = 'collecting' AND error_code IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM threads_posts other
             WHERE other.threads_media_id = ? AND other.id <> winner.id
           )
           AND EXISTS (
             SELECT 1 FROM threads_sync_jobs winner_job
             WHERE winner_job.threads_post_id = winner.id
               AND winner_job.generation = winner.sync_generation
               AND winner_job.status = 'collecting'
           )`,
      ).bind(root.id, postId, claim, generation, root.id)] : []),
    ];
    const changes = mutationBatch(await db.batch(statements), statements.length);
    if (changes.some((count) => count > 1)) invalidStorage();
    const base = correction.length;
    if (owner) {
      if (changes[0] === 0) {
        if (changes.some((count) => count !== 0)) invalidStorage();
        return false;
      }
      for (const index of [0, 1, 2, 3, base, base + 1, base + 2, base + 3,
        changes.length - 1]) {
        if (changes[index] !== 1) invalidStorage();
      }
      return true;
    }
    return changes[base + 1] === 1 && changes[base + 2] === 1 && changes[base + 3] === 1;
  } catch (error) { throw storageError(error); }
}

/** @param {any} db @param {{ postId: string, generation: number, entries: unknown[], nextCursor?: string | null, nowSeconds: number }} input */
export async function saveThreadsConversationPage(db, input) {
  const postId = requiredString(input?.postId);
  const generation = inputPositiveInteger(input?.generation);
  const now = inputTimestamp(input?.nowSeconds);
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
             )
             AND EXISTS (
               SELECT 1 FROM threads_posts WHERE id = ? AND sync_generation = ?
                 AND status <> 'deleting'
             )`,
        ).bind(now, postId, generation, postId, entry.id, postId, generation));
      }
      statements.push(primaryEntryStatement(db, entry, "author_reply", postId, generation, now));
      statements.push(...linkStatements(db, entry, "author_reply", postId, generation));
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
    return { accepted: changes.at(-1) === 1 ? accepted.length : 0, nextCursor };
  } catch (error) { throw storageError(error); }
}

/** @param {any} db @param {{ postId: string, generation: number, parentEntryId: string, profile: unknown, quote: unknown, nowSeconds: number }} input */
export async function saveThreadsQuote(db, input) {
  const postId = requiredString(input?.postId);
  const parentId = requiredString(input?.parentEntryId);
  const generation = inputPositiveInteger(input?.generation);
  const now = inputTimestamp(input?.nowSeconds);
  const profile = providerProfile(input?.profile);
  const quote = providerMedia(input?.quote);
  if (profile.id !== quote.ownerId) throw new AppError("threads_provider_protocol_error", 502);
  try {
    const statements = [
      db.prepare(
        `UPDATE threads_sync_jobs SET
           pending_quote_count = CASE WHEN pending_quote_count > 0
             THEN pending_quote_count - 1 ELSE 0 END, updated_at = ?
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
      ...linkStatements(db, quote, "quote", postId, generation, parentId),
    ];
    const changes = mutationBatch(await db.batch(statements), statements.length);
    if (changes.some((count) => count > 1)) invalidStorage();
    return changes[2] === 1;
  } catch (error) { throw storageError(error); }
}
