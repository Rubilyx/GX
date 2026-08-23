import {
  AppError, normalizeGitHubUrl, validateRepositoryEdit,
} from "./domain.js";
import { fetchRepositoryMetadata, fetchRepositoryReadme } from "./github.js";
import { analyzeRepository, PROMPT_VERSION } from "./openai.js";

/** @typedef {{ fetcher: typeof fetch, openAiApiKey: string, openAiModel: string }} Dependencies */

/** @param {any} value */
const nfc = (value) => typeof value === "string" ? value.normalize("NFC") : value;

/** @param {any} metadata */
function normalizedMetadata(metadata) {
  return {
    ...metadata,
    owner: nfc(metadata.owner), name: nfc(metadata.name), htmlUrl: nfc(metadata.htmlUrl),
    description: nfc(metadata.description), homepageUrl: nfc(metadata.homepageUrl),
    defaultBranch: nfc(metadata.defaultBranch), primaryLanguage: nfc(metadata.primaryLanguage),
    licenseSpdx: nfc(metadata.licenseSpdx),
    topics: metadata.topics.map(nfc), githubUpdatedAt: nfc(metadata.githubUpdatedAt),
    githubPushedAt: nfc(metadata.githubPushedAt),
  };
}

/** @param {string} repositoryId @param {string} analysisStatus @param {string | null} [errorCode] @param {boolean} [duplicate] */
function result(repositoryId, analysisStatus, errorCode = null, duplicate = false) {
  return { repositoryId, analysisStatus, errorCode, duplicate };
}

/** @param {unknown} error */
function storageError(error) {
  if (error instanceof AppError) return error;
  return new AppError("storage_unavailable", 503);
}

function invalidStorage() {
  throw new AppError("storage_unavailable", 503);
}

const REPOSITORY_WITH_NOTE_SUMMARY = `
  r.id,
  r.github_id,
  r.owner,
  r.name,
  r.html_url,
  r.description,
  r.homepage_url,
  r.default_branch,
  r.primary_language,
  r.stars,
  r.forks,
  r.license_spdx,
  r.topics_json,
  r.github_updated_at,
  r.github_pushed_at,
  r.activity_refreshed_at,
  r.readme_sha,
  r.readme_status,
  r.source_refreshed_at,
  r.summary,
  r.problem,
  r.values_json,
  r.audience,
  r.cautions,
  r.primary_category,
  r.analysis_status,
  r.analysis_error_code,
  r.analysis_model,
  r.prompt_version,
  r.analysis_started_at,
  r.analyzed_at,
  r.analysis_generation,
  r.created_at,
  r.updated_at,
  (
    SELECT COUNT(*)
    FROM repository_notes AS note_count_rows
    WHERE note_count_rows.repository_id = r.id
  ) AS note_count,
  (
    SELECT newest.body
    FROM repository_notes AS newest
    WHERE newest.repository_id = r.id
    ORDER BY newest.created_at DESC, newest.id DESC
    LIMIT 1
  ) AS latest_note`;

/** @param {any} value */
function mutationChanges(value) {
  const changes = value?.meta?.changes;
  if (value?.success !== true || !Number.isInteger(changes) || changes < 0) invalidStorage();
  return changes;
}

/** @param {any} value @param {number} expectedLength */
function mutationBatch(value, expectedLength) {
  if (!Array.isArray(value) || value.length !== expectedLength) invalidStorage();
  return value.map(mutationChanges);
}

/** @param {any} value @param {boolean} requireId */
function returningGeneration(value, requireId) {
  if (value === null) return null;
  if (!value || !Number.isInteger(value.analysis_generation) || value.analysis_generation < 1 ||
    (requireId && (typeof value.id !== "string" || !value.id))) invalidStorage();
  return value;
}

/** @param {any} value */
function sourceRow(value) {
  if (value === null) return null;
  if (!value || typeof value.owner !== "string" || !value.owner ||
    typeof value.name !== "string" || !value.name ||
    typeof value.github_id !== "string" || !value.github_id) invalidStorage();
  return value;
}

/** @param {any} value */
function activityLeaseRow(value) {
  const row = sourceRow(value);
  if (row === null) return null;
  if (!Number.isInteger(row.activity_refresh_generation) || row.activity_refresh_generation < 1)
    invalidStorage();
  return row;
}

/** @param {any} db @param {string} id */
async function claimActivityRefresh(db, id) {
  try {
    return activityLeaseRow(await db.prepare(
      `UPDATE repositories
       SET activity_refresh_generation = activity_refresh_generation + 1
       WHERE id = ?
       RETURNING owner, name, github_id, activity_refresh_generation`,
    ).bind(id).first());
  } catch (error) { throw storageError(error); }
}

/** @param {any} db @param {string} id @param {number} generation */
async function releaseActivityRefresh(db, id, generation) {
  try {
    const released = mutationChanges(await db.prepare(
      `UPDATE repositories
       SET activity_refresh_generation = activity_refresh_generation - 1
       WHERE id = ? AND activity_refresh_generation = ?`,
    ).bind(id, generation).run());
    if (released > 1) invalidStorage();
  } catch (error) { throw storageError(error); }
}

/** @param {any} db @param {string} id @param {any} lease @param {typeof fetch} fetcher @param {{ owner: string, name: string }} [repositoryRef] */
async function fetchClaimedActivity(db, id, lease, fetcher, repositoryRef = lease) {
  try {
    const metadata = normalizedMetadata(await fetchRepositoryMetadata(
      fetcher, repositoryRef, AbortSignal.timeout(8_000),
    ));
    if (metadata.githubId !== lease.github_id) throw new AppError("github_not_found", 404);
    return metadata;
  } catch (error) {
    await releaseActivityRefresh(db, id, lease.activity_refresh_generation);
    throw error;
  }
}

/** @param {any} db @param {string} id @param {any} lease @param {any} metadata */
async function persistClaimedActivity(db, id, lease, metadata) {
  try {
    const updated = mutationChanges(await db.prepare(
      `UPDATE repositories
       SET github_pushed_at = ?, activity_refreshed_at = unixepoch()
       WHERE id = ? AND github_id = ? AND activity_refresh_generation = ?`,
    ).bind(
      metadata.githubPushedAt, id, lease.github_id, lease.activity_refresh_generation,
    ).run());
    if (updated > 1) invalidStorage();
    return updated === 1;
  } catch (error) { throw storageError(error); }
}

/** @param {any} db @param {string} repositoryId @param {number} generation @param {any} repository @param {any} readme @param {Dependencies} dependencies */
async function finishAnalysis(db, repositoryId, generation, repository, readme, dependencies) {
  let analyzed;
  try {
    analyzed = await analyzeRepository(dependencies.fetcher, {
      apiKey: dependencies.openAiApiKey,
      model: dependencies.openAiModel,
      repository,
      readme: readme.text,
      signal: AbortSignal.timeout(45_000),
    });
  } catch (error) {
    const errorCode = error instanceof AppError ? error.code : "analysis_provider_error";
    let failed;
    try {
      failed = mutationChanges(await db.prepare(
        `UPDATE repositories SET analysis_status = 'error', analysis_error_code = ?,
           analysis_started_at = NULL, updated_at = unixepoch()
         WHERE id = ? AND analysis_generation = ?`,
      ).bind(errorCode, repositoryId, generation).run());
    } catch (dbError) { throw storageError(dbError); }
    if (failed > 1) throw new AppError("storage_unavailable", 503);
    return result(repositoryId, failed === 1 ? "error" : "pending",
      failed === 1 ? errorCode : null);
  }
  const { analysis, responseModel } = analyzed;
  try {
    const statements = [db.prepare(
      `UPDATE repositories SET
        summary = ?, problem = ?, values_json = ?, audience = ?, cautions = ?,
        primary_category = ?, analysis_status = 'ready', analysis_error_code = NULL,
        analysis_model = ?, prompt_version = ?, analyzed_at = unixepoch(),
        analysis_started_at = NULL, updated_at = unixepoch()
       WHERE id = ? AND analysis_generation = ?`,
    ).bind(
      analysis.summary, analysis.problem, JSON.stringify(analysis.values), analysis.audience,
      analysis.cautions, analysis.primaryCategory, nfc(responseModel), PROMPT_VERSION,
      repositoryId, generation,
    ), db.prepare(
      `DELETE FROM repository_tags
       WHERE repository_id = ? AND EXISTS (
         SELECT 1 FROM repositories
         WHERE id = ? AND analysis_generation = ? AND analysis_status = 'ready'
       )`,
    ).bind(repositoryId, repositoryId, generation)];
    for (const tag of analysis.tags) {
      statements.push(db.prepare(
        `INSERT INTO repository_tags (repository_id, normalized_tag)
         SELECT ?, ? WHERE EXISTS (
           SELECT 1 FROM repositories
           WHERE id = ? AND analysis_generation = ? AND analysis_status = 'ready'
         )`,
      ).bind(repositoryId, tag, repositoryId, generation));
    }
    const completed = mutationBatch(await db.batch(statements), statements.length);
    if (completed[0] > 1) invalidStorage();
    if (completed[0] !== 1) return result(repositoryId, "pending");
    return result(repositoryId, "ready");
  } catch (error) { throw storageError(error); }
}

/** @param {any} db @param {unknown} rawUrl @param {Dependencies} dependencies */
export async function collectRepository(db, rawUrl, dependencies) {
  const repositoryRef = normalizeGitHubUrl(rawUrl);
  const metadata = normalizedMetadata(await fetchRepositoryMetadata(
    dependencies.fetcher, repositoryRef, AbortSignal.timeout(8_000),
  ));
  const repositoryId = crypto.randomUUID();
  let inserted;
  try {
    inserted = returningGeneration(await db.prepare(
      `INSERT INTO repositories (
        id, github_id, owner, name, html_url, description, homepage_url,
        default_branch, primary_language, stars, forks, license_spdx,
        topics_json, github_updated_at, github_pushed_at, activity_refreshed_at,
        activity_refresh_generation,
        readme_status, source_refreshed_at,
        values_json, analysis_status, analysis_started_at, analysis_generation
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), 1, 'unavailable',
        unixepoch(), '[]', 'pending', unixepoch(), 1
      WHERE (SELECT COUNT(*) FROM repositories) < 1000
      ON CONFLICT(github_id) DO NOTHING
      RETURNING id, analysis_generation`,
    ).bind(
      repositoryId, metadata.githubId, metadata.owner, metadata.name, metadata.htmlUrl,
      metadata.description, metadata.homepageUrl, metadata.defaultBranch,
      metadata.primaryLanguage, metadata.stars, metadata.forks, metadata.licenseSpdx,
      JSON.stringify(metadata.topics), metadata.githubUpdatedAt, metadata.githubPushedAt,
    ).first(), true);
    if (!inserted) {
      const existing = await db.prepare(
        "SELECT id, analysis_status, analysis_error_code FROM repositories WHERE github_id = ?",
      ).bind(metadata.githubId).first();
      if (existing === null) throw new AppError("repository_limit_reached", 409);
      if (!existing || typeof existing.id !== "string" || !existing.id ||
        !["pending", "ready", "error"].includes(existing.analysis_status) ||
        !(existing.analysis_error_code === null || typeof existing.analysis_error_code === "string"))
        invalidStorage();
      const activityLease = await claimActivityRefresh(db, existing.id);
      if (!activityLease) throw new AppError("github_not_found", 404);
      const currentMetadata = await fetchClaimedActivity(
        db, existing.id, activityLease, dependencies.fetcher, metadata,
      );
      if (mutationChanges(await db.prepare(
        "UPDATE repositories SET owner = ?, name = ?, html_url = ?, updated_at = unixepoch() WHERE id = ?",
      ).bind(
        currentMetadata.owner, currentMetadata.name, currentMetadata.htmlUrl, existing.id,
      ).run()) !== 1)
        invalidStorage();
      await persistClaimedActivity(db, existing.id, activityLease, currentMetadata);
      return result(existing.id, existing.analysis_status, existing.analysis_error_code, true);
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("storage_unavailable", 503);
  }
  const readme = await fetchRepositoryReadme(
    dependencies.fetcher, metadata, AbortSignal.timeout(8_000),
  );
  let readmeSaved;
  try {
    readmeSaved = mutationChanges(await db.prepare(
      `UPDATE repositories SET readme_sha = ?, readme_status = ?, updated_at = unixepoch()
       WHERE id = ? AND analysis_generation = ?`,
    ).bind(readme.sha, readme.status, inserted.id, inserted.analysis_generation).run());
  } catch (error) { throw storageError(error); }
  if (readmeSaved > 1) invalidStorage();
  if (readmeSaved !== 1) return result(inserted.id, "pending");
  return finishAnalysis(db, inserted.id, inserted.analysis_generation, metadata, readme, dependencies);
}

/** @param {string} value */
function jsonArray(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string")
      ? parsed.map((item) => item.normalize("NFC")) : [];
  } catch { return []; }
}

/** @param {any} row @param {string[]} [tags] */
function mapRepository(row, tags = []) {
  const noteCount = Number(row.note_count);
  if (!Number.isInteger(noteCount) || noteCount < 0 ||
    !(typeof row.latest_note === "string" || row.latest_note === null)) invalidStorage();
  return {
    id: row.id, githubId: row.github_id, owner: row.owner, name: row.name,
    htmlUrl: row.html_url, description: row.description, homepageUrl: row.homepage_url,
    defaultBranch: row.default_branch, primaryLanguage: row.primary_language,
    stars: row.stars, forks: row.forks, licenseSpdx: row.license_spdx,
    topics: jsonArray(row.topics_json), githubUpdatedAt: row.github_updated_at,
    githubPushedAt: row.github_pushed_at, activityRefreshedAt: row.activity_refreshed_at,
    readmeSha: row.readme_sha, readmeStatus: row.readme_status,
    sourceRefreshedAt: row.source_refreshed_at, summary: row.summary,
    problem: row.problem, values: jsonArray(row.values_json), audience: row.audience,
    cautions: row.cautions, primaryCategory: row.primary_category,
    analysisStatus: row.analysis_status, analysisErrorCode: row.analysis_error_code,
    analysisModel: row.analysis_model, promptVersion: row.prompt_version,
    analysisStartedAt: row.analysis_started_at, analyzedAt: row.analyzed_at,
    noteCount, latestNote: row.latest_note, analysisGeneration: row.analysis_generation,
    createdAt: row.created_at, updatedAt: row.updated_at, tags,
  };
}

/** @param {any} db @param {string} id */
export async function getRepository(db, id) {
  try {
    const row = await db.prepare(
      `SELECT ${REPOSITORY_WITH_NOTE_SUMMARY} FROM repositories AS r WHERE r.id = ?`,
    ).bind(id).first();
    if (!row) return null;
    const tags = await db.prepare(
      "SELECT normalized_tag FROM repository_tags WHERE repository_id = ? ORDER BY normalized_tag",
    ).bind(id).all();
    return mapRepository(row, tags.results.map((/** @type {any} */ tag) => tag.normalized_tag));
  } catch (error) { throw storageError(error); }
}

/** @param {any} db @param {{ q?: string, category?: string, tag?: string, page?: number }} filters */
export async function listRepositories(db, filters) {
  const pageSize = 10;
  const clauses = [];
  const bindings = [];
  const q = String(filters.q ?? "").trim().normalize("NFC");
  if (q) {
    const pattern = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
    clauses.push(`(
      r.owner LIKE ? ESCAPE '\\' COLLATE NOCASE
      OR r.name LIKE ? ESCAPE '\\' COLLATE NOCASE
      OR r.description LIKE ? ESCAPE '\\' COLLATE NOCASE
      OR r.summary LIKE ? ESCAPE '\\' COLLATE NOCASE
      OR EXISTS (
        SELECT 1
        FROM repository_notes AS note_search
        WHERE note_search.repository_id = r.id
          AND note_search.body LIKE ? ESCAPE '\\' COLLATE NOCASE
      )
    )`);
    bindings.push(pattern, pattern, pattern, pattern, pattern);
  }
  if (filters.category) {
    clauses.push("r.primary_category = ?");
    bindings.push(filters.category);
  }
  if (filters.tag) {
    clauses.push(`EXISTS (
      SELECT 1 FROM repository_tags AS t
      WHERE t.repository_id = r.id AND t.normalized_tag = ?
    )`);
    bindings.push(filters.tag);
  }
  const whereSql = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  try {
    const total = Number(await db.prepare(
      `SELECT COUNT(*) AS count FROM repositories AS r ${whereSql}`,
    ).bind(...bindings).first("count"));
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const requestedPage = typeof filters.page === "number" &&
      Number.isInteger(filters.page) && filters.page > 0 ? filters.page : 1;
    const page = Math.min(requestedPage, totalPages);
    const rows = await db.prepare(
      `SELECT ${REPOSITORY_WITH_NOTE_SUMMARY} FROM repositories AS r ${whereSql}
       ORDER BY r.created_at DESC, r.id DESC LIMIT ? OFFSET ?`,
    ).bind(...bindings, pageSize, (page - 1) * pageSize).all();
    // ponytail: the 1,000-repository cap bounds this to 5,000 rows; scope by page if that cap grows.
    const [allTags, available, categoryCountRows] = await Promise.all([
      db.prepare(
        "SELECT repository_id, normalized_tag FROM repository_tags ORDER BY normalized_tag",
      ).all(),
      db.prepare("SELECT DISTINCT normalized_tag FROM repository_tags ORDER BY normalized_tag").all(),
      db.prepare(
        `SELECT primary_category, COUNT(*) AS count FROM repositories
         GROUP BY primary_category ORDER BY primary_category`,
      ).all(),
    ]);
    const tagsByRepository = new Map();
    for (const { repository_id, normalized_tag } of allTags.results) {
      if (!tagsByRepository.has(repository_id)) tagsByRepository.set(repository_id, []);
      tagsByRepository.get(repository_id).push(normalized_tag);
    }
    /** @type {Array<[string | null, number]>} */
    const categoryCounts = categoryCountRows.results.map((/** @type {any} */ row) =>
      [row.primary_category, Number(row.count)]);
    return {
      repositories: rows.results.map((/** @type {any} */ row) => mapRepository(row, tagsByRepository.get(row.id) ?? [])),
      page, totalPages, total,
      availableTags: available.results.map((/** @type {any} */ tag) => tag.normalized_tag),
      repositoryCounts: {
        all: categoryCounts.reduce((sum, [, count]) => sum + count, 0),
        byCategory: Object.fromEntries(categoryCounts.filter(([category]) => typeof category === "string")),
      },
    };
  } catch (error) { throw storageError(error); }
}

/** @param {any} db @param {string} id @param {any} patch */
export async function updateRepository(db, id, patch) {
  const edit = validateRepositoryEdit(patch);
  const statements = [db.prepare(
    `UPDATE repositories SET primary_category = ?, updated_at = unixepoch()
     WHERE id = ?`,
  ).bind(edit.primaryCategory, id), db.prepare(
    `DELETE FROM repository_tags WHERE repository_id = ?
     AND EXISTS (SELECT 1 FROM repositories WHERE id = ?)`,
  ).bind(id, id)];
  for (const tag of edit.tags) {
    statements.push(db.prepare(
      `INSERT INTO repository_tags (repository_id, normalized_tag)
       SELECT ?, ? WHERE EXISTS (SELECT 1 FROM repositories WHERE id = ?)`,
    ).bind(id, tag, id));
  }
  try {
    const updated = mutationBatch(await db.batch(statements), statements.length);
    if (updated[0] > 1) invalidStorage();
    if (updated[0] !== 1) return null;
    return getRepository(db, id);
  } catch (error) { throw storageError(error); }
}

/** @param {any} db @param {string} id */
export async function deleteRepository(db, id) {
  try {
    const deleted = mutationChanges(
      await db.prepare("DELETE FROM repositories WHERE id = ?").bind(id).run(),
    );
    return deleted > 0;
  } catch (error) { throw storageError(error); }
}

/** @param {any} db @param {string} id @param {typeof fetch} fetcher */
export async function refreshRepositoryActivity(db, id, fetcher) {
  const current = await claimActivityRefresh(db, id);
  if (!current) throw new AppError("github_not_found", 404);
  const metadata = await fetchClaimedActivity(db, id, current, fetcher);
  await persistClaimedActivity(db, id, current, metadata);
  return getRepository(db, id);
}

/** @param {any} db @param {string} id @param {Dependencies} dependencies */
export async function refreshRepository(db, id, dependencies) {
  const current = await claimActivityRefresh(db, id);
  if (!current) throw new AppError("github_not_found", 404);
  const metadata = await fetchClaimedActivity(db, id, current, dependencies.fetcher);
  await persistClaimedActivity(db, id, current, metadata);
  const readme = await fetchRepositoryReadme(
    dependencies.fetcher, metadata, AbortSignal.timeout(8_000),
  );
  let lease;
  try {
    lease = returningGeneration(await db.prepare(
      `UPDATE repositories SET
        owner = ?, name = ?, html_url = ?, description = ?, homepage_url = ?,
        default_branch = ?, primary_language = ?, stars = ?, forks = ?,
        license_spdx = ?, topics_json = ?, github_updated_at = ?,
        readme_sha = ?, readme_status = ?, source_refreshed_at = unixepoch(),
        analysis_generation = analysis_generation + 1,
        analysis_status = 'pending', analysis_error_code = NULL,
        analysis_started_at = unixepoch(), updated_at = unixepoch()
       WHERE id = ? AND github_id = ? AND (
         analysis_status <> 'pending' OR analysis_started_at IS NULL
         OR analysis_started_at <= unixepoch() - 300
       ) RETURNING analysis_generation`,
    ).bind(
      metadata.owner, metadata.name, metadata.htmlUrl, metadata.description,
      metadata.homepageUrl, metadata.defaultBranch, metadata.primaryLanguage,
      metadata.stars, metadata.forks, metadata.licenseSpdx,
      JSON.stringify(metadata.topics), metadata.githubUpdatedAt, readme.sha, readme.status,
      id, current.github_id,
    ).first(), false);
    if (!lease) {
      const existing = await db.prepare(
        "SELECT github_id FROM repositories WHERE id = ?",
      ).bind(id).first();
      if (existing === null) throw new AppError("github_not_found", 404);
      if (!existing || typeof existing.github_id !== "string" || !existing.github_id)
        invalidStorage();
      if (existing.github_id !== current.github_id)
        throw new AppError("github_not_found", 404);
      throw new AppError("analysis_in_progress", 409, { retryAfter: 300 });
    }
  } catch (error) { throw storageError(error); }
  return finishAnalysis(db, id, lease.analysis_generation, metadata, readme, dependencies);
}
