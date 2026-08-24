import {
  d1NonnegativeInteger, exactRow, invalidStorage, MEDIA_KINDS, MEDIA_TYPES,
  POST_STATUSES, requiredString, selectRows, storageError,
} from "./threads-storage.js";

const POST_READ_KEYS = [
  "id", "canonical_url", "status", "error_code", "root_author_id", "author_username",
  "author_display_name", "profile_media_status", "profile_r2_key", "profile_content_type",
  "profile_etag", "profile_bytes", "profile_error_code", "profile_retryable",
  "reply_count", "sync_generation",
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
    !(row.profile_media_status === null ||
      ["pending", "ready", "error", "deleting"].includes(row.profile_media_status)) ||
    !(row.profile_r2_key === null || typeof row.profile_r2_key === "string") ||
    !(row.profile_content_type === null || typeof row.profile_content_type === "string") ||
    !(row.profile_etag === null || typeof row.profile_etag === "string") ||
    !(row.profile_bytes === null || Number.isSafeInteger(row.profile_bytes) && row.profile_bytes >= 0) ||
    !(row.profile_error_code === null || typeof row.profile_error_code === "string") ||
    ![0, 1].includes(row.profile_retryable)) invalidStorage();
  for (const key of ["reply_count", "sync_generation", "expected_entry_count",
    "expected_media_count", "ready_media_count", "failed_media_count", "created_at", "updated_at"])
    d1NonnegativeInteger(row[key]);
  if (row.sync_generation < 1) invalidStorage();
  return row;
}
const POST_SELECT = `
  p.id, p.canonical_url, p.status, p.error_code, p.root_author_id,
  a.username AS author_username, a.display_name AS author_display_name,
  a.profile_media_status, a.profile_r2_key, a.profile_content_type,
  a.profile_etag, a.profile_bytes, a.profile_error_code,
  CASE WHEN p.status IN ('ready', 'partial', 'error')
      AND j.status IN ('ready', 'partial', 'error')
      AND j.profile_completed = 1 AND j.conversation_completed = 1
      AND j.capture_lease IS NULL AND j.pending_quote_count = 0
      AND j.content_completed_at IS NOT NULL AND j.completed_at IS NOT NULL
    THEN 1 ELSE 0 END AS profile_retryable,
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
  "profile_error_code", "profile_retryable",
];
const ENTRY_SELECT = `
  e.id, e.threads_post_id, e.source_media_id, e.kind, e.parent_entry_id, e.author_id,
  e.text, e.permalink, e.published_at, e.media_type, e.alt_text,
  e.nested_quote_permalink, a.username, a.display_name, a.profile_media_status,
  a.profile_r2_key, a.profile_content_type, a.profile_etag, a.profile_bytes,
  a.profile_error_code,
  CASE WHEN EXISTS (
    SELECT 1 FROM threads_posts retry_post
    JOIN threads_sync_jobs retry_job
      ON retry_job.threads_post_id = retry_post.id
     AND retry_job.generation = retry_post.sync_generation
    WHERE retry_post.id = e.threads_post_id
      AND retry_post.status IN ('ready', 'partial', 'error')
      AND retry_job.status IN ('ready', 'partial', 'error')
      AND retry_job.profile_completed = 1
      AND retry_job.conversation_completed = 1
      AND retry_job.capture_lease IS NULL
      AND retry_job.pending_quote_count = 0
      AND retry_job.content_completed_at IS NOT NULL
      AND retry_job.completed_at IS NOT NULL
  ) THEN 1 ELSE 0 END AS profile_retryable`;

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
      d1NonnegativeInteger(link.ordinal);
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
        !(item.bytes === null || Number.isSafeInteger(item.bytes) && item.bytes >= 0) ||
        !(item.etag === null || typeof item.etag === "string") ||
        !(item.error_code === null || typeof item.error_code === "string")) invalidStorage();
      d1NonnegativeInteger(item.ordinal);
      if (!mediaByEntry.has(item.entry_id)) mediaByEntry.set(item.entry_id, []);
      mediaByEntry.get(item.entry_id).push({
        id: item.id, sourceMediaId: item.source_media_id, kind: item.kind,
        ordinal: item.ordinal, altText: item.alt_text, status: item.status,
        contentType: item.content_type, bytes: item.bytes, etag: item.etag,
        errorCode: item.error_code,
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
      !["pending", "ready", "error", "deleting"].includes(row.profile_media_status) ||
      !(row.profile_r2_key === null || typeof row.profile_r2_key === "string") ||
      !(row.profile_content_type === null || typeof row.profile_content_type === "string") ||
      !(row.profile_etag === null || typeof row.profile_etag === "string") ||
      !(row.profile_bytes === null || Number.isSafeInteger(row.profile_bytes) && row.profile_bytes >= 0) ||
      !(row.profile_error_code === null || typeof row.profile_error_code === "string") ||
      ![0, 1].includes(row.profile_retryable) ||
      Number.isNaN(Date.parse(row.published_at))) invalidStorage();
    const author = {
      id: row.author_id, username: row.username, displayName: row.display_name,
      profileMedia: {
        status: row.profile_media_status === "deleting" ? "pending" : row.profile_media_status,
        contentType: row.profile_content_type,
        etag: row.profile_etag, bytes: row.profile_bytes, errorCode: row.profile_error_code,
        available: row.profile_r2_key !== null, retryable: row.profile_retryable === 1,
      },
    };
    mapped.set(row.id, {
      id: row.id, sourceMediaId: row.source_media_id, kind: row.kind,
      parentEntryId: row.parent_entry_id, author, text: row.text,
      permalink: row.permalink, publishedAt: row.published_at,
      mediaType: row.media_type, altText: row.alt_text,
      nestedQuotePermalink: row.nested_quote_permalink,
      links: linksByEntry.get(row.id) ?? [], media: mediaByEntry.get(row.id) ?? [], quote: null,
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
      status: post.profile_media_status === "deleting" ? "pending" : post.profile_media_status,
      contentType: post.profile_content_type,
      etag: post.profile_etag, bytes: post.profile_bytes, errorCode: post.profile_error_code,
      available: post.profile_r2_key !== null, retryable: post.profile_retryable === 1,
    },
  } : null);
  return {
    id: post.id, canonicalUrl: post.canonical_url, status: post.status,
    errorCode: post.error_code, author, root, quote: root?.quote ?? null,
    firstReplies, replyCount: post.reply_count,
    mediaProgress: {
      expected: post.expected_media_count, ready: post.ready_media_count,
      failed: post.failed_media_count,
      pending: Math.max(0,
        post.expected_media_count - post.ready_media_count - post.failed_media_count),
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
    const total = d1NonnegativeInteger(countRow.count);
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
      const rows = selectRows(entryResult, ENTRY_KEYS);
      const mapped = await mapEntryRows(db, rows);
      for (const [id, entry] of mapped) {
        const source = rows.find((row) => row.id === id);
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
  const requested = Number.isSafeInteger(options.repliesPage) &&
    /** @type {number} */ (options.repliesPage) > 0
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
