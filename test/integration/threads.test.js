import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { AppError } from "../../src/domain.js";
import {
  beginThreadsOAuth, disconnectThreads, finishThreadsOAuth, getThreadsAccessToken,
  refreshStoredThreadsCredential,
} from "../../src/threads-oauth.js";
import {
  claimThreadsJob, createThreadsSync, finalizeThreadsContent, getThreadsArchive,
  listThreadsArchives, markThreadsJobError, recalculateThreadsStatus,
  saveResolvedThreadsRoot, saveThreadsConversationPage, saveThreadsQuote,
  startThreadsDeletion,
} from "../../src/threads.js";
import { d1NonnegativeInteger, mutationChanges } from "../../src/threads-storage.js";
import {
  providerFixture, seedThreadsArchive, startHarness,
} from "../support/harness.js";

const TOKEN_KEY = "cmVwby1hdGxhcy10aHJlYWRzLXRlc3Qta2V5LTAwMDE=";
const OTHER_TOKEN_KEY = "b3RoZXItYXRsYXMtdGhyZWFkcy10ZXN0LWtleS0wMDE=";
const REDIRECT_URI = "https://app.test/threads/oauth/callback";
const SCOPES = ["threads_basic", "threads_profile_discovery", "threads_read_replies"];

/** @type {Awaited<ReturnType<typeof startHarness>>} */
let harness;
before(async () => { harness = await startHarness(); });
beforeEach(async () => { await harness.reset(); });
after(async () => { await harness.close(); });

/** @param {D1Database} db @param {{ stateByte?: number, tokenByte?: number, expiresAt?: number, fetcher?: typeof fetch }} [options] */
async function connect(db, options = {}) {
  const started = await beginThreadsOAuth({
    appId: "test-threads-app", redirectUri: REDIRECT_URI, sessionNonce: "pin-session",
    tokenKey: TOKEN_KEY, nowSeconds: 1_000,
    randomBytes: (length) => new Uint8Array(length).fill(options.stateByte ?? 7),
  });
  const state = new URL(started.location).searchParams.get("state");
  const cookieHeader = started.setCookie.split(";", 1)[0];
  const fetcher = options.fetcher ?? providerFixture({ threadsDebug: {
    app_id: "test-threads-app", user_id: "author-1", is_valid: true,
    expires_at: options.expiresAt ?? 5_185_001, scopes: SCOPES,
  } });
  return finishThreadsOAuth(db, {
    appId: "test-threads-app", appSecret: "test-threads-secret",
    redirectUri: REDIRECT_URI, callbackUrl: `${REDIRECT_URI}?code=code-1&state=${state}`,
    cookieHeader, tokenKey: TOKEN_KEY, nowSeconds: 1_001, fetcher,
    randomBytes: (length) => new Uint8Array(length).fill(options.tokenByte ?? 8),
  });
}

const isReconnect = (/** @type {unknown} */ error) =>
  error instanceof AppError && error.code === "threads_reconnect_required" && error.status === 401;

test("0004 creates the normalized Threads archive schema", async () => {
  const env = await harness.worker.getEnv();
  const tables = await env.PROD_DB.prepare(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'threads_%' ORDER BY name",
  ).all();
  assert.deepEqual(tables.results.map(/** @param {Record<string, unknown>} row */ (row) => String(row.name)), [
    "threads_authors", "threads_entries", "threads_links", "threads_media",
    "threads_oauth_credentials", "threads_posts", "threads_sync_jobs",
  ]);
  const indexes = await env.PROD_DB.prepare(
    "SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'threads_entries' ORDER BY name",
  ).all();
  assert.ok(indexes.results.some(/** @param {Record<string, unknown>} row */ (row) => row.name === "threads_entries_primary_source_idx"));
  assert.ok(indexes.results.some(/** @param {Record<string, unknown>} row */ (row) => row.name === "threads_entries_quote_source_idx"));
  for (const table of ["threads_entries", "threads_media", "threads_links", "threads_sync_jobs"]) {
    const foreignKeys = await env.PROD_DB.prepare(`PRAGMA foreign_key_list(${table})`).all();
    assert.ok(foreignKeys.results.some(/** @param {Record<string, unknown>} row */ (row) => row.on_delete === "CASCADE"), table);
  }
});

test("Threads entries enforce identity, quote parents, cascades, and OAuth singleton", async () => {
  const env = await harness.worker.getEnv();
  const db = env.PROD_DB;
  await db.prepare("INSERT INTO threads_authors (threads_user_id, username, display_name) VALUES ('author', 'author', 'Author'), ('reply', 'reply', 'Reply')").run();
  await db.prepare("INSERT INTO threads_posts (id, shortcode, submitted_url, status, root_author_id) VALUES ('post', 'short', 'https://www.threads.net/t/short', 'ready', 'author')").run();
  /** @param {string} id @param {string} source @param {'root' | 'author_reply' | 'quote'} kind @param {string | null} [parent] @param {string} [author] @param {string} [post] */
  const entry = (id, source, kind, parent = null, author = "author", post = "post") => db.prepare(
    `INSERT INTO threads_entries (id, threads_post_id, source_media_id, kind, parent_entry_id, author_id, text, published_at, media_type, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, '', '2026-08-24T00:00:00Z', 'TEXT_POST', 1, 1)`,
  ).bind(id, post, source, kind, parent, author).run();
  await entry("root", "root-media", "root");
  await entry("reply-a", "reply-a-media", "author_reply", null, "reply");
  await entry("reply-b", "reply-b-media", "author_reply", null, "reply");
  await entry("quote-a", "quote-media", "quote", "reply-a", "reply");
  await entry("quote-b", "quote-media", "quote", "reply-b", "reply");
  await assert.rejects(entry("quote-duplicate", "quote-media", "quote", "reply-a", "reply"));
  await db.prepare("INSERT INTO threads_posts (id, shortcode, submitted_url, status, root_author_id) VALUES ('post-2', 'short-2', 'https://www.threads.net/t/short-2', 'ready', 'author')").run();
  await assert.rejects(entry("cross-post-quote", "quote-media-2", "quote", "reply-a", "reply", "post-2"));
  await db.prepare("UPDATE threads_entries SET threads_post_id = 'post-2' WHERE id = 'quote-a'").run().then(
    () => assert.fail("cross-post update unexpectedly succeeded"),
    () => undefined,
  );
  await db.prepare("UPDATE threads_entries SET threads_post_id = 'post-2' WHERE id = 'reply-a'").run().then(
    () => assert.fail("referenced parent move unexpectedly succeeded"),
    () => undefined,
  );
  await db.prepare("UPDATE threads_entries SET kind = 'quote', parent_entry_id = 'root' WHERE id = 'reply-b'").run().then(
    () => assert.fail("referenced parent kind change unexpectedly succeeded"),
    () => undefined,
  );
  await assert.rejects(entry("nested-quote", "nested-media", "quote", "quote-a", "reply"));
  await db.prepare("UPDATE threads_entries SET parent_entry_id = 'quote-a' WHERE id = 'quote-b'").run().then(
    () => assert.fail("nested-quote update unexpectedly succeeded"),
    () => undefined,
  );
  await db.prepare("INSERT INTO threads_links (id, entry_id, url, source, ordinal) VALUES ('link', 'root', 'https://example.com', 'body', 0)").run();
  await db.prepare("INSERT INTO threads_media (id, entry_id, source_media_id, kind, ordinal) VALUES ('media', 'root', 'root-media', 'image', 0)").run();
  await db.prepare("INSERT INTO threads_sync_jobs (id, threads_post_id, generation, status, queued_at, updated_at) VALUES ('job', 'post', 1, 'queued', 1, 1)").run();
  await db.prepare("DELETE FROM threads_posts WHERE id = 'post'").run();
  for (const table of ["threads_entries", "threads_links", "threads_media", "threads_sync_jobs"]) {
    assert.equal(await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first("count"), 0, table);
  }
  await db.prepare("INSERT INTO threads_oauth_credentials (singleton_id, provider_user_id, encrypted_access_token, token_nonce, scopes_json, expires_at, refreshed_at, updated_at) VALUES (1, 'u', 'token', 'nonce', '[]', 1, 1, 1)").run();
  await assert.rejects(db.prepare("INSERT INTO threads_oauth_credentials (singleton_id, provider_user_id, encrypted_access_token, token_nonce, scopes_json, expires_at, refreshed_at, updated_at) VALUES (2, 'u', 'token', 'nonce', '[]', 1, 1, 1)").run());
});

test("Threads OAuth credential callback stores ciphertext and decrypts only with its configured key", async () => {
  const env = await harness.worker.getEnv();
  const db = env.PROD_DB;
  assert.deepEqual(await connect(db), { providerUserId: "author-1", scopes: SCOPES,
    setCookie: "__Host-threads_oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0" });
  const first = await db.prepare("SELECT * FROM threads_oauth_credentials WHERE singleton_id = 1").first();
  assert.ok(first);
  assert.equal(first.provider_user_id, "author-1");
  assert.equal(first.scopes_json, JSON.stringify(SCOPES));
  assert.equal(first.expires_at, 5_185_001);
  assert.equal(first.refreshed_at, 1_001);
  assert.equal(first.updated_at, 1_001);
  assert.notEqual(first.encrypted_access_token, "long-token");
  assert.notEqual(first.token_nonce, "long-token");
  assert.doesNotMatch(JSON.stringify(first), /short-token|long-token/);
  assert.deepEqual(await getThreadsAccessToken(db, {
    appId: "test-threads-app", tokenKey: TOKEN_KEY, nowSeconds: 1_001,
    fetcher: async () => assert.fail("far-future credential must not refresh"),
    randomBytes: crypto.getRandomValues.bind(crypto),
  }), { accessToken: "long-token", providerUserId: "author-1", expiresAt: 5_185_001, scopes: SCOPES });
  await assert.rejects(getThreadsAccessToken(db, {
    appId: "test-threads-app", tokenKey: OTHER_TOKEN_KEY, nowSeconds: 1_001,
    fetcher: async () => assert.fail("far-future credential must not refresh"),
    randomBytes: crypto.getRandomValues.bind(crypto),
  }), isReconnect);

  await connect(db, { stateByte: 9, tokenByte: 10 });
  const second = await db.prepare("SELECT * FROM threads_oauth_credentials WHERE singleton_id = 1").first();
  assert.ok(second);
  assert.notEqual(second.token_nonce, first.token_nonce);
  assert.notEqual(second.encrypted_access_token, first.encrypted_access_token);
  assert.equal((await getThreadsAccessToken(db, {
    appId: "test-threads-app", tokenKey: TOKEN_KEY, nowSeconds: 1_001,
    fetcher: async () => assert.fail("far-future credential must not refresh"),
    randomBytes: crypto.getRandomValues.bind(crypto),
  })).accessToken, "long-token");
});

test("Threads OAuth credential accepts an exact 256-byte UTF-8 token", async () => {
  const env = await harness.worker.getEnv();
  const accessToken = "é".repeat(128);
  const base = providerFixture();
  const fetcher = async (/** @type {RequestInfo | URL} */ input, /** @type {RequestInit} */ init = {}) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === "/v1.0/access_token")
      return Response.json({ access_token: accessToken, token_type: "bearer", expires_in: 5_184_000 });
    if (url.pathname === "/v1.0/debug_token")
      return Response.json({ data: { app_id: "test-threads-app", user_id: "author-1", is_valid: true, expires_at: 5_185_001, scopes: SCOPES } });
    return base(request);
  };
  await connect(env.PROD_DB, { fetcher });
  assert.equal((await getThreadsAccessToken(env.PROD_DB, {
    appId: "test-threads-app", tokenKey: TOKEN_KEY, nowSeconds: 1_001,
    fetcher: async () => assert.fail("far-future credential must not refresh"),
    randomBytes: crypto.getRandomValues.bind(crypto),
  })).accessToken, accessToken);
});

test("Threads OAuth credential rejects multibyte tokens above 256 UTF-8 bytes before D1 write", async () => {
  const env = await harness.worker.getEnv();
  for (const accessToken of ["é".repeat(129), "가".repeat(256)]) {
    const base = providerFixture();
    const fetcher = async (/** @type {RequestInfo | URL} */ input, /** @type {RequestInit} */ init = {}) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === "/v1.0/access_token")
        return Response.json({ access_token: accessToken, token_type: "bearer", expires_in: 5_184_000 });
      if (url.pathname === "/v1.0/debug_token")
        return Response.json({ data: { app_id: "test-threads-app", user_id: "author-1", is_valid: true, expires_at: 5_185_001, scopes: SCOPES } });
      return base(request);
    };
    await assert.rejects(connect(env.PROD_DB, { fetcher }), isReconnect);
    assert.equal(await env.PROD_DB.prepare(
      "SELECT COUNT(*) AS count FROM threads_oauth_credentials",
    ).first("count"), 0);
  }
});

test("Threads OAuth credential rejects legacy plaintext above 256 UTF-8 bytes after decryption", async () => {
  const env = await harness.worker.getEnv();
  const db = env.PROD_DB;
  await connect(db);
  const encoder = new TextEncoder();
  const material = await crypto.subtle.importKey(
    "raw", Buffer.from(TOKEN_KEY, "base64"), "HKDF", false, ["deriveBits"],
  );
  const keyBytes = await crypto.subtle.deriveBits({
    name: "HKDF", hash: "SHA-256", salt: encoder.encode("repo-atlas-threads-v1"),
    info: encoder.encode("token-aes-v1"),
  }, material, 256);
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const nonce = new Uint8Array(12).fill(11);
  const ciphertext = await crypto.subtle.encrypt({
    name: "AES-GCM", iv: nonce, additionalData: encoder.encode("threads-access-token-v1"),
  }, key, encoder.encode("é".repeat(129)));
  await db.prepare(
    "UPDATE threads_oauth_credentials SET encrypted_access_token = ?, token_nonce = ? WHERE singleton_id = 1",
  ).bind(Buffer.from(ciphertext).toString("base64url"), Buffer.from(nonce).toString("base64url")).run();
  await assert.rejects(getThreadsAccessToken(db, {
    appId: "test-threads-app", tokenKey: TOKEN_KEY, nowSeconds: 1_001,
    fetcher: async () => assert.fail("far-future credential must not refresh"),
    randomBytes: crypto.getRandomValues.bind(crypto),
  }), isReconnect);
});

test("Threads OAuth credential callback rejects debugger scope and identity mismatches without writing", async () => {
  const env = await harness.worker.getEnv();
  const valid = { app_id: "test-threads-app", user_id: "author-1", is_valid: true,
    expires_at: 5_185_001, scopes: SCOPES };
  for (const threadsDebug of [
    { ...valid, app_id: "wrong-app" }, { ...valid, user_id: "wrong-user" },
    { ...valid, is_valid: false }, { ...valid, scopes: SCOPES.slice(0, 2) },
    { ...valid, scopes: [...SCOPES].reverse() }, { ...valid, scopes: [...SCOPES, "extra"] },
  ]) {
    await assert.rejects(connect(env.PROD_DB, { fetcher: providerFixture({ threadsDebug }) }), isReconnect);
    assert.equal(await env.PROD_DB.prepare("SELECT COUNT(*) AS count FROM threads_oauth_credentials").first("count"), 0);
  }
});

test("credential refresh runs only inside the unexpired seven-day window and atomically rotates ciphertext", async () => {
  const env = await harness.worker.getEnv();
  const db = env.PROD_DB;
  await connect(db, { expiresAt: 605_801, tokenByte: 3 });
  const before = await db.prepare("SELECT * FROM threads_oauth_credentials WHERE singleton_id = 1").first();
  /** @type {Array<{ method: string, path: string }>} */
  const calls = [];
  const refreshed = await refreshStoredThreadsCredential(db, {
    appId: "test-threads-app", tokenKey: TOKEN_KEY, nowSeconds: 1_001,
    fetcher: providerFixture({ calls, threadsDebug: {
      app_id: "test-threads-app", user_id: "author-1", is_valid: true,
      expires_at: 6_000_000, scopes: SCOPES,
    } }),
    randomBytes: (length) => new Uint8Array(length).fill(4),
  });
  assert.deepEqual(refreshed, { refreshed: true, reconnectRequired: false });
  const afterRefresh = await db.prepare("SELECT * FROM threads_oauth_credentials WHERE singleton_id = 1").first();
  assert.ok(before && afterRefresh);
  assert.notEqual(afterRefresh.token_nonce, before.token_nonce);
  assert.notEqual(afterRefresh.encrypted_access_token, before.encrypted_access_token);
  assert.equal(afterRefresh.expires_at, 6_000_000);
  assert.equal(afterRefresh.refreshed_at, 1_001);
  assert.equal(afterRefresh.updated_at, 1_001);
  assert.equal(calls.length, 2);
  assert.equal((await getThreadsAccessToken(db, {
    appId: "test-threads-app", tokenKey: TOKEN_KEY, nowSeconds: 1_001,
    fetcher: async () => assert.fail("new credential must not refresh"),
    randomBytes: crypto.getRandomValues.bind(crypto),
  })).accessToken, "refreshed-token");

  await harness.reset();
  const freshEnv = await harness.worker.getEnv();
  await connect(freshEnv.PROD_DB, { expiresAt: 605_802 });
  assert.deepEqual(await refreshStoredThreadsCredential(freshEnv.PROD_DB, {
    appId: "test-threads-app", tokenKey: TOKEN_KEY, nowSeconds: 1_001,
    fetcher: async () => assert.fail("credential outside seven days must not refresh"),
    randomBytes: crypto.getRandomValues.bind(crypto),
  }), { refreshed: false, reconnectRequired: false });
});

test("credential refresh rejects debugger mismatches without rotating stored bytes", async () => {
  const env = await harness.worker.getEnv();
  const db = env.PROD_DB;
  await connect(db, { expiresAt: 605_801, tokenByte: 3 });
  const before = await db.prepare("SELECT * FROM threads_oauth_credentials WHERE singleton_id = 1").first();
  assert.deepEqual(await refreshStoredThreadsCredential(db, {
    appId: "test-threads-app", tokenKey: TOKEN_KEY, nowSeconds: 1_001,
    fetcher: providerFixture({ threadsDebug: {
      app_id: "test-threads-app", user_id: "author-1", is_valid: true,
      expires_at: 6_000_000, scopes: SCOPES.slice(0, 2),
    } }),
    randomBytes: (length) => new Uint8Array(length).fill(4),
  }), { refreshed: false, reconnectRequired: true });
  assert.deepEqual(
    await db.prepare("SELECT * FROM threads_oauth_credentials WHERE singleton_id = 1").first(),
    before,
  );
});

test("credential refresh rejects an oversized UTF-8 token before debugger and D1 rotation", async () => {
  const env = await harness.worker.getEnv();
  const db = env.PROD_DB;
  await connect(db, { expiresAt: 605_801, tokenByte: 3 });
  const before = await db.prepare("SELECT * FROM threads_oauth_credentials WHERE singleton_id = 1").first();
  const base = providerFixture();
  let debugCalls = 0;
  const fetcher = async (/** @type {RequestInfo | URL} */ input, /** @type {RequestInit} */ init = {}) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === "/v1.0/refresh_access_token")
      return Response.json({ access_token: "é".repeat(129), token_type: "bearer", expires_in: 5_184_000 });
    if (url.pathname === "/v1.0/debug_token") {
      debugCalls += 1;
      return Response.json({ data: {} });
    }
    return base(request);
  };
  assert.deepEqual(await refreshStoredThreadsCredential(db, {
    appId: "test-threads-app", tokenKey: TOKEN_KEY, nowSeconds: 1_001,
    fetcher, randomBytes: (length) => new Uint8Array(length).fill(4),
  }), { refreshed: false, reconnectRequired: true });
  assert.equal(debugCalls, 0);
  assert.deepEqual(
    await db.prepare("SELECT * FROM threads_oauth_credentials WHERE singleton_id = 1").first(),
    before,
  );
});

test("expired or malformed credentials require reconnect without provider calls", async () => {
  const env = await harness.worker.getEnv();
  const db = env.PROD_DB;
  await connect(db);
  await db.prepare("UPDATE threads_oauth_credentials SET expires_at = 1000 WHERE singleton_id = 1").run();
  let calls = 0;
  const input = {
    appId: "test-threads-app", tokenKey: TOKEN_KEY, nowSeconds: 1_001,
    fetcher: async () => { calls += 1; return new Response(); },
    randomBytes: crypto.getRandomValues.bind(crypto),
  };
  assert.deepEqual(await refreshStoredThreadsCredential(db, input), { refreshed: false, reconnectRequired: true });
  await assert.rejects(getThreadsAccessToken(db, input), isReconnect);
  assert.equal(calls, 0);

  await db.prepare("UPDATE threads_oauth_credentials SET expires_at = 6000000, encrypted_access_token = 'corrupt', scopes_json = '[\"threads_basic\"]' WHERE singleton_id = 1").run();
  assert.deepEqual(await refreshStoredThreadsCredential(db, input), { refreshed: false, reconnectRequired: true });
  await assert.rejects(getThreadsAccessToken(db, input), isReconnect);
  assert.equal(calls, 0);
});

test("credential disconnect deletes only the singleton and retains Threads archives", async () => {
  const env = await harness.worker.getEnv();
  const db = env.PROD_DB;
  await db.prepare("INSERT INTO threads_authors (threads_user_id, username, display_name) VALUES ('author-1', 'meta', 'Meta')").run();
  await db.prepare("INSERT INTO threads_posts (id, shortcode, submitted_url, status, root_author_id) VALUES ('post-1', 'short', 'https://www.threads.net/t/short', 'ready', 'author-1')").run();
  await connect(db);
  assert.equal(await disconnectThreads(db), true);
  assert.equal(await disconnectThreads(db), false);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM threads_posts").first("count"), 1);
});

/** @param {string} [id] @param {string} [username] */
const profile = (id = "author-1", username = "meta") => ({
  id, username, name: username === "meta" ? "Meta" : username, profilePictureUrl:
    `https://scontent.cdninstagram.com/${id}-avatar`,
});
/** @param {string} id @param {string} [ownerId] @param {Record<string, unknown>} [overrides] */
const media = (id, ownerId = "author-1", overrides = {}) => ({
  id, ownerId, username: ownerId === "author-1" ? "meta" : "other",
  text: `Text ${id}`, permalink: `https://www.threads.com/@meta/post/${id}`,
  timestamp: `2026-08-24T00:${String(Number(/\d+$/.exec(id)?.[0] ?? 0) % 60).padStart(2, "0")}:00Z`,
  mediaType: "TEXT_POST", mediaUrl: null, thumbnailUrl: null, children: [],
  quotedPostId: null, linkAttachmentUrl: null, altText: null,
  rootPostId: "root-1", repliedToId: "root-1", ...overrides,
});

test("Threads sync creates one active generation, advances completed captures, and records enqueue failure", async () => {
  const db = (await harness.worker.getEnv()).PROD_DB;
  const first = await createThreadsSync(
    db, harness.captureQueue, "https://www.threads.com/@meta/post/RootShort", 1_000,
  );
  assert.deepEqual(first, {
    threadsPostId: first.threadsPostId, generation: 1, duplicate: false, status: "pending",
  });
  assert.deepEqual(harness.captureMessages, [{
    version: 1, type: "resolve-post", postId: first.threadsPostId, generation: 1, cursor: null,
  }]);
  assert.deepEqual(await createThreadsSync(
    db, harness.captureQueue, "https://threads.net/t/RootShort", 1_001,
  ), { ...first, duplicate: true });
  assert.equal(harness.captureMessages.length, 1);

  await db.prepare(
    "UPDATE threads_sync_jobs SET status = 'ready' WHERE threads_post_id = ? AND generation = 1",
  ).bind(first.threadsPostId).run();
  const second = await createThreadsSync(
    db, harness.captureQueue, "https://threads.net/t/RootShort", 1_002,
  );
  assert.deepEqual(second, {
    threadsPostId: first.threadsPostId, generation: 2, duplicate: false, status: "pending",
  });

  await harness.setQueueMode({ captureReject: true });
  await assert.rejects(
    createThreadsSync(db, harness.captureQueue, "https://threads.net/t/QueueFail", 1_003),
    (error) => error instanceof AppError && error.code === "queue_unavailable" && error.status === 503,
  );
  assert.deepEqual(await db.prepare(
    "SELECT p.status, p.error_code, j.status AS job_status, j.error_code AS job_error " +
    "FROM threads_posts p JOIN threads_sync_jobs j ON j.threads_post_id = p.id " +
    "WHERE p.shortcode = 'QueueFail'",
  ).first(), { status: "error", error_code: "queue_unavailable",
    job_status: "error", job_error: "queue_unavailable" });
});

test("immutable Threads writes add unseen author replies and scope repeated quotes by parent", async () => {
  const db = (await harness.worker.getEnv()).PROD_DB;
  const sync = await createThreadsSync(
    db, harness.captureQueue, "https://www.threads.com/@meta/post/RootShort", 2_000,
  );
  assert.ok(await claimThreadsJob(db, sync.threadsPostId, 1, "resolving"));
  const root = media("root-1", "author-1", {
    text: "Original archived text", rootPostId: null, repliedToId: null,
    mediaType: "IMAGE", mediaUrl: "https://scontent.cdninstagram.com/root-image",
    linkAttachmentUrl: "https://example.com/root",
  });
  assert.equal(await saveResolvedThreadsRoot(db, {
    postId: sync.threadsPostId, generation: 1, profile: profile(), root,
    profileCursor: null, conversationCursor: null, nowSeconds: 2_001,
  }), true);
  assert.deepEqual(await saveThreadsConversationPage(db, {
    postId: sync.threadsPostId, generation: 1, entries: [
      media("reply-1"), media("other-1", "author-2"),
    ], nextCursor: null, nowSeconds: 2_002,
  }), { accepted: 1, nextCursor: null });
  const replyId = await db.prepare(
    "SELECT id FROM threads_entries WHERE threads_post_id = ? AND source_media_id = 'reply-1'",
  ).bind(sync.threadsPostId).first("id");
  assert.equal(typeof replyId, "string");
  if (typeof replyId !== "string") throw new Error("test_reply_id_missing");
  await saveThreadsQuote(db, {
    postId: sync.threadsPostId, generation: 1, parentEntryId: replyId,
    profile: profile("quoted-author", "quoted"), quote: media("quote-1", "quoted-author", {
      username: "quoted", rootPostId: null, repliedToId: null,
    }), nowSeconds: 2_003,
  });
  await saveThreadsConversationPage(db, {
    postId: sync.threadsPostId, generation: 1, entries: [media("reply-2")],
    nextCursor: null, nowSeconds: 2_004,
  });
  const reply2Id = await db.prepare(
    "SELECT id FROM threads_entries WHERE threads_post_id = ? AND source_media_id = 'reply-2'",
  ).bind(sync.threadsPostId).first("id");
  if (typeof reply2Id !== "string") throw new Error("test_reply_id_missing");
  await saveThreadsQuote(db, {
    postId: sync.threadsPostId, generation: 1, parentEntryId: reply2Id,
    profile: profile("quoted-author", "quoted"), quote: media("quote-1", "quoted-author", {
      username: "quoted", rootPostId: null, repliedToId: null,
    }), nowSeconds: 2_005,
  });
  await saveResolvedThreadsRoot(db, {
    postId: sync.threadsPostId, generation: 1, profile: profile(),
    root: { ...root, text: "Provider edit must not overwrite" },
    profileCursor: null, conversationCursor: null, nowSeconds: 2_006,
  });
  assert.deepEqual(await db.prepare(
    `SELECT text, last_seen_at FROM threads_entries
     WHERE threads_post_id = ? AND kind = 'root'`,
  ).bind(sync.threadsPostId).first(), {
    text: "Original archived text", last_seen_at: 2_006,
  });
  assert.equal(await db.prepare(
    "SELECT COUNT(*) AS count FROM threads_entries WHERE threads_post_id = ? AND kind = 'author_reply'",
  ).bind(sync.threadsPostId).first("count"), 2);
  assert.equal(await db.prepare(
    "SELECT COUNT(*) AS count FROM threads_entries WHERE threads_post_id = ? AND kind = 'quote'",
  ).bind(sync.threadsPostId).first("count"), 2);
  await db.prepare(
    "UPDATE threads_sync_jobs SET pending_quote_count = 1 WHERE threads_post_id = ? AND generation = 1",
  ).bind(sync.threadsPostId).run();
  assert.equal(await saveThreadsQuote(db, {
    postId: sync.threadsPostId, generation: 1, parentEntryId: "missing-parent",
    profile: profile("quoted-author", "quoted"), quote: media("missing-parent-quote", "quoted-author", {
      username: "quoted", rootPostId: null, repliedToId: null,
    }), nowSeconds: 2_007,
  }), false);
  assert.equal(await db.prepare(
    "SELECT pending_quote_count FROM threads_sync_jobs WHERE threads_post_id = ? AND generation = 1",
  ).bind(sync.threadsPostId).first("pending_quote_count"), 1);
});

test("Threads archive reads clamp ten-card pages and paginate twenty chronological replies", async () => {
  const db = (await harness.worker.getEnv()).PROD_DB;
  for (let index = 0; index < 12; index += 1) {
    const suffix = String(index).padStart(2, "0");
    await seedThreadsArchive(db, {
      id: `post-${suffix}`, shortcode: `Short${suffix}`, threadsMediaId: `root-${suffix}`,
      submittedUrl: `https://threads.net/t/Short${suffix}`,
      canonicalUrl: `https://www.threads.com/@user${suffix}/post/Short${suffix}`,
      authorId: `author-${suffix}`, username: `user${suffix}`, displayName: `User ${suffix}`,
      rootEntryId: `root-entry-${suffix}`, rootText: `Root ${suffix}`,
      rootPermalink: `https://www.threads.com/@user${suffix}/post/Short${suffix}`,
      createdAt: index + 1, updatedAt: index + 1,
    });
  }
  const firstPage = await listThreadsArchives(db, { page: 1 });
  assert.equal(firstPage.archives.length, 10);
  assert.deepEqual(firstPage.archives.map((archive) => archive.id),
    ["post-11", "post-10", "post-09", "post-08", "post-07", "post-06",
      "post-05", "post-04", "post-03", "post-02"]);
  assert.deepEqual({ page: firstPage.page, totalPages: firstPage.totalPages, total: firstPage.total },
    { page: 1, totalPages: 2, total: 12 });
  assert.deepEqual((await listThreadsArchives(db, { page: 99 })).archives.map((archive) => archive.id),
    ["post-01", "post-00"]);

  const entries = Array.from({ length: 21 }, (_, index) => media(`reply-${index + 1}`, "author-11", {
    username: "user11", timestamp: `2026-08-24T00:${String(index).padStart(2, "0")}:00Z`,
  }));
  await db.prepare(
    "UPDATE threads_sync_jobs SET status = 'collecting' WHERE threads_post_id = 'post-11'",
  ).run();
  await saveThreadsConversationPage(db, {
    postId: "post-11", generation: 1, entries, nextCursor: null, nowSeconds: 100,
  });
  const detail = await getThreadsArchive(db, "post-11", { repliesPage: 2 });
  assert.ok(detail);
  assert.equal(detail.replies.length, 1);
  assert.equal(detail.replies[0].sourceMediaId, "reply-21");
  assert.deepEqual({ page: detail.repliesPage, pages: detail.totalReplyPages, total: detail.totalReplies },
    { page: 2, pages: 2, total: 21 });
});

test("Threads finalization is idempotent, stale generations cannot advance status, and deletion keeps rows", async () => {
  const db = (await harness.worker.getEnv()).PROD_DB;
  const sync = await createThreadsSync(
    db, harness.captureQueue, "https://www.threads.com/@meta/post/RootShort", 3_000,
  );
  await claimThreadsJob(db, sync.threadsPostId, 1, "resolving");
  const root = media("root-1", "author-1", {
    rootPostId: null, repliedToId: null, mediaType: "IMAGE",
    mediaUrl: "https://scontent.cdninstagram.com/root-image", altText: "root alt",
  });
  await saveResolvedThreadsRoot(db, {
    postId: sync.threadsPostId, generation: 1, profile: profile(), root,
    profileCursor: null, conversationCursor: null, nowSeconds: 3_001,
  });
  const rootEntryId = await db.prepare(
    "SELECT id FROM threads_entries WHERE threads_post_id = ? AND kind = 'root'",
  ).bind(sync.threadsPostId).first("id");
  const finalizeInput = {
    postId: sync.threadsPostId, generation: 1, nowSeconds: 3_002,
    media: [{ entryId: rootEntryId, sourceMediaId: "root-1", kind: "image",
      ordinal: 0, altText: "root alt", sourceUrl: root.mediaUrl }],
    profiles: [{ authorId: "author-1", sourceUrl: profile().profilePictureUrl }],
  };
  assert.equal((await finalizeThreadsContent(db, harness.mediaQueue, finalizeInput)).status, "media_pending");
  assert.equal(harness.mediaMessages.length, 2);
  await finalizeThreadsContent(db, harness.mediaQueue, finalizeInput);
  assert.equal(harness.mediaMessages.length, 2);
  const storedMedia = await db.prepare("SELECT id, alt_text FROM threads_media").first();
  assert.equal(storedMedia?.alt_text, "root alt");
  await db.prepare(
    "UPDATE threads_media SET status = 'ready', r2_key = 'key', bytes = 4, etag = 'etag' WHERE id = ?",
  ).bind(storedMedia?.id).run();
  await db.prepare(
    "UPDATE threads_authors SET profile_media_status = 'ready', profile_r2_key = 'profile-key' WHERE threads_user_id = 'author-1'",
  ).run();
  assert.equal((await recalculateThreadsStatus(db, {
    postId: sync.threadsPostId, generation: 1, nowSeconds: 3_003,
  })).status, "ready");
  const next = await createThreadsSync(
    db, harness.captureQueue, "https://threads.net/t/RootShort", 3_004,
  );
  assert.equal(next.generation, 2);
  await markThreadsJobError(db, {
    postId: sync.threadsPostId, generation: 1, errorCode: "threads_post_unavailable",
    nowSeconds: 3_005,
  });
  assert.equal(await db.prepare("SELECT status FROM threads_posts WHERE id = ?")
    .bind(sync.threadsPostId).first("status"), "pending");
  await markThreadsJobError(db, {
    postId: sync.threadsPostId, generation: 2, errorCode: "threads_post_unavailable",
    nowSeconds: 3_006,
  });
  assert.equal(await db.prepare("SELECT status FROM threads_posts WHERE id = ?")
    .bind(sync.threadsPostId).first("status"), "partial");
  assert.equal(await db.prepare("SELECT text FROM threads_entries WHERE id = ?")
    .bind(rootEntryId).first("text"), "Text root-1");

  await seedThreadsArchive(db, {
    id: "delete-queue-failure", shortcode: "DeleteQueueFailure",
    threadsMediaId: "delete-root", submittedUrl: "https://threads.net/t/DeleteQueueFailure",
    canonicalUrl: "https://www.threads.com/@delete/post/DeleteQueueFailure",
    authorId: "delete-author", username: "delete", displayName: "Delete",
    rootEntryId: "delete-root-entry", rootText: "Retain me",
    rootPermalink: "https://www.threads.com/@delete/post/DeleteQueueFailure",
    createdAt: 9, updatedAt: 9,
  });
  await harness.setQueueMode({ captureReject: true });
  await assert.rejects(
    startThreadsDeletion(db, harness.captureQueue, "delete-queue-failure", 3_007),
    (error) => error instanceof AppError && error.code === "queue_unavailable",
  );
  assert.deepEqual(await db.prepare(
    "SELECT status, error_code FROM threads_posts WHERE id = 'delete-queue-failure'",
  ).first(), { status: "deleting", error_code: "queue_unavailable" });
  assert.equal(await db.prepare(
    "SELECT COUNT(*) AS count FROM threads_entries WHERE threads_post_id = 'delete-queue-failure'",
  ).first("count"), 1);
  await harness.setQueueMode({});

  assert.deepEqual(await startThreadsDeletion(db, harness.captureQueue, sync.threadsPostId, 3_008),
    { threadsPostId: sync.threadsPostId, status: "deleting", duplicate: false });
  assert.deepEqual(harness.captureMessages.at(-1), {
    version: 1, type: "delete-archive", postId: sync.threadsPostId,
  });
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM threads_entries WHERE threads_post_id = ?")
    .bind(sync.threadsPostId).first("count"), 1);
  await assert.rejects(
    createThreadsSync(db, harness.captureQueue, "https://threads.net/t/RootShort", 3_009),
    (error) => error instanceof AppError && error.code === "threads_archive_deleting",
  );
});

/** @param {D1Database} db @param {string} id @param {number} createdAt */
async function seedCollisionCandidate(db, id, createdAt) {
  return seedThreadsArchive(db, {
    id, shortcode: `${id}Short`, threadsMediaId: null,
    submittedUrl: `https://threads.net/t/${id}Short`, canonicalUrl: null,
    status: "collecting", authorId: `${id}-seed-author`, username: id,
    displayName: id, rootEntryId: `${id}-unused-root`, withRoot: false,
    jobStatus: "resolving", createdAt, updatedAt: createdAt,
  });
}

const collisionRoot = () => media("provider-shared-root", "provider-owner", {
  username: "provider", rootPostId: null, repliedToId: null,
  permalink: "https://www.threads.com/@provider/post/SharedRoot",
});

test("Threads review deterministically reassigns a provider ID when the newer row resolves first", async () => {
  const db = (await harness.worker.getEnv()).PROD_DB;
  await seedCollisionCandidate(db, "older-local", 10);
  await seedCollisionCandidate(db, "newer-local", 20);
  assert.equal(await saveResolvedThreadsRoot(db, {
    postId: "newer-local", generation: 1, profile: profile("provider-owner", "provider"),
    root: collisionRoot(), profileCursor: null, conversationCursor: null, nowSeconds: 21,
  }), true);
  assert.equal(await saveResolvedThreadsRoot(db, {
    postId: "older-local", generation: 1, profile: profile("provider-owner", "provider"),
    root: collisionRoot(), profileCursor: null, conversationCursor: null, nowSeconds: 22,
  }), true);
  assert.deepEqual(await db.prepare(
    `SELECT id, threads_media_id, status, error_code FROM threads_posts
     WHERE id IN ('older-local','newer-local') ORDER BY id`,
  ).all().then((result) => result.results), [
    { id: "newer-local", threads_media_id: null, status: "error",
      error_code: "threads_archive_duplicate" },
    { id: "older-local", threads_media_id: "provider-shared-root", status: "collecting",
      error_code: null },
  ]);
  assert.deepEqual(await db.prepare(
    `SELECT p.id, j.status, j.error_code FROM threads_posts p JOIN threads_sync_jobs j
     ON j.threads_post_id = p.id AND j.generation = p.sync_generation
     WHERE p.id IN ('older-local','newer-local') ORDER BY p.id`,
  ).all().then((result) => result.results), [
    { id: "newer-local", status: "error", error_code: "threads_archive_duplicate" },
    { id: "older-local", status: "collecting", error_code: null },
  ]);
});

test("Threads review keeps the older provider owner when it resolves first", async () => {
  const db = (await harness.worker.getEnv()).PROD_DB;
  await seedCollisionCandidate(db, "older-local", 10);
  await seedCollisionCandidate(db, "newer-local", 20);
  assert.equal(await saveResolvedThreadsRoot(db, {
    postId: "older-local", generation: 1, profile: profile("provider-owner", "provider"),
    root: collisionRoot(), profileCursor: null, conversationCursor: null, nowSeconds: 21,
  }), true);
  assert.equal(await saveResolvedThreadsRoot(db, {
    postId: "newer-local", generation: 1, profile: profile("provider-owner", "provider"),
    root: collisionRoot(), profileCursor: null, conversationCursor: null, nowSeconds: 22,
  }), false);
  assert.deepEqual(await db.prepare(
    `SELECT id, threads_media_id, status, error_code FROM threads_posts
     WHERE id IN ('older-local','newer-local') ORDER BY id`,
  ).all().then((result) => result.results), [
    { id: "newer-local", threads_media_id: null, status: "error",
      error_code: "threads_archive_duplicate" },
    { id: "older-local", threads_media_id: "provider-shared-root", status: "collecting",
      error_code: null },
  ]);
});

/** @param {D1Database} db @param {string} id */
async function seedFinalizable(db, id) {
  const row = await seedThreadsArchive(db, {
    id, shortcode: `${id}Short`, threadsMediaId: `${id}-source`,
    submittedUrl: `https://threads.net/t/${id}Short`,
    canonicalUrl: `https://www.threads.com/@${id}/post/${id}Short`,
    status: "collecting", authorId: `${id}-author`, username: id,
    displayName: id, rootEntryId: `${id}-root-entry`, rootText: id,
    rootPermalink: `https://www.threads.com/@${id}/post/${id}Short`,
    jobStatus: "collecting", createdAt: 10, updatedAt: 10,
  });
  return {
    postId: id, generation: 1, nowSeconds: 20,
    media: [{ entryId: row.rootEntryId, sourceMediaId: row.threadsMediaId,
      kind: "image", ordinal: 0, altText: `${id} alt`,
      sourceUrl: `https://scontent.cdninstagram.com/${id}-image` }],
    profiles: [{ authorId: row.authorId,
      sourceUrl: `https://scontent.cdninstagram.com/${id}-profile` }],
  };
}

/** @param {D1Database} db @param {() => Promise<unknown>} beforeBatch */
function interceptFirstBatch(db, beforeBatch) {
  let intercepted = false;
  return {
    prepare: db.prepare.bind(db),
    /** @param {D1PreparedStatement[]} statements */
    async batch(statements) {
      if (!intercepted) { intercepted = true; await beforeBatch(); }
      return db.batch(statements);
    },
  };
}

/** @param {D1Database} db */
async function collisionLoserSnapshot(db) {
  return {
    post: await db.prepare("SELECT * FROM threads_posts WHERE id = 'newer-local'").first(),
    job: await db.prepare(
      "SELECT * FROM threads_sync_jobs WHERE threads_post_id = 'newer-local' AND generation = 1",
    ).first(),
  };
}

test("Threads collision race leaves the newer owner untouched when the older winner becomes stale", async () => {
  const db = (await harness.worker.getEnv()).PROD_DB;
  await seedCollisionCandidate(db, "older-local", 10);
  await seedCollisionCandidate(db, "newer-local", 20);
  assert.equal(await saveResolvedThreadsRoot(db, {
    postId: "newer-local", generation: 1, profile: profile("provider-owner", "provider"),
    root: collisionRoot(), profileCursor: null, conversationCursor: null, nowSeconds: 21,
  }), true);
  const loserBefore = await collisionLoserSnapshot(db);
  const raced = interceptFirstBatch(db, () => db.prepare(
    "UPDATE threads_posts SET sync_generation = 2 WHERE id = 'older-local'",
  ).run());
  assert.equal(await saveResolvedThreadsRoot(raced, {
    postId: "older-local", generation: 1, profile: profile("provider-owner", "provider"),
    root: collisionRoot(), profileCursor: null, conversationCursor: null, nowSeconds: 22,
  }), false);
  assert.deepEqual(await collisionLoserSnapshot(db), loserBefore);
  assert.equal(await db.prepare(
    "SELECT threads_media_id FROM threads_posts WHERE id = 'older-local'",
  ).first("threads_media_id"), null);
  assert.equal(await db.prepare(
    "SELECT COUNT(*) AS count FROM threads_posts WHERE threads_media_id LIKE 'claim:%'",
  ).first("count"), 0);
});

test("Threads collision race leaves the newer owner untouched when deletion wins for the older winner", async () => {
  const db = (await harness.worker.getEnv()).PROD_DB;
  await seedCollisionCandidate(db, "older-local", 10);
  await seedCollisionCandidate(db, "newer-local", 20);
  assert.equal(await saveResolvedThreadsRoot(db, {
    postId: "newer-local", generation: 1, profile: profile("provider-owner", "provider"),
    root: collisionRoot(), profileCursor: null, conversationCursor: null, nowSeconds: 21,
  }), true);
  const loserBefore = await collisionLoserSnapshot(db);
  const raced = interceptFirstBatch(db, () => db.prepare(
    "UPDATE threads_posts SET status = 'deleting' WHERE id = 'older-local'",
  ).run());
  assert.equal(await saveResolvedThreadsRoot(raced, {
    postId: "older-local", generation: 1, profile: profile("provider-owner", "provider"),
    root: collisionRoot(), profileCursor: null, conversationCursor: null, nowSeconds: 22,
  }), false);
  assert.deepEqual(await collisionLoserSnapshot(db), loserBefore);
  assert.equal(await db.prepare(
    "SELECT threads_media_id FROM threads_posts WHERE id = 'older-local'",
  ).first("threads_media_id"), null);
  assert.equal(await db.prepare(
    "SELECT COUNT(*) AS count FROM threads_posts WHERE threads_media_id LIKE 'claim:%'",
  ).first("count"), 0);
});

test("Threads review finalization commits no media after its generation becomes stale", async () => {
  const db = (await harness.worker.getEnv()).PROD_DB;
  const input = await seedFinalizable(db, "stale-finalize");
  const raced = interceptFirstBatch(db, () => db.prepare(
    "UPDATE threads_posts SET sync_generation = 2 WHERE id = 'stale-finalize'",
  ).run());
  assert.equal((await finalizeThreadsContent(raced, harness.mediaQueue, input)).status, "stale");
  assert.equal(await db.prepare(
    "SELECT COUNT(*) AS count FROM threads_media WHERE entry_id = 'stale-finalize-root-entry'",
  ).first("count"), 0);
  assert.equal(harness.mediaMessages.length, 0);
});

test("Threads review finalization commits no media when deletion wins before its batch", async () => {
  const db = (await harness.worker.getEnv()).PROD_DB;
  const input = await seedFinalizable(db, "delete-finalize");
  const raced = interceptFirstBatch(db, () => db.prepare(
    "UPDATE threads_posts SET status = 'deleting' WHERE id = 'delete-finalize'",
  ).run());
  assert.equal((await finalizeThreadsContent(raced, harness.mediaQueue, input)).status, "stale");
  assert.equal(await db.prepare(
    "SELECT COUNT(*) AS count FROM threads_media WHERE entry_id = 'delete-finalize-root-entry'",
  ).first("count"), 0);
  assert.equal(harness.mediaMessages.length, 0);
});

test("Threads review missing media Queue terminalizes every unsent item as partial", async () => {
  const db = (await harness.worker.getEnv()).PROD_DB;
  const input = await seedFinalizable(db, "missing-media-queue");
  const result = await finalizeThreadsContent(db, null, input);
  assert.equal(result.status, "partial");
  assert.deepEqual(await db.prepare(
    "SELECT status, error_code FROM threads_media WHERE entry_id = 'missing-media-queue-root-entry'",
  ).first(), { status: "error", error_code: "queue_unavailable" });
  assert.deepEqual(await db.prepare(
    "SELECT profile_media_status, profile_error_code FROM threads_authors WHERE threads_user_id = 'missing-media-queue-author'",
  ).first(), { profile_media_status: "error", profile_error_code: "queue_unavailable" });
});

test("Threads review partial media Queue rejection cannot strand media_pending", async () => {
  const db = (await harness.worker.getEnv()).PROD_DB;
  const input = await seedFinalizable(db, "partial-media-queue");
  input.media.push({ ...input.media[0], kind: "video_thumbnail", ordinal: 1 });
  let sends = 0;
  const queue = { async send() {
    sends += 1;
    if (sends === 2) throw new Error("reject-second-message");
  } };
  const result = await finalizeThreadsContent(db, queue, input);
  assert.equal(result.status, "partial");
  assert.equal(await db.prepare(
    "SELECT COUNT(*) AS count FROM threads_media WHERE status = 'error'",
  ).first("count"), 1);
  assert.equal(await db.prepare(
    "SELECT status FROM threads_posts WHERE id = 'partial-media-queue'",
  ).first("status"), "partial");
});

test("Threads review premature aggregation leaves collecting content unchanged", async () => {
  const db = (await harness.worker.getEnv()).PROD_DB;
  await seedFinalizable(db, "premature-aggregate");
  assert.deepEqual(await recalculateThreadsStatus(db, {
    postId: "premature-aggregate", generation: 1, nowSeconds: 21,
  }), { status: "collecting", ready: 0, failed: 0, expected: 0 });
  assert.deepEqual(await db.prepare(
    `SELECT p.status AS post_status, j.status AS job_status, j.content_completed_at
     FROM threads_posts p JOIN threads_sync_jobs j ON j.threads_post_id = p.id
     WHERE p.id = 'premature-aggregate'`,
  ).first(), { post_status: "collecting", job_status: "collecting",
    content_completed_at: null });
});

test("Threads review canonicalizes offset timestamps before chronological reply ordering", async () => {
  const db = (await harness.worker.getEnv()).PROD_DB;
  const row = await seedThreadsArchive(db, {
    id: "timestamp-order", shortcode: "TimestampOrder", threadsMediaId: "timestamp-root",
    submittedUrl: "https://threads.net/t/TimestampOrder",
    canonicalUrl: "https://www.threads.com/@time/post/TimestampOrder",
    status: "collecting", authorId: "time-author", username: "time",
    displayName: "Time", rootEntryId: "timestamp-root-entry",
    rootPermalink: "https://www.threads.com/@time/post/TimestampOrder",
    jobStatus: "collecting", createdAt: 10, updatedAt: 10,
  });
  await saveThreadsConversationPage(db, {
    postId: row.id, generation: 1, nextCursor: null, nowSeconds: 20,
    entries: [
      media("minus-offset", row.authorId, { username: "time",
        timestamp: "2026-08-24T00:30:00-0900" }),
      media("utc-middle", row.authorId, { username: "time",
        timestamp: "2026-08-24T00:00:00Z" }),
      media("plus-offset", row.authorId, { username: "time",
        timestamp: "2026-08-24T00:30:00+0900" }),
    ],
  });
  const detail = await getThreadsArchive(db, row.id, { repliesPage: 1 });
  assert.deepEqual(detail?.replies.map((reply) => [reply.sourceMediaId, reply.publishedAt]), [
    ["plus-offset", "2026-08-23T15:30:00.000Z"],
    ["utc-middle", "2026-08-24T00:00:00.000Z"],
    ["minus-offset", "2026-08-24T09:30:00.000Z"],
  ]);
});

test("Threads review rejects unsafe D1 counts before issuing a page query", async () => {
  let prepares = 0;
  const malformedDb = { prepare() {
    prepares += 1;
    return { first: async () => ({ count: Number.MAX_SAFE_INTEGER + 1 }) };
  } };
  await assert.rejects(listThreadsArchives(malformedDb, { page: 1 }),
    (error) => error instanceof AppError && error.code === "storage_unavailable");
  assert.equal(prepares, 1);
});

test("Threads review rejects unsafe D1 generations counts bytes timestamps and mutation changes", () => {
  for (const field of ["generation", "count", "bytes", "timestamp"]) {
    assert.throws(() => d1NonnegativeInteger(Number.MAX_SAFE_INTEGER + 1),
      (error) => error instanceof AppError && error.code === "storage_unavailable", field);
  }
  assert.throws(() => mutationChanges({
    success: true, meta: { changes: Number.MAX_SAFE_INTEGER + 1 },
  }), (error) => error instanceof AppError && error.code === "storage_unavailable");
});
