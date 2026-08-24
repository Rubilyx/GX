import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import {
  login, postForm, providerFixture, seedThreadsArchive, startHarness,
} from "../support/harness.js";
import { handleRequest, handleThreadsScheduled } from "../../src/worker.js";
import { beginThreadsOAuth } from "../../src/threads-oauth.js";

const OAUTH_CLEAR = "__Host-threads_oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0";

/** @type {Awaited<ReturnType<typeof startHarness>>} */
let harness;

before(async () => { harness = await startHarness(); });
beforeEach(async () => { await harness.reset(); });
after(async () => { await harness.close(); });

test("Threads OAuth callback relies on its signed cookie and never weakens the PIN cookie", async () => {
  const session = await login(harness.worker);
  const started = await harness.worker.fetch(`${session.origin}/threads/connect`, {
    headers: { Cookie: session.cookie },
  });
  assert.equal(started.status, 303);
  const location = started.headers.get("location");
  if (!location) throw new Error("OAuth redirect missing");
  const authorize = new URL(location);
  assert.equal(authorize.origin, "https://threads.net");
  const state = authorize.searchParams.get("state");
  const oauthCookie = started.headers.get("set-cookie");
  assert.ok(state);
  if (!state) throw new Error("OAuth state missing");
  if (!oauthCookie) throw new Error("OAuth cookie missing");
  assert.match(oauthCookie, /SameSite=Lax/);
  assert.match(session.cookie, /SameSite=Strict/);

  const callback = await harness.worker.fetch(
    `${session.origin}/threads/oauth/callback?code=code-1&state=${state}`,
    { headers: { Cookie: oauthCookie } },
  );
  assert.equal(callback.status, 303);
  assert.equal(callback.headers.get("location"), "/threads?flash=threads_connected");
  assert.equal(callback.headers.get("set-cookie"), OAUTH_CLEAR);

  for (const url of [
    `${session.origin}/threads/oauth/callback?code=code-1&state=wrong`,
    `${session.origin}/threads/oauth/callback?code=code-1&state=${state}&state=${state}`,
    `${session.origin}/threads/oauth/callback?code=code-1&state=${state}&unknown=1`,
    `${session.origin}/threads/oauth/callback?code=code-1&error=access_denied&state=${state}`,
  ]) {
    const rejected = await harness.worker.fetch(url, { headers: { Cookie: oauthCookie } });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.headers.get("set-cookie"), OAUTH_CLEAR);
  }
  const [oauthPair] = oauthCookie.split(";", 1);
  const tamperedCookie = `${oauthPair.slice(0, -1)}${oauthPair.endsWith("x") ? "y" : "x"}`;
  const tampered = await harness.worker.fetch(
    `${session.origin}/threads/oauth/callback?code=code-1&state=${state}`,
    { headers: { Cookie: tamperedCookie } },
  );
  assert.equal(tampered.status, 400);
  assert.equal(tampered.headers.get("set-cookie"), OAUTH_CLEAR);

  const denied = await harness.worker.fetch(
    `${session.origin}/threads/oauth/callback?error=access_denied&error_reason=user_denied&error_description=Denied&state=${state}`,
    { headers: { Cookie: oauthCookie } },
  );
  assert.equal(denied.status, 400);
  assert.equal(denied.headers.get("set-cookie"), OAUTH_CLEAR);
  assert.match(session.cookie, /__Host-repo_atlas_session=/);
  assert.doesNotMatch(session.cookie, /SameSite=Lax/);
});

test("every callback response boundary clears only the OAuth cookie", async () => {
  const session = await login(harness.worker);
  for (const method of ["POST", "PUT"]) {
    const response = await harness.worker.fetch(`${session.origin}/threads/oauth/callback`, {
      method, headers: { Cookie: session.cookie },
    });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("set-cookie"), OAUTH_CLEAR);
  }

  const env = await harness.worker.getEnv();
  const missingBindings = await handleRequest(new Request(
    `${session.origin}/threads/oauth/callback?code=code-1&state=state`,
  ), { ...env, THREADS_MEDIA: undefined }, { waitUntil() {} },
  async () => { throw new Error("not reached"); });
  assert.equal(missingBindings.status, 503);
  assert.equal(missingBindings.headers.get("set-cookie"), OAUTH_CLEAR);

  const invalidBindings = /** @type {any} */ ({
    ...env, THREADS_MEDIA: harness.mediaBucket,
    THREADS_CAPTURE_QUEUE: harness.captureQueue, THREADS_MEDIA_QUEUE: harness.mediaQueue,
    THREADS_CAPTURE_QUEUE_NAME: "capture", THREADS_MEDIA_QUEUE_NAME: "media",
    THREADS_CAPTURE_DLQ_NAME: "capture-dlq", THREADS_MEDIA_DLQ_NAME: "media-dlq",
    THREADS_APP_ID: 7,
  });
  const invalidConfig = await handleRequest(new Request(
    `${session.origin}/threads/oauth/callback?code=code-1&state=state`,
  ), invalidBindings, { waitUntil() {} }, async () => { throw new Error("not reached"); });
  assert.equal(invalidConfig.status, 503);
  assert.equal(invalidConfig.headers.get("set-cookie"), OAUTH_CLEAR);

  const target = new Request(
    `${session.origin}/threads/oauth/callback?code=code-1&state=state`,
  );
  const unexpectedRequest = new Proxy(target, {
    get(request, property) {
      if (property === "headers") throw new Error("unexpected request fault");
      return Reflect.get(request, property, request);
    },
  });
  const unexpected = await handleRequest(unexpectedRequest, env,
    { waitUntil() {} }, async () => { throw new Error("not reached"); });
  assert.equal(unexpected.status, 500);
  assert.equal(unexpected.headers.get("set-cookie"), OAUTH_CLEAR);

  const expiredState = await beginThreadsOAuth({
    appId: "test-threads-app", redirectUri: `${session.origin}/threads/oauth/callback`,
    sessionNonce: "expired-session", tokenKey:
      "cmVwby1hdGxhcy10aHJlYWRzLXRlc3Qta2V5LTAwMDE=",
    nowSeconds: Math.floor(Date.now() / 1_000) - 700,
  });
  const expired = await harness.worker.fetch(
    `${session.origin}/threads/oauth/callback?code=code-1&state=${
      new URL(expiredState.location).searchParams.get("state")}`,
    { headers: { Cookie: expiredState.setCookie } },
  );
  assert.equal(expired.status, 400);
  assert.equal(expired.headers.get("set-cookie"), OAUTH_CLEAR);
});

test("scheduled boundary refreshes only near expiry and never queues content", async () => {
  const session = await login(harness.worker);
  const started = await harness.worker.fetch(`${session.origin}/threads/connect`, {
    headers: { Cookie: session.cookie },
  });
  const location = started.headers.get("location");
  const cookie = started.headers.get("set-cookie");
  if (!location || !cookie) throw new Error("OAuth setup missing");
  const state = new URL(location).searchParams.get("state");
  assert.equal((await harness.worker.fetch(
    `${session.origin}/threads/oauth/callback?code=code-1&state=${state}`,
    { headers: { Cookie: cookie } },
  )).status, 303);

  const env = await harness.worker.getEnv();
  const eventEnv = /** @type {any} */ ({
    ...env, THREADS_MEDIA: harness.mediaBucket,
    THREADS_CAPTURE_QUEUE: harness.captureQueue, THREADS_MEDIA_QUEUE: harness.mediaQueue,
    THREADS_CAPTURE_QUEUE_NAME: "capture", THREADS_MEDIA_QUEUE_NAME: "media",
    THREADS_CAPTURE_DLQ_NAME: "capture-dlq", THREADS_MEDIA_DLQ_NAME: "media-dlq",
  });
  /** @type {Promise<unknown>[]} */
  const waited = [];
  const context = /** @type {{ waitUntil(promise: Promise<unknown>): void }} */ ({
    waitUntil(promise) {
    waited.push(promise);
    },
  });
  const queueCounts = [harness.captureMessages.length, harness.mediaMessages.length];
  assert.deepEqual(await handleThreadsScheduled(
    eventEnv, context, providerFixture(), 1_900_000_000,
  ), { refreshed: false, reconnectRequired: false });
  assert.notEqual((await env.PROD_DB.prepare(
    "SELECT refreshed_at FROM threads_oauth_credentials WHERE singleton_id = 1",
  ).first("refreshed_at")), 1_900_000_000);
  assert.deepEqual(await handleThreadsScheduled(
    eventEnv, context, providerFixture(), 1_999_500_000,
  ), { refreshed: true, reconnectRequired: false });
  assert.equal(await env.PROD_DB.prepare(
    "SELECT refreshed_at FROM threads_oauth_credentials WHERE singleton_id = 1",
  ).first("refreshed_at"), 1_999_500_000);
  assert.deepEqual(await handleThreadsScheduled(
    eventEnv, context, providerFixture(), 2_000_000_001,
  ), { refreshed: false, reconnectRequired: true });
  assert.equal(waited.length, 3);
  assert.deepEqual([harness.captureMessages.length, harness.mediaMessages.length], queueCounts);
});

test("authenticated Threads list, capture, detail polling, sync, and delete use exact contracts", async () => {
  assert.equal((await harness.worker.fetch("https://production.repo-atlas.test/threads")).status, 303);
  const session = await login(harness.worker);
  const list = await harness.worker.fetch(`${session.origin}/threads?page=1`, {
    headers: { Cookie: session.cookie },
  });
  assert.equal(list.status, 200);
  assert.match(await list.text(), /Threads 게시물 URL/);
  assert.equal((await harness.worker.fetch(`${session.origin}/threads?page=1&page=2`, {
    headers: { Cookie: session.cookie },
  })).status, 400);

  const created = await postForm(harness.worker, "/threads", session, {
    url: "https://www.threads.com/@meta/post/RootShort",
  }, { Accept: "application/json" });
  assert.equal(created.status, 200);
  const result = await created.json();
  assert.deepEqual(Object.keys(result).sort(), ["duplicate", "generation", "status", "threadsPostId"]);
  assert.equal(result.generation, 1);
  assert.equal(result.status, "pending");
  assert.equal(result.duplicate, false);

  const duplicate = await postForm(harness.worker, "/threads", session, {
    url: "https://www.threads.com/@meta/post/RootShort",
  }, { Accept: "application/json" });
  assert.deepEqual(await duplicate.json(), { ...result, duplicate: true });

  const detailUrl = `${session.origin}/threads/${result.threadsPostId}`;
  const detail = await harness.worker.fetch(detailUrl, {
    headers: { Cookie: session.cookie, Accept: "application/json" },
  });
  assert.equal(detail.status, 200);
  const etag = detail.headers.get("etag");
  assert.ok(etag);
  const detailJson = await detail.json();
  assert.deepEqual(Object.keys(detailJson).sort(), [
    "actions", "archive", "replies", "repliesPage", "totalReplies", "totalReplyPages",
  ]);
  assert.deepEqual(detailJson.actions, {
    detail: `/threads/${result.threadsPostId}`,
    sync: `/threads/${result.threadsPostId}/sync`,
    delete: `/threads/${result.threadsPostId}/delete`,
  });
  assert.equal((await harness.worker.fetch(detailUrl, {
    headers: { Cookie: session.cookie, Accept: "application/json", "If-None-Match": etag },
  })).status, 304);
  assert.equal((await harness.worker.fetch(`${detailUrl}?repliesPage=1&unknown=1`, {
    headers: { Cookie: session.cookie },
  })).status, 400);

  await harness.drainCaptureQueue();
  await harness.drainMediaQueue();
  const sync = await postForm(harness.worker, `/threads/${result.threadsPostId}/sync`,
    session, {}, { Accept: "application/json" });
  assert.equal(sync.status, 200);
  assert.equal((await sync.json()).generation, 2);
  const deleted = await postForm(harness.worker, `/threads/${result.threadsPostId}/delete`,
    session, { confirm: "yes" }, { Accept: "application/json" });
  assert.equal(deleted.status, 200);
  assert.deepEqual(Object.keys(await deleted.json()).sort(), ["duplicate", "status", "threadsPostId"]);
});

test("disconnect and every Threads mutation enforce origin, CSRF, duplicate fields, and methods", async () => {
  const env = await harness.worker.getEnv();
  const archive = await seedThreadsArchive(env.PROD_DB, {
    id: "11111111-1111-1111-1111-111111111111",
    rootEntryId: "22222222-2222-2222-2222-222222222222",
    status: "partial", jobStatus: "partial",
  });
  const mediaId = "33333333-3333-3333-3333-333333333333";
  await env.PROD_DB.prepare(
    `INSERT INTO threads_media
      (id, entry_id, source_media_id, kind, ordinal, alt_text, status, r2_key,
       content_type, bytes, etag, error_code, attempt_count, created_at, updated_at)
     VALUES (?, ?, 'root-1', 'image', 0, NULL, 'error', NULL, NULL, NULL, NULL,
       'threads_media_unavailable', 1, 1, 1)`,
  ).bind(mediaId, archive.rootEntryId).run();
  const session = await login(harness.worker);
  const mutations = [
    ["/threads", { url: "https://www.threads.com/@meta/post/MutationPost" }],
    [`/threads/${archive.id}/sync`, {}],
    [`/threads/${archive.id}/media/${mediaId}/retry`, {}],
    [`/threads/${archive.id}/delete`, { confirm: "yes" }],
    ["/threads/disconnect", {}],
  ];
  for (const [path, fields] of mutations) {
    const makeBody = (includeCsrf = true, duplicateCsrf = false) => {
      const body = new FormData();
      if (includeCsrf) body.set("csrf", session.csrf);
      if (duplicateCsrf) body.append("csrf", session.csrf);
      for (const [name, value] of Object.entries(fields)) body.set(name, String(value));
      return body;
    };
    assert.equal((await harness.worker.fetch(`${session.origin}${path}`, {
      method: "POST", headers: { Origin: session.origin }, body: makeBody(),
    })).status, 401);
    assert.equal((await harness.worker.fetch(`${session.origin}${path}`, {
      method: "POST", headers: { Origin: "https://evil.example", Cookie: session.cookie },
      body: makeBody(),
    })).status, 401);
    assert.equal((await harness.worker.fetch(`${session.origin}${path}`, {
      method: "POST", headers: { Origin: session.origin, Cookie: session.cookie },
      body: makeBody(false),
    })).status, 401);
    assert.equal((await harness.worker.fetch(`${session.origin}${path}`, {
      method: "POST", headers: { Origin: session.origin, Cookie: session.cookie },
      body: makeBody(true, true),
    })).status, 400);
    assert.equal((await harness.worker.fetch(`${session.origin}${path}`, {
      method: "PUT", headers: { Cookie: session.cookie },
    })).status, 405);
  }

  const disconnected = await postForm(harness.worker, "/threads/disconnect", session, {}, {
    Accept: "application/json",
  });
  assert.equal(disconnected.status, 200);
  assert.deepEqual(await disconnected.json(), { disconnected: false });
  assert.equal((await postForm(harness.worker, `/threads/${archive.id}/sync`, session, {}, {
    Accept: "application/json",
  })).status, 200);
  assert.equal((await postForm(
    harness.worker, `/threads/${archive.id}/media/${mediaId}/retry`, session, {},
    { Accept: "application/json" },
  )).status, 200);
  assert.equal((await postForm(harness.worker, `/threads/${archive.id}/delete`, session,
    { confirm: "yes" }, { Accept: "application/json" })).status, 200);
});

test("Threads media is authenticated, archive-scoped, range-capable, and retry is scoped", async () => {
  const env = await harness.worker.getEnv();
  const archive = await seedThreadsArchive(env.PROD_DB, {
    id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    rootEntryId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    status: "partial", jobStatus: "partial",
  });
  const mediaId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
  const key = "threads/posts/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/root-1/image-0/11111111-1111-1111-1111-111111111111";
  await env.PROD_DB.prepare(
    `INSERT INTO threads_media
      (id, entry_id, source_media_id, kind, ordinal, alt_text, status, r2_key,
       content_type, bytes, etag, error_code, attempt_count, created_at, updated_at)
     VALUES (?, ?, 'root-1', 'image', 0, NULL, 'ready', ?, 'image/png', 6,
       '"etag-1"', NULL, 1, 1, 1)`,
  ).bind(mediaId, archive.rootEntryId, key).run();
  await harness.mediaBucket.put(key, new Blob(["abcdef"]).stream(), {
    httpMetadata: { contentType: "image/png" },
  });
  const session = await login(harness.worker);
  const path = `/threads/${archive.id}/media/${mediaId}`;
  assert.equal((await harness.worker.fetch(`${session.origin}${path}`)).status, 303);
  assert.equal((await harness.worker.fetch(`${session.origin}${path}`, {
    headers: { Cookie: session.cookie },
  })).status, 200);
  const range = await harness.worker.fetch(`${session.origin}${path}`, {
    headers: { Cookie: session.cookie, Range: "bytes=1-3" },
  });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get("content-range"), "bytes 1-3/6");
  assert.equal(await range.text(), "bcd");
  assert.equal((await harness.worker.fetch(`${session.origin}${path}`, {
    method: "HEAD", headers: { Cookie: session.cookie },
  })).status, 200);
  assert.equal((await harness.worker.fetch(
    `${session.origin}/threads/dddddddd-dddd-dddd-dddd-dddddddddddd/media/${mediaId}`,
    { headers: { Cookie: session.cookie } },
  )).status, 404);

  await env.PROD_DB.prepare(
    "UPDATE threads_media SET status = 'error', r2_key = NULL, content_type = NULL, bytes = NULL, etag = NULL, error_code = 'threads_media_unavailable' WHERE id = ?",
  ).bind(mediaId).run();
  const retried = await postForm(harness.worker, `${path}/retry`, session, {}, {
    Accept: "application/json",
  });
  assert.equal(retried.status, 200);
  assert.deepEqual(await retried.json(), {
    threadsPostId: archive.id, mediaId, status: "queued",
  });
  assert.equal(harness.mediaMessages.at(-1)?.type, "retry-media");
});

test("author profile media fallback is authenticated, scoped, private, and range-capable", async () => {
  const env = await harness.worker.getEnv();
  const postId = "44444444-4444-4444-4444-444444444444";
  await seedThreadsArchive(env.PROD_DB, {
    id: postId, rootEntryId: "55555555-5555-5555-5555-555555555555",
    authorId: "12345", username: "profile-owner", status: "ready", jobStatus: "ready",
  });
  const other = await seedThreadsArchive(env.PROD_DB, {
    id: "66666666-6666-6666-6666-666666666666",
    rootEntryId: "77777777-7777-7777-7777-777777777777",
    shortcode: "OtherProfile", threadsMediaId: "other-profile-root",
    submittedUrl: "https://www.threads.com/@other-owner/post/OtherProfile",
    canonicalUrl: "https://www.threads.com/@other-owner/post/OtherProfile",
    rootPermalink: "https://www.threads.com/@other-owner/post/OtherProfile",
    authorId: "67890", username: "other-owner", status: "ready", jobStatus: "ready",
  });
  const key = "threads/authors/12345/profile/88888888-8888-8888-8888-888888888888";
  await env.PROD_DB.prepare(
    `UPDATE threads_authors SET profile_media_status = 'ready', profile_r2_key = ?,
       profile_content_type = 'image/png', profile_bytes = 6, profile_etag = '"profile-etag"',
       profile_error_code = NULL WHERE threads_user_id = '12345'`,
  ).bind(key).run();
  await harness.mediaBucket.put(key, new Blob(["avatar"]).stream(), {
    httpMetadata: { contentType: "image/png" },
  });
  const session = await login(harness.worker);
  const path = `/threads/${postId}/media/12345`;
  assert.equal((await harness.worker.fetch(`${session.origin}${path}`)).status, 303);
  assert.equal((await harness.worker.fetch(`${session.origin}${path}`, {
    headers: { Accept: "application/json" },
  })).status, 401);

  const full = await harness.worker.fetch(`${session.origin}${path}`, {
    headers: { Cookie: session.cookie },
  });
  assert.equal(full.status, 200);
  assert.equal(await full.text(), "avatar");
  assert.equal(full.headers.get("cache-control"), "private, no-cache");
  assert.equal(full.headers.get("content-disposition"), "inline");
  assert.equal(full.headers.get("accept-ranges"), "bytes");
  assert.equal(full.headers.get("etag"), '"profile-etag"');
  assert.equal(full.headers.get("x-content-type-options"), "nosniff");

  const head = await harness.worker.fetch(`${session.origin}${path}`, {
    method: "HEAD", headers: { Cookie: session.cookie },
  });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), "6");
  const range = await harness.worker.fetch(`${session.origin}${path}`, {
    headers: { Cookie: session.cookie, Range: "bytes=1-3" },
  });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get("content-range"), "bytes 1-3/6");
  assert.equal(await range.text(), "vat");
  const invalid = await harness.worker.fetch(`${session.origin}${path}`, {
    headers: { Cookie: session.cookie, Range: "bytes=0-1,3-4" },
  });
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers.get("content-range"), "bytes */6");
  assert.equal(invalid.headers.get("cache-control"), "private, no-cache");
  assert.equal((await harness.worker.fetch(
    `${session.origin}/threads/${other.id}/media/12345`,
    { headers: { Cookie: session.cookie } },
  )).status, 404);
});

test("Threads mutations reject extra fields and unsupported methods without raw IDs in telemetry", async () => {
  const session = await login(harness.worker);
  /** @type {unknown[]} */
  const logs = [];
  const original = console.log;
  console.log = (value) => { logs.push(value); };
  try {
    const extra = new FormData();
    extra.set("csrf", session.csrf); extra.set("url", "https://threads.net/t/RootShort");
    extra.set("token", "private-token");
    assert.equal((await harness.worker.fetch(`${session.origin}/threads`, {
      method: "POST", headers: { Origin: session.origin, Cookie: session.cookie }, body: extra,
    })).status, 400);
    assert.equal((await harness.worker.fetch(`${session.origin}/threads`, {
      method: "PUT", headers: { Cookie: session.cookie },
    })).status, 405);
    await harness.worker.fetch(`${session.origin}/threads/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa`, {
      headers: { Cookie: session.cookie },
    });
    for (const path of [
      "/threads/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/sync",
      "/threads/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/delete",
      "/threads/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/media/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/retry",
    ]) await harness.worker.fetch(`${session.origin}${path}`, {
      method: "PUT", headers: { Cookie: session.cookie },
    });
  } finally { console.log = original; }
  const serialized = JSON.stringify(logs);
  assert.match(serialized, /\/threads\/:id/);
  assert.match(serialized, /\/threads\/:id\/sync/);
  assert.match(serialized, /\/threads\/:id\/delete/);
  assert.match(serialized, /\/threads\/:id\/media\/:mediaId\/retry/);
  assert.match(serialized, /"threadsStatus":"none"/);
  assert.doesNotMatch(serialized, /aaaaaaaa|private-token|RootShort|oauth|code=|state=|cdninstagram/);
});
