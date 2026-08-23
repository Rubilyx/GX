import { AppError, validateRepositoryNote } from "./domain.js";

const PAGE_SIZE = 5;

/** @param {unknown} error */
function storageError(error) {
  if (error instanceof AppError) return error;
  return new AppError("storage_unavailable", 503);
}

function invalidStorage() {
  throw new AppError("storage_unavailable", 503);
}

/** @param {unknown} value */
function validStoredBody(value) {
  return typeof value === "string" && value.length >= 1 && value.length <= 4_000 &&
    value.trim() === value && value.normalize("NFC") === value;
}

/** @param {any} row */
function noteRow(row) {
  if (!row || typeof row.id !== "string" || !row.id ||
    typeof row.repository_id !== "string" || !row.repository_id ||
    !validStoredBody(row.body) ||
    !Number.isInteger(row.created_at) || row.created_at < 0 ||
    !Number.isInteger(row.updated_at) || row.updated_at < row.created_at)
    invalidStorage();
  return {
    id: row.id, repositoryId: row.repository_id, body: row.body,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

/** @param {any} row */
function presentRow(row) {
  if (row === null) return false;
  if (!row || row.present !== 1) invalidStorage();
  return true;
}

/** @param {any} row */
function countRow(row) {
  if (!row || !Number.isInteger(row.count) || row.count < 0) invalidStorage();
  return row.count;
}

/** @param {any} result */
function noteRows(result) {
  if (!result || result.success !== true || !Array.isArray(result.results)) invalidStorage();
  return result.results.map(noteRow);
}

/** @param {any} result */
function mutationChanges(result) {
  const changes = result?.meta?.changes;
  if (result?.success !== true || !Number.isInteger(changes) || changes < 0 || changes > 1)
    invalidStorage();
  return changes;
}

/** @param {any} db @param {string} repositoryId @param {number} requestedPage */
export async function listRepositoryNotes(db, repositoryId, requestedPage) {
  const pageRequest = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  try {
    const present = presentRow(await db.prepare(
      "SELECT 1 AS present FROM repositories WHERE id = ?",
    ).bind(repositoryId).first());
    if (!present) return null;
    const total = countRow(await db.prepare(
      "SELECT COUNT(*) AS count FROM repository_notes WHERE repository_id = ?",
    ).bind(repositoryId).first());
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const page = Math.min(pageRequest, totalPages);
    const rows = noteRows(await db.prepare(
      `SELECT id, repository_id, body, created_at, updated_at
       FROM repository_notes
       WHERE repository_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ? OFFSET ?`,
    ).bind(repositoryId, PAGE_SIZE, (page - 1) * PAGE_SIZE).all());
    return { notes: rows, page, totalPages, total };
  } catch (error) { throw storageError(error); }
}

/** @param {any} db @param {string} repositoryId @param {unknown} rawBody */
export async function createRepositoryNote(db, repositoryId, rawBody) {
  const body = validateRepositoryNote(rawBody);
  const id = crypto.randomUUID();
  try {
    const row = await db.prepare(
      `WITH note_time AS (
        SELECT max(unixepoch(), COALESCE((
          SELECT MAX(created_at) + 1 FROM repository_notes WHERE repository_id = ?
        ), unixepoch())) AS created_at
      )
      INSERT INTO repository_notes (id, repository_id, body, created_at, updated_at)
      SELECT ?, ?, ?, created_at, created_at
      FROM note_time
      WHERE EXISTS (SELECT 1 FROM repositories WHERE id = ?)
      RETURNING id, repository_id, body, created_at, updated_at`,
    ).bind(repositoryId, id, repositoryId, body, repositoryId).first();
    return row === null ? null : noteRow(row);
  } catch (error) { throw storageError(error); }
}

/** @param {any} db @param {string} repositoryId @param {string} noteId @param {unknown} rawBody */
export async function updateRepositoryNote(db, repositoryId, noteId, rawBody) {
  const body = validateRepositoryNote(rawBody);
  try {
    const row = await db.prepare(
      `UPDATE repository_notes
       SET body = ?, updated_at = max(unixepoch(), updated_at + 1)
       WHERE repository_id = ? AND id = ?
       RETURNING id, repository_id, body, created_at, updated_at`,
    ).bind(body, repositoryId, noteId).first();
    return row === null ? null : noteRow(row);
  } catch (error) { throw storageError(error); }
}

/** @param {any} db @param {string} repositoryId @param {string} noteId */
export async function deleteRepositoryNote(db, repositoryId, noteId) {
  try {
    const changes = mutationChanges(await db.prepare(
      "DELETE FROM repository_notes WHERE repository_id = ? AND id = ?",
    ).bind(repositoryId, noteId).run());
    return changes === 1;
  } catch (error) { throw storageError(error); }
}

/** @param {any} db @param {string} repositoryId */
export async function getRepositoryNoteSummary(db, repositoryId) {
  try {
    const row = await db.prepare(
      `SELECT
        COUNT(*) AS note_count,
        (
          SELECT body
          FROM repository_notes AS newest
          WHERE newest.repository_id = ?
          ORDER BY newest.created_at DESC, newest.id DESC
          LIMIT 1
        ) AS latest_note
       FROM repository_notes
       WHERE repository_id = ?`,
    ).bind(repositoryId, repositoryId).first();
    if (!row || !Number.isInteger(row.note_count) || row.note_count < 0 ||
      !((row.note_count === 0 && row.latest_note === null) ||
        (row.note_count > 0 && validStoredBody(row.latest_note))))
      invalidStorage();
    return { noteCount: row.note_count, latestNote: row.latest_note };
  } catch (error) { throw storageError(error); }
}
