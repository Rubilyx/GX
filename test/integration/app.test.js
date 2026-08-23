import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { authenticatePin, createSession, hashClientIp } from "../../src/auth.js";
import { AppError } from "../../src/domain.js";
import { getRepository } from "../../src/repositories.js";
import { recordTelemetry } from "../../src/telemetry.js";
import { handleRequest } from "../../src/worker.js";
import {
  login, postForm, providerFixture, seedRepository, seedRepositoryNote, startHarness,
} from "../support/harness.js";

/** @param {unknown} error */
const isGuardUnavailable = (error) =>
  error instanceof AppError && error.code === "auth_guard_unavailable" && error.status === 503;

/** @type {Awaited<ReturnType<typeof startHarness>>} */
let harness;
before(async () => { harness = await startHarness(); });
beforeEach(async () => { await harness.reset(); });
after(async () => { await harness.close(); });

test("browser harness serves the test worker over HTTPS", () => {
  assert.equal(new URL(harness.url).protocol, "https:");
});

/** @param {Response} response */
function assertBaseHeaders(response) {
  assert.equal(response.headers.get("strict-transport-security"),
    "max-age=63072000; includeSubDomains");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "same-origin");
  assert.equal(response.headers.get("permissions-policy"),
    "camera=(), geolocation=(), microphone=(), payment=(), usb=()");
}

test("locks the fifth IP failure and the fiftieth global failure", async () => {
  const env = await harness.worker.getEnv();
  const input = {
    pin: "000000",
    ip: "192.0.2.10",
    nowSeconds: 1_800_000_000,
    pinSalt: env.PROD_PIN_SALT,
    pinDigest: env.PROD_PIN_DIGEST,
    ipHmacKey: env.PROD_IP_HMAC_KEY,
  };
  for (let count = 1; count < 5; count += 1)
    await assert.rejects(authenticatePin(env.PROD_DB, input), /invalid_pin/);
  await assert.rejects(authenticatePin(env.PROD_DB, input), /auth_locked/);

  await env.PROD_DB.prepare("DELETE FROM auth_attempts").run();
  for (let count = 1; count < 50; count += 1) {
    const next = { ...input, ip: `198.51.100.${count}` };
    await assert.rejects(authenticatePin(env.PROD_DB, next), /invalid_pin/);
  }
  await assert.rejects(
    authenticatePin(env.PROD_DB, { ...input, ip: "203.0.113.1" }),
    /auth_locked/,
  );
});

test("fails closed when D1 is missing", async () => {
  const env = await harness.worker.getEnv();
  await assert.rejects(authenticatePin(null, {
    pin: "123456", ip: "192.0.2.30", nowSeconds: 1_800_000_000,
    pinSalt: env.PROD_PIN_SALT, pinDigest: env.PROD_PIN_DIGEST, ipHmacKey: env.PROD_IP_HMAC_KEY,
  }), isGuardUnavailable);
});

test("fails closed when IP is missing", async () => {
  const env = await harness.worker.getEnv();
  await assert.rejects(authenticatePin(env.PROD_DB, {
    pin: "123456", ip: "", nowSeconds: 1_800_000_000,
    pinSalt: env.PROD_PIN_SALT, pinDigest: env.PROD_PIN_DIGEST, ipHmacKey: env.PROD_IP_HMAC_KEY,
  }), isGuardUnavailable);
});

test("successful authentication removes only the pseudonymous IP row", async () => {
  const env = await harness.worker.getEnv();
  const input = {
    pin: "000000",
    ip: "192.0.2.20",
    nowSeconds: 1_800_000_000,
    pinSalt: env.PROD_PIN_SALT,
    pinDigest: env.PROD_PIN_DIGEST,
    ipHmacKey: env.PROD_IP_HMAC_KEY,
  };
  await assert.rejects(authenticatePin(env.PROD_DB, input), /invalid_pin/);
  const ipKey = `ip:${await hashClientIp(input.ip, input.ipHmacKey)}`;

  assert.deepEqual(
    await authenticatePin(env.PROD_DB, { ...input, pin: "123456" }),
    { ok: true },
  );
  const rows = await env.PROD_DB.prepare(
    "SELECT attempt_key FROM auth_attempts ORDER BY attempt_key",
  ).all();
  assert.deepEqual(rows.results.map((row) => row.attempt_key), ["global"]);
  assert.equal(rows.results.some((row) => row.attempt_key === ipKey), false);
});

test("native forms cover login through create, detail, edit, refresh, filter, delete, and logout", async () => {
  const session = await login(harness.worker);
  const created = await postForm(harness.worker, "/repositories", session, {
    url: "https://github.com/OpenAI/example",
  });
  assert.equal(created.status, 303);
  assert.match(created.headers.get("location"), /^\/repositories\/[0-9a-f-]+\?flash=repository_created$/);
  const path = created.headers.get("location").split("?")[0];

  const detail = await harness.worker.fetch(`${session.origin}${path}`, {
    headers: { Cookie: session.cookie },
  });
  assert.equal(detail.status, 200);
  assert.match(await detail.text(), /예제 저장소의 핵심 사용법/);

  assert.equal((await postForm(harness.worker, path, session, {
    primaryCategory: "Backend", tags: "example, node-js",
  })).status, 303);
  assert.equal((await postForm(harness.worker, `${path}/notes`, session, {
    body: "보관할 Note",
  })).status, 303);
  const notesPage = await harness.worker.fetch(`${session.origin}${path}/notes`, {
    headers: { Cookie: session.cookie },
  });
  assert.equal(notesPage.status, 200);
  const notesHtml = await notesPage.text();
  assert.match(notesHtml, /<textarea id="new-note" name="body"/);
  assert.match(notesHtml, /<p class="repository-note-body">보관할 Note<\/p>/);
  assert.equal((await postForm(harness.worker, `${path}/refresh`, session, { confirm: "yes" })).status, 303);

  const filtered = await harness.worker.fetch(`${session.origin}/?q=example&category=Backend&tag=example&page=1`, {
    headers: { Cookie: session.cookie },
  });
  assert.equal(filtered.status, 200);
  const filteredHtml = await filtered.text();
  assert.match(filteredHtml,
    /<span class="repository-title"><span class="repository-owner">OpenAI\/<\/span><span class="repository-name">example<\/span><\/span>/);
  assert.match(filteredHtml,
    /<a href="\/\?q=example&amp;tag=example&amp;page=1">All 1<\/a>/);
  assert.match(filteredHtml,
    /<a href="\/\?q=example&amp;category=Backend&amp;tag=example&amp;page=1" aria-current="page">Backend 1<\/a>/);
  assert.doesNotMatch(filteredHtml, /id="category"|name="category"/);

  const deleted = await postForm(harness.worker, `${path}/delete`, session, { confirm: "yes" });
  assert.equal(deleted.status, 303);
  assert.equal(deleted.headers.get("location"), "/?flash=repository_deleted");
  const logout = await postForm(harness.worker, "/session/logout", session, {});
  assert.equal(logout.status, 303);
  assert.equal(logout.headers.get("location"), "/login");
  assert.equal(logout.headers.get("set-cookie"),
    "__Host-repo_atlas_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0");
});

test("enhanced capture returns exact success, partial failure, and duplicate JSON contracts", async () => {
  await harness.setProviderMode({ openAiStatus: 429 });
  const session = await login(harness.worker);
  const partial = await postForm(harness.worker, "/repositories", session, {
    url: "https://github.com/OpenAI/example",
  }, { Accept: "text/html, application/json; q=0.9" });
  assert.equal(partial.status, 200);
  const partialBody = await partial.json();
  assert.deepEqual(Object.keys(partialBody).sort(), ["analysisStatus", "errorCode", "repositoryId"]);
  assert.equal(partialBody.analysisStatus, "error");
  assert.equal(partialBody.errorCode, "analysis_rate_limited");

  const duplicate = await postForm(harness.worker, "/repositories", session, {
    url: "https://github.com/OpenAI/example",
  }, { Accept: "application/json" });
  assert.equal(duplicate.status, 200);
  assert.deepEqual(await duplicate.json(), {
    repositoryId: partialBody.repositoryId, analysisStatus: "error", errorCode: "analysis_rate_limited",
  });

  const htmlDuplicate = await postForm(harness.worker, "/repositories", session, {
    url: "https://github.com/OpenAI/example",
  });
  assert.equal(htmlDuplicate.status, 303);
  assert.equal(htmlDuplicate.headers.get("location"),
    `/repositories/${partialBody.repositoryId}?flash=repository_already_saved`);
});

test("enhanced detail and mutation routes return exact JSON shapes", async () => {
  const session = await login(harness.worker);
  const created = await postForm(harness.worker, "/repositories", session, {
    url: "https://github.com/OpenAI/example",
  }, { Accept: "application/json" });
  const { repositoryId } = await created.json();
  const path = `/repositories/${repositoryId}`;

  const detail = await harness.worker.fetch(`${session.origin}${path}`, {
    headers: { Cookie: session.cookie, Accept: "application/json" },
  });
  assert.equal(detail.status, 200);
  assert.deepEqual(Object.keys(await detail.clone().json()), ["repository"]);

  const edited = await postForm(harness.worker, path, session, {
    primaryCategory: "Backend", tags: "example",
  }, { Accept: "application/json" });
  assert.equal(edited.status, 200);
  assert.deepEqual(Object.keys(await edited.json()), ["repository"]);
  assert.equal((await postForm(harness.worker, `${path}/refresh`, session, { confirm: "yes" }, {
    Accept: "application/json",
  })).status, 200);
  assert.equal((await postForm(harness.worker, `${path}/delete`, session, { confirm: "yes" }, {
    Accept: "application/json",
  })).status, 200);
});

test("Note collection and item routes expose exact JSON CRUD contracts", async () => {
  const env = await harness.worker.getEnv();
  const repositoryId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  await seedRepository(env.PROD_DB, {
    id: repositoryId, owner: "Owner", name: "Repository", summary: "Safe summary",
  });
  for (let index = 1; index <= 6; index += 1) await seedRepositoryNote(env.PROD_DB, {
    id: `${index}`.repeat(8) + "-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    repositoryId, body: `Existing ${index}`, createdAt: index, updatedAt: index,
  });
  const session = await login(harness.worker);
  const notesPath = `/repositories/${repositoryId}/notes`;

  const listed = await harness.worker.fetch(`${session.origin}${notesPath}?page=2`, {
    headers: { Cookie: session.cookie, Accept: "application/json" },
  });
  assert.equal(listed.status, 200);
  const listJson = await listed.json();
  assert.deepEqual(Object.keys(listJson).sort(),
    ["notes", "page", "repository", "total", "totalPages"]);
  assert.deepEqual(Object.keys(listJson.repository).sort(),
    ["id", "name", "owner", "summary"]);
  assert.deepEqual(listJson.repository, {
    id: repositoryId, owner: "Owner", name: "Repository", summary: "Safe summary",
  });
  assert.equal(listJson.page, 2);
  assert.equal(listJson.totalPages, 2);
  assert.equal(listJson.total, 6);
  assert.deepEqual(listJson.notes.map((/** @type {any} */ note) => note.body), ["Existing 1"]);

  const created = await postForm(harness.worker, notesPath, session,
    { body: "  새 Note  " }, { Accept: "application/json" });
  assert.equal(created.status, 200);
  const createJson = await created.json();
  assert.deepEqual(Object.keys(createJson).sort(), ["note", "noteSummary"]);
  assert.equal(createJson.note.body, "새 Note");
  assert.deepEqual(createJson.noteSummary, { noteCount: 7, latestNote: "새 Note" });

  const itemPath = `${notesPath}/${createJson.note.id}`;
  const updated = await postForm(harness.worker, itemPath, session,
    { body: "  수정 Note  " }, { Accept: "application/json" });
  assert.equal(updated.status, 200);
  const updateJson = await updated.json();
  assert.deepEqual(Object.keys(updateJson).sort(), ["note", "noteSummary"]);
  assert.equal(updateJson.note.body, "수정 Note");
  assert.deepEqual(updateJson.noteSummary, { noteCount: 7, latestNote: "수정 Note" });

  const deleted = await postForm(harness.worker, `${itemPath}/delete`, session,
    { confirm: "yes" }, { Accept: "application/json" });
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), {
    repositoryId, noteId: createJson.note.id,
    noteSummary: { noteCount: 6, latestNote: "Existing 6" },
  });
});

test("Note routes enforce authentication, CSRF, validation, scoping, queries, and methods", async () => {
  const origin = "https://production.repo-atlas.test";
  const repositoryId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const otherRepositoryId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  const noteId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
  const env = await harness.worker.getEnv();
  await seedRepository(env.PROD_DB, { id: repositoryId });
  await seedRepository(env.PROD_DB, { id: otherRepositoryId, githubId: "other" });
  await seedRepositoryNote(env.PROD_DB, { id: noteId, repositoryId, body: "Keep me" });
  const notesPath = `/repositories/${repositoryId}/notes`;

  const expiredHtml = await harness.worker.fetch(`${origin}${notesPath}`);
  assert.equal(expiredHtml.status, 303);
  assert.equal(expiredHtml.headers.get("location"), "/login");
  const expiredJson = await harness.worker.fetch(`${origin}${notesPath}`, {
    headers: { Accept: "application/json" },
  });
  assert.equal(expiredJson.status, 401);
  assert.deepEqual(await expiredJson.json(), { errorCode: "session_expired" });

  const session = await login(harness.worker);
  /** @param {string} path @param {Array<[string, string]>} entries */
  const rawPost = (path, entries) => {
    const body = new FormData();
    for (const [key, value] of entries) body.append(key, value);
    return harness.worker.fetch(`${origin}${path}`, {
      method: "POST",
      headers: { Origin: origin, Cookie: session.cookie, Accept: "application/json" },
      body,
    });
  };
  /** @type {Array<[string, Array<[string, string]>]>} */
  const mutations = [
    [notesPath, [["body", "new"]]],
    [`${notesPath}/${noteId}`, [["body", "updated"]]],
    [`${notesPath}/${noteId}/delete`, [["confirm", "yes"]]],
  ];
  for (const [path, fields] of mutations) {
    assert.equal((await rawPost(path, fields)).status, 401, `${path} absent CSRF`);
    assert.equal((await rawPost(path, [["csrf", "invalid"], ...fields])).status, 401,
      `${path} invalid CSRF`);
  }

  for (const body of ["", "x".repeat(4_001)]) {
    for (const path of [notesPath, `${notesPath}/${noteId}`]) {
      const response = await postForm(harness.worker, path, session, { body }, {
        Accept: "application/json",
      });
      assert.equal(response.status, 400, `${path} body length ${body.length}`);
      assert.deepEqual(await response.json(), { errorCode: "invalid_repository_note" });
    }
  }

  const duplicate = await rawPost(notesPath, [
    ["csrf", session.csrf], ["body", "one"], ["body", "two"],
  ]);
  assert.equal(duplicate.status, 400);
  assert.deepEqual(await duplicate.json(), { errorCode: "invalid_form" });
  const extra = await postForm(harness.worker, `${notesPath}/${noteId}`, session,
    { body: "update", unexpected: "private" }, { Accept: "application/json" });
  assert.equal(extra.status, 400);
  assert.deepEqual(await extra.json(), { errorCode: "invalid_form" });

  const unconfirmed = await postForm(harness.worker, `${notesPath}/${noteId}/delete`, session,
    { confirm: "no" }, { Accept: "application/json" });
  assert.equal(unconfirmed.status, 400);
  assert.deepEqual(await unconfirmed.json(), { errorCode: "confirmation_required" });

  const mismatched = await postForm(harness.worker,
    `/repositories/${otherRepositoryId}/notes/${noteId}`, session,
    { body: "wrong repository" }, { Accept: "application/json" });
  assert.equal(mismatched.status, 404);
  assert.deepEqual(await mismatched.json(), { errorCode: "repository_note_not_found" });
  const missingParent = await postForm(harness.worker,
    "/repositories/dddddddd-dddd-dddd-dddd-dddddddddddd/notes", session,
    { body: "missing" }, { Accept: "application/json" });
  assert.equal(missingParent.status, 404);
  assert.deepEqual(await missingParent.json(), { errorCode: "repository_not_found" });

  for (const query of ["", "?page=0", "?page=not-a-number"]) {
    const response = await harness.worker.fetch(`${origin}${notesPath}${query}`, {
      headers: { Cookie: session.cookie, Accept: "application/json" },
    });
    assert.equal(response.status, 200, query || "missing page");
    assert.equal((await response.json()).page, 1);
  }
  for (const query of ["?page=1&page=2", "?debug=yes"]) {
    const response = await harness.worker.fetch(`${origin}${notesPath}${query}`, {
      headers: { Cookie: session.cookie, Accept: "application/json" },
    });
    assert.equal(response.status, 400, query);
    assert.deepEqual(await response.json(), { errorCode: "invalid_note_query" });
  }
  assert.equal((await postForm(harness.worker, `${notesPath}?page=1`, session,
    { body: "query" }, { Accept: "application/json" })).status, 400);

  for (const [method, path, status] of [
    ["GET", `${notesPath}/${noteId}`, 405],
    ["DELETE", `${notesPath}/${noteId}`, 405],
    ["PATCH", `${notesPath}/${noteId}`, 405],
    ["GET", `${notesPath}/${noteId}/delete`, 405],
    ["POST", `${notesPath}/${noteId}/unknown`, 404],
  ]) {
    const response = await harness.worker.fetch(`${origin}${path}`, {
      method, headers: { Cookie: session.cookie },
    });
    assert.equal(response.status, status, `${method} ${path}`);
  }
});

test("native Note mutations redirect to the manager with fixed flash codes", async () => {
  const repositoryId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const env = await harness.worker.getEnv();
  await seedRepository(env.PROD_DB, { id: repositoryId });
  const session = await login(harness.worker);
  const notesPath = `/repositories/${repositoryId}/notes`;

  const created = await postForm(harness.worker, notesPath, session, { body: "새 Note" });
  assert.equal(created.status, 303);
  assert.equal(created.headers.get("location"), `${notesPath}?flash=repository_note_created`);
  const note = await env.PROD_DB.prepare(
    "SELECT id FROM repository_notes WHERE repository_id = ?",
  ).bind(repositoryId).first();
  assert.ok(note);
  const updated = await postForm(harness.worker, `${notesPath}/${note.id}`, session,
    { body: "수정 Note" });
  assert.equal(updated.status, 303);
  assert.equal(updated.headers.get("location"), `${notesPath}?flash=repository_note_updated`);
  const deleted = await postForm(harness.worker, `${notesPath}/${note.id}/delete`, session,
    { confirm: "yes" });
  assert.equal(deleted.status, 303);
  assert.equal(deleted.headers.get("location"), `${notesPath}?flash=repository_note_deleted`);
});

test("activity refresh synchronizes pushed activity with one GitHub metadata request", async () => {
  const env = await harness.worker.getEnv();
  const repositoryId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
  await seedRepository(env.PROD_DB, {
    id: repositoryId, githubId: "9007199254740000", owner: "OpenAI", name: "example",
    htmlUrl: "https://github.com/OpenAI/example", githubPushedAt: null,
    activityRefreshedAt: null,
    personalNote: "보존할 메모", tags: ["keep"], stars: 10,
  });
  await env.PROD_DB.prepare(
    "UPDATE repositories SET updated_at = 123 WHERE id = ?",
  ).bind(repositoryId).run();
  const before = await env.PROD_DB.prepare(
    "SELECT * FROM repositories WHERE id = ?",
  ).bind(repositoryId).first();
  /** @type {Array<{ method: string, path: string }>} */
  const calls = [];
  await harness.setProviderMode({
    calls,
    metadata: {
      id: 9007199254740000, owner: { login: "OpenAI" }, name: "example",
      html_url: "https://github.com/OpenAI/example", description: "changed",
      homepage: null, default_branch: "main", language: "TypeScript",
      stargazers_count: 999, forks_count: 888, license: { spdx_id: "MIT" },
      topics: ["changed"], updated_at: "2026-08-23T01:00:00Z",
      pushed_at: "2026-08-22T12:00:00Z",
    },
  });
  const session = await login(harness.worker);

  const response = await postForm(
    harness.worker, `/repositories/${repositoryId}/activity`, session, {},
    { Accept: "application/json" },
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(Object.keys(body), ["repository"]);
  assert.equal(body.repository.githubPushedAt, "2026-08-22T12:00:00Z");
  assert.deepEqual(calls, [{ method: "GET", path: "/repos/OpenAI/example" }]);
  const after = await env.PROD_DB.prepare(
    "SELECT * FROM repositories WHERE id = ?",
  ).bind(repositoryId).first();
  assert.ok(before);
  assert.ok(after);
  for (const key of ["github_pushed_at", "activity_refreshed_at", "activity_refresh_generation"])
    delete before[key], delete after[key];
  assert.deepEqual(after, before);
  const stored = await getRepository(env.PROD_DB, repositoryId);
  assert.ok(stored);
  assert.equal(stored.githubPushedAt, "2026-08-22T12:00:00Z");
  assert.equal(typeof stored.activityRefreshedAt, "number");
  assert.equal(stored.stars, 10);
  assert.equal(stored.primaryLanguage, "JavaScript");
  assert.equal(Object.hasOwn(stored, "personalNote"), false);
  assert.deepEqual(stored.tags, ["keep"]);

  const native = await postForm(
    harness.worker, `/repositories/${repositoryId}/activity`, session, {},
  );
  assert.equal(native.status, 303);
  assert.equal(native.headers.get("location"), "/?flash=repository_activity_refreshed");
});

test("blank tags clear in JSON and native edits while internal empty entries stay invalid", async () => {
  const session = await login(harness.worker);
  const created = await postForm(harness.worker, "/repositories", session, {
    url: "https://github.com/OpenAI/example",
  }, { Accept: "application/json" });
  const { repositoryId } = await created.json();
  const path = `/repositories/${repositoryId}`;

  const clearedJson = await postForm(harness.worker, path, session, {
    primaryCategory: "Backend", tags: "   ",
  }, { Accept: "application/json" });
  assert.equal(clearedJson.status, 200);
  assert.deepEqual((await clearedJson.json()).repository.tags, []);

  assert.equal((await postForm(harness.worker, path, session, {
    primaryCategory: "Backend", tags: "one, two",
  }, { Accept: "application/json" })).status, 200);
  const clearedNative = await postForm(harness.worker, path, session, {
    primaryCategory: "Backend", tags: " \t ",
  });
  assert.equal(clearedNative.status, 303);
  const afterNative = await getRepository((await harness.worker.getEnv()).PROD_DB, repositoryId);
  assert.ok(afterNative);
  assert.deepEqual(afterNative.tags, []);

  const malformed = await postForm(harness.worker, path, session, {
    primaryCategory: "Backend", tags: "one,,two",
  }, { Accept: "application/json" });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { errorCode: "invalid_tags" });
  const afterMalformed = await getRepository((await harness.worker.getEnv()).PROD_DB, repositoryId);
  assert.ok(afterMalformed);
  assert.deepEqual(afterMalformed.tags, []);
});

test("Accept enables JSON only for an exact application/json range with positive valid q", async () => {
  const url = "https://production.repo-atlas.test/repositories/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  /** @type {Array<[string, number, string | null]>} */
  const cases = [
    ["application/json", 401, "application/json; charset=utf-8"],
    ["text/html, APPLICATION/JSON; Q=0.5", 401, "application/json; charset=utf-8"],
    ["application/json;q=0", 303, null],
    [`application/json;profile="a,b";q=0`, 303, null],
    [`application/json;profile="a;b";q=0`, 303, null],
    [`application/json;profile="unterminated;q=1`, 303, null],
    ["application/json;q=bogus", 303, null],
    ["application/json;q=bogus, application/json", 303, null],
    ["application/json; q=2", 303, null],
    ["text/plain; note=application/json", 303, null],
  ];
  for (const [accept, status, type] of cases) {
    const response = await harness.worker.fetch(url, { headers: { Accept: accept } });
    assert.equal(response.status, status, accept);
    assert.equal(response.headers.get("content-type"), type, accept);
  }
});

test("authentication, origin, CSRF, host, query, confirmation, and method boundaries fail closed", async () => {
  const origin = "https://production.repo-atlas.test";
  const htmlExpired = await harness.worker.fetch(`${origin}/`);
  assert.equal(htmlExpired.status, 303);
  assert.equal(htmlExpired.headers.get("location"), "/login");
  const jsonExpired = await harness.worker.fetch(`${origin}/repositories/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa`, {
    headers: { Accept: "application/json" },
  });
  assert.equal(jsonExpired.status, 401);
  assert.deepEqual(await jsonExpired.json(), { errorCode: "session_expired" });
  const env = await harness.worker.getEnv();
  const expired = (await createSession(Math.floor(Date.now() / 1_000) - 604_801, env.PROD_SESSION_KEY)).cookie;
  assert.equal((await harness.worker.fetch(`${origin}/`, { headers: { Cookie: expired } })).status, 303);
  assert.equal((await harness.worker.fetch(`${origin}/repositories/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa`, {
    headers: { Cookie: expired, Accept: "application/json" },
  })).status, 401);

  assert.equal((await harness.worker.fetch("https://unknown.repo-atlas.test/health")).status, 404);
  assert.equal((await harness.worker.fetch(`${origin}/health?debug=yes`)).status, 400);
  const session = await login(harness.worker);
  assert.equal((await harness.worker.fetch(`${origin}/?q=a&q=b`, {
    headers: { Cookie: session.cookie },
  })).status, 400);
  assert.equal((await harness.worker.fetch(`${origin}/?flash=x&flash=y`, {
    headers: { Cookie: session.cookie },
  })).status, 400);

  const method = await harness.worker.fetch(`${origin}/repositories`, { method: "GET" });
  assert.equal(method.status, 405);
  assert.equal(method.headers.get("allow"), "POST");
  assert.equal((await harness.worker.fetch(`${origin}/repositories/not-an-id`, {
    headers: { Cookie: session.cookie },
  })).status, 404);
  assert.equal((await postForm(harness.worker, "/repositories?debug=yes", session, {
    url: "https://github.com/OpenAI/example",
  })).status, 400);

  const badOrigin = await postForm(harness.worker, "/repositories", session, {
    url: "https://github.com/OpenAI/example",
  }, { Origin: "https://evil.test", Accept: "application/json" });
  assert.equal(badOrigin.status, 401);
  assert.deepEqual(await badOrigin.json(), { errorCode: "session_expired" });

  const missingCsrf = new FormData();
  missingCsrf.set("url", "https://github.com/OpenAI/example");
  assert.equal((await harness.worker.fetch(`${origin}/repositories`, {
    method: "POST", headers: { Origin: origin, Cookie: session.cookie }, body: missingCsrf,
  })).status, 401);
  missingCsrf.set("csrf", "invalid");
  assert.equal((await harness.worker.fetch(`${origin}/repositories`, {
    method: "POST", headers: { Origin: origin, Cookie: session.cookie }, body: missingCsrf,
  })).status, 401);

  const created = await postForm(harness.worker, "/repositories", session, {
    url: "https://github.com/OpenAI/example",
  }, { Accept: "application/json" });
  const path = `/repositories/${(await created.json()).repositoryId}`;
  assert.equal((await postForm(harness.worker, `${path}/refresh`, session, {})).status, 400);
  assert.equal((await postForm(harness.worker, `${path}/delete`, session, { confirm: "no" })).status, 400);
});

test("form parsers enforce media type, field allowlists, repetition, and both body caps", async () => {
  const origin = "https://production.repo-atlas.test";
  const loginBody = new URLSearchParams({ pin: "123456" });
  assert.equal((await harness.worker.fetch(`${origin}/session`, {
    method: "POST", headers: { Origin: origin, "CF-Connecting-IP": "192.0.2.1", "Content-Type": "text/plain" },
    body: loginBody.toString(),
  })).status, 415);
  assert.equal((await harness.worker.fetch(`${origin}/session`, {
    method: "POST", headers: {
      Origin: origin, "CF-Connecting-IP": "192.0.2.1", "Content-Type": "text/plain", "Content-Length": "4097",
    }, body: loginBody.toString(),
  })).status, 413);
  assert.equal((await harness.worker.fetch(`${origin}/session`, {
    method: "POST", headers: { Origin: origin, "CF-Connecting-IP": "192.0.2.1", "Content-Type": "application/x-www-form-urlencoded", "Content-Length": "4097" },
    body: loginBody.toString(),
  })).status, 413);
  assert.equal((await harness.worker.fetch(`${origin}/session`, {
    method: "POST", headers: { Origin: "https://evil.test", "CF-Connecting-IP": "192.0.2.1" },
    body: new URLSearchParams({ pin: "123456" }),
  })).status, 401);
  assert.equal((await harness.worker.fetch(`${origin}/session`, {
    method: "POST", headers: { Origin: origin }, body: new URLSearchParams({ pin: "123456" }),
  })).status, 503);

  const session = await login(harness.worker);
  const repeated = new FormData();
  repeated.append("csrf", session.csrf);
  repeated.append("url", "https://github.com/OpenAI/example");
  repeated.append("url", "https://github.com/OpenAI/other");
  assert.equal((await harness.worker.fetch(`${origin}/repositories`, {
    method: "POST", headers: { Origin: origin, Cookie: session.cookie }, body: repeated,
  })).status, 400);
  assert.equal((await postForm(harness.worker, "/repositories", session, {
    url: "https://github.com/OpenAI/example", unexpected: "secret-value",
  }, { Accept: "application/json" })).status, 400);
  assert.equal((await harness.worker.fetch(`${origin}/repositories`, {
    method: "POST", headers: {
      Origin: origin, Cookie: session.cookie, "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": "16385",
    }, body: `csrf=${session.csrf}&url=x`,
  })).status, 413);

  const oversized = new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(`pin=${"1".repeat(4097)}`));
    controller.close();
  } });
  assert.equal((await harness.worker.fetch(new Request(`${origin}/session`, /** @type {any} */ ({
    method: "POST", headers: { Origin: origin, "CF-Connecting-IP": "192.0.2.2", "Content-Type": "application/x-www-form-urlencoded" },
    body: oversized, duplex: "half",
  })))).status, 413);
  const mutationStream = new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(16_385));
    controller.close();
  } });
  assert.equal((await harness.worker.fetch(new Request(`${origin}/repositories`, /** @type {any} */ ({
    method: "POST", headers: {
      Origin: origin, Cookie: session.cookie, "Content-Type": "application/x-www-form-urlencoded",
    }, body: mutationStream, duplex: "half",
  })))).status, 413);
});

test("stream body caps do not await a never-settling cancel", async () => {
  const origin = "https://production.repo-atlas.test";
  const env = await harness.worker.getEnv();
  let cancelStarted = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(4_097)); },
    cancel() { cancelStarted = true; return new Promise(() => {}); },
  });
  let timeout;
  try {
    const response = await Promise.race([
      handleRequest(new Request(`${origin}/session`, /** @type {any} */ ({
        method: "POST", headers: {
          Origin: origin, "CF-Connecting-IP": "192.0.2.2",
          "Content-Type": "application/x-www-form-urlencoded",
        }, body, duplex: "half",
      })), env, { waitUntil() {} }, providerFixture()),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("body_cap_timeout")), 250); }),
    ]);
    assert.equal(response.status, 413);
    assert.equal(cancelStarted, true);
  } finally { clearTimeout(timeout); }
});

test("assets require the current release and receive exact immutable cache and MIME headers", async () => {
  const origin = "https://production.repo-atlas.test";
  const missingAsset = await harness.worker.fetch(`${origin}/assets/old/app.js`);
  assert.equal(missingAsset.status, 404);
  assertBaseHeaders(missingAsset);
  const js = await harness.worker.fetch(`${origin}/assets/test-release/app.js`);
  assert.equal(js.status, 200);
  assertBaseHeaders(js);
  assert.equal(js.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.equal(js.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(js.headers.get("referrer-policy"), "same-origin");
  assert.equal(js.headers.get("vary"), "Accept-Encoding");
  assert.equal(js.headers.get("x-content-type-options"), "nosniff");
  const css = await harness.worker.fetch(`${origin}/assets/test-release/core.css`);
  assert.equal(css.headers.get("content-type"), "text/css; charset=utf-8");
  const favicon = await harness.worker.fetch(`${origin}/assets/test-release/favicon.svg`);
  assert.equal(favicon.status, 200);
  assert.equal(favicon.headers.get("content-type"), "image/svg+xml");
  assert.equal(favicon.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(favicon.headers.get("x-content-type-options"), "nosniff");
  assert.equal((await harness.worker.fetch(`${origin}/assets/test-release/secret.txt`)).status, 404);

  const loginPage = await harness.worker.fetch(`${origin}/login`);
  assert.equal(loginPage.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(loginPage.headers.get("cache-control"), "no-store");
  assert.equal((await harness.worker.fetch(`${origin}/health`)).headers.get("content-type"),
    "application/json; charset=utf-8");
});

test("asset binding rejection is contained as a safe no-store error and reset restores assets", async () => {
  const url = "https://production.repo-atlas.test/assets/test-release/app.js";
  await harness.setAssetMode({ reject: true });
  const failed = await harness.worker.fetch(url, { headers: { Accept: "application/json" } });
  assert.equal(failed.status, 500);
  assertBaseHeaders(failed);
  assert.deepEqual(await failed.json(), { errorCode: "internal_error" });
  assert.equal(failed.headers.get("cache-control"), "no-store");
  assert.notEqual(failed.headers.get("cache-control"), "public, max-age=31536000, immutable");
  await harness.reset();
  assert.equal((await harness.worker.fetch(url)).status, 200);
});

test("base headers cover not found, method, and login error responses", async () => {
  const origin = "https://production.repo-atlas.test";
  const session = await login(harness.worker);
  const responses = [
    await harness.worker.fetch(`${origin}/missing`),
    await harness.worker.fetch(`${origin}/repositories`, { headers: { Cookie: session.cookie } }),
    await harness.worker.fetch(`${origin}/session`, {
      method: "POST", headers: { Origin: "https://evil.test" },
      body: new URLSearchParams({ pin: "123456" }),
    }),
  ];
  assert.deepEqual(responses.map((response) => response.status), [404, 405, 401]);
  for (const response of responses) assertBaseHeaders(response);
});

test("safe retry hints survive provider throttling and an active analysis lease", async () => {
  await harness.setProviderMode({ metadataStatus: 429, metadataRetryAfter: "60" });
  const session = await login(harness.worker);
  const throttled = await postForm(harness.worker, "/repositories", session, {
    url: "https://github.com/OpenAI/example",
  }, { Accept: "application/json" });
  assert.equal(throttled.status, 429);
  assert.equal(throttled.headers.get("retry-after"), "60");
  assert.deepEqual(await throttled.json(), { errorCode: "github_rate_limited" });

  await harness.reset();
  const activeSession = await login(harness.worker);
  const env = await harness.worker.getEnv();
  const id = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  await seedRepository(env.PROD_DB, {
    id, githubId: "9007199254740000", owner: "OpenAI", name: "example",
    htmlUrl: "https://github.com/OpenAI/example", analysisStatus: "pending",
    analysisStartedAt: Math.floor(Date.now() / 1_000),
  });
  const leased = await postForm(harness.worker, `/repositories/${id}/refresh`, activeSession, {
    confirm: "yes",
  }, { Accept: "application/json" });
  assert.equal(leased.status, 409);
  assert.equal(leased.headers.get("retry-after"), "300");
  assert.deepEqual(await leased.json(), { errorCode: "analysis_in_progress" });
});

test("provider fixture allows only exact expected methods and paths", async () => {
  /** @type {Array<{ method: string, path: string }>} */
  const calls = [];
  await harness.setProviderMode({ calls });
  const session = await login(harness.worker);
  assert.equal((await postForm(harness.worker, "/repositories", session, {
    url: "https://github.com/OpenAI/example",
  }, { Accept: "application/json" })).status, 200);
  assert.deepEqual(calls, [
    { method: "GET", path: "/repos/OpenAI/example" },
    { method: "GET", path: "/repos/OpenAI/example/readme?ref=main" },
    { method: "POST", path: "/v1/responses" },
  ]);

  const fixture = providerFixture();
  await assert.rejects(fixture("https://api.github.com/user"), /Unexpected provider/);
  await assert.rejects(fixture("https://api.github.com/repos/OpenAI/example?unexpected=1"), /Unexpected provider/);
  await assert.rejects(fixture("https://api.github.com/repos/OpenAI/example/readme"), /Unexpected provider/);
  await assert.rejects(fixture("https://api.openai.com/v1/models", { method: "POST" }), /Unexpected provider/);
  await assert.rejects(fixture("https://api.openai.com/v1/responses"), /Unexpected provider/);
  await assert.rejects(fixture("https://api.openai.com/v1/responses", { method: "GET" }), /Unexpected provider/);
  await assert.rejects(fixture(new Request("https://api.openai.com/v1/responses", {
    method: "POST",
  }), { method: "GET" }), /Unexpected provider/);
  await assert.rejects(fixture("https://api.openai.com/v1/responses?debug=1", { method: "POST" }), /Unexpected provider/);
});

test("page CSP, Trusted Types rollout, and global security headers are exact", async () => {
  const origin = "https://production.repo-atlas.test";
  const loginPage = await harness.worker.fetch(`${origin}/login`);
  assert.equal(loginPage.headers.get("content-security-policy"),
    "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; connect-src 'none'; report-uri /csp-report");
  assert.equal(loginPage.headers.get("content-security-policy-report-only"), null);
  const session = await login(harness.worker);
  const appPage = await harness.worker.fetch(`${origin}/`, { headers: { Cookie: session.cookie } });
  assert.equal(appPage.headers.get("content-security-policy"),
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' https://github.com https://avatars.githubusercontent.com; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; report-uri /csp-report");
  assert.equal(appPage.headers.get("content-security-policy-report-only"),
    "require-trusted-types-for 'script'; trusted-types 'none'; report-uri /csp-report");

  const env = await harness.worker.getEnv();
  const enforced = await handleRequest(new Request(`${origin}/`, {
    headers: { Cookie: session.cookie },
  }), { ...env, TRUSTED_TYPES_MODE: "enforce" }, { waitUntil() {} }, providerFixture());
  assert.equal(enforced.headers.get("content-security-policy"),
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' https://github.com https://avatars.githubusercontent.com; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; require-trusted-types-for 'script'; trusted-types 'none'; report-uri /csp-report");
  assert.equal(enforced.headers.get("content-security-policy-report-only"), null);

  for (const response of [loginPage, appPage, enforced, await harness.worker.fetch(`${origin}/health`)]) {
    assert.equal(response.headers.get("strict-transport-security"),
      "max-age=63072000; includeSubDomains");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("referrer-policy"), "same-origin");
    assert.equal(response.headers.get("permissions-policy"),
      "camera=(), geolocation=(), microphone=(), payment=(), usb=()");
  }
});

test("authenticated telemetry is referer-derived, bucketed, retained, and natively rate limited", async () => {
  const origin = "https://production.repo-atlas.test";
  const env = await harness.worker.getEnv();
  assert.equal(typeof env.REPORT_RATE_LIMITER?.limit, "function");
  const nativeOutcome = await env.REPORT_RATE_LIMITER.limit({ key: `test:${crypto.randomUUID()}` });
  assert.equal(typeof nativeOutcome.success, "boolean");
  const oldDay = new Date(Date.now() - 31 * 86_400_000).toISOString().slice(0, 10);
  await env.PROD_DB.prepare(`INSERT INTO telemetry_daily
    (day, release_id, route_template, event_type, metric_name, value_bucket, dimension, count)
    VALUES (?, 'old-release', '/', 'navigation', 'navigation_duration', '<100', 'none', 1)`)
    .bind(oldDay).run();
  const session = await login(harness.worker);
  const headers = {
    Cookie: session.cookie, Origin: origin, Referer: `${origin}/repositories/private-id?token=secret`,
    "Content-Type": "application/json",
  };
  const body = JSON.stringify({ eventType: "web_vital", metricName: "LCP", value: 2_100 });
  for (let count = 0; count < 2; count += 1) {
    const response = await harness.worker.fetch(`${origin}/telemetry`, { method: "POST", headers, body });
    assert.equal(response.status, 204);
    assert.equal(await response.text(), "");
  }
  const repositoryId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const noteId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  const noteResponse = await harness.worker.fetch(`${origin}/telemetry`, {
    method: "POST",
    headers: {
      ...headers, Referer: `${origin}/repositories/${repositoryId}/notes/${noteId}?private=secret`,
    },
    body: JSON.stringify({
      eventType: "navigation", metricName: "navigation_duration", value: 321,
    }),
  });
  assert.equal(noteResponse.status, 204);
  const rows = await env.PROD_DB.prepare(
    "SELECT * FROM telemetry_daily ORDER BY release_id, event_type",
  ).all();
  assert.deepEqual(rows.results, [
    {
      day: new Date().toISOString().slice(0, 10), release_id: "test-release",
      route_template: "/repositories/:id/notes", event_type: "navigation",
      metric_name: "navigation_duration", value_bucket: "300-999", dimension: "none", count: 1,
    },
    {
      day: new Date().toISOString().slice(0, 10), release_id: "test-release",
      route_template: "/repositories/:id", event_type: "web_vital", metric_name: "LCP",
      value_bucket: "good", dimension: "none", count: 2,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(rows.results),
    new RegExp(`private|token|secret|${repositoryId}|${noteId}`));
});

test("telemetry write cleanup deletes the exact thirty-day cutoff and retains day twenty-nine", async () => {
  const env = await harness.worker.getEnv();
  for (const day of ["2026-07-10", "2026-07-11"]) {
    await env.PROD_DB.prepare(`INSERT INTO telemetry_daily
      (day, release_id, route_template, event_type, metric_name, value_bucket, dimension, count)
      VALUES (?, 'old-release', '/', 'navigation', 'navigation_duration', '<100', 'none', 1)`)
      .bind(day).run();
  }
  await recordTelemetry(env.PROD_DB, {
    releaseId: "test-release", routeTemplate: "/", eventType: "navigation",
    metricName: "navigation_duration", valueBucket: "100-299", dimension: "none",
  }, Date.UTC(2026, 7, 9) / 1_000);
  const rows = (await env.PROD_DB.prepare(
    "SELECT day FROM telemetry_daily ORDER BY day",
  ).all()).results;
  assert.deepEqual(rows, [{ day: "2026-07-11" }, { day: "2026-08-09" }]);
});

test("telemetry rejects untrusted context, media types, unknown fields, and oversized bodies", async () => {
  const origin = "https://production.repo-atlas.test";
  const session = await login(harness.worker);
  const valid = { eventType: "client_error", metricName: "none", value: 0, code: "other" };
  const request = (headers = {}, body = JSON.stringify(valid)) => harness.worker.fetch(`${origin}/telemetry`, {
    method: "POST", headers: {
      Origin: origin, Referer: `${origin}/`, Cookie: session.cookie,
      "Content-Type": "application/json", ...headers,
    }, body,
  });
  assert.equal((await harness.worker.fetch(`${origin}/telemetry`, {
    method: "POST", headers: { Origin: origin, Referer: `${origin}/`, "Content-Type": "application/json" },
    body: JSON.stringify(valid),
  })).status, 401);
  assert.equal((await request({ Origin: "https://evil.test" })).status, 401);
  assert.equal((await request({ Referer: "https://evil.test/private" })).status, 400);
  assert.equal((await request({ Referer: "" })).status, 400);
  assert.equal((await request({ "Content-Type": "text/plain" })).status, 415);
  const unknown = await request({}, JSON.stringify({ ...valid, repository: "OpenAI/secret", stack: "private" }));
  assert.equal(unknown.status, 400);
  assert.doesNotMatch(await unknown.text(), /OpenAI|secret|private/);
  assert.equal((await request({ "Content-Length": "4097" })).status, 413);
});

test("telemetry limiter and aggregate failures fail closed with exact key handling", async () => {
  const origin = "https://production.repo-atlas.test";
  const env = await harness.worker.getEnv();
  const now = Math.floor(Date.now() / 1_000);
  const created = await createSession(now, env.PROD_SESSION_KEY);
  const body = JSON.stringify({ eventType: "navigation", metricName: "navigation_duration", value: 123 });
  const makeRequest = () => new Request(`${origin}/telemetry`, {
    method: "POST", headers: {
      Origin: origin, Referer: `${origin}/`, Cookie: created.cookie, "Content-Type": "application/json",
    }, body,
  });
  /** @type {string[]} */
  const keys = [];
  const accepted = {
    /** @param {{ key: string }} input */
    limit(input) { keys.push(input.key); return Promise.resolve({ success: true }); },
  };
  assert.equal((await handleRequest(makeRequest(), { ...env, REPORT_RATE_LIMITER: accepted },
    { waitUntil() {} }, providerFixture())).status, 204);
  assert.deepEqual(keys, [`telemetry:${created.session.nonce}`]);

  /** @type {Array<{ limiter: any, db: any, status: number }>} */
  const cases = [
    { limiter: undefined, db: env.PROD_DB, status: 503 },
    { limiter: { limit() { throw new Error("limiter-private"); } }, db: env.PROD_DB, status: 503 },
    { limiter: { limit() { return Promise.resolve({}); } }, db: env.PROD_DB, status: 503 },
    { limiter: { limit() { return Promise.resolve({ success: false }); } }, db: env.PROD_DB, status: 429 },
    { limiter: { limit() { return Promise.resolve({ success: true }); } }, db: {
      prepare() { return { bind() { return this; } }; },
      batch() { return Promise.resolve([{ success: true }]); },
    }, status: 503 },
    { limiter: { limit() { return Promise.resolve({ success: true }); } }, db: {
      prepare() { return { bind() { return this; } }; },
      batch() { return Promise.reject(new Error("private-batch-error")); },
    }, status: 503 },
    { limiter: { limit() { return Promise.resolve({ success: true }); } }, db: {
      prepare() { return { bind() { return this; } }; },
      batch() { return Promise.resolve([{ success: true }, { success: false }]); },
    }, status: 503 },
  ];
  for (const item of cases) assert.equal((await handleRequest(makeRequest(), {
    ...env, PROD_DB: item.db, REPORT_RATE_LIMITER: item.limiter,
  }, { waitUntil() {} }, providerFixture())).status, item.status);
});

test("CSP report validates document origin, pseudonymizes IP, and stores no URL", async () => {
  const origin = "https://production.repo-atlas.test";
  const env = await harness.worker.getEnv();
  const privateBody = JSON.stringify({
    "csp-report": {
      "violated-directive": "script-src-elem",
      "blocked-uri": "https://evil.example/private?token=secret",
      "document-uri": `${origin}/repositories/repo-secret?query=private#fragment`,
    },
  });
  const response = await harness.worker.fetch(`${origin}/csp-report`, {
    method: "POST", headers: {
      "Content-Type": "application/csp-report", "CF-Connecting-IP": "192.0.2.9",
    }, body: privateBody,
  });
  assert.equal(response.status, 204);
  assert.equal(await response.text(), "");
  const stored = JSON.stringify((await env.PROD_DB.prepare("SELECT * FROM telemetry_daily").all()).results);
  assert.doesNotMatch(stored, /private|token|repo-secret|evil\.example|192\.0\.2\.9/);
  assert.match(stored, /script-src-elem:other/);
  assert.match(stored, /repositories\/:id/);

  /** @type {string[]} */
  const keys = [];
  const accepted = {
    /** @param {{ key: string }} input */
    limit(input) { keys.push(input.key); return Promise.resolve({ success: true }); },
  };
  const modernBody = JSON.stringify([{ type: "csp-violation", body: {
    effectiveDirective: "connect-src", blockedURL: "https://api.openai.com/v1/private",
    documentURL: `${origin}/`,
  } }]);
  assert.equal((await handleRequest(new Request(`${origin}/csp-report`, {
    method: "POST", headers: {
      "Content-Type": "application/reports+json", "CF-Connecting-IP": "192.0.2.10",
    }, body: modernBody,
  }), { ...env, REPORT_RATE_LIMITER: accepted }, { waitUntil() {} }, providerFixture())).status, 204);
  assert.deepEqual(keys, [`csp:${await hashClientIp("192.0.2.10", env.PROD_IP_HMAC_KEY)}`]);
});

test("CSP report fails closed and rejects an unknown host", async () => {
  const production = "https://production.repo-atlas.test";
  const env = await harness.worker.getEnv();
  /** @param {string} documentUri */
  const bodyFor = (documentUri) => JSON.stringify({ "csp-report": {
    "violated-directive": "style-src", "blocked-uri": "inline", "document-uri": documentUri,
  } });
  /** @param {string} body @param {Record<string, string>} [headers] */
  const send = (body, headers = {}) => harness.worker.fetch(`${production}/csp-report`, {
    method: "POST", headers: { "Content-Type": "application/csp-report", ...headers }, body,
  });
  assert.equal((await send(bodyFor(`${production}/`))).status, 503);
  assert.equal((await send(bodyFor("https://evil.test/private"), { "CF-Connecting-IP": "192.0.2.11" })).status, 400);
  assert.equal((await send(bodyFor(`${production}/private`), { "CF-Connecting-IP": "192.0.2.11" })).status, 400);
  assert.equal((await send("not-json", { "CF-Connecting-IP": "192.0.2.11" })).status, 400);
  assert.equal((await send(bodyFor(`${production}/`), {
    "CF-Connecting-IP": "192.0.2.11", "Content-Length": "16385",
  })).status, 413);

  const unknownResponse = await harness.worker.fetch("https://staging.repo-atlas.test/csp-report", {
    method: "POST", headers: {
      "Content-Type": "application/csp-report", "CF-Connecting-IP": "192.0.2.12",
    }, body: bodyFor("https://staging.repo-atlas.test/login?private=yes#secret"),
  });
  assert.equal(unknownResponse.status, 404);
  const productionCount = await env.PROD_DB.prepare(
    "SELECT COUNT(*) AS count FROM telemetry_daily",
  ).first();
  assert.ok(productionCount);
  assert.equal(productionCount.count, 0);
});

test("global authentication locks aggregate once while public response and logs stay redacted", async () => {
  const origin = "https://production.repo-atlas.test";
  const env = await harness.worker.getEnv();
  const now = Math.floor(Date.now() / 1_000);
  await env.PROD_DB.prepare(`INSERT INTO auth_attempts
    (attempt_key, window_started_at, failures, locked_until, updated_at)
    VALUES ('global', ?, 50, ?, ?)`).bind(now - 1, now + 600, now).run();

  /** @type {any[][]} */
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => { logs.push(args); };
  try {
    const pin = "654321";
    const loginBody = new FormData();
    loginBody.set("pin", pin);
    const locked = await harness.worker.fetch(`${origin}/session`, {
      method: "POST", headers: { Origin: origin, "CF-Connecting-IP": "192.0.2.20" }, body: loginBody,
    });
    assert.equal(locked.status, 429);
    const lockedText = await locked.text();
    assert.match(lockedText, /로그인 시도가 잠겼습니다/);
    assert.doesNotMatch(lockedText, /654321|192\.0\.2\.20/);

    await env.PROD_DB.prepare("DELETE FROM auth_attempts").run();
    const session = await login(harness.worker);
    const created = await postForm(harness.worker, "/repositories", session, {
      url: "https://github.com/OpenAI/example",
    }, { Accept: "application/json" });
    const repositoryId = (await created.json()).repositoryId;
    const privateNote = await postForm(harness.worker, `/repositories/${repositoryId}/notes`, session, {
      body: "private Note body",
    }, { Accept: "application/json" });
    const noteId = (await privateNote.json()).note.id;
    await postForm(harness.worker, `/repositories/${repositoryId}/notes/${noteId}`, session, {
      body: "updated private Note body",
    }, { Accept: "application/json" });
    const cspUri = "https://evil.example/private-csp?token=secret";
    const cspResponse = await harness.worker.fetch(`${origin}/csp-report`, {
      method: "POST", headers: {
        "Content-Type": "application/csp-report", "CF-Connecting-IP": "192.0.2.21",
      }, body: JSON.stringify({ "csp-report": {
        "violated-directive": "script-src", "blocked-uri": cspUri, "document-uri": `${origin}/`,
      } }),
    });
    assert.equal(cspResponse.status, 204);
    assert.doesNotMatch(await cspResponse.text(), /private-csp|token|secret/);

    assert.equal(logs.length, 7);
    const records = logs.map((call) => {
      assert.equal(call.length, 1);
      const record = call[0];
      assert.equal(record !== null && typeof record === "object" &&
        Object.getPrototypeOf(record) === Object.prototype, true);
      assert.deepEqual(Object.keys(record), [
        "requestId", "routeTemplate", "status", "latencyMs",
        "githubStatus", "openAiStatus", "errorCode",
      ]);
      assert.match(record.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      assert.equal(new Set([
        "/session", "/", "/repositories", "/repositories/:id",
        "/repositories/:id/notes", "/csp-report",
      ]).has(record.routeTemplate), true);
      assert.equal(Number.isInteger(record.status) && record.status >= 100 && record.status <= 599, true);
      assert.equal(Number.isInteger(record.latencyMs) && record.latencyMs >= 0, true);
      assert.equal(new Set(["none", "ok", "not_found", "rate_limited", "error"])
        .has(record.githubStatus), true);
      assert.equal(new Set(["none", "ok", "not_found", "rate_limited", "error"])
        .has(record.openAiStatus), true);
      assert.equal(new Set([
        "none", "bad_request", "unauthorized", "not_found", "method_not_allowed",
        "conflict", "rate_limited", "server_error",
      ]).has(record.errorCode), true);
      return record;
    });
    const serialized = JSON.stringify(logs);
    for (const secret of [
      pin, session.cookie, "https://github.com/OpenAI/example", "# Example",
      "예제 저장소의 핵심 사용법을 보여준다.", "private Note body",
      "updated private Note body", repositoryId, noteId, cspUri,
    ]) assert.doesNotMatch(serialized, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(records.some((record) => record.routeTemplate === "/repositories" &&
      record.githubStatus === "ok" && record.openAiStatus === "ok"), true);
    assert.equal(records.filter((record) =>
      record.routeTemplate === "/repositories/:id/notes").length, 2);
  } finally { console.log = originalLog; }

  const aggregate = await env.PROD_DB.prepare(`SELECT event_type, route_template, metric_name,
    value_bucket, dimension, count FROM telemetry_daily WHERE event_type = 'auth_global_lock'`).first();
  assert.deepEqual(aggregate, {
    event_type: "auth_global_lock", route_template: "/login", metric_name: "none",
    value_bucket: "none", dimension: "none", count: 1,
  });
});
