import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import {
  providerFixture, seedNamedRepositories, seedRepository, startHarness,
} from "../support/harness.js";
import {
  collectRepository, deleteRepository, getRepository, listRepositories,
  refreshRepository, updateRepository,
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

test("migration creates four tables and enforces five tags", async () => {
  const env = await harness.worker.getEnv();
  const rows = await env.PROD_DB.prepare(
    `SELECT name FROM sqlite_schema
     WHERE type = 'table'
       AND name NOT GLOB '_cf_*'
       AND name NOT GLOB 'sqlite_*'
     ORDER BY name`,
  ).all();
  assert.deepEqual(rows.results.map((row) => row.name), [
    "auth_attempts", "repositories", "repository_tags", "telemetry_daily",
  ]);

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
        "SELECT analysis_status FROM repositories WHERE github_id = ?",
      ).bind(String(metadataFixture.id)).first();
      sawPersisted = row?.analysis_status === "pending";
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
    "SELECT owner, name, html_url, personal_note, summary FROM repositories WHERE id = ?",
  ).bind("existing").first();
  assert.deepEqual(duplicate, {
    repositoryId: "existing", analysisStatus: "ready", errorCode: null, duplicate: true,
  });
  assert.equal(calls, 1);
  assert.deepEqual(row, {
    owner: "Renamed", name: "renamed", html_url: "https://github.com/Renamed/renamed",
    personal_note: "보존할 메모", summary: "보존할 요약이다.",
  });
  assert.equal(await env.PROD_DB.prepare(
    "SELECT COUNT(*) AS count FROM repository_tags WHERE repository_id = ?",
  ).bind("existing").first("count"), 1);
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

test("edit revalidates and replaces note category tags; delete cascades", async () => {
  const env = await harness.worker.getEnv();
  await seedRepository(env.PROD_DB, { tags: ["old"] });
  const updated = await updateRepository(env.PROD_DB, "repo-1", {
    personalNote: "  cafe\u0301  ", primaryCategory: "Data", tags: ["New Tag", "new-tag"],
  });
  assert.ok(updated);
  assert.equal(updated.personalNote, "café");
  assert.equal(updated.primaryCategory, "Data");
  assert.deepEqual(updated.tags, ["new-tag"]);
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

test("successful refresh preserves note and replaces at most five tags", async () => {
  const env = await harness.worker.getEnv();
  await seedRepository(env.PROD_DB, {
    githubId: String(metadataFixture.id), personalNote: "keep", tags: ["old"],
  });
  const analysis = { ...analysisFixture, tags: ["one", "two", "three", "four", "five"] };
  await refreshRepository(env.PROD_DB, "repo-1", dependencies(providerFixture({ analysis })));
  const row = await getRepository(env.PROD_DB, "repo-1");
  assert.ok(row);
  assert.equal(row.personalNote, "keep");
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
        first: [null, { id: "repo-1", analysis_status: "ready", analysis_error_code: null }],
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
      { personalNote: "note", primaryCategory: "Backend", tags: ["tag"] },
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
      d1Stub({ first: [{ owner: "owner", name: "repository", github_id: "1" }, {}] }),
      "repo-1", dependencies(async (input, init) => { calls += 1; return baseFetcher(input, init); }),
    ));
    assert.equal(calls, 2);
  });
});
