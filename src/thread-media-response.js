import { AppError } from "./domain.js";
import { validateStoredContentType, validateStoredEtag } from "./thread-media-download.js";
import { d1NonnegativeInteger, exactRow } from "./threads-storage.js";

const READ_KEYS = ["r2_key", "content_type", "bytes", "etag"];

/** @param {string | null} rawRange @param {number} size */
export function parseSingleRange(rawRange, size) {
  if (!Number.isSafeInteger(size) || size < 0)
    throw new AppError("invalid_media_range", 416);
  if (rawRange === null) return null;
  if (typeof rawRange !== "string") throw new AppError("invalid_media_range", 416);
  const match = /^bytes=(\d*)-(\d*)$/.exec(rawRange);
  if (!match || rawRange.includes(",") || match[1] === "" && match[2] === "")
    throw new AppError("invalid_media_range", 416);
  let start;
  let end;
  if (match[1] === "") {
    if (!/^\d+$/.test(match[2]) || !Number.isSafeInteger(Number(match[2])))
      throw new AppError("invalid_media_range", 416);
    const suffix = Number(match[2]);
    if (suffix <= 0 || size === 0) throw new AppError("invalid_media_range", 416);
    start = Math.max(0, size - suffix); end = size - 1;
  } else {
    if (!Number.isSafeInteger(Number(match[1])) ||
      match[2] !== "" && !Number.isSafeInteger(Number(match[2])))
      throw new AppError("invalid_media_range", 416);
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
    if (start >= size || end < start) throw new AppError("invalid_media_range", 416);
  }
  return { offset: start, length: end - start + 1,
    contentRange: `bytes ${start}-${end}/${size}` };
}

/** @param {unknown} value */
function readableRow(value) {
  const row = exactRow(value, READ_KEYS);
  if (typeof row.r2_key !== "string" || !row.r2_key)
    throw new AppError("storage_unavailable", 503);
  validateStoredContentType(row.content_type); d1NonnegativeInteger(row.bytes);
  validateStoredEtag(row.etag);
  return /** @type {{ r2_key: string, content_type: string, bytes: number, etag: string }} */ (row);
}

/** @param {any} db @param {string} postId @param {string} mediaId */
async function readStoredMedia(db, postId, mediaId) {
  const entry = await db.prepare(
    `SELECT media.r2_key, media.content_type, media.bytes, media.etag
     FROM threads_media media JOIN threads_entries entry ON entry.id = media.entry_id
     JOIN threads_posts post ON post.id = entry.threads_post_id
     WHERE entry.threads_post_id = ? AND media.id = ? AND media.status = 'ready'
       AND media.r2_key IS NOT NULL AND media.content_type IS NOT NULL
       AND media.bytes IS NOT NULL AND media.etag IS NOT NULL
       AND post.status <> 'deleting'`,
  ).bind(postId, mediaId).first();
  if (entry !== null) return readableRow(entry);
  const profile = await db.prepare(
    `SELECT author.profile_r2_key AS r2_key,
       author.profile_content_type AS content_type, author.profile_bytes AS bytes,
       author.profile_etag AS etag
     FROM threads_authors author
     WHERE author.threads_user_id = ? AND author.profile_media_status = 'ready'
       AND author.profile_r2_key IS NOT NULL AND author.profile_content_type IS NOT NULL
       AND author.profile_bytes IS NOT NULL AND author.profile_etag IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM threads_entries entry JOIN threads_posts post
           ON post.id = entry.threads_post_id
         WHERE entry.threads_post_id = ? AND entry.author_id = author.threads_user_id
           AND post.status <> 'deleting'
       )`,
  ).bind(mediaId, postId).first();
  return profile === null ? null : readableRow(profile);
}

/** @param {Request} request */
function mediaPath(request) {
  let url;
  try { url = new URL(request.url); }
  catch { return null; }
  if (url.search || url.hash) return null;
  const match = /^\/threads\/([^/]+)\/media\/([^/]+)$/.exec(url.pathname);
  if (!match) return null;
  try {
    const postId = decodeURIComponent(match[1]);
    const mediaId = decodeURIComponent(match[2]);
    if (!postId || !mediaId || /[\/\\]/.test(postId) || /[\/\\]/.test(mediaId)) return null;
    return { postId, mediaId };
  } catch { return null; }
}

/** @param {{ content_type: string, etag: string }} row @param {number} length */
function mediaHeaders(row, length) {
  return new Headers({
    "Accept-Ranges": "bytes", "Cache-Control": "private, no-cache",
    "Content-Disposition": "inline", "Content-Length": String(length),
    "Content-Type": row.content_type, ETag: row.etag,
    "X-Content-Type-Options": "nosniff",
  });
}

/** @param {Request} request @param {any} dependencies */
export async function serveThreadsMedia(request, dependencies) {
  if (!(request instanceof Request) || !["GET", "HEAD"].includes(request.method))
    return new Response(null, { status: 404 });
  const path = mediaPath(request);
  if (!path) return new Response(null, { status: 404 });
  let row;
  try { row = await readStoredMedia(dependencies.db, path.postId, path.mediaId); }
  catch { return new Response(null, { status: 404 }); }
  if (!row) return new Response(null, { status: 404 });
  let range;
  try { range = parseSingleRange(request.headers.get("range"), row.bytes); }
  catch {
    return new Response(null, { status: 416, headers: {
      "Accept-Ranges": "bytes", "Cache-Control": "private, no-cache",
      "Content-Range": `bytes */${row.bytes}`,
      "X-Content-Type-Options": "nosniff",
    } });
  }
  const length = range?.length ?? row.bytes;
  const headers = mediaHeaders(row, length);
  if (range) headers.set("Content-Range", range.contentRange);
  let object;
  try {
    object = request.method === "HEAD" ? await dependencies.bucket.head(row.r2_key) :
      await dependencies.bucket.get(row.r2_key, range ? {
        range: { offset: range.offset, length: range.length },
      } : undefined);
  } catch { return new Response(null, { status: 503, headers: {
    "Cache-Control": "private, no-cache", "X-Content-Type-Options": "nosniff",
  } }); }
  if (!object) return new Response(null, { status: 404 });
  if (request.method === "HEAD") return new Response(null, {
    status: range ? 206 : 200, headers,
  });
  if (!(object.body instanceof ReadableStream)) return new Response(null, { status: 404 });
  return new Response(object.body, { status: range ? 206 : 200, headers });
}
