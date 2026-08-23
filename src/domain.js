export class AppError extends Error {
  /** @param {string} code @param {number} status @param {Record<string, string | number>} [details] */
  constructor(code, status, details = {}) {
    super(code);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const CATEGORIES = Object.freeze([
  "AI/ML", "Frontend", "Backend", "Data", "DevOps",
  "Security", "Mobile", "Design", "Productivity", "Other",
]);

const TAG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EDIT_KEYS = new Set(["primaryCategory", "tags"]);

/** @param {unknown} raw */
export function validateRepositoryNote(raw) {
  if (typeof raw !== "string") throw new AppError("invalid_repository_note", 400);
  const body = raw.trim().normalize("NFC");
  if (!body || body.length > 4_000) throw new AppError("invalid_repository_note", 400);
  return body;
}

/** @param {unknown} raw */
export function normalizeGitHubUrl(raw) {
  let url;
  try { url = new URL(String(raw).trim()); }
  catch { throw new AppError("invalid_repository_url", 400); }
  const parts = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  if (url.origin !== "https://github.com" || url.username || url.password || parts.length !== 2)
    throw new AppError("invalid_repository_url", 400);
  let owner;
  let name;
  try {
    owner = decodeURIComponent(parts[0]).normalize("NFC");
    name = decodeURIComponent(parts[1]).replace(/\.git$/i, "").normalize("NFC");
  } catch {
    throw new AppError("invalid_repository_url", 400);
  }
  if (!owner || !name || /[\\/]/.test(owner) || /[\\/]/.test(name))
    throw new AppError("invalid_repository_url", 400);
  return { owner, name, url: `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}` };
}

/** @param {string[]} values */
export function normalizeTags(values) {
  const tags = [...new Set(values.map((value) => String(value).trim().toLowerCase().replace(/\s+/g, "-").normalize("NFC")))];
  if (tags.length > 5 || tags.some((tag) => tag.length > 32 || !TAG.test(tag)))
    throw new AppError("invalid_tags", 400);
  return tags;
}

/** @param {URL} url */
export function parseListQuery(url) {
  for (const key of url.searchParams.keys()) {
    if (!new Set(["q", "category", "tag", "page"]).has(key) || url.searchParams.getAll(key).length !== 1)
      throw new AppError("invalid_list_query", 400);
  }
  const q = (url.searchParams.get("q") ?? "").trim().normalize("NFC");
  const category = url.searchParams.get("category") ?? "";
  const tag = url.searchParams.get("tag") ?? "";
  if (q.length > 100 || (category && !CATEGORIES.includes(category)) || (tag && !TAG.test(tag)))
    throw new AppError("invalid_list_query", 400);
  const page = Number(url.searchParams.get("page"));
  return { q, category, tag, page: Number.isInteger(page) && page > 0 ? page : 1 };
}

/** @param {URL} url */
export function parseNotePage(url) {
  for (const key of url.searchParams.keys()) {
    if (key !== "page" || url.searchParams.getAll(key).length !== 1)
      throw new AppError("invalid_note_query", 400);
  }
  const raw = url.searchParams.get("page");
  if (raw === null || !/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw)))
    return { page: 1 };
  return { page: Number(raw) };
}

/** @param {{ primaryCategory: string, tags: string[] } & Record<string, unknown>} input */
export function validateRepositoryEdit(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
    Object.keys(input).some((key) => !EDIT_KEYS.has(key)) ||
    typeof input.primaryCategory !== "string" || !Array.isArray(input.tags))
    throw new AppError("invalid_repository_edit", 400);
  if (!CATEGORIES.includes(input.primaryCategory))
    throw new AppError("invalid_repository_edit", 400);
  return { primaryCategory: input.primaryCategory, tags: normalizeTags(input.tags) };
}
