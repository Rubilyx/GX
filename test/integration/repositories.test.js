import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import {
  providerFixture, seedNamedRepositories, seedRepository, seedRepositoryNote, startHarness,
} from "../support/harness.js";
import {
  collectRepository, deleteRepository, getRepository, listRepositories,
  refreshRepository, refreshRepositoryActivity, updateRepository,
} from "../../src/repositories.js";

const metadataFixture = {
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
};

/** @type {{ summary: string, problem: string, values: string[], audience: string, cautions: string, primaryCategory: string, tags: string[] }} */
const analysisFixture = {
  summary: "예제 저장소의 핵심 사용법을 보여준다.",
  problem: "작동하는 최소 예제가 필요하다.",
  values: ["구조가 단순하다."],
  audience: "JavaScript 개발자",
  cautions: "예제 목적의 저장소다.",
  primaryCategory: "Backend",
  tags: ["example"],
};

/** @param {typeof fetch} fetcher */
function dependencies(fetcher) {
  return { fetcher, openAiApiKey: "secret", openAiModel: "gpt-5.6-terra-test-snapshot" };
}

/** @param {number} changes */
const changed = (changes) => ({ success: true, meta: { changes } });

/** @param {{ first?: any[], run?: any[], batch?: any[], all?: any[] }} [options] */
function d1Stub(options = {}) {
  const { first = [], run = [], batch = [], all = [] } = options;
  /** @param {any[]} queue @param {string} operation */
  const take = (queue, operation) => {
    if (!queue.length) throw new Error(`Unexpected D1 ${operation}`);
    return queue.shift();
  };
  return {
    prepare() {
      const statement = {
        bind() { return statement; },
        first() { return Promise.resolve(take(first, "first")); },
        run() { return Promise.resolve(take(run, "run")); },
        all() { return Promise.resolve(take(all, "all")); },
      };
      return statement;
    },
    batch() { return Promise.resolve(take(batch, "batch")); },
  };
}

/** @param {any} db */
function withoutLegacyRepositoryReads(db) {
  return {
    prepare(/** @type {string} */ sql) {
      if (/^\s*SELECT\b/i.test(sql) && (/\br\.\*/i.test(sql) || /\bpersonal_note\b/i.test(sql)))
        throw new Error("legacy repository column read");
      return db.prepare(sql);
    },
  };
}

/** @param {Promise<any>} promise */
async function rejectsStorage(promise) {
  await assert.rejects(
    promise,
    (error) => error instanceof Error && "code" in error && "status" in error &&
      error.code === "storage_unavailable" && error.status === 503,
  );
}

/** @type {Awaited<ReturnType<typeof startHarness>>} */
let harness;
before(async () => { harness = await startHarness(); });
beforeEach(async () => { await harness.reset(); });
after(async () => { await harness.close(); });

test("migration creates the complete table inventory and enforces five tags", async () => {
  const env = await harness.worker.getEnv();
  const rows = await env.PROD_DB.prepare(
    `SELECT name FROM sqlite_schema
     WHERE type = 'table'
       AND name NOT GLOB '_cf_*'
       AND name NOT GLOB 'sqlite_*'
     ORDER BY name`,
  ).all();
  assert.deepEqual(rows.results.map((row) => row.name), [
    "auth_attempts", "repositories", "repository_notes", "repository_tags", "telemetry_daily",
    "threads_authors", "threads_entries", "threads_links", "threads_media",
    "threads_oauth_credentials", "threads_posts", "threads_sync_cursors",
    "threads_sync_jobs",
  ]);
  const columns = await env.PROD_DB.prepare("PRAGMA table_info(repositories)").all();
  assert.equal(columns.results.some((column) => column.name === "github_pushed_at"), true);
  assert.equal(columns.results.some((column) => column.name === "activity_refreshed_at"), true);
  assert.equal(columns.results.some((column) => column.name === "activity_refresh_generation"), true);

  await env.PROD_DB.prepare(
    `INSERT INTO repositories
      (id, github_id, owner, name, html_url, default_branch, stars, forks,
       topics_json, github_updated_at, readme_status, source_refreshed_at,
       values_json, analysis_status, analysis_generation)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0, '[]', ?, 'missing', unixepoch(), '[]', 'pending', 1)`,
  ).bind("repo-1", "123", "openai", "example", "https://github.com/openai/example", "main", "2026-08-09T00:00:00Z").run();

  for (const tag of ["one", "two", "three", "four", "five"]) {
    await env.PROD_DB.prepare(
      "INSERT INTO repository_tags (repository_id, normalized_tag) VALUES (?, ?)",
    ).bind("repo-1", tag).run();
  }
  await assert.rejects(
    env.PROD_DB.prepare(
      "INSERT INTO repository_tags (repository_id, normalized_tag) VALUES (?, ?)",
    ).bind("repo-1", "six").run(),
    /repository_tag_limit/,
  );
});

test("persists GitHub metadata before calling OpenAI", async () => {
  const env = await harness.worker.getEnv();
  let sawPersisted = false;
  /** @type {typeof fetch} */
  const fetcher = async (input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.hostname === "api.github.com" && !url.pathname.endsWith("/readme"))
      return Response.json(metadataFixture);
    if (url.hostname === "api.github.com") return new Response("# Example");
    if (url.hostname === "api.openai.com") {
      const row = await env.PROD_DB.prepare(
        "SELECT analysis_status, github_pushed_at FROM repositories WHERE github_id = ?",
      ).bind(String(metadataFixture.id)).first();
      sawPersisted = row?.analysis_status === "pending" &&
        row.github_pushed_at === metadataFixture.pushed_at;
      return Response.json({
        model: "gpt-5.6-terra-test-snapshot",
        output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(analysisFixture) }] }],
      });
    }
    throw new Error(`Unexpected provider URL: ${url}`);
  };
  const result = await collectRepository(
    env.PROD_DB, "https://github.com/OpenAI/example", dependencies(fetcher),
  );
  assert.equal(sawPersisted, true);
  assert.equal(result.analysisStatus, "ready");
});

test("duplicate canonical rename preserves note analysis and tags", async () => {
  const env = await harness.worker.getEnv();
  await seedRepository(env.PROD_DB, {
    id: "existing", githubId: String(metadataFixture.id), personalNote: "보존할 메모",
    summary: "보존할 요약이다.", tags: ["keep"],
  });
  let calls = 0;
  /** @type {typeof fetch} */
  const fetcher = async (input) => {
    calls += 1;
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.hostname === "api.github.com" && !url.pathname.endsWith("/readme")) {
      return Response.json({ ...metadataFixture, owner: { login: "Renamed" }, name: "renamed" });
    }
    throw new Error("duplicate path reached a forbidden provider call");
  };
  const duplicate = await collectRepository(env.PROD_DB, "https://github.com/old/name", dependencies(fetcher));
  const row = await env.PROD_DB.prepare(
    "SELECT owner, name, html_url, github_pushed_at, personal_note, summary FROM repositories WHERE id = ?",
  ).bind("existing").first();
  assert.deepEqual(duplicate, {
    repositoryId: "existing", analysisStatus: "ready", errorCode: null, duplicate: true,
  });
  assert.equal(calls, 2);
  assert.deepEqual(row, {
    owner: "Renamed", name: "renamed", html_url: "https://github.com/Renamed/renamed",
    github_pushed_at: "2026-08-08T00:00:00Z",
    personal_note: "보존할 메모", summary: "보존할 요약이다.",
  });
  assert.equal(await env.PROD_DB.prepare(
    "SELECT COUNT(*) AS count FROM repository_tags WHERE repository_id = ?",
  ).bind("existing").first("count"), 1);
});

test("duplicate save refetches activity after claiming the newest write generation", async () => {
  const env = await harness.worker.getEnv();
  await seedRepository(env.PROD_DB, {
    id: "existing", githubId: String(metadataFixture.id), githubPushedAt: "2026-08-01T00:00:00Z",
  });
  let announceFirst = () => {};
  let releaseFirst = () => {};
  const firstStarted = new Promise((resolve) => { announceFirst = () => resolve(undefined); });
  const firstGate = new Promise((resolve) => { releaseFirst = () => resolve(undefined); });
  let metadataCalls = 0;
  /** @type {typeof fetch} */
  const duplicateFetcher = async (input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.hostname !== "api.github.com" || url.pathname.endsWith("/readme"))
      throw new Error("duplicate path reached a forbidden provider call");
    metadataCalls += 1;
    if (metadataCalls === 1) {
      announceFirst();
      await firstGate;
      return Response.json({ ...metadataFixture, pushed_at: "2026-08-02T00:00:00Z" });
    }
    return Response.json({ ...metadataFixture, pushed_at: "2026-08-20T00:00:00Z" });
  };
  const duplicate = collectRepository(
    env.PROD_DB, "https://github.com/OpenAI/example", dependencies(duplicateFetcher),
  );
  await firstStarted;
  await refreshRepositoryActivity(env.PROD_DB, "existing", providerFixture({
    metadata: { ...metadataFixture, pushed_at: "2026-08-10T00:00:00Z" },
  }));
  releaseFirst();
  await duplicate;

  assert.equal(metadataCalls, 2);
  assert.equal((await getRepository(env.PROD_DB, "existing"))?.githubPushedAt,
    "2026-08-20T00:00:00Z");
});

test("newer overlapping activity refresh wins regardless of response order", async () => {
  const env = await harness.worker.getEnv();
  await seedRepository(env.PROD_DB, {
    githubId: String(metadataFixture.id), githubPushedAt: "2026-08-01T00:00:00Z",
  });
  let announceOld = () => {};
  let releaseOld = () => {};
  const oldStarted = new Promise((resolve) => { announceOld = () => resolve(undefined); });
  const oldGate = new Promise((resolve) => { releaseOld = () => resolve(undefined); });
  const old = refreshRepositoryActivity(env.PROD_DB, "repo-1", async () => {
    announceOld();
    await oldGate;
    return Response.json({ ...metadataFixture, pushed_at: "2026-08-02T00:00:00Z" });
  });
  await oldStarted;
  await refreshRepositoryActivity(env.PROD_DB, "repo-1", providerFixture({
    metadata: { ...metadataFixture, pushed_at: "2026-08-20T00:00:00Z" },
  }));
  releaseOld();
  await old;

  assert.equal((await getRepository(env.PROD_DB, "repo-1"))?.githubPushedAt,
    "2026-08-20T00:00:00Z");
});

test("activity icon wins over an older full refresh delayed before metadata", async () => {
  const env = await harness.worker.getEnv();
  await seedRepository(env.PROD_DB, {
    githubId: String(metadataFixture.id), githubPushedAt: "2026-08-01T00:00:00Z",
  });
  let announceFull = () => {};
  let releaseFull = () => {};
  const fullStarted = new Promise((resolve) => { announceFull = () => resolve(undefined); });
  const fullGate = new Promise((resolve) => { releaseFull = () => resolve(undefined); });
  const base = providerFixture({
    metadata: { ...metadataFixture, pushed_at: "2026-08-02T00:00:00Z" },
  });
  const full = refreshRepository(env.PROD_DB, "repo-1", dependencies(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.hostname === "api.github.com" && !url.pathname.endsWith("/readme")) {
      announceFull();
      await fullGate;
    }
    return base(input, init);
  }));
  await fullStarted;
  await refreshRepositoryActivity(env.PROD_DB, "repo-1", providerFixture({
    metadata: { ...metadataFixture, pushed_at: "2026-08-20T00:00:00Z" },
  }));
  releaseFull();
  await full;

  assert.equal((await getRepository(env.PROD_DB, "repo-1"))?.githubPushedAt,
    "2026-08-20T00:00:00Z");
});

test("record 1000 completes and record 1001 stops after metadata", async () => {
  const env = await harness.worker.getEnv();
  await seedNamedRepositories(env.PROD_DB, 999);
  let calls = 0;
  /** @type {typeof fetch} */
  const fetcher = async (input) => {
    calls += 1;
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.hostname === "api.github.com" && !url.pathname.endsWith("/readme")) {
      const id = calls === 1 ? 9007199254740990 : 9007199254740991;
      return Response.json({ ...metadataFixture, id });
    }
    if (url.hostname === "api.github.com") return new Response("# Example");
    if (url.hostname === "api.openai.com") return Response.json({
      model: "gpt-5.6-terra-test-snapshot",
      output: [{ type: "message", content: [{
        type: "output_text", text: JSON.stringify(analysisFixture),
      }] }],
    });
    throw new Error(`Unexpected provider URL: ${url}`);
  };
  const thousandth = await collectRepository(
    env.PROD_DB, "https://github.com/OpenAI/example", dependencies(fetcher),
  );
  assert.equal(thousandth.analysisStatus, "ready");
  assert.equal(calls, 3);
  await assert.rejects(
    collectRepository(env.PROD_DB, "https://github.com/OpenAI/example", dependencies(fetcher)),
    (error) => error instanceof Error && "code" in error && "status" in error &&
      error.code === "repository_limit_reached" && error.status === 409,
  );
  assert.equal(calls, 4);
  assert.equal(await env.PROD_DB.prepare("SELECT COUNT(*) AS count FROM repositories").first("count"), 1000);
});

test("initial D1 failure is safe and prevents README and OpenAI", async () => {
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    return Response.json(metadataFixture);
  };
  const db = { prepare() { throw new Error("private database detail"); } };
  await assert.rejects(
    collectRepository(db, "https://github.com/OpenAI/example", dependencies(fetcher)),
    (error) => error instanceof Error && "code" in error && "status" in error &&
      error.code === "storage_unavailable" && error.status === 503 &&
      !error.message.includes("private database detail"),
  );
  assert.equal(calls, 1);
});

test("stale generation discards README and skips OpenAI", async () => {
  const env = await harness.worker.getEnv();
  let openAiCalls = 0;
  /** @type {typeof fetch} */
  const fetcher = async (input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.hostname === "api.github.com" && !url.pathname.endsWith("/readme"))
      return Response.json(metadataFixture);
    if (url.hostname === "api.github.com") {
      await env.PROD_DB.prepare(
        "UPDATE repositories SET analysis_generation = 2 WHERE github_id = ?",
      ).bind(String(metadataFixture.id)).run();
      return new Response("# stale");
    }
    openAiCalls += 1;
    return new Response(null, { status: 500 });
  };
  const result = await collectRepository(
    env.PROD_DB, "https://github.com/OpenAI/example", dependencies(fetcher),
  );
  assert.equal(result.analysisStatus, "pending");
  assert.equal(openAiCalls, 0);
  const row = await env.PROD_DB.prepare(
    "SELECT readme_sha, readme_status FROM repositories WHERE id = ?",
  ).bind(result.repositoryId).first();
  assert.deepEqual(row, { readme_sha: null, readme_status: "unavailable" });
});

test("uses independent GitHub and OpenAI timeout budgets", async () => {
  const env = await harness.worker.getEnv();
  const original = AbortSignal.timeout;
  /** @type {number[]} */
  const budgets = [];
  const signals = [new AbortController().signal, new AbortController().signal, new AbortController().signal];
  /** @type {(AbortSignal | null | undefined)[]} */
  const received = [];
  const baseFetcher = providerFixture();
  /** @type {typeof fetch} */
  const fetcher = async (input, init) => {
    received.push(init?.signal);
    return baseFetcher(input, init);
  };
  AbortSignal.timeout = (milliseconds) => {
    budgets.push(milliseconds);
    return signals[budgets.length - 1];
  };
  try {
    await collectRepository(
      env.PROD_DB, "https://github.com/OpenAI/example", dependencies(fetcher),
    );
  } finally { AbortSignal.timeout = original; }
  assert.deepEqual(budgets, [8_000, 8_000, 45_000]);
  assert.equal(received.length, 3);
  assert.equal(received[0], signals[0]);
  assert.equal(received[1], signals[1]);
  assert.equal(received[2], signals[2]);
});

test("keeps GitHub data when analysis fails", async () => {
  const env = await harness.worker.getEnv();
  let calls = 0;
  const baseFetcher = providerFixture({ openAiStatus: 429 });
  /** @type {typeof fetch} */
  const fetcher = async (input, init) => {
    calls += 1;
    return baseFetcher(input, init);
  };
  const result = await collectRepository(
    env.PROD_DB, "https://github.com/OpenAI/example",
    dependencies(fetcher),
  );
  assert.deepEqual({ status: result.analysisStatus, code: result.errorCode }, {
    status: "error", code: "analysis_rate_limited",
  });
  assert.equal(calls, 3);
  assert.equal(await env.PROD_DB.prepare("SELECT COUNT(*) AS count FROM repositories").first("count"), 1);
});

test("README unavailable still performs metadata-only analysis", async () => {
  const env = await harness.worker.getEnv();
  const result = await collectRepository(
    env.PROD_DB, "https://github.com/OpenAI/example",
    dependencies(providerFixture({ readmeStatus: 404 })),
  );
  const row = await env.PROD_DB.prepare(
    "SELECT readme_status, readme_sha, analysis_status FROM repositories WHERE id = ?",
  ).bind(result.repositoryId).first();
  assert.deepEqual(row, { readme_status: "missing", readme_sha: null, analysis_status: "ready" });
});

test("search treats percent and underscore literally and caps rows at 10", async () => {
  const env = await harness.worker.getEnv();
  await seedNamedRepositories(env.PROD_DB, 35, { matchingName: "literal_100%" });
  await seedRepository(env.PROD_DB, { id: "near-mixed", githubId: "36", name: "literalX100Y" });
  await seedRepository(env.PROD_DB, { id: "under", githubId: "37", name: "under_only" });
  await seedRepository(env.PROD_DB, { id: "near-under", githubId: "38", name: "underXonly" });
  await seedRepository(env.PROD_DB, { id: "percent", githubId: "39", name: "percent%only" });
  await seedRepository(env.PROD_DB, { id: "near-percent", githubId: "40", name: "percentXonly" });
  await seedRepository(env.PROD_DB, { id: "slash", githubId: "41", name: "back\\slash" });
  await seedRepository(env.PROD_DB, { id: "near-slash", githubId: "42", name: "backslash" });
  const result = await listRepositories(env.PROD_DB, { q: "_100%", category: "", tag: "", page: 1 });
  assert.equal(result.total, 1);
  assert.equal(result.repositories[0].name, "literal_100%");
  const firstPage = await listRepositories(env.PROD_DB, { q: "", category: "", tag: "", page: 1 });
  assert.equal(firstPage.repositories.length, 10);
  assert.deepEqual((await listRepositories(
    env.PROD_DB, { q: "_", category: "", tag: "", page: 1 },
  )).repositories.map((/** @type {any} */ repository) => repository.id).sort(), ["repo-0000", "under"]);
  assert.deepEqual((await listRepositories(
    env.PROD_DB, { q: "%", category: "", tag: "", page: 1 },
  )).repositories.map((/** @type {any} */ repository) => repository.id).sort(), ["percent", "repo-0000"]);
  assert.deepEqual((await listRepositories(
    env.PROD_DB, { q: "\\", category: "", tag: "", page: 1 },
  )).repositories.map((/** @type {any} */ repository) => repository.id), ["slash"]);
});

test("Note summary joins use newest timestamp then id and omit legacy personal notes", async () => {
  const env = await harness.worker.getEnv();
  await seedRepository(env.PROD_DB, { id: "repo-first", githubId: "first", createdAt: 2 });
  await seedRepository(env.PROD_DB, { id: "repo-second", githubId: "second", createdAt: 1 });
  await seedRepositoryNote(env.PROD_DB, {
    id: "note-a", repositoryId: "repo-first", body: "Oldest Note", createdAt: 10, updatedAt: 10,
  });
  await seedRepositoryNote(env.PROD_DB, {
    id: "note-b", repositoryId: "repo-first", body: "Second Note", createdAt: 20, updatedAt: 20,
  });
  await seedRepositoryNote(env.PROD_DB, {
    id: "note-c", repositoryId: "repo-first", body: "Latest Note", createdAt: 20, updatedAt: 20,
  });

  const first = await getRepository(env.PROD_DB, "repo-first");
  assert.ok(first);
  assert.deepEqual({ noteCount: first.noteCount, latestNote: first.latestNote }, {
    noteCount: 3, latestNote: "Latest Note",
  });
  assert.equal(Object.hasOwn(first, "personalNote"), false);

  const listed = await listRepositories(env.PROD_DB, { q: "", category: "", tag: "", page: 1 });
  const byId = new Map(listed.repositories.map((/** @type {any} */ repository) => [repository.id, repository]));
  assert.deepEqual(
    { noteCount: byId.get("repo-first")?.noteCount, latestNote: byId.get("repo-first")?.latestNote },
    { noteCount: 3, latestNote: "Latest Note" },
  );
  assert.deepEqual(
    { noteCount: byId.get("repo-second")?.noteCount, latestNote: byId.get("repo-second")?.latestNote },
    { noteCount: 0, latestNote: null },
  );
  assert.equal(Object.hasOwn(byId.get("repo-second"), "personalNote"), false);
});

test("repository detail and list reads never request the legacy personal-note column", async () => {
  const env = await harness.worker.getEnv();
  await seedRepository(env.PROD_DB, {
    id: "repo-notes", githubId: "notes", personalNote: "legacy-only poison",
  });
  await seedRepositoryNote(env.PROD_DB, {
    id: "note-current", repositoryId: "repo-notes", body: "current searchable Note",
    createdAt: 10, updatedAt: 10,
  });
  const guardedDb = withoutLegacyRepositoryReads(env.PROD_DB);

  const detail = await getRepository(guardedDb, "repo-notes");
  assert.ok(detail);
  assert.deepEqual({ noteCount: detail.noteCount, latestNote: detail.latestNote }, {
    noteCount: 1, latestNote: "current searchable Note",
  });
  const listed = await listRepositories(guardedDb, {
    q: "current searchable", category: "", tag: "", page: 1,
  });
  assert.deepEqual(listed.repositories.map((/** @type {any} */ repository) => repository.id), ["repo-notes"]);
});

test("Note body search finds older Notes and escapes literal wildcards", async () => {
  const env = await harness.worker.getEnv();
  await seedRepository(env.PROD_DB, { id: "repo-notes", githubId: "notes" });
  await seedRepository(env.PROD_DB, { id: "repo-empty", githubId: "empty" });
  await seedRepositoryNote(env.PROD_DB, {
    id: "note-search-old", repositoryId: "repo-notes", body: "older unique phrase", createdAt: 10, updatedAt: 10,
  });
  await seedRepositoryNote(env.PROD_DB, {
    id: "note-search-percent", repositoryId: "repo-notes", body: "literal_100%", createdAt: 20, updatedAt: 20,
  });
  await seedRepositoryNote(env.PROD_DB, {
    id: "note-search-slash", repositoryId: "repo-notes", body: "back\\slash", createdAt: 30, updatedAt: 30,
  });

  for (const query of ["older unique phrase", "_100%", "%", "\\"]) {
    const result = await listRepositories(env.PROD_DB, { q: query, category: "", tag: "", page: 1 });
    assert.deepEqual(result.repositories.map((/** @type {any} */ repository) => repository.id), ["repo-notes"]);
  }
});

test("list combines q category and tag with AND and clamps to last page", async () => {
  const env = await harness.worker.getEnv();
  await seedNamedRepositories(env.PROD_DB, 31);
  await seedRepository(env.PROD_DB, {
    id: "match", githubId: "100", name: "needle", primaryCategory: "Data", tags: ["chosen"],
    createdAt: 100,
  });
  await seedRepository(env.PROD_DB, {
    id: "wrong-category", githubId: "101", name: "needle", primaryCategory: "Backend", tags: ["chosen"],
  });
  await seedRepository(env.PROD_DB, {
    id: "wrong-tag", githubId: "102", name: "needle", primaryCategory: "Data", tags: ["other"],
  });
  await seedRepository(env.PROD_DB, {
    id: "wrong-q", githubId: "103", name: "haystack", primaryCategory: "Data", tags: ["chosen"],
  });
  const filtered = await listRepositories(env.PROD_DB, {
    q: "NEEDLE", category: "Data", tag: "chosen", page: 99,
  });
  assert.deepEqual(filtered.repositories.map((/** @type {any} */ repository) => repository.id), ["match"]);
  assert.equal(filtered.page, 1);
  assert.deepEqual(filtered.availableTags, ["chosen", "other"]);
  assert.deepEqual(filtered.repositoryCounts, {
    all: 35,
    byCategory: { Backend: 32, Data: 3 },
  });
  const clamped = await listRepositories(env.PROD_DB, { q: "", category: "", tag: "", page: 99 });
  assert.equal(clamped.page, 4);
  assert.equal(clamped.repositories.length, 5);
});

test("repository edit excludes Notes and legacy field while replacing category tags", async () => {
  const env = await harness.worker.getEnv();
  await seedRepository(env.PROD_DB, { tags: ["old"] });
  await seedRepositoryNote(env.PROD_DB, {
    id: "note-kept", body: "Keep this Note", createdAt: 10, updatedAt: 10,
  });
  const notesBefore = await env.PROD_DB.prepare(
    "SELECT id, repository_id, body, created_at, updated_at FROM repository_notes WHERE repository_id = ?",
  ).bind("repo-1").all();
  const updated = await updateRepository(env.PROD_DB, "repo-1", {
    primaryCategory: "Data", tags: ["New Tag", "new-tag"],
  });
  assert.ok(updated);
  assert.equal(Object.hasOwn(updated, "personalNote"), false);
  assert.equal(updated.primaryCategory, "Data");
  assert.deepEqual(updated.tags, ["new-tag"]);
  const notesAfter = await env.PROD_DB.prepare(
    "SELECT id, repository_id, body, created_at, updated_at FROM repository_notes WHERE repository_id = ?",
  ).bind("repo-1").all();
  assert.deepEqual(notesAfter.results, notesBefore.results);
  await deleteRepository(env.PROD_DB, "repo-1");
  assert.equal(await env.PROD_DB.prepare("SELECT COUNT(*) AS count FROM repositories").first("count"), 0);
  assert.equal(await env.PROD_DB.prepare("SELECT COUNT(*) AS count FROM repository_tags").first("count"), 0);
  assert.equal(await getRepository(env.PROD_DB, "repo-1"), null);
});

test("active 299-second lease fails and 301-second lease is reclaimed", async () => {
  const env = await harness.worker.getEnv();
  await seedRepository(env.PROD_DB, {
    githubId: String(metadataFixture.id), analysisStatus: "pending", analysisStartedAt: 0,
  });
  const baseFetcher = providerFixture();
  /** @type {typeof fetch} */
  const activeLeaseFetcher = async (input, init) => {
    const response = await baseFetcher(input, init);
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.hostname === "api.github.com" && url.pathname.endsWith("/readme")) {
      await env.PROD_DB.prepare(
        "UPDATE repositories SET analysis_started_at = ? WHERE id = ?",
      ).bind(Date.now() / 1000 - 299, "repo-1").run();
    }
    return response;
  };
  await assert.rejects(
    refreshRepository(env.PROD_DB, "repo-1", dependencies(activeLeaseFetcher)),
    (error) => error instanceof Error && "code" in error && "details" in error &&
      error.code === "analysis_in_progress" &&
      /** @type {any} */ (error.details).retryAfter === 300,
  );
  await env.PROD_DB.prepare(
    "UPDATE repositories SET analysis_started_at = unixepoch() - 301 WHERE id = ?",
  ).bind("repo-1").run();
  const result = await refreshRepository(env.PROD_DB, "repo-1", dependencies(providerFixture()));
  assert.equal(result.analysisStatus, "ready");
  const refreshed = await getRepository(env.PROD_DB, "repo-1");
  assert.ok(refreshed);
  assert.equal(refreshed.analysisGeneration, 2);
});

test("refresh GitHub failure leaves stored row byte-for-byte unchanged", async () => {
  const env = await harness.worker.getEnv();
  await seedRepository(env.PROD_DB, { personalNote: "keep", tags: ["keep"] });
  const before = await env.PROD_DB.prepare("SELECT * FROM repositories WHERE id = ?").bind("repo-1").first();
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    return new Response(null, { status: 503 });
  };
  await assert.rejects(
    refreshRepository(env.PROD_DB, "repo-1", dependencies(fetcher)),
    (error) => error instanceof Error && "code" in error && error.code === "github_unavailable",
  );
  assert.equal(calls, 1);
  const afterRow = await env.PROD_DB.prepare("SELECT * FROM repositories WHERE id = ?").bind("repo-1").first();
  assert.deepEqual(afterRow, before);
});

test("successful refresh preserves Notes and replaces at most five tags", async () => {
  const env = await harness.worker.getEnv();
  await seedRepository(env.PROD_DB, {
    githubId: String(metadataFixture.id), tags: ["old"],
  });
  await seedRepositoryNote(env.PROD_DB, {
    id: "note-refresh", body: "Keep this Note", createdAt: 10, updatedAt: 10,
  });
  const analysis = { ...analysisFixture, tags: ["one", "two", "three", "four", "five"] };
  await refreshRepository(env.PROD_DB, "repo-1", dependencies(providerFixture({ analysis })));
  const row = await getRepository(env.PROD_DB, "repo-1");
  assert.ok(row);
  assert.deepEqual({ noteCount: row.noteCount, latestNote: row.latestNote }, {
    noteCount: 1, latestNote: "Keep this Note",
  });
  assert.equal(row.githubPushedAt, "2026-08-08T00:00:00Z");
  assert.deepEqual(row.tags, ["five", "four", "one", "three", "two"]);
});

test("late generation cannot overwrite a refreshed analysis", async () => {
  const env = await harness.worker.getEnv();
  await seedRepository(env.PROD_DB, {
    id: "repo-1", githubId: String(metadataFixture.id),
    analysisStatus: "ready", analysisGeneration: 1,
  });
  let announceOpenAi = () => {};
  let releaseOpenAi = () => {};
  const reachedOpenAi = new Promise((resolve) => { announceOpenAi = () => resolve(undefined); });
  const openAiGate = new Promise((resolve) => { releaseOpenAi = () => resolve(undefined); });
  const first = refreshRepository(env.PROD_DB, "repo-1", dependencies(providerFixture({
    beforeOpenAi: announceOpenAi, openAiGate,
    analysis: { ...analysisFixture, summary: "오래된 응답이다." },
  })));
  await reachedOpenAi;
  await env.PROD_DB.prepare(
    "UPDATE repositories SET analysis_started_at = unixepoch() - 301 WHERE id = ?",
  ).bind("repo-1").run();
  await refreshRepository(env.PROD_DB, "repo-1", dependencies(providerFixture({
    analysis: { ...analysisFixture, summary: "최신 응답이다." },
  })));
  releaseOpenAi();
  await first;
  const row = await env.PROD_DB.prepare(
    "SELECT analysis_generation, summary FROM repositories WHERE id = ?",
  ).bind("repo-1").first();
  assert.deepEqual(row, { analysis_generation: 3, summary: "최신 응답이다." });
});

test("refresh rejects a changed GitHub identity before README and leaves row and tags unchanged", async () => {
  const env = await harness.worker.getEnv();
  await seedRepository(env.PROD_DB, { githubId: "1", tags: ["keep"] });
  const beforeRow = await env.PROD_DB.prepare(
    "SELECT * FROM repositories WHERE id = ?",
  ).bind("repo-1").first();
  const beforeTags = (await env.PROD_DB.prepare(
    "SELECT * FROM repository_tags WHERE repository_id = ? ORDER BY normalized_tag",
  ).bind("repo-1").all()).results;
  let calls = 0;
  /** @type {typeof fetch} */
  const fetcher = async (input) => {
    calls += 1;
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.hostname === "api.github.com" && !url.pathname.endsWith("/readme"))
      return Response.json(metadataFixture);
    throw new Error("identity mismatch reached a forbidden provider call");
  };
  await assert.rejects(
    refreshRepository(env.PROD_DB, "repo-1", dependencies(fetcher)),
    (error) => error instanceof Error && "code" in error && "status" in error &&
      error.code === "github_not_found" && error.status === 404,
  );
  assert.equal(calls, 1);
  assert.deepEqual(await env.PROD_DB.prepare(
    "SELECT * FROM repositories WHERE id = ?",
  ).bind("repo-1").first(), beforeRow);
  assert.deepEqual((await env.PROD_DB.prepare(
    "SELECT * FROM repository_tags WHERE repository_id = ? ORDER BY normalized_tag",
  ).bind("repo-1").all()).results, beforeTags);
});

test("refresh continues metadata-only analysis when README is unavailable", async () => {
  const env = await harness.worker.getEnv();
  await seedRepository(env.PROD_DB, {
    githubId: String(metadataFixture.id), owner: "old", name: "old", htmlUrl: "https://github.com/old/old",
  });
  const calls = { metadata: 0, readme: 0, openAi: 0 };
  const baseFetcher = providerFixture({ readmeStatus: 503 });
  /** @type {typeof fetch} */
  const fetcher = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.hostname === "api.openai.com") calls.openAi += 1;
    else if (url.pathname.endsWith("/readme")) calls.readme += 1;
    else calls.metadata += 1;
    return baseFetcher(input, init);
  };
  const refreshed = await refreshRepository(env.PROD_DB, "repo-1", dependencies(fetcher));
  const repository = await getRepository(env.PROD_DB, "repo-1");
  assert.ok(repository);
  assert.equal(refreshed.analysisStatus, "ready");
  assert.deepEqual(calls, { metadata: 1, readme: 1, openAi: 1 });
  assert.deepEqual({
    githubId: repository.githubId,
    owner: repository.owner,
    name: repository.name,
    htmlUrl: repository.htmlUrl,
    description: repository.description,
    homepageUrl: repository.homepageUrl,
    defaultBranch: repository.defaultBranch,
    primaryLanguage: repository.primaryLanguage,
    stars: repository.stars,
    forks: repository.forks,
    licenseSpdx: repository.licenseSpdx,
    topics: repository.topics,
    githubUpdatedAt: repository.githubUpdatedAt,
    readmeStatus: repository.readmeStatus,
    readmeSha: repository.readmeSha,
    analysisStatus: repository.analysisStatus,
    analysisModel: repository.analysisModel,
    summary: repository.summary,
  }, {
    githubId: String(metadataFixture.id),
    owner: "OpenAI",
    name: "example",
    htmlUrl: "https://github.com/OpenAI/example",
    description: "Example repository",
    homepageUrl: null,
    defaultBranch: "main",
    primaryLanguage: "JavaScript",
    stars: 10,
    forks: 2,
    licenseSpdx: "MIT",
    topics: ["example"],
    githubUpdatedAt: "2026-08-09T00:00:00Z",
    readmeStatus: "unavailable",
    readmeSha: null,
    analysisStatus: "ready",
    analysisModel: "gpt-5.6-terra-test-snapshot",
    summary: "예제 저장소의 핵심 사용법을 보여준다.",
  });
});

test("maps stored JSON arrays only when every member is a string", async () => {
  const env = await harness.worker.getEnv();
  await seedRepository(env.PROD_DB);
  await env.PROD_DB.prepare(
    "UPDATE repositories SET topics_json = ?, values_json = ? WHERE id = ?",
  ).bind('["safe",1]', '[null,"safe"]', "repo-1").run();
  const repository = await getRepository(env.PROD_DB, "repo-1");
  assert.ok(repository);
  assert.deepEqual(repository.topics, []);
  assert.deepEqual(repository.values, []);
});

test("fails closed on malformed D1 mutation results", async (context) => {
  const provider = providerFixture();
  await context.test("collect insert RETURNING missing generation", async () => {
    let calls = 0;
    await rejectsStorage(collectRepository(
      d1Stub({ first: [{ id: "repo-1" }] }),
      "https://github.com/OpenAI/example",
      dependencies(async (input) => { calls += 1; return provider(input); }),
    ));
    assert.equal(calls, 1);
  });
  await context.test("duplicate canonical update missing meta", async () => {
    await rejectsStorage(collectRepository(
      d1Stub({
        first: [
          null,
          { id: "repo-1", analysis_status: "ready", analysis_error_code: null },
          { owner: "owner", name: "repository", github_id: "9007199254740000",
            activity_refresh_generation: 2 },
        ],
        run: [{ success: true }],
      }),
      "https://github.com/OpenAI/example", dependencies(provider),
    ));
  });
  await context.test("README save missing changes", async () => {
    await rejectsStorage(collectRepository(
      d1Stub({ first: [{ id: "repo-1", analysis_generation: 1 }], run: [{ success: true }] }),
      "https://github.com/OpenAI/example", dependencies(provider),
    ));
  });
  await context.test("analysis error run null", async () => {
    await rejectsStorage(collectRepository(
      d1Stub({
        first: [{ id: "repo-1", analysis_generation: 1 }],
        run: [changed(1), null],
      }),
      "https://github.com/OpenAI/example",
      dependencies(providerFixture({ openAiStatus: 429 })),
    ));
  });
  await context.test("analysis success batch has malformed sibling", async () => {
    await rejectsStorage(collectRepository(
      d1Stub({
        first: [{ id: "repo-1", analysis_generation: 1 }], run: [changed(1)],
        batch: [[changed(1), {}, changed(1)]],
      }),
      "https://github.com/OpenAI/example", dependencies(provider),
    ));
  });
  await context.test("edit batch is short", async () => {
    await rejectsStorage(updateRepository(
      d1Stub({
        batch: [[changed(1)]],
        first: [{ id: "repo-1", topics_json: "[]", values_json: "[]" }],
        all: [{ results: [] }],
      }), "repo-1",
      { primaryCategory: "Backend", tags: ["tag"] },
    ));
  });
  await context.test("repository Note summary fields are malformed", async () => {
    await rejectsStorage(getRepository(
      d1Stub({ first: [{ note_count: -1, latest_note: null }], all: [{ results: [] }] }), "repo-1",
    ));
    await rejectsStorage(getRepository(
      d1Stub({ first: [{ note_count: 1, latest_note: 42 }], all: [{ results: [] }] }), "repo-1",
    ));
  });
  await context.test("delete result reports unsuccessful", async () => {
    await rejectsStorage(deleteRepository(
      d1Stub({ run: [{ success: false, meta: { changes: 1 } }] }), "repo-1",
    ));
  });
  await context.test("refresh RETURNING missing generation", async () => {
    let calls = 0;
    const baseFetcher = providerFixture({ metadata: { ...metadataFixture, id: 1 } });
    await rejectsStorage(refreshRepository(
      d1Stub({
        first: [{ owner: "owner", name: "repository", github_id: "1",
          activity_refresh_generation: 2 }, {}],
        run: [changed(1)],
      }),
      "repo-1", dependencies(async (input, init) => { calls += 1; return baseFetcher(input, init); }),
    ));
    assert.equal(calls, 2);
  });
  await context.test("activity refresh update reports unsuccessful", async () => {
    let calls = 0;
    const baseFetcher = providerFixture({ metadata: { ...metadataFixture, id: 1 } });
    await rejectsStorage(refreshRepositoryActivity(
      d1Stub({
        first: [{ owner: "owner", name: "repository", github_id: "1",
          activity_refresh_generation: 2 }],
        run: [{ success: false, meta: { changes: 1 } }],
      }),
      "repo-1", async (input, init) => { calls += 1; return baseFetcher(input, init); },
    ));
    assert.equal(calls, 1);
  });
});

test("activity migration preserves populated v1 rows as unsynchronized", async () => {
  const env = await harness.worker.getEnv();
  await env.PROD_DB.exec("DROP TABLE repository_tags; DROP TABLE repositories;");
  const initial = await readFile("migrations/0001_initial.sql", "utf8");
  const repositoryTable = /CREATE TABLE repositories \([\s\S]*?\n\);/.exec(initial)?.[0];
  assert.ok(repositoryTable);
  await env.PROD_DB.prepare(repositoryTable).run();
  await env.PROD_DB.prepare(
    `INSERT INTO repositories
      (id, github_id, owner, name, html_url, default_branch, stars, forks,
       topics_json, github_updated_at, readme_status, source_refreshed_at,
       values_json, analysis_status, analysis_generation)
     VALUES ('legacy', '1', 'owner', 'repo', 'https://github.com/owner/repo', 'main',
       0, 0, '[]', '2026-08-01T00:00:00Z', 'missing', unixepoch(), '[]', 'ready', 1)`,
  ).run();

  const activityMigration = await readFile("migrations/0002_repository_activity.sql", "utf8");
  for (const statement of activityMigration.split(";").map((value) => value.trim()).filter(Boolean))
    await env.PROD_DB.prepare(statement).run();

  assert.deepEqual(await env.PROD_DB.prepare(
    `SELECT github_pushed_at, activity_refreshed_at, activity_refresh_generation
     FROM repositories WHERE id = 'legacy'`,
  ).first(), {
    github_pushed_at: null, activity_refreshed_at: null, activity_refresh_generation: 0,
  });
});

test("repository notes migration leaves legacy personal notes behind and cascades", async () => {
  const env = await harness.worker.getEnv();
  await env.PROD_DB.exec("DROP TABLE IF EXISTS repository_notes");
  await seedRepository(env.PROD_DB, {
    id: "legacy", githubId: "legacy", personalNote: "legacy must not migrate",
  });

  const noteMigration = await readFile("migrations/0003_repository_notes.sql", "utf8");
  for (const statement of noteMigration.split(";").map((value) => value.trim()).filter(Boolean))
    await env.PROD_DB.prepare(statement).run();

  assert.equal(await env.PROD_DB.prepare(
    "SELECT COUNT(*) FROM repository_notes",
  ).first("COUNT(*)"), 0);
  assert.deepEqual(
    await env.PROD_DB.prepare("PRAGMA foreign_key_list(repository_notes)").all()
      .then((result) => result.results.map((row) => [row.table, row.from, row.on_delete])),
    [["repositories", "repository_id", "CASCADE"]],
  );
  const indexes = await env.PROD_DB.prepare("PRAGMA index_list(repository_notes)").all();
  assert.equal(indexes.results.some((row) =>
    row.name === "repository_notes_repository_order_idx" && row.unique === 0), true);
  assert.deepEqual(
    await env.PROD_DB.prepare(
      "PRAGMA index_xinfo(repository_notes_repository_order_idx)",
    ).all().then((result) => result.results
      .filter((row) => row.key === 1)
      .map((row) => [row.name, row.desc])),
    [["repository_id", 0], ["created_at", 1], ["id", 1]],
  );

  await env.PROD_DB.prepare(
    "INSERT INTO repository_notes (id, repository_id, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).bind("note-legacy", "legacy", "New note", 1, 1).run();
  await env.PROD_DB.prepare("DELETE FROM repositories WHERE id = ?").bind("legacy").run();
  assert.equal(await env.PROD_DB.prepare(
    "SELECT COUNT(*) FROM repository_notes",
  ).first("COUNT(*)"), 0);
});
