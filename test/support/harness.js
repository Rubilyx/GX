import { createTestHarness } from "wrangler";
import { handleRequest } from "../../src/worker.js";

const secrets = Object.freeze({
  PROD_PIN_SALT: "cmVwby1hdGxhcy10ZXN0LXNhbHQ=",
  PROD_PIN_DIGEST: "X3eotQ9GFhyeDwcCPzwVmINdYuMBwamov6bQPl+DQWk=",
  PROD_IP_HMAC_KEY: "cmVwby1hdGxhcy10ZXN0LWlwLWtleQ==",
  PROD_SESSION_KEY: "cmVwby1hdGxhcy10ZXN0LXNlc3Npb24ta2V5",
  OPENAI_API_KEY: "test-openai-key",
});

const vars = Object.freeze({
  ENVIRONMENT: "test",
  PRODUCTION_HOST: "production.repo-atlas.test",
  OPENAI_MODEL: "test-snapshot",
  RELEASE_ID: "test-release",
  TRUSTED_TYPES_MODE: "report-only",
});

/** @param {unknown} error */
export function shouldRetryBrowserListen(error) {
  return error instanceof TypeError && /bad port/i.test(`${error.message} ${
    error.cause instanceof Error ? error.cause.message : ""}`);
}

/** @param {unknown} error */
export function shouldAcceptBrowserListen(error) {
  const cause = error instanceof TypeError && error.cause instanceof Error
    ? /** @type {Error & { code?: unknown }} */ (error.cause) : undefined;
  return cause?.code === "DEPTH_ZERO_SELF_SIGNED_CERT";
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

/** @typedef {{ id: string, githubId: string, owner: string, name: string, htmlUrl: string, description: string | null, homepageUrl: string | null, defaultBranch: string, primaryLanguage: string | null, stars: number, forks: number, licenseSpdx: string | null, topics: string[], githubUpdatedAt: string, readmeSha: string | null, readmeStatus: string, summary: string | null, problem: string | null, values: string[], audience: string | null, cautions: string | null, primaryCategory: string | null, analysisStatus: string, analysisErrorCode: string | null, analysisModel: string | null, promptVersion: string | null, analysisStartedAt: number | null, personalNote: string, analysisGeneration: number, tags: string[], createdAt: number | null }} SeedRepository */
/** @type {Readonly<SeedRepository>} */
const seedDefaults = Object.freeze({
  id: "repo-1", githubId: "1", owner: "owner", name: "repository",
  htmlUrl: "https://github.com/owner/repository", description: "description",
  homepageUrl: null, defaultBranch: "main", primaryLanguage: "JavaScript",
  stars: 1, forks: 1, licenseSpdx: "MIT", topics: ["topic"],
  githubUpdatedAt: "2026-08-09T00:00:00Z", readmeSha: null,
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
      github_updated_at, readme_sha, readme_status, source_refreshed_at,
      summary, problem, values_json, audience, cautions, primary_category,
      analysis_status, analysis_error_code, analysis_model, prompt_version,
      analysis_started_at, analyzed_at, personal_note, analysis_generation,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(),
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), ?, ?,
      COALESCE(?, unixepoch()), unixepoch())`,
  ).bind(
    row.id, row.githubId, row.owner, row.name, row.htmlUrl, row.description,
    row.homepageUrl, row.defaultBranch, row.primaryLanguage, row.stars, row.forks,
    row.licenseSpdx, JSON.stringify(row.topics), row.githubUpdatedAt, row.readmeSha,
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

/** @param {{ metadata?: Record<string, any>, analysis?: typeof analysisFixture, metadataStatus?: number, metadataRetryAfter?: string, openAiStatus?: number, readmeStatus?: number, beforeOpenAi?: () => unknown, openAiGate?: Promise<unknown>, calls?: Array<{ method: string, path: string }> }} [options] */
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
    throw new Error(`Unexpected provider request: ${method} ${url}`);
  };
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
  async function listenForBrowser() {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const listener = await server.listen();
      try {
        await originalFetch(new URL("/health", listener.url));
        return listener.url;
      } catch (error) {
        if (shouldRetryBrowserListen(error)) {
          await server.reset();
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
  const remoteWorker = server.getWorker();
  let providerMode = {};
  /** @param {RequestInfo | URL} input @param {RequestInit} [init] */
  const outboundFetch = (input, init) => providerFixture(providerMode)(input, init);
  globalThis.fetch = outboundFetch;
  /** @type {{ reject?: boolean }} */
  let assetMode = {};
  const assets = { async fetch(/** @type {Request} */ request) {
    if (assetMode.reject) throw new Error("test_asset_rejection");
    const name = new URL(request.url).pathname.split("/").pop();
    if (name === "app.js") return new Response("export {};\n");
    if (name?.endsWith(".css")) return new Response("@layer components {}\n");
    if (name === "favicon.svg") return new Response('<svg xmlns="http://www.w3.org/2000/svg"/>');
    return new Response("Not Found", { status: 404 });
  } };
  /** @type {{ getEnv(): Promise<Env>, applyD1Migrations(name: "PROD_DB"): Promise<void>, fetch(input: any, init?: any): Promise<Response> }} */
  const worker = {
    async getEnv() {
      const { PROVIDER_FIXTURE: unusedProviderFixture, ...runtimeEnv } =
        /** @type {Env & { PROVIDER_FIXTURE?: unknown }} */ (await remoteWorker.getEnv());
      void unusedProviderFixture;
      return runtimeEnv;
    },
    applyD1Migrations: (name) => remoteWorker.applyD1Migrations(name),
    async fetch(input, init) {
      const request = input instanceof Request ? input : new Request(input, init);
      const { PROVIDER_FIXTURE: unusedProviderFixture, ...runtimeEnv } =
        /** @type {Env & { PROVIDER_FIXTURE?: unknown }} */ (await remoteWorker.getEnv());
      void unusedProviderFixture;
      const env = { ...runtimeEnv, ASSETS: assets };
      return handleRequest(request, env, { waitUntil() {} }, providerFixture(providerMode));
    },
  };
  /** @param {any} options */
  async function setProviderMode(options) { providerMode = { ...options }; }
  /** @param {{ reject?: boolean }} options */
  async function setAssetMode(options) { assetMode = { ...options }; }
  function providerCalls() {
    return server.getLogs().flatMap((entry) =>
      JSON.stringify(entry).match(/provider_fixture:[a-z_]+/g) ?? []);
  }
  async function reset() {
    await server.reset();
    url = await listenForBrowser();
    providerMode = {};
    assetMode = {};
    await remoteWorker.applyD1Migrations("PROD_DB");
    const env = await worker.getEnv();
    // ponytail: reset recreates storage; retain ledgers if incremental migration tests are added.
    await env.PROD_DB.exec("DROP TABLE d1_migrations");
  }
  await reset();
  async function close() {
    if (globalThis.fetch === outboundFetch) globalThis.fetch = originalFetch;
    await server.close();
  }
  return {
    get url() { return url; },
    server, worker, setProviderMode, setAssetMode, providerCalls, reset, close,
  };
}
