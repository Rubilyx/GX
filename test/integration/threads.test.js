import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { AppError } from "../../src/domain.js";
import {
  beginThreadsOAuth, disconnectThreads, finishThreadsOAuth, getThreadsAccessToken,
  refreshStoredThreadsCredential,
} from "../../src/threads-oauth.js";
import { providerFixture, startHarness } from "../support/harness.js";

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

test("Threads OAuth credential accepts the provider boundary's maximum token length", async () => {
  const env = await harness.worker.getEnv();
  const accessToken = "t".repeat(256);
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
