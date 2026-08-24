import { createTestHarness } from "wrangler";
import { readFile } from "node:fs/promises";
import { handleThreadsCaptureMessage } from "../../src/threads-capture.js";
import {
  deleteThreadsArchive, handleThreadsMediaMessage,
} from "../../src/thread-media.js";
import { recalculateThreadsStatus } from "../../src/threads.js";
import { handleRequest } from "../../src/worker.js";
import { validateCaptureMessage, validateMediaMessage } from "../../src/threads-domain.js";

const browserAssetRoot = new URL("../../public/assets/", import.meta.url);

const secrets = Object.freeze({
  PROD_PIN_SALT: "cmVwby1hdGxhcy10ZXN0LXNhbHQ=",
  PROD_PIN_DIGEST: "X3eotQ9GFhyeDwcCPzwVmINdYuMBwamov6bQPl+DQWk=",
  PROD_IP_HMAC_KEY: "cmVwby1hdGxhcy10ZXN0LWlwLWtleQ==",
  PROD_SESSION_KEY: "cmVwby1hdGxhcy10ZXN0LXNlc3Npb24ta2V5",
  OPENAI_API_KEY: "test-openai-key",
  THREADS_APP_SECRET: "test-threads-secret",
  THREADS_TOKEN_KEY: "cmVwby1hdGxhcy10aHJlYWRzLXRlc3Qta2V5LTAwMDE=",
});

const vars = Object.freeze({
  ENVIRONMENT: "test",
  PRODUCTION_HOST: "production.repo-atlas.test",
  OPENAI_MODEL: "test-snapshot",
  RELEASE_ID: "test-release",
  TRUSTED_TYPES_MODE: "report-only",
  THREADS_APP_ID: "test-threads-app",
});

/** @param {unknown} error */
export function shouldRetryBrowserListen(error) {
  const record = error && typeof error === "object" && !Array.isArray(error)
    ? /** @type {Record<string, unknown>} */ (error) : null;
  const cause = record?.cause && typeof record.cause === "object" &&
    !Array.isArray(record.cause)
    ? /** @type {Record<string, unknown>} */ (record.cause) : null;
  return (error instanceof TypeError || record?.name === "TypeError") &&
    /bad port/i.test(`${typeof record?.message === "string" ? record.message : ""} ${
      typeof cause?.message === "string" ? cause.message : ""}`);
}

/** @param {unknown} error */
export function shouldAcceptBrowserListen(error) {
  const cause = error instanceof TypeError && error.cause instanceof Error
    ? /** @type {Error & { code?: unknown }} */ (error.cause) : undefined;
  return cause?.code === "DEPTH_ZERO_SELF_SIGNED_CERT";
}

/**
 * @param {{ reset(): Promise<void>, listen(): Promise<URL>,
 * probe(url: URL): Promise<void>, getWorker(): any,
 * migrate(worker: any): Promise<void>, initializeBinding(worker: any): Promise<void> }} operations
 */
export async function runBrowserResetTransaction(operations) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await operations.reset();
      const url = await operations.listen();
      await operations.probe(url);
      const worker = operations.getWorker();
      await operations.migrate(worker);
      await operations.initializeBinding(worker);
      return { url, worker };
    } catch (error) {
      if (!shouldRetryBrowserListen(error)) throw error;
    }
  }
  throw new Error("test_harness_unsafe_port");
}

/** @type {Record<string, any>} */
const metadataFixture = Object.freeze({
  id: 9007199254740000,
  owner: { login: "OpenAI" },
  name: "example",
  html_url: "https://github.com/OpenAI/example",
  description: "Example repository",
  homepage: null,
  default_branch: "main",
  language: "JavaScript",
  stargazers_count: 10,
  forks_count: 2,
  license: { spdx_id: "MIT" },
  topics: ["example"],
  updated_at: "2026-08-09T00:00:00Z",
  pushed_at: "2026-08-08T00:00:00Z",
});

/** @type {{ summary: string, problem: string, values: string[], audience: string, cautions: string, primaryCategory: string, tags: string[] }} */
const analysisFixture = Object.freeze({
  summary: "예제 저장소의 핵심 사용법을 보여준다.",
  problem: "작동하는 최소 예제가 필요하다.",
  values: ["구조가 단순하다."],
  audience: "JavaScript 개발자",
  cautions: "예제 목적의 저장소다.",
  primaryCategory: "Backend",
  tags: ["example"],
});

const threadsFields = [
  "id", "media_product_type", "media_type", "media_url", "permalink", "owner",
  "username", "text", "timestamp", "shortcode", "thumbnail_url", "children",
  "is_quote_post", "quoted_post", "link_attachment_url", "alt_text", "root_post", "replied_to",
].join(",");
const threadsProfileFields = "id,username,name,threads_profile_picture_url";
const threadsProfile = Object.freeze({
  id: "author-1", username: "meta", name: "Meta", threads_profile_picture_url: "https://scontent.cdninstagram.com/fixture-avatar",
});
const threadsRootMedia = Object.freeze({
  id: "root-1", media_product_type: "THREADS", media_type: "TEXT_POST",
  permalink: "https://www.threads.com/@meta/post/RootShort", owner: { id: "author-1" },
  username: "meta", text: "Root", timestamp: "2026-08-24T00:00:00+0000", shortcode: "RootShort",
});

/** @param {URL} url @param {readonly string[]} keys */
function exactQuery(url, keys) {
  const actual = [...url.searchParams.keys()];
  return actual.length === keys.length && keys.every((key) =>
    url.searchParams.getAll(key).length === 1);
}

/** @param {Request} request */
function bearer(request) { return /^Bearer\s+[^\s]+$/.test(request.headers.get("authorization") ?? ""); }

/** @param {unknown} pages @param {string | null} after @param {string} path */
function fixturePage(pages, after, path) {
  const first = after === null ? 0 : -1;
  /** @type {any} */ let page;
  if (Array.isArray(pages)) {
    let index = first;
    if (after !== null) {
      const previous = pages.findIndex((item) => item?.nextCursor === after);
      if (previous < 0) return null;
      index = previous + 1;
    }
    page = pages[index];
  } else if (pages && typeof pages === "object") page = /** @type {Record<string, any>} */ (pages)[after ?? ""];
  if (!page || typeof page !== "object" || Array.isArray(page) || !Array.isArray(page.data)) return null;
  /** @type {{ data: any, paging?: { next: string } }} */
  const body = { data: page.data };
  if (page.nextCursor !== undefined && page.nextCursor !== null) {
    if (typeof page.nextCursor !== "string" || !page.nextCursor) return null;
    body.paging = { next: `https://graph.threads.net/v1.0/${path}?after=${encodeURIComponent(page.nextCursor)}` };
  }
  return body;
}

/** @param {unknown} status @param {string} route */
function fixtureStatus(status, route) {
  if (typeof status === "number") return status;
  const routes = status && typeof status === "object" ?
    /** @type {Record<string, number | number[]>} */ (status) : null;
  const value = routes?.[route];
  if (Array.isArray(value)) {
    const next = value.length > 1 ? value.shift() : value[0];
    return Number.isInteger(next) ? next : 200;
  }
  return Number.isInteger(value) ? value : 200;
}

/** @typedef {{ id: string, githubId: string, owner: string, name: string, htmlUrl: string, description: string | null, homepageUrl: string | null, defaultBranch: string, primaryLanguage: string | null, stars: number, forks: number, licenseSpdx: string | null, topics: string[], githubUpdatedAt: string, githubPushedAt: string | null, activityRefreshedAt: number | null, activityRefreshGeneration: number, readmeSha: string | null, readmeStatus: string, summary: string | null, problem: string | null, values: string[], audience: string | null, cautions: string | null, primaryCategory: string | null, analysisStatus: string, analysisErrorCode: string | null, analysisModel: string | null, promptVersion: string | null, analysisStartedAt: number | null, personalNote: string, analysisGeneration: number, tags: string[], createdAt: number | null }} SeedRepository */
/** @type {Readonly<SeedRepository>} */
const seedDefaults = Object.freeze({
  id: "repo-1", githubId: "1", owner: "owner", name: "repository",
  htmlUrl: "https://github.com/owner/repository", description: "description",
  homepageUrl: null, defaultBranch: "main", primaryLanguage: "JavaScript",
  stars: 1, forks: 1, licenseSpdx: "MIT", topics: ["topic"],
  githubUpdatedAt: "2026-08-09T00:00:00Z", githubPushedAt: "2026-08-08T00:00:00Z",
  activityRefreshedAt: 1, activityRefreshGeneration: 1, readmeSha: null,
  readmeStatus: "missing", summary: "기존 요약이다.", problem: "기존 문제다.",
  values: ["기존 가치다."], audience: "개발자", cautions: "주의한다.",
  primaryCategory: "Backend", analysisStatus: "ready", analysisErrorCode: null,
  analysisModel: "test-snapshot", promptVersion: "repo-atlas-v1.0",
  analysisStartedAt: null, personalNote: "", analysisGeneration: 1,
  tags: [], createdAt: null,
});

/** @param {any} db @param {Partial<SeedRepository>} [overrides] */
export async function seedRepository(db, overrides = {}) {
  for (const key of Object.keys(overrides)) {
    if (!(key in seedDefaults)) throw new Error(`Unknown seed override: ${key}`);
  }
  const row = { ...seedDefaults, ...overrides };
  await db.prepare(
    `INSERT INTO repositories (
      id, github_id, owner, name, html_url, description, homepage_url,
      default_branch, primary_language, stars, forks, license_spdx, topics_json,
      github_updated_at, github_pushed_at, activity_refreshed_at, activity_refresh_generation,
      readme_sha, readme_status, source_refreshed_at,
      summary, problem, values_json, audience, cautions, primary_category,
      analysis_status, analysis_error_code, analysis_model, prompt_version,
      analysis_started_at, analyzed_at, personal_note, analysis_generation,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(),
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), ?, ?,
      COALESCE(?, unixepoch()), unixepoch())`,
  ).bind(
    row.id, row.githubId, row.owner, row.name, row.htmlUrl, row.description,
    row.homepageUrl, row.defaultBranch, row.primaryLanguage, row.stars, row.forks,
    row.licenseSpdx, JSON.stringify(row.topics), row.githubUpdatedAt, row.githubPushedAt,
    row.activityRefreshedAt, row.activityRefreshGeneration, row.readmeSha,
    row.readmeStatus, row.summary, row.problem, JSON.stringify(row.values), row.audience,
    row.cautions, row.primaryCategory, row.analysisStatus, row.analysisErrorCode,
    row.analysisModel, row.promptVersion, row.analysisStartedAt, row.personalNote,
    row.analysisGeneration, row.createdAt,
  ).run();
  for (const tag of row.tags) {
    await db.prepare(
      "INSERT INTO repository_tags (repository_id, normalized_tag) VALUES (?, ?)",
    ).bind(row.id, tag).run();
  }
}

/** @param {any} db @param {{ id?: string, repositoryId?: string, body?: string, createdAt?: number, updatedAt?: number }} [overrides] */
export async function seedRepositoryNote(db, overrides = {}) {
  const row = {
    id: "note-1", repositoryId: "repo-1", body: "Note body",
    createdAt: 1, updatedAt: 1, ...overrides,
  };
  await db.prepare(
    "INSERT INTO repository_notes " +
    "(id, repository_id, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).bind(row.id, row.repositoryId, row.body, row.createdAt, row.updatedAt).run();
  return row;
}

/** @param {any} db @param {number} count @param {{ matchingName?: string }} [options] */
export async function seedNamedRepositories(db, count, options = {}) {
  for (let index = 0; index < count; index += 1) {
    const suffix = String(index).padStart(4, "0");
    await seedRepository(db, {
      id: `repo-${suffix}`, githubId: String(index + 1), name:
        index === 0 && options.matchingName ? options.matchingName : `repository-${suffix}`,
      htmlUrl: `https://github.com/owner/repository-${suffix}`,
      createdAt: index + 1,
    });
  }
}

/** @param {{ metadata?: Record<string, any>, analysis?: typeof analysisFixture, metadataStatus?: number, metadataRetryAfter?: string, openAiStatus?: number, readmeStatus?: number, beforeOpenAi?: () => unknown, openAiGate?: Promise<unknown>, threadsProfilePages?: unknown, threadsConversationPages?: unknown, threadsMedia?: Record<string, any>, threadsStatus?: number | Record<string, number | number[]>, threadsRetryAfter?: string, threadsDebug?: Record<string, any>, mediaBodies?: Record<string, BodyInit | { body: BodyInit, status?: number, headers?: HeadersInit }>, calls?: Array<{ method: string, path: string }> }} [options] */
export function providerFixture(options = {}) {
  const {
  metadata = metadataFixture,
  analysis = analysisFixture,
  metadataStatus = 200,
  metadataRetryAfter,
  openAiStatus = 200,
  readmeStatus = 200,
  beforeOpenAi = () => {},
  openAiGate = Promise.resolve(),
  threadsProfilePages = [{ data: [threadsRootMedia] }],
  threadsConversationPages = [{ data: [] }],
  threadsMedia = { "root-1": threadsRootMedia },
  threadsStatus = 200,
  threadsRetryAfter,
  threadsDebug = {
    app_id: "test-threads-app", type: "USER", application: "Repo Atlas",
    user_id: "author-1", data_access_expires_at: 1_999_000_000,
    expires_at: 2_000_000_000, issued_at: 1_900_000_000, is_valid: true,
    scopes: ["threads_basic", "threads_profile_discovery", "threads_read_replies"],
    granular_scopes: [
      { scope: "threads_basic" },
      { scope: "threads_profile_discovery", target_ids: ["author-1"] },
    ],
  },
  mediaBodies = { "fixture-avatar": "avatar", "fixture-image": "image" },
  calls,
  } = options;
  /** @param {RequestInfo | URL} input @param {RequestInit} [init] */
  return async (input, init = {}) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const path = `${url.pathname}${url.search}`;
    if (url.origin === "https://api.github.com" && method === "GET" &&
      /^\/repos\/[^/]+\/[^/]+$/.test(url.pathname) && !url.search) {
      calls?.push({ method, path });
      return metadataStatus === 200
        ? Response.json(metadata)
        : new Response(null, {
          status: metadataStatus,
          headers: metadataRetryAfter ? { "Retry-After": metadataRetryAfter } : {},
        });
    }
    if (url.origin === "https://api.github.com" && method === "GET" &&
      /^\/repos\/[^/]+\/[^/]+\/readme$/.test(url.pathname) &&
      [...url.searchParams.keys()].every((key) => key === "ref") &&
      url.searchParams.getAll("ref").length === 1 && url.searchParams.get("ref")) {
      calls?.push({ method, path });
      return readmeStatus === 200
        ? new Response("# Example", { headers: { "Content-Type": "text/plain; charset=utf-8" } })
        : new Response(null, { status: readmeStatus });
    }
    if (url.origin === "https://api.openai.com" && method === "POST" &&
      url.pathname === "/v1/responses" && !url.search) {
      calls?.push({ method, path });
      await beforeOpenAi();
      await openAiGate;
      return openAiStatus === 200
        ? Response.json({
          model: "gpt-5.6-terra-test-snapshot",
          output: [{ type: "message", content: [{
            type: "output_text", text: JSON.stringify(analysis),
          }] }],
        })
        : new Response(null, { status: openAiStatus });
    }
    const unexpected = () => { throw new Error(`Unexpected provider request: ${method} ${url}`); };
    const statusResponse = (/** @type {string} */ route) => {
      const status = fixtureStatus(threadsStatus, route);
      return status === 200 ? null : new Response(null, { status, headers: threadsRetryAfter ? { "Retry-After": threadsRetryAfter } : {} });
    };
    if (["https://www.threads.com", "https://threads.com", "https://www.threads.net",
      "https://threads.net"].includes(url.origin) && method === "GET" &&
      url.pathname === "/t/RootShort" && !url.search &&
      !request.headers.get("authorization")) {
      calls?.push({ method, path });
      return new Response(null, { status: 302, headers: { Location: "https://www.threads.com/@meta/post/RootShort" } });
    }
    if (url.origin === "https://graph.threads.net" && url.pathname === "/v1.0/oauth/access_token" && method === "POST" && !url.search && !request.headers.get("authorization")) {
      const form = new URLSearchParams(await request.text());
      if ([...form.keys()].length !== 5 || !["client_id", "client_secret", "grant_type", "redirect_uri", "code"].every((key) => form.getAll(key).length === 1) || form.get("grant_type") !== "authorization_code") return unexpected();
      calls?.push({ method, path });
      return statusResponse("oauth/access_token") ?? Response.json({ access_token: "short-token", user_id: "author-1" });
    }
    if (url.origin === "https://graph.threads.net" && method === "GET" && url.pathname === "/v1.0/access_token" && exactQuery(url, ["grant_type", "client_secret", "access_token"]) && url.searchParams.get("grant_type") === "th_exchange_token" && !request.headers.get("authorization")) {
      calls?.push({ method, path });
      return statusResponse("access_token") ?? Response.json({ access_token: "long-token", token_type: "bearer", expires_in: 5_184_000 });
    }
    if (url.origin === "https://graph.threads.net" && method === "GET" && url.pathname === "/v1.0/refresh_access_token" && exactQuery(url, ["grant_type", "access_token"]) && url.searchParams.get("grant_type") === "th_refresh_token" && !request.headers.get("authorization")) {
      calls?.push({ method, path });
      return statusResponse("refresh_access_token") ?? Response.json({ access_token: "refreshed-token", token_type: "bearer", expires_in: 5_184_000 });
    }
    if (url.origin === "https://graph.threads.net" && method === "GET" && url.pathname === "/v1.0/debug_token" && exactQuery(url, ["input_token"]) && bearer(request) && request.headers.get("authorization") === `Bearer ${url.searchParams.get("input_token")}`) {
      calls?.push({ method, path });
      return statusResponse("debug_token") ?? Response.json({ data: threadsDebug });
    }
    if (url.origin === "https://graph.threads.net" && method === "GET" && url.pathname === "/v1.0/profile_lookup" && exactQuery(url, ["fields", "username"]) && url.searchParams.get("fields") === threadsProfileFields && url.searchParams.get("username") === "meta" && bearer(request)) {
      calls?.push({ method, path });
      return statusResponse("profile_lookup") ?? Response.json(threadsProfile);
    }
    if (url.origin === "https://graph.threads.net" && method === "GET" && url.pathname === "/v1.0/profile_posts" && exactQuery(url, [...(url.searchParams.has("after") ? ["fields", "username", "after"] : ["fields", "username"])]) && url.searchParams.get("fields") === threadsFields && url.searchParams.get("username") === "meta" && bearer(request)) {
      const after = url.searchParams.get("after");
      const page = fixturePage(threadsProfilePages, after, "profile_posts");
      if (!page) return unexpected();
      calls?.push({ method, path });
      return statusResponse("profile_posts") ?? Response.json(page);
    }
    const mediaMatch = /^\/v1\.0\/([^/]+)$/.exec(url.pathname);
    if (url.origin === "https://graph.threads.net" && method === "GET" && mediaMatch && exactQuery(url, ["fields"]) && url.searchParams.get("fields") === threadsFields && bearer(request)) {
      const body = threadsMedia[decodeURIComponent(mediaMatch[1])];
      if (!body) return unexpected();
      calls?.push({ method, path });
      return statusResponse("media") ?? Response.json(body);
    }
    const conversationMatch = /^\/v1\.0\/([^/]+)\/conversation$/.exec(url.pathname);
    if (url.origin === "https://graph.threads.net" && method === "GET" && conversationMatch && exactQuery(url, url.searchParams.has("after") ? ["fields", "after"] : ["fields"]) && url.searchParams.get("fields") === threadsFields && bearer(request)) {
      const id = decodeURIComponent(conversationMatch[1]);
      const conversationSets = threadsConversationPages && typeof threadsConversationPages === "object" && !Array.isArray(threadsConversationPages) ? /** @type {Record<string, unknown>} */ (threadsConversationPages) : null;
      const pages = conversationSets && id in conversationSets ? conversationSets[id] : threadsConversationPages;
      const page = fixturePage(pages, url.searchParams.get("after"), `${id}/conversation`);
      if (!page) return unexpected();
      calls?.push({ method, path });
      return statusResponse("conversation") ?? Response.json(page);
    }
    if (["cdninstagram.com", "fbcdn.net"].some((host) =>
      url.hostname === host || url.hostname.endsWith(`.${host}`)) &&
      method === "GET" && !url.port && !url.search && /^\/[^/]+$/.test(url.pathname) &&
      !request.headers.get("authorization")) {
      const object = decodeURIComponent(url.pathname.slice(1));
      if (!(object in mediaBodies)) return unexpected();
      calls?.push({ method, path });
      const value = mediaBodies[object];
      if (value && typeof value === "object" && !(value instanceof Blob) &&
        !(value instanceof ArrayBuffer) && !ArrayBuffer.isView(value) &&
        !(value instanceof ReadableStream) && Object.hasOwn(value, "body")) {
        const spec = /** @type {{ body: BodyInit, status?: number, headers?: HeadersInit }} */ (value);
        return new Response(spec.body, { status: spec.status, headers: spec.headers });
      }
      const response = new Response(/** @type {BodyInit} */ (value));
      let length = null;
      if (value instanceof Blob) length = value.size;
      else if (typeof value === "string") length = new TextEncoder().encode(value).byteLength;
      else if (value instanceof ArrayBuffer) length = value.byteLength;
      else if (ArrayBuffer.isView(value)) length = value.byteLength;
      if (length !== null) response.headers.set("Content-Length", String(length));
      return response;
    }
    return unexpected();
  };
}

/** @typedef {{ id: string, shortcode: string, threadsMediaId: string | null,
 * submittedUrl: string, canonicalUrl: string | null, status: string,
 * errorCode: string | null, syncGeneration: number, authorId: string,
 * username: string, displayName: string, rootEntryId: string, rootText: string,
 * rootPermalink: string, rootPublishedAt: string, rootMediaType: string,
 * createdAt: number, updatedAt: number, withRoot: boolean, withJob: boolean,
 * jobStatus: string, jobErrorCode: string | null, profileCompleted: boolean,
 * conversationStarted: boolean, conversationCompleted: boolean,
 * captureLease: string | null }} SeedThreadsArchive */
/** @type {Readonly<SeedThreadsArchive>} */
const threadsArchiveDefaults = Object.freeze({
  id: "threads-post-1", shortcode: "RootShort", threadsMediaId: "root-1",
  submittedUrl: "https://www.threads.com/@meta/post/RootShort",
  canonicalUrl: "https://www.threads.com/@meta/post/RootShort",
  status: "ready", errorCode: null, syncGeneration: 1,
  authorId: "author-1", username: "meta", displayName: "Meta",
  rootEntryId: "threads-entry-root-1", rootText: "Archived root",
  rootPermalink: "https://www.threads.com/@meta/post/RootShort",
  rootPublishedAt: "2026-08-24T00:00:00Z", rootMediaType: "TEXT_POST",
  createdAt: 1, updatedAt: 1, withRoot: true, withJob: true,
  jobStatus: "ready", jobErrorCode: null,
  profileCompleted: true, conversationStarted: true, conversationCompleted: true,
  captureLease: null,
});

/** @param {any} db @param {Partial<SeedThreadsArchive>} [overrides] */
export async function seedThreadsArchive(db, overrides = {}) {
  for (const key of Object.keys(overrides)) {
    if (!(key in threadsArchiveDefaults)) throw new Error(`Unknown Threads seed override: ${key}`);
  }
  const row = { ...threadsArchiveDefaults, ...overrides };
  await db.prepare(
    `INSERT INTO threads_authors
       (threads_user_id, username, display_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(threads_user_id) DO UPDATE SET
       username = excluded.username, display_name = excluded.display_name,
       updated_at = excluded.updated_at`,
  ).bind(row.authorId, row.username, row.displayName, row.createdAt, row.updatedAt).run();
  await db.prepare(
    `INSERT INTO threads_posts
       (id, shortcode, threads_media_id, submitted_url, canonical_url, root_author_id,
        status, error_code, sync_generation, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    row.id, row.shortcode, row.threadsMediaId, row.submittedUrl, row.canonicalUrl,
    row.authorId, row.status, row.errorCode, row.syncGeneration, row.createdAt, row.updatedAt,
  ).run();
  if (row.withRoot) {
    await db.prepare(
      `INSERT INTO threads_entries
         (id, threads_post_id, source_media_id, kind, author_id, text, permalink,
          published_at, media_type, first_seen_at, last_seen_at, created_at)
       VALUES (?, ?, ?, 'root', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      row.rootEntryId, row.id, row.threadsMediaId, row.authorId, row.rootText,
      row.rootPermalink, row.rootPublishedAt, row.rootMediaType,
      row.createdAt, row.updatedAt, row.createdAt,
    ).run();
  }
  if (row.withJob) {
    await db.prepare(
      `INSERT INTO threads_sync_jobs
         (id, threads_post_id, generation, status, error_code, profile_completed,
          conversation_started, conversation_completed, capture_lease, queued_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      `threads-job-${row.id}-${row.syncGeneration}`, row.id, row.syncGeneration,
      row.jobStatus, row.jobErrorCode, row.profileCompleted ? 1 : 0,
      row.conversationStarted ? 1 : 0, row.conversationCompleted ? 1 : 0,
      row.captureLease, row.createdAt, row.updatedAt,
    ).run();
  }
  return row;
}

/** @param {any} worker @param {{ origin?: string, pin?: string, ip?: string }} [options] */
export async function login(worker, {
  origin = "https://production.repo-atlas.test", pin = "123456", ip = "192.0.2.1",
} = {}) {
  const body = new FormData();
  body.set("pin", pin);
  const response = await worker.fetch(`${origin}/session`, {
    method: "POST", headers: { Origin: origin, "CF-Connecting-IP": ip }, body,
  });
  const cookie = response.headers.get("set-cookie");
  if (response.status !== 303 || !cookie) throw new Error("test_login_failed");
  const index = await worker.fetch(`${origin}/`, { headers: { Cookie: cookie } });
  const csrf = /name="csrf" value="([^"]+)"/.exec(await index.text())?.[1];
  if (!csrf) throw new Error("test_csrf_missing");
  return { origin, cookie, csrf };
}

/** @param {any} worker @param {string} path @param {{ origin: string, cookie: string, csrf: string }} session @param {Record<string, unknown>} fields @param {Record<string, string>} [headers] */
export async function postForm(worker, path, session, fields, headers = {}) {
  const body = new FormData();
  body.set("csrf", session.csrf);
  for (const [name, value] of Object.entries(fields)) body.set(name, String(value));
  return worker.fetch(`${session.origin}${path}`, {
    method: "POST", headers: { Origin: session.origin, Cookie: session.cookie, ...headers }, body,
  });
}

export async function startHarness() {
  const server = createTestHarness({
    workers: [
      {
        configPath: "./wrangler.jsonc", env: "test", vars, secrets,
        bindingOverrides: { PROVIDER_FIXTURE: "provider-fixture" },
      },
      { configPath: "./test/support/provider-fixture.wrangler.jsonc" },
    ],
  });
  const originalFetch = globalThis.fetch;
  /** @type {URL} */
  let url;
  async function resetForBrowser() {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try { await server.reset(); return; }
      catch (error) {
        if (!shouldRetryBrowserListen(error)) throw error;
      }
    }
    throw new Error("test_harness_unsafe_port");
  }
  async function listenForBrowser() {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const listener = await server.listen();
      try {
        await originalFetch(new URL("/health", listener.url));
        return listener.url;
      } catch (error) {
        if (shouldRetryBrowserListen(error)) {
          await resetForBrowser();
          continue;
        }
        if (shouldAcceptBrowserListen(error)) return listener.url;
        throw error;
      }
    }
    throw new Error("test_harness_unsafe_port");
  }
  url = await listenForBrowser();
  /** @type {import("wrangler").WorkerHandle<Env>} */
  let remoteWorker = server.getWorker();
  const configuredWorker = {
    /** @param {RequestInfo | URL} input @param {RequestInit} [init] */
    fetch(input, init) {
      if (init?.body instanceof FormData) {
        const body = new URLSearchParams();
        for (const [name, value] of init.body) {
          if (typeof value !== "string") throw new Error("test_configured_file_unsupported");
          body.append(name, value);
        }
        const headers = new Headers(init.headers);
        headers.set("Content-Type", "application/x-www-form-urlencoded;charset=UTF-8");
        return server.fetch(String(input), /** @type {any} */ ({
          redirect: "manual", ...init, body, headers,
        }));
      }
      return server.fetch(String(input), /** @type {any} */ ({
        redirect: "manual", ...init,
      }));
    },
  };
  /** @type {{ origin: string, cookie: string, csrf: string } | undefined} */
  let configuredSession;
  let providerMode = {};
  /** @type {Record<string, unknown>[]} */
  const captureMessages = [];
  /** @type {Record<string, unknown>[]} */
  const mediaMessages = [];
  let queueMode = { captureReject: false, mediaReject: false };
  /** @param {Record<string, unknown>[]} messages
   * @param {(message: unknown) => Record<string, unknown>} validate
   * @param {"captureReject" | "mediaReject"} rejected */
  const queue = (messages, validate, rejected) => ({
    messages,
    /** @param {unknown} message @param {unknown} [options] */
    async send(message, options) {
      if (options !== undefined) structuredClone(options);
      const copy = validate(structuredClone(message));
      if (queueMode[rejected]) throw new Error("test_queue_rejection");
      messages.push(copy);
    },
  });
  const captureQueue = queue(captureMessages, validateCaptureMessage, "captureReject");
  const mediaQueue = queue(mediaMessages, validateMediaMessage, "mediaReject");
  /** @type {Map<string, { key: string, bytes: Uint8Array, size: number,
   * httpEtag: string, etag: string, httpMetadata: { contentType?: string } }>} */
  const r2Objects = new Map();
  let r2Mode = { putReject: false, getReject: false, deleteReject: false };
  const mediaBucket = {
    /** @param {string} key @param {ReadableStream<Uint8Array>} body
     * @param {{ httpMetadata?: { contentType?: string },
     * onlyIf?: { etagMatches?: string, etagDoesNotMatch?: string } }} [options] */
    async put(key, body, options = {}) {
      if (r2Mode.putReject) throw new Error("test_r2_put_rejection");
      if (!(body instanceof ReadableStream)) throw new Error("test_r2_stream_required");
      const current = r2Objects.get(key);
      if (options.onlyIf?.etagMatches !== undefined &&
        current?.etag !== options.onlyIf.etagMatches) return null;
      if (options.onlyIf?.etagDoesNotMatch === "*" && current) return null;
      if (options.onlyIf?.etagDoesNotMatch !== undefined &&
        options.onlyIf.etagDoesNotMatch !== "*" &&
        current?.etag === options.onlyIf.etagDoesNotMatch) return null;
      const reader = body.getReader();
      /** @type {Uint8Array[]} */
      const chunks = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array)) throw new Error("test_r2_byte_chunk_required");
        chunks.push(value); size += value.byteLength;
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const httpEtag = `"r2-${size}"`;
      const object = {
        key, bytes, size, httpEtag, etag: `r2-${size}`,
        httpMetadata: { ...options.httpMetadata },
      };
      r2Objects.set(key, object);
      return { ...object, bytes: undefined };
    },
    /** @param {string} key @param {{ range?: { offset: number, length: number } }} [options] */
    async get(key, options = {}) {
      if (r2Mode.getReject) throw new Error("test_r2_get_rejection");
      const object = r2Objects.get(key);
      if (!object) return null;
      const offset = options.range?.offset ?? 0;
      const length = options.range?.length ?? object.size;
      const selected = object.bytes.slice(offset, offset + length);
      return {
        key: object.key, size: object.size, etag: object.etag,
        httpEtag: object.httpEtag, httpMetadata: { ...object.httpMetadata },
        range: options.range ? { offset, length: selected.byteLength } : undefined,
        body: new Blob([selected]).stream(),
      };
    },
    /** @param {string} key */
    async head(key) {
      const object = r2Objects.get(key);
      return object ? {
        key: object.key, size: object.size, etag: object.etag,
        httpEtag: object.httpEtag, httpMetadata: { ...object.httpMetadata },
      } : null;
    },
    /** @param {string | string[]} keys */
    async delete(keys) {
      if (r2Mode.deleteReject) throw new Error("test_r2_delete_rejection");
      for (const key of Array.isArray(keys) ? keys : [keys]) r2Objects.delete(key);
    },
  };
  /** @param {RequestInfo | URL} input @param {RequestInit} [init] */
  const outboundFetch = (input, init) => providerFixture(providerMode)(input, init);
  const providerService = /** @type {Fetcher} */ ({
    fetch: outboundFetch,
    connect() { throw new Error("provider_fixture_socket_unsupported"); },
  });
  globalThis.fetch = outboundFetch;
  /** @type {{ reject?: boolean }} */
  let assetMode = {};
  const assets = { async fetch(/** @type {Request} */ request) {
    if (assetMode.reject) throw new Error("test_asset_rejection");
    const name = new URL(request.url).pathname.split("/").pop();
    if (!name || !/^[a-z0-9.-]+$/.test(name)) return new Response("Not Found", { status: 404 });
    try { return new Response(await readFile(new URL(name, browserAssetRoot))); }
    catch { return new Response("Not Found", { status: 404 }); }
  } };
  /** @type {{ getEnv(): Promise<Env>, applyD1Migrations(name: "PROD_DB"): Promise<void>, fetch(input: any, init?: any): Promise<Response> }} */
  const worker = {
    async getEnv() {
      const { PROVIDER_FIXTURE: unusedProviderFixture, ...runtimeEnv } =
        /** @type {Env & { PROVIDER_FIXTURE?: unknown }} */ (await remoteWorker.getEnv());
      void unusedProviderFixture;
      return { ...runtimeEnv, PROVIDER_FIXTURE: providerService };
    },
    applyD1Migrations: (name) => remoteWorker.applyD1Migrations(name),
    async fetch(input, init) {
      const request = input instanceof Request ? input : new Request(input, init);
      const { PROVIDER_FIXTURE: unusedProviderFixture, ...runtimeEnv } =
        /** @type {Env & { PROVIDER_FIXTURE?: unknown }} */ (await remoteWorker.getEnv());
      void unusedProviderFixture;
      const env = {
        ...runtimeEnv, ASSETS: assets, PROVIDER_FIXTURE: providerService,
        THREADS_MEDIA: mediaBucket,
        THREADS_CAPTURE_QUEUE: captureQueue,
        THREADS_MEDIA_QUEUE: mediaQueue,
        THREADS_CAPTURE_QUEUE_NAME: "repo-atlas-test-threads-capture",
        THREADS_MEDIA_QUEUE_NAME: "repo-atlas-test-threads-media",
        THREADS_CAPTURE_DLQ_NAME: "repo-atlas-test-threads-capture-dlq",
        THREADS_MEDIA_DLQ_NAME: "repo-atlas-test-threads-media-dlq",
      };
      return handleRequest(request, env, { waitUntil() {} }, providerFixture(providerMode));
    },
  };
  /** @param {any} options */
  async function setProviderMode(options) { providerMode = { ...options }; }
  /** @param {string} id @param {string} expectedStatus @param {number} [timeoutMs] */
  async function waitForThreadsArchive(id, expectedStatus, timeoutMs = 10_000) {
    if (!configuredSession)
      configuredSession = await login(configuredWorker, { origin: url.origin });
    const deadline = Date.now() + timeoutMs;
    let delayMs = 25;
    do {
      const { cookie } = configuredSession;
      const response = await configuredWorker.fetch(
        `${configuredSession.origin}/threads/${encodeURIComponent(id)}`,
        { headers: { Accept: "application/json", Cookie: cookie } },
      );
      if (response.status === 200) {
        const body = /** @type {any} */ (await response.json());
        if (body?.archive?.status === expectedStatus) return body;
      } else await response.body?.cancel();
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, remaining)));
      delayMs = Math.min(delayMs * 2, 250);
    } while (Date.now() <= deadline);
    server.debug();
    throw new Error(`test_threads_archive_timeout:${expectedStatus}`);
  }
  /** @param {{ captureReject?: boolean, mediaReject?: boolean }} options */
  async function setQueueMode(options) {
    queueMode = {
      captureReject: options.captureReject === true,
      mediaReject: options.mediaReject === true,
    };
  }
  /** @param {{ putReject?: boolean, getReject?: boolean, deleteReject?: boolean }} options */
  async function setR2Mode(options) {
    r2Mode = {
      putReject: options.putReject === true,
      getReject: options.getReject === true,
      deleteReject: options.deleteReject === true,
    };
  }
  function mediaObjects() {
    return [...r2Objects.values()].sort((left, right) => left.key.localeCompare(right.key))
      .map((object) => ({
        key: object.key, bytes: new Uint8Array(object.bytes), size: object.size,
        httpEtag: object.httpEtag, etag: object.etag,
        httpMetadata: { ...object.httpMetadata },
      }));
  }
  /** @param {{ reject?: boolean }} options */
  async function setAssetMode(options) { assetMode = { ...options }; }
  /** @param {{ getAccessToken?: () => Promise<Record<string, unknown>>, nowSeconds?: number, signal?: AbortSignal, deleteArchive?: (message: Record<string, unknown>) => Promise<unknown> }} [options] */
  async function drainCaptureQueue(options = {}) {
    const env = await worker.getEnv();
    let processed = 0;
    let retries = 0;
    while (captureMessages.length) {
      if (processed >= 500) throw new Error("test_capture_queue_did_not_quiesce");
      const message = captureMessages.shift();
      const result = await handleThreadsCaptureMessage(message, {
        db: env.PROD_DB, captureQueue, mediaQueue, fetcher: outboundFetch,
        getAccessToken: options.getAccessToken ?? (async () => ({ accessToken: "long-token" })),
        nowSeconds: options.nowSeconds ?? 4_000, signal: options.signal,
        deleteArchive: options.deleteArchive ?? ((message) => deleteThreadsArchive(message, {
          db: env.PROD_DB, bucket: mediaBucket,
          nowSeconds: options.nowSeconds ?? 4_000,
        })),
      });
      processed += 1;
      if (result.action === "retry") {
        retries += 1;
        captureMessages.push(validateCaptureMessage(structuredClone(message)));
      } else if (result.action !== "ack") throw new Error("test_invalid_capture_action");
    }
    return { processed, retries };
  }
  /** @param {{ getAccessToken?: () => Promise<Record<string, unknown>>,
   * nowSeconds?: number, signal?: AbortSignal, maximumBytes?: number }} [options] */
  async function drainMediaQueue(options = {}) {
    const env = await worker.getEnv();
    let processed = 0;
    let retries = 0;
    while (mediaMessages.length) {
      if (processed >= 500) throw new Error("test_media_queue_did_not_quiesce");
      const message = mediaMessages.shift();
      const result = await handleThreadsMediaMessage(message, {
        db: env.PROD_DB, bucket: mediaBucket, fetcher: outboundFetch,
        getAccessToken: options.getAccessToken ?? (async () => ({ accessToken: "long-token" })),
        recalculateStatus: recalculateThreadsStatus,
        nowSeconds: options.nowSeconds ?? 4_000, signal: options.signal,
        maximumBytes: options.maximumBytes,
      });
      processed += 1;
      if (result.action === "retry") {
        retries += 1;
        mediaMessages.push(validateMediaMessage(structuredClone(message)));
      } else if (result.action !== "ack") throw new Error("test_invalid_media_action");
    }
    return { processed, retries };
  }
  function providerCalls() {
    return server.getLogs().flatMap((entry) =>
      JSON.stringify(entry).match(/provider_fixture:[a-z_]+/g) ?? []);
  }
  async function reset() {
    const initialized = await runBrowserResetTransaction({
      reset: () => server.reset(),
      listen: async () => (await server.listen()).url,
      async probe(candidate) {
        try { await originalFetch(new URL("/health", candidate)); }
        catch (error) {
          if (!shouldAcceptBrowserListen(error)) throw error;
        }
      },
      getWorker: () => server.getWorker(),
      migrate: (worker) => worker.applyD1Migrations("PROD_DB"),
      async initializeBinding(worker) {
        const env = await worker.getEnv();
        // ponytail: reset recreates storage; retain ledgers if incremental migration tests are added.
        await env.PROD_DB.exec("DROP TABLE d1_migrations");
      },
    });
    url = initialized.url;
    remoteWorker = initialized.worker;
    providerMode = {};
    configuredSession = undefined;
    captureMessages.length = 0;
    mediaMessages.length = 0;
    queueMode = { captureReject: false, mediaReject: false };
    r2Objects.clear();
    r2Mode = { putReject: false, getReject: false, deleteReject: false };
    assetMode = {};
  }
  await reset();
  async function close() {
    if (globalThis.fetch === outboundFetch) globalThis.fetch = originalFetch;
    await server.close();
  }
  return {
    get url() { return url; },
    get remoteWorker() { return remoteWorker; },
    server, worker, configuredWorker, captureQueue, mediaQueue, captureMessages,
    mediaMessages, mediaBucket,
    setProviderMode, setQueueMode, setR2Mode, setAssetMode,
    drainCaptureQueue, drainMediaQueue, mediaObjects, waitForThreadsArchive,
    providerCalls, reset, close,
  };
}
