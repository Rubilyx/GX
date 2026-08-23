import { AppError } from "./domain.js";

const API = "https://api.github.com";
const README_BYTES = 131_072;
const commonHeaders = Object.freeze({
  "User-Agent": "repo-atlas",
  "X-GitHub-Api-Version": "2022-11-28",
});

/** @typedef {(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>} Fetcher */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

/** @param {unknown} error */
function githubError(error) {
  if (error instanceof AppError) return error;
  if (error instanceof Error && error.name === "AbortError")
    return new AppError("github_timeout", 504);
  return new AppError("github_unavailable", 503);
}

/** @param {Headers} headers */
function rateLimitError(headers) {
  const raw = headers.get("retry-after");
  const retryAfter = raw !== null && /^\d+$/.test(raw) ? Number(raw) : NaN;
  return new AppError(
    "github_rate_limited", 429,
    Number.isSafeInteger(retryAfter) ? { retryAfter } : {},
  );
}

/** @param {unknown} value */
function component(value) {
  if (typeof value !== "string" || !value || value.length > 256)
    throw new AppError("github_unavailable", 503);
  return encodeURIComponent(value);
}

/**
 * @param {Fetcher} fetcher
 * @param {URL} url
 * @param {AbortSignal | undefined} signal
 * @param {string} [accept]
 */
async function githubFetch(fetcher, url, signal, accept = "application/vnd.github+json") {
  let current = url;
  for (let redirects = 0; redirects <= 1; redirects += 1) {
    if (current.protocol !== "https:" || current.origin !== API)
      throw new AppError("github_unavailable", 503);
    const response = await fetcher(current, {
      headers: { ...commonHeaders, Accept: accept }, redirect: "manual", signal,
    });
    if (!(response instanceof Response)) throw new AppError("github_unavailable", 503);
    if (![301, 302, 307, 308].includes(response.status)) return response;
    if (redirects === 1) throw new AppError("github_unavailable", 503);
    const location = response.headers.get("location");
    if (!location) throw new AppError("github_unavailable", 503);
    current = new URL(location, current);
  }
  throw new AppError("github_unavailable", 503);
}

/** @param {ReadableStream<Uint8Array> | null} body @param {number} maximumBytes */
async function readAtMost(body, maximumBytes) {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const output = new Uint8Array(maximumBytes);
  let length = 0;
  try {
    while (length < maximumBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error("invalid_body_chunk");
      const take = Math.min(value.byteLength, maximumBytes - length);
      output.set(value.subarray(0, take), length);
      length += take;
      if (take < value.byteLength) break;
    }
    if (length === maximumBytes) void reader.cancel().catch(() => {});
    return output.slice(0, length);
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

/** @param {Response} response @param {number} maximumBytes */
async function readJson(response, maximumBytes) {
  const bytes = await readAtMost(response.body, maximumBytes + 1);
  if (bytes.byteLength > maximumBytes) throw new Error("response_too_large");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

/** @param {unknown} value */
function positiveId(value) {
  if (Number.isSafeInteger(value) && Number(value) > 0) return String(value);
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const normalized = value.replace(/^0+/, "");
  return normalized || null;
}

/** @param {unknown} value @param {boolean} nullable */
function stringField(value, nullable = false) {
  if (nullable && value === null) return null;
  return typeof value === "string" ? value : undefined;
}

/** @param {unknown} value */
function validTimestamp(value) {
  if (typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) return false;
  const date = new Date(value);
  return !Number.isNaN(date.valueOf()) && date.toISOString().replace(".000Z", "Z") === value;
}

/** @param {unknown} value */
function validateMetadata(value) {
  if (!isPlainObject(value)) throw new AppError("github_unavailable", 503);
  const id = positiveId(value.id);
  const owner = isPlainObject(value.owner) ? stringField(value.owner.login) : undefined;
  const name = stringField(value.name);
  const description = stringField(value.description, true);
  const homepageUrl = stringField(value.homepage, true);
  const defaultBranch = stringField(value.default_branch);
  const primaryLanguage = stringField(value.language, true);
  const stars = value.stargazers_count;
  const forks = value.forks_count;
  const licenseSpdx = value.license === null ? null
    : isPlainObject(value.license) ? stringField(value.license.spdx_id, true) : undefined;
  const topics = value.topics;
  const githubUpdatedAt = value.updated_at;
  const githubPushedAt = stringField(value.pushed_at, true);
  if (!id || !owner || !name || !defaultBranch ||
    description === undefined || homepageUrl === undefined || primaryLanguage === undefined ||
    typeof stars !== "number" || !Number.isSafeInteger(stars) || stars < 0 ||
    typeof forks !== "number" || !Number.isSafeInteger(forks) || forks < 0 ||
    licenseSpdx === undefined || !Array.isArray(topics) ||
    topics.some((topic) => typeof topic !== "string") || !validTimestamp(githubUpdatedAt) ||
    githubPushedAt === undefined ||
    (githubPushedAt !== null && !validTimestamp(githubPushedAt)))
    throw new AppError("github_unavailable", 503);
  return {
    githubId: id,
    owner,
    name,
    htmlUrl: `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
    description,
    homepageUrl,
    defaultBranch,
    primaryLanguage,
    stars,
    forks,
    licenseSpdx,
    topics,
    githubUpdatedAt,
    githubPushedAt,
  };
}

/**
 * @param {Fetcher} fetcher
 * @param {{ owner: string, name: string }} repositoryRef
 * @param {AbortSignal} [signal]
 */
export async function fetchRepositoryMetadata(fetcher, repositoryRef, signal) {
  try {
    const url = new URL(`/repos/${component(repositoryRef?.owner)}/${component(repositoryRef?.name)}`, API);
    const response = await githubFetch(fetcher, url, signal);
    if (response.status === 404) throw new AppError("github_not_found", 404);
    if (response.status === 403 || response.status === 429) throw rateLimitError(response.headers);
    if (!response.ok) throw new AppError("github_unavailable", 503);
    return validateMetadata(await readJson(response, 1_048_576));
  } catch (error) {
    throw githubError(error);
  }
}

/** @param {Uint8Array} bytes @param {number} [maximumBytes] */
export function truncateUtf8(bytes, maximumBytes = README_BYTES) {
  if (bytes.byteLength <= maximumBytes) return { bytes, truncated: false };
  let end = maximumBytes;
  while (end > 0 && (bytes[end] & 0b1100_0000) === 0b1000_0000) end -= 1;
  const width = bytes[end] >= 0b1111_0000 ? 4
    : bytes[end] >= 0b1110_0000 ? 3 : bytes[end] >= 0b1100_0000 ? 2 : 1;
  return {
    bytes: bytes.slice(0, end + width > maximumBytes ? end : maximumBytes),
    truncated: true,
  };
}

/**
 * @param {"present" | "truncated" | "missing" | "nontext" | "unavailable"} status
 * @param {string | null} [errorCode]
 */
function emptyReadme(status, errorCode = null) {
  return { text: "", bytes: new Uint8Array(), sha: null, status, errorCode };
}

/**
 * @param {Fetcher} fetcher
 * @param {{ owner: string, name: string, defaultBranch: string }} repository
 * @param {AbortSignal} [signal]
 */
export async function fetchRepositoryReadme(fetcher, repository, signal) {
  try {
    const path = `/repos/${component(repository?.owner)}/${component(repository?.name)}/readme`;
    if (typeof repository?.defaultBranch !== "string" || !repository.defaultBranch)
      throw new AppError("github_unavailable", 503);
    const url = new URL(path, API);
    url.searchParams.set("ref", repository.defaultBranch);
    const response = await githubFetch(
      fetcher, url, signal, "application/vnd.github.raw+json",
    );
    if (response.status === 404) return emptyReadme("missing");
    if (response.status === 403 || response.status === 429)
      return emptyReadme("unavailable", "github_rate_limited");
    if (!response.ok) return emptyReadme("unavailable", "github_unavailable");
    const result = truncateUtf8(await readAtMost(response.body, README_BYTES + 4));
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(result.bytes);
    } catch {
      return emptyReadme("nontext");
    }
    if (result.bytes.includes(0)) return emptyReadme("nontext");
    const hashInput = new ArrayBuffer(result.bytes.byteLength);
    new Uint8Array(hashInput).set(result.bytes);
    const digest = await globalThis.crypto.subtle.digest("SHA-256", hashInput);
    const sha = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return {
      text, bytes: result.bytes, sha,
      status: result.truncated ? "truncated" : "present", errorCode: null,
    };
  } catch (error) {
    return emptyReadme("unavailable", githubError(error).code);
  }
}
