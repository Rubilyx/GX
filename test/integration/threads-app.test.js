import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { login, postForm, seedThreadsArchive, startHarness } from "../support/harness.js";

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
  assert.match(callback.headers.get("set-cookie") ?? "", /Max-Age=0/);

  for (const url of [
    `${session.origin}/threads/oauth/callback?code=code-1&state=wrong`,
    `${session.origin}/threads/oauth/callback?code=code-1&state=${state}&state=${state}`,
  ]) {
    const rejected = await harness.worker.fetch(url, { headers: { Cookie: oauthCookie } });
    assert.equal(rejected.status, 400);
    assert.match(rejected.headers.get("set-cookie") ?? "", /Max-Age=0/);
  }
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
  } finally { console.log = original; }
  const serialized = JSON.stringify(logs);
  assert.match(serialized, /\/threads\/:id/);
  assert.match(serialized, /"threadsStatus":"none"/);
  assert.doesNotMatch(serialized, /aaaaaaaa|private-token|RootShort|oauth|code=|state=|cdninstagram/);
});
