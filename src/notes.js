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

/** @param {any} result @param {string} repositoryId @param {number} pageRequest */
function notePage(result, repositoryId, pageRequest) {
  if (!result || result.success !== true || !Array.isArray(result.results)) invalidStorage();
  if (result.results.length === 0) return null;
  const [{ total, page }] = result.results;
  if (!Number.isSafeInteger(total) || total < 0 || !Number.isSafeInteger(page) || page < 1)
    invalidStorage();
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (page !== Math.min(pageRequest, totalPages) || result.results.some((/** @type {any} */ row) =>
    row.parent_repository_id !== repositoryId || row.total !== total || row.page !== page))
    invalidStorage();
  if (total === 0) {
    const [row] = result.results;
    if (result.results.length !== 1 ||
      [row.id, row.repository_id, row.body, row.created_at, row.updated_at]
        .some((value) => value !== null)) invalidStorage();
    return { notes: [], page, totalPages, total };
  }
  const expectedRows = Math.min(PAGE_SIZE, total - (page - 1) * PAGE_SIZE);
  if (result.results.length !== expectedRows) invalidStorage();
  const notes = result.results.map(noteRow);
  if (notes.some((/** @type {any} */ note) => note.repositoryId !== repositoryId)) invalidStorage();
  for (let index = 1; index < notes.length; index += 1) {
    const previous = notes[index - 1];
    const current = notes[index];
    if (previous.createdAt < current.createdAt ||
      (previous.createdAt === current.createdAt && previous.id <= current.id)) invalidStorage();
  }
  return { notes, page, totalPages, total };
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
    const result = await db.prepare(
      `WITH parent_repository AS (
        SELECT id FROM repositories WHERE id = ?
      ),
      ordered_notes AS (
        SELECT
          note_rows.id,
          note_rows.repository_id,
          note_rows.body,
          note_rows.created_at,
          note_rows.updated_at,
          COUNT(*) OVER () AS total,
          ROW_NUMBER() OVER (
            ORDER BY note_rows.created_at DESC, note_rows.id DESC
          ) AS row_number
        FROM repository_notes AS note_rows
        INNER JOIN parent_repository AS parent
          ON parent.id = note_rows.repository_id
      ),
      page_metadata AS (
        SELECT
          COALESCE(MAX(total), 0) AS total,
          min(?, max(1, CAST((COALESCE(MAX(total), 0) + ? - 1) / ? AS INTEGER))) AS page
        FROM ordered_notes
      )
      SELECT
        parent.id AS parent_repository_id,
        page_metadata.total,
        page_metadata.page,
        ordered_notes.id,
        ordered_notes.repository_id,
        ordered_notes.body,
        ordered_notes.created_at,
        ordered_notes.updated_at
      FROM parent_repository AS parent
      CROSS JOIN page_metadata
      LEFT JOIN ordered_notes
        ON ordered_notes.row_number > (page_metadata.page - 1) * ?
       AND ordered_notes.row_number <= page_metadata.page * ?
      ORDER BY ordered_notes.created_at DESC, ordered_notes.id DESC`,
    ).bind(repositoryId, pageRequest, PAGE_SIZE, PAGE_SIZE, PAGE_SIZE, PAGE_SIZE).all();
    return notePage(result, repositoryId, pageRequest);
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
