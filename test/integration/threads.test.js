import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { AppError } from "../../src/domain.js";
import {
  handleThreadsCaptureDeadLetter, handleThreadsCaptureMessage,
} from "../../src/threads-capture.js";
import {
  deleteThreadsArchive, handleThreadsMediaDeadLetter, handleThreadsMediaMessage,
  serveThreadsMedia,
} from "../../src/thread-media.js";
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

test("Threads interface migration enforces durable quote work states", async () => {
  const db = (await harness.worker.getEnv()).PROD_DB;
  const columns = await db.prepare("PRAGMA table_info(threads_entries)").all();
  assert.deepEqual(columns.results.filter((row) => [
    "quoted_post_id", "quote_status", "quote_error_code", "quote_generation",
  ].includes(String(row.name))).map((row) => [row.name, row.notnull, row.dflt_value]), [
    ["quoted_post_id", 0, null],
    ["quote_status", 1, "'none'"],
    ["quote_error_code", 0, null],
    ["quote_generation", 0, null],
  ]);
  await db.prepare(
    "INSERT INTO threads_authors (threads_user_id, username, display_name) VALUES ('quote-author', 'quote', 'Quote')",
  ).run();
  await db.prepare(
    `INSERT INTO threads_posts (id, shortcode, submitted_url, status, root_author_id)
     VALUES ('quote-post', 'QuoteWork', 'https://threads.net/t/QuoteWork', 'collecting', 'quote-author')`,
  ).run();
  /** @param {string} id @param {string} kind @param {string | null} parent @param {string | null} quoteId @param {string} status @param {string | null} errorCode @param {number | null} quoteGeneration */
  const insert = (id, kind, parent, quoteId, status, errorCode, quoteGeneration) => db.prepare(
    `INSERT INTO threads_entries
       (id, threads_post_id, source_media_id, kind, parent_entry_id, author_id,
        published_at, media_type, first_seen_at, last_seen_at,
        quoted_post_id, quote_status, quote_error_code, quote_generation)
     VALUES (?, 'quote-post', ?, ?, ?, 'quote-author', '2026-08-24T00:00:00Z',
       'TEXT_POST', 1, 1, ?, ?, ?, ?)`,
  ).bind(id, `${id}-source`, kind, parent, quoteId, status, errorCode,
    quoteGeneration).run();
  await insert("parent-none", "root", null, null, "none", null, null);
  await insert("parent-pending", "author_reply", null, "quote-pending", "pending", null, 1);
  await insert("parent-ready", "author_reply", null, "quote-ready", "ready", null, 1);
  await insert("parent-error", "author_reply", null, "quote-error", "error", "quote_unavailable", 1);
  await insert("quote-clean", "quote", "parent-none", null, "none", null, null);
  /** @type {[string, string, string | null, string | null, string, string | null, number | null][]} */
  const invalidStates = [
    ["quote-work", "quote", "parent-none", "nested", "pending", null, 1],
    ["no-id-ready", "author_reply", null, null, "ready", null, 1],
    ["pending-error", "author_reply", null, "q", "pending", "bad", 1],
    ["error-null", "author_reply", null, "q", "error", null, 1],
    ["error-empty", "author_reply", null, "q", "error", "", 1],
    ["pending-no-generation", "author_reply", null, "q", "pending", null, null],
    ["none-with-generation", "author_reply", null, null, "none", null, 1],
    ["zero-generation", "author_reply", null, "q", "pending", null, 0],
  ];
  for (const invalid of invalidStates) await assert.rejects(insert(...invalid));
});

test("Threads capture jobs expose durable phases and a nullable capture lease", async () => {
  const db = (await harness.worker.getEnv()).PROD_DB;
  const columns = await db.prepare("PRAGMA table_info(threads_sync_jobs)").all();
  assert.deepEqual(columns.results.filter((row) => [
    "profile_completed", "conversation_started", "conversation_completed", "capture_lease",
  ].includes(String(row.name))).map((row) => [row.name, row.notnull, row.dflt_value]), [
    ["profile_completed", 1, "0"],
    ["conversation_started", 1, "0"],
    ["conversation_completed", 1, "0"],
    ["capture_lease", 0, null],
  ]);
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
/** @param {string} id @param {string} shortcode @param {string} [ownerId] @param {Record<string, unknown>} [overrides] */
const rawThreadsMedia = (id, shortcode, ownerId = "author-1", overrides = {}) => ({
  id, media_product_type: "THREADS", media_type: "TEXT_POST",
  permalink: `https://www.threads.com/@meta/post/${shortcode}`,
  owner: { id: ownerId }, username: ownerId === "author-1" ? "meta" : "other",
  text: `Raw ${id}`, timestamp: "2026-08-24T00:00:00+0000", shortcode,
  ...overrides,
});
/** @param {string} entrySourceMediaId @param {string} sourceMediaId @param {"image" | "video" | "video_thumbnail"} [kind] @param {number} [ordinal] @param {string | null} [altText] */
const mediaDescriptor = (entrySourceMediaId, sourceMediaId, kind = "image", ordinal = 0,
  altText = null) => ({ entrySourceMediaId, sourceMediaId, kind, ordinal, altText });
const SAVED_NO_QUOTES = Object.freeze({ applied: true, quoteWork: [] });
const NOT_SAVED = Object.freeze({ applied: false, quoteWork: [] });

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

test("Threads interface facade exposes exactly fourteen capture-store operations", async () => {
  const facade = await import("../../src/threads.js");
  assert.deepEqual(Object.keys(facade).sort(), [
    "advanceThreadsProfileCursor", "claimThreadsJob", "createThreadsSync", "failThreadsQuote",
    "finalizeThreadsContent", "getThreadsArchive", "listThreadsArchives",
    "listThreadsPendingQuoteWork", "markThreadsJobError", "recalculateThreadsStatus",
    "saveResolvedThreadsRoot", "saveThreadsConversationPage", "saveThreadsQuote",
    "startThreadsDeletion",
  ]);
});

test("Threads interface claim exposes capture identity and profile cursor CAS rejects replay", async () => {
  const { advanceThreadsProfileCursor } = await import("../../src/threads.js");
  const db = (await harness.worker.getEnv()).PROD_DB;
  const sync = await createThreadsSync(
    db, harness.captureQueue, "https://threads.net/t/CursorShort", 1_100,
  );
  assert.deepEqual(await claimThreadsJob(db, sync.threadsPostId, 1, "resolving"), {
    postId: sync.threadsPostId, generation: 1, status: "resolving",
    profileCursor: null, conversationCursor: null, pendingQuoteCount: 0,
    expectedEntryCount: 0, expectedMediaCount: 0, readyMediaCount: 0,
    failedMediaCount: 0, errorCode: null, rootAuthorId: null, threadsMediaId: null,
    canonicalUrl: null, submittedUrl: "https://threads.net/t/CursorShort",
    shortcode: "CursorShort", profileCompleted: false, conversationStarted: false,
    conversationCompleted: false, captureLease: null,
  });
  assert.equal(await advanceThreadsProfileCursor(db, {
    postId: sync.threadsPostId, generation: 1, expectedCursor: null,
    nextCursor: "profile-1", nowSeconds: 1_101,
  }), true);
  assert.equal(await advanceThreadsProfileCursor(db, {
    postId: sync.threadsPostId, generation: 1, expectedCursor: null,
    nextCursor: "replay-must-not-win", nowSeconds: 1_102,
  }), false);
  assert.equal(await advanceThreadsProfileCursor(db, {
    postId: sync.threadsPostId, generation: 1, expectedCursor: "profile-1",
    nextCursor: null, nowSeconds: 1_103,
  }), true);
  assert.deepEqual(await db.prepare(
    `SELECT status, profile_cursor, updated_at FROM threads_sync_jobs
     WHERE threads_post_id = ? AND generation = 1`,
  ).bind(sync.threadsPostId).first(), {
    status: "resolving", profile_cursor: null, updated_at: 1_103,
  });
  await claimThreadsJob(db, sync.threadsPostId, 1, "collecting");
  assert.equal(await advanceThreadsProfileCursor(db, {
    postId: sync.threadsPostId, generation: 1, expectedCursor: null,
    nextCursor: "late", nowSeconds: 1_104,
  }), false);
  assert.equal(await advanceThreadsProfileCursor(db, {
    postId: sync.threadsPostId, generation: 2, expectedCursor: null,
    nextCursor: "stale", nowSeconds: 1_105,
  }), false);
  const malformedDb = { prepare() { return { bind() { return { first: async () => ({
    post_id: "p", generation: 1, status: "resolving", profile_cursor: null,
    conversation_cursor: null, pending_quote_count: 0, expected_entry_count: 0,
    expected_media_count: 0, ready_media_count: 0, failed_media_count: 0,
    error_code: null, root_author_id: null, threads_media_id: null, canonical_url: null,
    submitted_url: "", shortcode: "Short", profile_completed: 0,
    conversation_started: 0, conversation_completed: 0, capture_lease: null,
  }) }; } }; } };
  await assert.rejects(claimThreadsJob(malformedDb, "p", 1, "resolving"),
    (error) => error instanceof AppError && error.code === "storage_unavailable");
});

/** @param {D1Database} db @param {string} postId */
async function capturePageSnapshot(db, postId) {
  return {
    post: await db.prepare("SELECT * FROM threads_posts WHERE id = ?").bind(postId).first(),
    jobs: await db.prepare(
      "SELECT * FROM threads_sync_jobs WHERE threads_post_id = ? ORDER BY generation",
    ).bind(postId).all().then((result) => result.results),
    entries: await db.prepare(
      "SELECT * FROM threads_entries WHERE threads_post_id = ? ORDER BY id",
    ).bind(postId).all().then((result) => result.results),
    links: await db.prepare(
      `SELECT link.* FROM threads_links link JOIN threads_entries entry
       ON entry.id = link.entry_id WHERE entry.threads_post_id = ? ORDER BY link.id`,
    ).bind(postId).all().then((result) => result.results),
    media: await db.prepare(
      `SELECT item.* FROM threads_media item JOIN threads_entries entry
       ON entry.id = item.entry_id WHERE entry.threads_post_id = ? ORDER BY item.id`,
    ).bind(postId).all().then((result) => result.results),
  };
}

test("Threads capture page leases make root and conversation CAS all-or-nothing", async () => {
  const db = (await harness.worker.getEnv()).PROD_DB;
  const sync = await createThreadsSync(
    db, harness.captureQueue, "https://www.threads.com/@meta/post/AtomicPages", 1_200,
  );
  await claimThreadsJob(db, sync.threadsPostId, 1, "resolving");
  const root = media("atomic-root", "author-1", {
    rootPostId: null, repliedToId: null, quotedPostId: "atomic-root-quote",
    permalink: "https://www.threads.com/@meta/post/AtomicPages",
    text: "atomic root https://example.com/root",
  });
  const rootInput = {
    postId: sync.threadsPostId, generation: 1, expectedProfileCursor: null,
    profile: profile(), root, profileCursor: null, conversationCursor: null,
    media: [mediaDescriptor(root.id, "atomic-root-image")], nowSeconds: 1_201,
  };
  const appliedRoot = await saveResolvedThreadsRoot(db, rootInput);
  assert.equal(appliedRoot.applied, true);
  assert.equal(appliedRoot.quoteWork.length, 1);
  assert.deepEqual(await db.prepare(
    `SELECT profile_completed, conversation_started, conversation_completed,
       capture_lease FROM threads_sync_jobs WHERE threads_post_id = ? AND generation = 1`,
  ).bind(sync.threadsPostId).first(), {
    profile_completed: 1, conversation_started: 0,
    conversation_completed: 0, capture_lease: null,
  });
  const afterRoot = await capturePageSnapshot(db, sync.threadsPostId);
  assert.deepEqual(await saveResolvedThreadsRoot(db, {
    ...rootInput, nowSeconds: 1_202,
  }), { applied: false, quoteWork: [] });
  assert.deepEqual(await capturePageSnapshot(db, sync.threadsPostId), afterRoot);

  const pageB = {
    postId: sync.threadsPostId, generation: 1, expectedCursor: null,
    entries: [media("atomic-reply-b")], nextCursor: "cursor-b", nowSeconds: 1_203,
  };
  assert.deepEqual(await saveThreadsConversationPage(db, pageB), {
    applied: true, accepted: 1, nextCursor: "cursor-b", quoteWork: [],
  });
  const afterB = await capturePageSnapshot(db, sync.threadsPostId);
  assert.deepEqual(await saveThreadsConversationPage(db, {
    ...pageB, nowSeconds: 1_204,
  }), { applied: false, accepted: 0, nextCursor: "cursor-b", quoteWork: [] });
  assert.deepEqual(await capturePageSnapshot(db, sync.threadsPostId), afterB);

  const pageC = {
    postId: sync.threadsPostId, generation: 1, expectedCursor: "cursor-b",
    entries: [media("atomic-reply-c")], nextCursor: "cursor-c", nowSeconds: 1_205,
  };
  assert.equal((await saveThreadsConversationPage(db, pageC)).applied, true);
  const afterC = await capturePageSnapshot(db, sync.threadsPostId);
  assert.equal((await saveThreadsConversationPage(db, {
    ...pageB, nowSeconds: 1_206,
  })).applied, false);
  assert.deepEqual(await capturePageSnapshot(db, sync.threadsPostId), afterC);

  const finalPage = {
    postId: sync.threadsPostId, generation: 1, expectedCursor: "cursor-c",
    entries: [media("atomic-reply-final")], nextCursor: null, nowSeconds: 1_207,
  };
  assert.equal((await saveThreadsConversationPage(db, finalPage)).applied, true);
  const completed = await capturePageSnapshot(db, sync.threadsPostId);
  assert.deepEqual(await db.prepare(
    `SELECT profile_completed, conversation_started, conversation_completed,
       conversation_cursor, capture_lease FROM threads_sync_jobs
     WHERE threads_post_id = ? AND generation = 1`,
  ).bind(sync.threadsPostId).first(), {
    profile_completed: 1, conversation_started: 1, conversation_completed: 1,
    conversation_cursor: null, capture_lease: null,
  });
  for (const delayed of [
    { ...pageC, nowSeconds: 1_208 }, { ...finalPage, nowSeconds: 1_209 },
  ]) assert.equal((await saveThreadsConversationPage(db, delayed)).applied, false);
  assert.deepEqual(await capturePageSnapshot(db, sync.threadsPostId), completed);
});

test("Threads capture page leases reject stale and deleting races without content drift", async () => {
  const db = (await harness.worker.getEnv()).PROD_DB;
  for (const race of ["stale", "deleting"]) {
    const suffix = race === "stale" ? "Stale" : "Deleting";
    const sync = await createThreadsSync(
      db, harness.captureQueue, `https://www.threads.com/@meta/post/Lease${suffix}`, 1_220,
    );
    await claimThreadsJob(db, sync.threadsPostId, 1, "resolving");
    let racedSnapshot;
    const raced = interceptFirstBatch(db, async () => {
      await db.prepare(race === "stale" ?
        "UPDATE threads_posts SET sync_generation = 2 WHERE id = ?" :
        "UPDATE threads_posts SET status = 'deleting' WHERE id = ?")
        .bind(sync.threadsPostId).run();
      racedSnapshot = await capturePageSnapshot(db, sync.threadsPostId);
    });
    const result = await saveResolvedThreadsRoot(raced, {
      postId: sync.threadsPostId, generation: 1, expectedProfileCursor: null,
      profile: profile(), root: media(`lease-${race}-root`, "author-1", {
        rootPostId: null, repliedToId: null,
        permalink: `https://www.threads.com/@meta/post/Lease${suffix}`,
      }), profileCursor: null, conversationCursor: null, nowSeconds: 1_221,
    });
    assert.deepEqual(result, { applied: false, quoteWork: [] });
    if (!racedSnapshot) throw new Error("test_capture_lease_race_snapshot_missing");
    assert.deepEqual(await capturePageSnapshot(db, sync.threadsPostId), racedSnapshot);
  }
});

test("Threads conversation page lease rejects stale and deleting races without content drift", async () => {
  const db = (await harness.worker.getEnv()).PROD_DB;
  for (const race of ["stale", "deleting"]) {
    const suffix = race === "stale" ? "ConversationStale" : "ConversationDeleting";
    const sync = await createThreadsSync(
      db, harness.captureQueue, `https://www.threads.com/@meta/post/${suffix}`, 1_230,
    );
    await claimThreadsJob(db, sync.threadsPostId, 1, "resolving");
    await saveResolvedThreadsRoot(db, {
      postId: sync.threadsPostId, generation: 1, expectedProfileCursor: null,
      profile: profile(), root: media(`lease-${race}-conversation-root`, "author-1", {
        rootPostId: null, repliedToId: null,
        permalink: `https://www.threads.com/@meta/post/${suffix}`,
      }), profileCursor: null, conversationCursor: null, nowSeconds: 1_231,
    });
    let racedSnapshot;
    const raced = interceptFirstBatch(db, async () => {
      await db.prepare(race === "stale" ?
        "UPDATE threads_posts SET sync_generation = 2 WHERE id = ?" :
        "UPDATE threads_posts SET status = 'deleting' WHERE id = ?")
        .bind(sync.threadsPostId).run();
      racedSnapshot = await capturePageSnapshot(db, sync.threadsPostId);
    });
    assert.deepEqual(await saveThreadsConversationPage(raced, {
      postId: sync.threadsPostId, generation: 1, expectedCursor: null,
      entries: [media(`lease-${race}-conversation-reply`)],
      nextCursor: null, nowSeconds: 1_232,
    }), { applied: false, accepted: 0, nextCursor: null, quoteWork: [] });
    if (!racedSnapshot) throw new Error("test_conversation_lease_race_snapshot_missing");
    assert.deepEqual(await capturePageSnapshot(db, sync.threadsPostId), racedSnapshot);
  }
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
  assert.deepEqual(await saveResolvedThreadsRoot(db, {
    postId: sync.threadsPostId, generation: 1, profile: profile(), root,
    profileCursor: null, conversationCursor: null, nowSeconds: 2_001,
  }), SAVED_NO_QUOTES);
  const firstPage = await saveThreadsConversationPage(db, {
    postId: sync.threadsPostId, generation: 1, entries: [
      media("reply-1", "author-1", { quotedPostId: "quote-1" }),
      media("other-1", "author-2"),
    ], expectedCursor: null, nextCursor: "immutable-page-2", nowSeconds: 2_002,
  });
  assert.equal(firstPage.accepted, 1);
  assert.equal(firstPage.nextCursor, "immutable-page-2");
  assert.equal(firstPage.quoteWork.length, 1);
  assert.equal(firstPage.quoteWork[0].quoteId, "quote-1");
  const replyId = firstPage.quoteWork[0].parentEntryId;
  assert.equal(typeof replyId, "string");
  if (typeof replyId !== "string") throw new Error("test_reply_id_missing");
  await saveThreadsQuote(db, {
    postId: sync.threadsPostId, generation: 1, parentEntryId: replyId,
    profile: profile("quoted-author", "quoted"), quote: media("quote-1", "quoted-author", {
      username: "quoted", rootPostId: null, repliedToId: null,
    }), nowSeconds: 2_003,
  });
  const secondPage = await saveThreadsConversationPage(db, {
    postId: sync.threadsPostId, generation: 1, expectedCursor: "immutable-page-2",
    entries: [media("reply-2", "author-1", { quotedPostId: "quote-1" })],
    nextCursor: null, nowSeconds: 2_004,
  });
  assert.equal(secondPage.quoteWork.length, 1);
  const reply2Id = secondPage.quoteWork[0].parentEntryId;
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
    text: "Original archived text", last_seen_at: 2_001,
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

test("Threads interface quote work survives replay and resolves or fails exactly once", async () => {
  const { failThreadsQuote } = await import("../../src/threads.js");
  const db = (await harness.worker.getEnv()).PROD_DB;
  const sync = await createThreadsSync(
    db, harness.captureQueue, "https://threads.net/t/QuoteState", 2_100,
  );
  await claimThreadsJob(db, sync.threadsPostId, 1, "resolving");
  const root = media("quote-state-root", "author-1", {
    rootPostId: null, repliedToId: null, quotedPostId: "root-quote-id",
  });
  const savedRoot = await saveResolvedThreadsRoot(db, {
    postId: sync.threadsPostId, generation: 1, profile: profile(), root,
    profileCursor: null, conversationCursor: null, nowSeconds: 2_101,
    media: [mediaDescriptor(root.id, "root-image", "image", 0, "root alt")],
  });
  assert.equal(savedRoot.applied, true);
  assert.equal(savedRoot.quoteWork.length, 1);
  assert.equal(savedRoot.quoteWork[0].quoteId, "root-quote-id");
  assert.equal(typeof savedRoot.quoteWork[0].parentEntryId, "string");
  assert.deepEqual(await saveResolvedThreadsRoot(db, {
    postId: sync.threadsPostId, generation: 1, profile: profile(), root,
    profileCursor: null, conversationCursor: null, nowSeconds: 2_102,
    media: [mediaDescriptor(root.id, "root-image", "image", 0, "root alt")],
  }), NOT_SAVED);
  assert.equal(await db.prepare(
    "SELECT pending_quote_count FROM threads_sync_jobs WHERE threads_post_id = ? AND generation = 1",
  ).bind(sync.threadsPostId).first("pending_quote_count"), 1);
  assert.deepEqual(await db.prepare(
    `SELECT quoted_post_id, quote_status, quote_error_code FROM threads_entries
     WHERE id = ?`,
  ).bind(savedRoot.quoteWork[0].parentEntryId).first(), {
    quoted_post_id: "root-quote-id", quote_status: "pending", quote_error_code: null,
  });
  assert.equal((await saveThreadsConversationPage(db, {
    postId: sync.threadsPostId, generation: 1, expectedCursor: null,
    entries: [], nextCursor: "quote-reply-page", nowSeconds: 2_102,
  })).applied, true);

  const quote = media("root-quote-id", "quoted-author", {
    username: "quoted", rootPostId: null, repliedToId: null,
  });
  const saveQuoteInput = {
    postId: sync.threadsPostId, generation: 1,
    parentEntryId: savedRoot.quoteWork[0].parentEntryId,
    profile: profile("quoted-author", "quoted"), quote,
    nestedQuotePermalink: "https://www.threads.com/@nested/post/NestedQuote",
    media: [mediaDescriptor(quote.id, "quote-video", "video", 0, null)],
    nowSeconds: 2_103,
  };
  await assert.rejects(saveThreadsQuote(db, {
    ...saveQuoteInput, nestedQuotePermalink: "x".repeat(4_097),
  }), (error) => error instanceof AppError && error.code === "invalid_threads_state");
  assert.equal(await saveThreadsQuote(db, saveQuoteInput), true);
  assert.equal(await saveThreadsQuote(db, { ...saveQuoteInput, nowSeconds: 2_104 }), false);
  assert.deepEqual(await db.prepare(
    `SELECT quote_status, quote_error_code FROM threads_entries WHERE id = ?`,
  ).bind(savedRoot.quoteWork[0].parentEntryId).first(), {
    quote_status: "ready", quote_error_code: null,
  });
  assert.deepEqual(await db.prepare(
    `SELECT nested_quote_permalink FROM threads_entries
     WHERE parent_entry_id = ? AND source_media_id = 'root-quote-id'`,
  ).bind(savedRoot.quoteWork[0].parentEntryId).first(), {
    nested_quote_permalink: "https://www.threads.com/@nested/post/NestedQuote",
  });
  assert.deepEqual(await db.prepare(
    `SELECT media.source_media_id, media.kind, media.ordinal, media.alt_text
     FROM threads_media media JOIN threads_entries entry ON entry.id = media.entry_id
     WHERE entry.parent_entry_id = ?`,
  ).bind(savedRoot.quoteWork[0].parentEntryId).first(), {
    source_media_id: "quote-video", kind: "video", ordinal: 0, alt_text: null,
  });
  assert.equal(await db.prepare(
    "SELECT pending_quote_count FROM threads_sync_jobs WHERE threads_post_id = ? AND generation = 1",
  ).bind(sync.threadsPostId).first("pending_quote_count"), 0);

  const pageInput = {
    postId: sync.threadsPostId, generation: 1, expectedCursor: "quote-reply-page",
    nextCursor: null, nowSeconds: 2_105,
    entries: [media("quote-state-reply", "author-1", { quotedPostId: "reply-quote-id" })],
    media: [mediaDescriptor("quote-state-reply", "reply-carousel-child", "image", 1,
      "carousel child alt")],
  };
  const page = await saveThreadsConversationPage(db, pageInput);
  assert.equal(page.accepted, 1);
  assert.equal(page.nextCursor, null);
  assert.equal(page.quoteWork.length, 1);
  assert.equal(page.quoteWork[0].quoteId, "reply-quote-id");
  assert.deepEqual(await saveThreadsConversationPage(db, {
    ...pageInput, nowSeconds: 2_106,
  }), { applied: false, accepted: 0, nextCursor: null, quoteWork: [] });
  assert.equal(await db.prepare(
    `SELECT COUNT(*) AS count FROM threads_media media
     JOIN threads_entries entry ON entry.id = media.entry_id
     WHERE entry.threads_post_id = ? AND media.source_media_id = 'reply-carousel-child'`,
  ).bind(sync.threadsPostId).first("count"), 1);
  assert.equal(await db.prepare(
    "SELECT pending_quote_count FROM threads_sync_jobs WHERE threads_post_id = ? AND generation = 1",
  ).bind(sync.threadsPostId).first("pending_quote_count"), 1);
  assert.equal(await failThreadsQuote(db, {
    postId: sync.threadsPostId, generation: 1, parentEntryId: page.quoteWork[0].parentEntryId,
    quoteId: "wrong-quote-id", errorCode: "threads_quote_unavailable", nowSeconds: 2_107,
  }), false);
  const failure = {
    postId: sync.threadsPostId, generation: 1, parentEntryId: page.quoteWork[0].parentEntryId,
    quoteId: "reply-quote-id", errorCode: "threads_quote_unavailable", nowSeconds: 2_108,
  };
  assert.equal(await failThreadsQuote(db, failure), true);
  assert.equal(await failThreadsQuote(db, { ...failure, nowSeconds: 2_109 }), false);
  assert.deepEqual(await db.prepare(
    `SELECT quoted_post_id, quote_status, quote_error_code FROM threads_entries WHERE id = ?`,
  ).bind(page.quoteWork[0].parentEntryId).first(), {
    quoted_post_id: "reply-quote-id", quote_status: "error",
    quote_error_code: "threads_quote_unavailable",
  });
  assert.equal(await db.prepare(
    "SELECT pending_quote_count FROM threads_sync_jobs WHERE threads_post_id = ? AND generation = 1",
  ).bind(sync.threadsPostId).first("pending_quote_count"), 0);
});

test("Threads quote generation re-arms pending and error work once while ready stays resolved", async () => {
  const { failThreadsQuote, listThreadsPendingQuoteWork } =
    await import("../../src/threads.js");
  const db = (await harness.worker.getEnv()).PROD_DB;
  for (const initialStatus of ["pending", "error"]) {
    const suffix = initialStatus === "pending" ? "Pending" : "Error";
    const sync = await createThreadsSync(
      db, harness.captureQueue, `https://threads.net/t/Generation${suffix}`, 2_120,
    );
    await claimThreadsJob(db, sync.threadsPostId, 1, "resolving");
    const root = media(`generation-${initialStatus}-root`, "author-1", {
      rootPostId: null, repliedToId: null, quotedPostId: `generation-${initialStatus}-quote`,
      permalink: `https://www.threads.com/@meta/post/Generation${suffix}`,
    });
    const first = await saveResolvedThreadsRoot(db, {
      postId: sync.threadsPostId, generation: 1, profile: profile(), root,
      profileCursor: null, conversationCursor: null, nowSeconds: 2_121,
    });
    assert.equal(first.quoteWork.length, 1);
    assert.equal((await saveThreadsConversationPage(db, {
      postId: sync.threadsPostId, generation: 1, expectedCursor: null,
      entries: [], nextCursor: null, nowSeconds: 2_121,
    })).applied, true);
    if (initialStatus === "error") assert.equal(await failThreadsQuote(db, {
      postId: sync.threadsPostId, generation: 1,
      parentEntryId: first.quoteWork[0].parentEntryId,
      quoteId: first.quoteWork[0].quoteId,
      errorCode: "threads_quote_unavailable", nowSeconds: 2_122,
    }), true);
    await db.prepare(
      `UPDATE threads_sync_jobs SET status = 'error'
       WHERE threads_post_id = ? AND generation = 1`,
    ).bind(sync.threadsPostId).run();
    await db.prepare(
      "UPDATE threads_posts SET status = 'partial' WHERE id = ?",
    ).bind(sync.threadsPostId).run();
    const second = await createThreadsSync(
      db, harness.captureQueue, `https://threads.net/t/Generation${suffix}`, 2_123,
    );
    assert.equal(second.generation, 2);
    await claimThreadsJob(db, sync.threadsPostId, 2, "resolving");
    const rearmed = await saveResolvedThreadsRoot(db, {
      postId: sync.threadsPostId, generation: 2, profile: profile(), root,
      profileCursor: null, conversationCursor: null, nowSeconds: 2_124,
    });
    assert.deepEqual(rearmed.quoteWork, first.quoteWork);
    assert.deepEqual(await db.prepare(
      `SELECT quote_status, quote_error_code, quote_generation
       FROM threads_entries WHERE id = ?`,
    ).bind(first.quoteWork[0].parentEntryId).first(), {
      quote_status: "pending", quote_error_code: null, quote_generation: 2,
    });
    assert.equal(await db.prepare(
      `SELECT pending_quote_count FROM threads_sync_jobs
       WHERE threads_post_id = ? AND generation = 2`,
    ).bind(sync.threadsPostId).first("pending_quote_count"), 1);
    assert.equal((await saveThreadsConversationPage(db, {
      postId: sync.threadsPostId, generation: 2, expectedCursor: null,
      entries: [], nextCursor: null, nowSeconds: 2_124,
    })).applied, true);
    assert.deepEqual(await listThreadsPendingQuoteWork(db, {
      postId: sync.threadsPostId, generation: 2,
    }), first.quoteWork);
    await saveResolvedThreadsRoot(db, {
      postId: sync.threadsPostId, generation: 2, profile: profile(), root,
      profileCursor: null, conversationCursor: null, nowSeconds: 2_125,
    });
    assert.equal(await db.prepare(
      `SELECT pending_quote_count FROM threads_sync_jobs
       WHERE threads_post_id = ? AND generation = 2`,
    ).bind(sync.threadsPostId).first("pending_quote_count"), 1);
    assert.equal(await failThreadsQuote(db, {
      postId: sync.threadsPostId, generation: 1,
      parentEntryId: first.quoteWork[0].parentEntryId,
      quoteId: first.quoteWork[0].quoteId,
      errorCode: "stale_must_not_claim", nowSeconds: 2_126,
    }), false);
    const quote = media(first.quoteWork[0].quoteId, "author-1", {
      rootPostId: null, repliedToId: null,
    });
    assert.equal(await saveThreadsQuote(db, {
      postId: sync.threadsPostId, generation: 2,
      parentEntryId: first.quoteWork[0].parentEntryId,
      profile: profile(), quote, nowSeconds: 2_127,
    }), true);
    await db.prepare(
      `UPDATE threads_sync_jobs SET status = 'ready'
       WHERE threads_post_id = ? AND generation = 2`,
    ).bind(sync.threadsPostId).run();
    await db.prepare("UPDATE threads_posts SET status = 'ready' WHERE id = ?")
      .bind(sync.threadsPostId).run();
    const third = await createThreadsSync(
      db, harness.captureQueue, `https://threads.net/t/Generation${suffix}`, 2_128,
    );
    await claimThreadsJob(db, sync.threadsPostId, third.generation, "resolving");
    const readyReplay = await saveResolvedThreadsRoot(db, {
      postId: sync.threadsPostId, generation: third.generation, profile: profile(), root,
      profileCursor: null, conversationCursor: null, nowSeconds: 2_129,
    });
    assert.deepEqual(readyReplay.quoteWork, []);
    assert.deepEqual(await db.prepare(
      `SELECT quote_status, quote_generation FROM threads_entries WHERE id = ?`,
    ).bind(first.quoteWork[0].parentEntryId).first(), {
      quote_status: "ready", quote_generation: 2,
    });
    assert.equal(await db.prepare(
      `SELECT pending_quote_count FROM threads_sync_jobs
       WHERE threads_post_id = ? AND generation = 3`,
    ).bind(sync.threadsPostId).first("pending_quote_count"), 0);
  }
});

test("Threads current-generation quote errors force partial without inflating media counts", async () => {
  const db = (await harness.worker.getEnv()).PROD_DB;
  await seedThreadsArchive(db, {
    id: "current-quote-error", shortcode: "CurrentQuoteError",
    threadsMediaId: "current-quote-root", status: "collecting", jobStatus: "collecting",
    rootEntryId: "current-quote-entry", createdAt: 2_140, updatedAt: 2_140,
  });
  await db.prepare(
    `UPDATE threads_entries SET quoted_post_id = 'missing-current-quote',
       quote_status = 'error', quote_error_code = 'threads_quote_unavailable',
       quote_generation = 1 WHERE id = 'current-quote-entry'`,
  ).run();
  await db.prepare(
    `UPDATE threads_authors SET profile_media_status = 'ready'
     WHERE threads_user_id = 'author-1'`,
  ).run();
  const current = await finalizeThreadsContent(db, harness.mediaQueue, {
    postId: "current-quote-error", generation: 1, nowSeconds: 2_141,
  });
  assert.deepEqual(current, { status: "partial", ready: 1, failed: 0, expected: 1 });
  assert.deepEqual(await db.prepare(
    `SELECT p.status, p.error_code, j.status AS job_status, j.error_code AS job_error_code,
       j.expected_media_count FROM threads_posts p JOIN threads_sync_jobs j
       ON j.threads_post_id = p.id WHERE p.id = 'current-quote-error'`,
  ).first(), {
    status: "partial", error_code: "threads_quote_unavailable",
    job_status: "partial", job_error_code: "threads_quote_unavailable",
    expected_media_count: 1,
  });

  await seedThreadsArchive(db, {
    id: "old-quote-error", shortcode: "OldQuoteError", threadsMediaId: "old-quote-root",
    status: "partial", jobStatus: "partial", rootEntryId: "old-quote-entry",
    createdAt: 2_150, updatedAt: 2_150,
  });
  await db.prepare(
    `UPDATE threads_entries SET quoted_post_id = 'missing-old-quote',
       quote_status = 'error', quote_error_code = 'threads_quote_unavailable',
       quote_generation = 1 WHERE id = 'old-quote-entry'`,
  ).run();
  const next = await createThreadsSync(
    db, harness.captureQueue, "https://threads.net/t/OldQuoteError", 2_151,
  );
  await claimThreadsJob(db, next.threadsPostId, 2, "resolving");
  await saveResolvedThreadsRoot(db, {
    postId: next.threadsPostId, generation: 2, profile: profile(),
    root: media("old-quote-root", "author-1", {
      rootPostId: null, repliedToId: null,
      permalink: "https://www.threads.com/@meta/post/OldQuoteError",
    }), profileCursor: null, conversationCursor: null, nowSeconds: 2_152,
  });
  await saveThreadsConversationPage(db, {
    postId: next.threadsPostId, generation: 2, expectedCursor: null,
    entries: [], nextCursor: null, nowSeconds: 2_152,
  });
  const old = await finalizeThreadsContent(db, harness.mediaQueue, {
    postId: next.threadsPostId, generation: 2, nowSeconds: 2_153,
  });
  assert.deepEqual(old, { status: "ready", ready: 1, failed: 0, expected: 1 });
  assert.equal(await db.prepare(
    "SELECT error_code FROM threads_posts WHERE id = 'old-quote-error'",
  ).first("error_code"), null);
});

test("Threads pending quote work reader validates exact deterministic current-generation rows", async () => {
  const { listThreadsPendingQuoteWork } = await import("../../src/threads.js");
  const malformedDb = { prepare() { return { bind() { return { all: async () => ({
    success: true, results: [{ parent_entry_id: "parent", quoted_post_id: "quote", extra: 1 }],
  }) }; } }; } };
  await assert.rejects(listThreadsPendingQuoteWork(malformedDb, {
    postId: "post", generation: 1,
  }), (error) => error instanceof AppError && error.code === "storage_unavailable");
});

test("Threads interface persists strict URL-free carousel descriptors by local entry", async () => {
  const db = (await harness.worker.getEnv()).PROD_DB;
  const sync = await createThreadsSync(
    db, harness.captureQueue, "https://threads.net/t/MediaDescriptors", 2_200,
  );
  await claimThreadsJob(db, sync.threadsPostId, 1, "resolving");
  const root = media("descriptor-root", "author-1", {
    rootPostId: null, repliedToId: null, mediaType: "CAROUSEL_ALBUM",
    children: ["child-image", "child-video"],
  });
  await saveResolvedThreadsRoot(db, {
    postId: sync.threadsPostId, generation: 1, profile: profile(), root,
    profileCursor: null, conversationCursor: null, nowSeconds: 2_201,
    media: [
      mediaDescriptor(root.id, "child-image", "image", 0, "child alt"),
      mediaDescriptor(root.id, "child-video", "video", 1, null),
      mediaDescriptor(root.id, "child-video", "video_thumbnail", 2, "thumb alt"),
    ],
  });
  assert.deepEqual(await db.prepare(
    `SELECT m.source_media_id, m.kind, m.ordinal, m.alt_text, m.status
     FROM threads_media m JOIN threads_entries e ON e.id = m.entry_id
     WHERE e.threads_post_id = ? ORDER BY m.ordinal`,
  ).bind(sync.threadsPostId).all().then((result) => result.results), [
    { source_media_id: "child-image", kind: "image", ordinal: 0,
      alt_text: "child alt", status: "pending" },
    { source_media_id: "child-video", kind: "video", ordinal: 1,
      alt_text: null, status: "pending" },
    { source_media_id: "child-video", kind: "video_thumbnail", ordinal: 2,
      alt_text: "thumb alt", status: "pending" },
  ]);
  await assert.rejects(saveThreadsConversationPage(db, {
    postId: sync.threadsPostId, generation: 1, entries: [media("known-reply")],
    nextCursor: null, nowSeconds: 2_202,
    media: [mediaDescriptor("unknown-reply", "unknown-image")],
  }), (error) => error instanceof AppError && error.code === "invalid_threads_state");
  await assert.rejects(saveThreadsConversationPage(db, {
    postId: sync.threadsPostId, generation: 1,
    entries: [media("accepted-reply"), media("other-reply", "other-author")],
    nextCursor: null, nowSeconds: 2_202,
    media: [mediaDescriptor("other-reply", "other-image")],
  }), (error) => error instanceof AppError && error.code === "invalid_threads_state");
  await assert.rejects(saveResolvedThreadsRoot(db, {
    postId: sync.threadsPostId, generation: 1, profile: profile(), root,
    profileCursor: null, conversationCursor: null, nowSeconds: 2_203,
    media: [{ ...mediaDescriptor(root.id, "child-image"),
      sourceUrl: "https://scontent.cdninstagram.com/must-not-enter" }],
  }), (error) => error instanceof AppError && error.code === "invalid_threads_state");
  assert.equal(await db.prepare(
    `SELECT COUNT(*) AS count FROM threads_entries
     WHERE source_media_id IN ('known-reply','accepted-reply','other-reply')`,
  ).first("count"), 0);
  assert.doesNotMatch(JSON.stringify(await db.prepare(
    `SELECT e.*, m.* FROM threads_entries e LEFT JOIN threads_media m ON m.entry_id = e.id
     WHERE e.threads_post_id = ?`,
  ).bind(sync.threadsPostId).all().then((result) => result.results)), /sourceUrl|scontent/);
});

test("Threads interface finalization replays only pending URL-free stable IDs", async () => {
  const db = (await harness.worker.getEnv()).PROD_DB;
  const sync = await createThreadsSync(
    db, harness.captureQueue, "https://threads.net/t/FinalizeDescriptors", 2_300,
  );
  await claimThreadsJob(db, sync.threadsPostId, 1, "resolving");
  const root = media("finalize-root", "author-1", {
    rootPostId: null, repliedToId: null, mediaType: "CAROUSEL_ALBUM",
    children: ["finalize-image", "finalize-video"],
  });
  const saved = await saveResolvedThreadsRoot(db, {
    postId: sync.threadsPostId, generation: 1, profile: profile(), root,
    profileCursor: null, conversationCursor: null, nowSeconds: 2_301,
    media: [
      mediaDescriptor(root.id, "finalize-image", "image", 0, "image alt"),
      mediaDescriptor(root.id, "finalize-video", "video", 1, null),
      mediaDescriptor(root.id, "finalize-video", "video_thumbnail", 2, "thumb alt"),
    ],
  });
  assert.equal(saved.applied, true);
  assert.equal((await saveThreadsConversationPage(db, {
    postId: sync.threadsPostId, generation: 1, expectedCursor: null,
    entries: [], nextCursor: null, nowSeconds: 2_301,
  })).applied, true);
  const rows = await db.prepare(
    `SELECT m.id AS media_id, m.entry_id, m.ordinal
     FROM threads_media m JOIN threads_entries e ON e.id = m.entry_id
     WHERE e.threads_post_id = ? ORDER BY m.ordinal`,
  ).bind(sync.threadsPostId).all().then((result) => result.results);
  const expectedMediaMessages = rows.map((row) => ({
    version: 1, type: "archive-entry-media", postId: sync.threadsPostId, generation: 1,
    entryId: row.entry_id, mediaId: row.media_id,
  }));
  const expectedProfileMessage = {
    version: 1, type: "archive-profile", postId: sync.threadsPostId, generation: 1,
    authorId: "author-1",
  };
  const input = { postId: sync.threadsPostId, generation: 1, nowSeconds: 2_302 };
  assert.equal((await finalizeThreadsContent(db, harness.mediaQueue, input)).status,
    "media_pending");
  assert.deepEqual(harness.mediaMessages, [...expectedMediaMessages, expectedProfileMessage]);
  assert.equal((await finalizeThreadsContent(db, harness.mediaQueue, {
    ...input, nowSeconds: 2_303,
  })).status, "media_pending");
  assert.deepEqual(harness.mediaMessages, [
    ...expectedMediaMessages, expectedProfileMessage,
    ...expectedMediaMessages, expectedProfileMessage,
  ]);
  await db.prepare(
    `UPDATE threads_media SET status = CASE ordinal WHEN 0 THEN 'ready'
       WHEN 1 THEN 'error' ELSE 'pending' END,
       error_code = CASE ordinal WHEN 1 THEN 'threads_media_unavailable' ELSE NULL END
     WHERE entry_id = ?`,
  ).bind(rows[0].entry_id).run();
  await db.prepare(
    `UPDATE threads_authors SET profile_media_status = 'ready'
     WHERE threads_user_id = 'author-1'`,
  ).run();
  assert.equal((await finalizeThreadsContent(db, harness.mediaQueue, {
    ...input, nowSeconds: 2_304,
  })).status, "partial");
  assert.deepEqual(harness.mediaMessages.at(-1), expectedMediaMessages[2]);
  assert.equal(harness.mediaMessages.length, 9);
  await finalizeThreadsContent(db, harness.mediaQueue, { ...input, nowSeconds: 2_305 });
  assert.equal(harness.mediaMessages.length, 9);
  assert.doesNotMatch(JSON.stringify(harness.mediaMessages), /sourceUrl|scontent/);
});

test("capture ordering waits for the first conversation page before quote or finalization work", async () => {
  const db = (await harness.worker.getEnv()).PROD_DB;
  const sync = await createThreadsSync(
    db, harness.captureQueue, "https://www.threads.com/@meta/post/PhaseOrder", 3_900,
  );
  const rootMessage = harness.captureMessages.shift();
  if (!rootMessage) throw new Error("test_phase_order_root_message_missing");
  const root = rawThreadsMedia("phase-order-root", "PhaseOrder", "author-1", {
    is_quote_post: true, quoted_post: { id: "phase-order-quote" },
  });
  const fetcher = providerFixture({
    threadsProfilePages: [{ data: [root] }], threadsConversationPages: [{ data: [] }],
    threadsMedia: {
      "phase-order-quote": rawThreadsMedia("phase-order-quote", "PhaseOrderQuote"),
    }, threadsStatus: { conversation: [429, 200] },
  });
  const dependencies = {
    db, captureQueue: harness.captureQueue, mediaQueue: harness.mediaQueue, fetcher,
    getAccessToken: async () => ({ accessToken: "token" }), nowSeconds: 3_901,
    deleteArchive: async () => ({ action: "ack" }),
  };
  assert.deepEqual(await handleThreadsCaptureMessage(rootMessage, dependencies),
    { action: "ack" });
  assert.deepEqual(harness.captureMessages, [{
    version: 1, type: "collect-conversation", postId: sync.threadsPostId,
    generation: 1, cursor: null,
  }]);
  const conversation = harness.captureMessages.shift();
  assert.deepEqual(await handleThreadsCaptureMessage(conversation, dependencies),
    { action: "retry", delaySeconds: 1 });
  assert.deepEqual(harness.captureMessages, []);
  assert.deepEqual(await db.prepare(
    `SELECT profile_completed, conversation_started, conversation_completed,
       pending_quote_count FROM threads_sync_jobs
     WHERE threads_post_id = ? AND generation = 1`,
  ).bind(sync.threadsPostId).first(), {
    profile_completed: 1, conversation_started: 0,
    conversation_completed: 0, pending_quote_count: 1,
  });
  assert.deepEqual(await handleThreadsCaptureMessage(conversation, dependencies),
    { action: "ack" });
  const orderedMessages = /** @type {Record<string, unknown>[]} */ (
    harness.captureMessages
  );
  assert.equal(orderedMessages.some((message) =>
    message.type === "finalize-content"), false);
  assert.deepEqual(orderedMessages.map((message) => message.type), ["collect-quote"]);
});

test("capture phase recovery does not refetch a persisted root or completed conversation", async () => {
  const db = (await harness.worker.getEnv()).PROD_DB;
  const sync = await createThreadsSync(
    db, harness.captureQueue, "https://www.threads.com/@meta/post/PhaseRecovery", 3_920,
  );
  const rootMessage = harness.captureMessages.shift();
  if (!rootMessage) throw new Error("test_phase_recovery_root_message_missing");
  /** @type {Array<{ method: string, path: string }>} */
  const calls = [];
  const fetcher = providerFixture({ calls,
    threadsProfilePages: [{ data: [rawThreadsMedia(
      "phase-recovery-root", "PhaseRecovery",
    )] }], threadsConversationPages: [{ data: [] }] });
  const dependencies = {
    db, captureQueue: harness.captureQueue, mediaQueue: harness.mediaQueue, fetcher,
    getAccessToken: async () => ({ accessToken: "token" }), nowSeconds: 3_921,
    deleteArchive: async () => ({ action: "ack" }),
  };
  await harness.setQueueMode({ captureReject: true });
  assert.deepEqual(await handleThreadsCaptureMessage(rootMessage, dependencies),
    { action: "retry", delaySeconds: 1 });
  const rootCalls = calls.length;
  await harness.setQueueMode({});
  assert.deepEqual(await handleThreadsCaptureMessage(rootMessage, dependencies),
    { action: "ack" });
  assert.equal(calls.length, rootCalls);
  const conversation = harness.captureMessages.shift();
  if (!conversation) throw new Error("test_phase_recovery_conversation_missing");
  await harness.setQueueMode({ captureReject: true });
  assert.deepEqual(await handleThreadsCaptureMessage(conversation, dependencies),
    { action: "retry", delaySeconds: 1 });
  await harness.setQueueMode({});
  assert.deepEqual(await handleThreadsCaptureMessage(conversation, {
    ...dependencies, fetcher: async () => { throw new Error("completed page refetched"); },
  }), { action: "ack" });
  assert.deepEqual(harness.captureMessages, [{
    version: 1, type: "finalize-content", postId: sync.threadsPostId, generation: 1,
  }]);
});

test("capture rejects a mismatched nested quote identity without persisting a permalink", async () => {
  const db = (await harness.worker.getEnv()).PROD_DB;
  const sync = await createThreadsSync(
    db, harness.captureQueue, "https://www.threads.com/@meta/post/NestedMismatch", 3_940,
  );
  harness.captureMessages.length = 0;
  await claimThreadsJob(db, sync.threadsPostId, 1, "resolving");
  const saved = await saveResolvedThreadsRoot(db, {
    postId: sync.threadsPostId, generation: 1, expectedProfileCursor: null,
    profile: profile(), root: media("nested-mismatch-root", "author-1", {
      rootPostId: null, repliedToId: null, quotedPostId: "outer-mismatch-quote",
      permalink: "https://www.threads.com/@meta/post/NestedMismatch",
    }), profileCursor: null, conversationCursor: null, nowSeconds: 3_941,
  });
  await saveThreadsConversationPage(db, {
    postId: sync.threadsPostId, generation: 1, expectedCursor: null,
    entries: [], nextCursor: null, nowSeconds: 3_942,
  });
  const quoteMessage = {
    version: 1, type: "collect-quote", postId: sync.threadsPostId, generation: 1,
    entryId: saved.quoteWork[0].parentEntryId, quoteId: saved.quoteWork[0].quoteId,
  };
  assert.deepEqual(await handleThreadsCaptureMessage(quoteMessage, {
    db, captureQueue: harness.captureQueue, mediaQueue: harness.mediaQueue,
    fetcher: providerFixture({ threadsMedia: {
      "outer-mismatch-quote": rawThreadsMedia(
        "outer-mismatch-quote", "OuterMismatchQuote", "author-1", {
          is_quote_post: true, quoted_post: { id: "expected-nested-id" },
        },
      ),
      "expected-nested-id": rawThreadsMedia("different-nested-id", "DifferentNested"),
    } }), getAccessToken: async () => ({ accessToken: "token" }),
    nowSeconds: 3_943, deleteArchive: async () => ({ action: "ack" }),
  }), { action: "ack" });
  assert.equal(await db.prepare(
    `SELECT COUNT(*) AS count FROM threads_entries
     WHERE threads_post_id = ? AND kind = 'quote'`,
  ).bind(sync.threadsPostId).first("count"), 0);
  assert.deepEqual(await db.prepare(
    `SELECT status, error_code FROM threads_sync_jobs
     WHERE threads_post_id = ? AND generation = 1`,
  ).bind(sync.threadsPostId).first(), {
    status: "error", error_code: "threads_provider_protocol_error",
  });
});

test("capture consumer traverses official pages, filters stable owners, and finalizes URL-free work", async () => {
  const db = (await harness.worker.getEnv()).PROD_DB;
  const sync = await createThreadsSync(
    db, harness.captureQueue, "https://threads.net/t/RootShort", 4_000,
  );
  const root = rawThreadsMedia("capture-root", "RootShort", "author-1", {
    media_type: "IMAGE", media_url: "https://scontent.cdninstagram.com/root-capture-image",
    alt_text: "root capture alt",
  });
  const replies = Array.from({ length: 12 }, (_, index) => rawThreadsMedia(
    `author-reply-${String(index + 1).padStart(2, "0")}`,
    `Reply${String(index + 1).padStart(2, "0")}`, "author-1", {
      timestamp: `2026-08-24T00:${String(index + 1).padStart(2, "0")}:00+0000`,
      root_post: { id: "capture-root" },
      replied_to: { id: index < 4 ? "capture-root" : `author-reply-${String(index).padStart(2, "0")}` },
      ...(index < 2 ? { is_quote_post: true, quoted_post: { id: "shared-quote" } } : {}),
      ...(index === 2 ? {
        media_type: "CAROUSEL_ALBUM",
        children: { data: [{ id: "carousel-image" }, { id: "carousel-video" }] },
      } : {}),
    },
  ));
  const other = rawThreadsMedia("other-user-reply", "OtherReply", "author-2", {
    root_post: { id: "capture-root" }, replied_to: { id: "author-reply-01" },
  });
  await harness.setProviderMode({
    threadsProfilePages: [
      { data: [rawThreadsMedia("older-a", "OlderA")], nextCursor: "profile-2" },
      { data: [rawThreadsMedia("older-b", "OlderB")], nextCursor: "profile-3" },
      { data: [root] },
    ],
    threadsConversationPages: [
      { data: [...replies.slice(0, 4), other], nextCursor: "conversation-2" },
      { data: replies.slice(4, 8), nextCursor: "conversation-3" },
      { data: replies.slice(8) },
    ],
    threadsMedia: {
      "carousel-image": rawThreadsMedia("carousel-image", "CarouselImage", "author-1", {
        media_type: "IMAGE", media_url: "https://scontent.cdninstagram.com/carousel-image",
        alt_text: "carousel image alt",
      }),
      "carousel-video": rawThreadsMedia("carousel-video", "CarouselVideo", "author-1", {
        media_type: "VIDEO", media_url: "https://scontent.cdninstagram.com/carousel-video",
        thumbnail_url: "https://scontent.cdninstagram.com/carousel-thumbnail",
        alt_text: "carousel video alt",
      }),
      "shared-quote": rawThreadsMedia("shared-quote", "SharedQuote", "author-1", {
        media_type: "IMAGE", media_url: "https://scontent.cdninstagram.com/shared-quote",
        is_quote_post: true, quoted_post: { id: "nested-quote" },
      }),
      "nested-quote": rawThreadsMedia("nested-quote", "NestedQuote", "author-1"),
    },
    threadsStatus: { conversation: [429, 200] }, threadsRetryAfter: "7",
  });
  const drained = await harness.drainCaptureQueue({ nowSeconds: 4_001 });
  assert.equal(drained.retries, 1);
  const storedReplies = await db.prepare(
    `SELECT source_media_id FROM threads_entries
     WHERE threads_post_id = ? AND kind = 'author_reply'
     ORDER BY published_at, source_media_id`,
  ).bind(sync.threadsPostId).all();
  assert.equal(storedReplies.results.length, 12);
  assert.equal(storedReplies.results.some((row) =>
    row.source_media_id === "other-user-reply"), false);
  const quotes = await db.prepare(
    `SELECT source_media_id, nested_quote_permalink FROM threads_entries
     WHERE threads_post_id = ? AND kind = 'quote' ORDER BY parent_entry_id`,
  ).bind(sync.threadsPostId).all();
  assert.deepEqual(quotes.results, [
    { source_media_id: "shared-quote",
      nested_quote_permalink: "https://www.threads.com/@meta/post/NestedQuote" },
    { source_media_id: "shared-quote",
      nested_quote_permalink: "https://www.threads.com/@meta/post/NestedQuote" },
  ]);
  assert.deepEqual(await db.prepare(
    `SELECT source_media_id, kind, ordinal, alt_text FROM threads_media
     ORDER BY source_media_id, kind, ordinal`,
  ).all().then((result) => result.results), [
    { source_media_id: "capture-root", kind: "image", ordinal: 0,
      alt_text: "root capture alt" },
    { source_media_id: "carousel-image", kind: "image", ordinal: 0,
      alt_text: "carousel image alt" },
    { source_media_id: "carousel-video", kind: "video", ordinal: 1,
      alt_text: "carousel video alt" },
    { source_media_id: "carousel-video", kind: "video_thumbnail", ordinal: 1,
      alt_text: "carousel video alt" },
    { source_media_id: "shared-quote", kind: "image", ordinal: 0, alt_text: null },
    { source_media_id: "shared-quote", kind: "image", ordinal: 0, alt_text: null },
  ]);
  assert.equal(await db.prepare(
    `SELECT pending_quote_count FROM threads_sync_jobs
     WHERE threads_post_id = ? AND generation = 1`,
  ).bind(sync.threadsPostId).first("pending_quote_count"), 0);
  assert.equal(await db.prepare(
    `SELECT status FROM threads_sync_jobs WHERE threads_post_id = ? AND generation = 1`,
  ).bind(sync.threadsPostId).first("status"), "media_pending");
  assert.equal(harness.captureMessages.length, 0);
  assert.doesNotMatch(JSON.stringify(harness.mediaMessages), /sourceUrl|scontent/);
});

test("conversation cursor loops terminate while stale generations and bounded 429 retries stay safe", async () => {
  const db = (await harness.worker.getEnv()).PROD_DB;
  const sync = await createThreadsSync(
    db, harness.captureQueue,
    "https://www.threads.com/@meta/post/ConversationLoop", 4_100,
  );
  const root = rawThreadsMedia("loop-root", "ConversationLoop");
  await harness.setProviderMode({
    threadsProfilePages: [{ data: [root] }],
    threadsConversationPages: [
      { data: [], nextCursor: "loop-cursor" },
      { data: [], nextCursor: "loop-cursor" },
    ],
  });
  await harness.drainCaptureQueue({ nowSeconds: 4_101 });
  assert.deepEqual(await db.prepare(
    `SELECT p.status, p.error_code, j.status AS job_status, j.error_code AS job_error_code
     FROM threads_posts p JOIN threads_sync_jobs j ON j.threads_post_id = p.id
     WHERE p.id = ? AND j.generation = 1`,
  ).bind(sync.threadsPostId).first(), {
    status: "partial", error_code: "threads_provider_protocol_error",
    job_status: "error", job_error_code: "threads_provider_protocol_error",
  });

  /** @type {Array<{ method: string, path: string }>} */
  const calls = [];
  await db.prepare(
    "UPDATE threads_sync_jobs SET status = 'error' WHERE threads_post_id = ? AND generation = 1",
  ).bind(sync.threadsPostId).run();
  const current = await createThreadsSync(
    db, harness.captureQueue,
    "https://www.threads.com/@meta/post/ConversationLoop", 4_102,
  );
  assert.equal(current.generation, 2);
  const stale = harness.captureMessages.shift();
  const staleResult = await handleThreadsCaptureMessage({
    version: 1, type: "resolve-post", postId: sync.threadsPostId, generation: 1, cursor: null,
  }, {
    db, captureQueue: harness.captureQueue, mediaQueue: harness.mediaQueue,
    fetcher: providerFixture({ calls }), getAccessToken: async () => ({ accessToken: "token" }),
    nowSeconds: 4_103, deleteArchive: async () => ({ action: "ack" }),
  });
  assert.deepEqual(staleResult, { action: "ack" });
  assert.deepEqual(calls, []);
  if (!stale) throw new Error("test_current_capture_message_missing");
  const limited = await handleThreadsCaptureMessage(stale, {
    db, captureQueue: harness.captureQueue, mediaQueue: harness.mediaQueue,
    fetcher: providerFixture({ threadsStatus: { profile_lookup: 429 },
      threadsRetryAfter: "9999" }),
    getAccessToken: async () => ({ accessToken: "token" }), nowSeconds: 4_104,
    deleteArchive: async () => ({ action: "ack" }),
  });
  assert.deepEqual(limited, { action: "retry", delaySeconds: 900 });
});

test("capture consumer recovers profile, conversation, quote, and finalization crash windows", async () => {
  const db = (await harness.worker.getEnv()).PROD_DB;
  /** @param {typeof fetch} fetcher */
  const dependencies = (fetcher) => ({
    db, captureQueue: harness.captureQueue, mediaQueue: harness.mediaQueue, fetcher,
    getAccessToken: async () => ({ accessToken: "token" }), nowSeconds: 4_200,
    deleteArchive: async () => ({ action: "ack" }),
  });

  const profileSync = await createThreadsSync(
    db, harness.captureQueue, "https://www.threads.com/@meta/post/ProfileCrash", 4_201,
  );
  const profileMessage = harness.captureMessages.shift();
  if (!profileMessage) throw new Error("test_profile_message_missing");
  /** @type {Array<{ method: string, path: string }>} */
  const profileCalls = [];
  const profileFetcher = providerFixture({ calls: profileCalls,
    threadsProfilePages: [{ data: [], nextCursor: "profile-recovered" }] });
  await harness.setQueueMode({ captureReject: true });
  assert.deepEqual(await handleThreadsCaptureMessage(profileMessage,
    dependencies(profileFetcher)), { action: "retry", delaySeconds: 1 });
  assert.equal(await db.prepare(
    `SELECT profile_cursor FROM threads_sync_jobs WHERE threads_post_id = ? AND generation = 1`,
  ).bind(profileSync.threadsPostId).first("profile_cursor"), "profile-recovered");
  const profileCallCount = profileCalls.length;
  await harness.setQueueMode({});
  assert.deepEqual(await handleThreadsCaptureMessage(profileMessage,
    dependencies(profileFetcher)), { action: "ack" });
  assert.equal(profileCalls.length, profileCallCount);
  assert.deepEqual(harness.captureMessages, [{
    version: 1, type: "resolve-post", postId: profileSync.threadsPostId,
    generation: 1, cursor: "profile-recovered",
  }]);
  harness.captureMessages.length = 0;

  await seedThreadsArchive(db, {
    id: "profile-crash-existing", shortcode: "ProfileCrashExisting",
    threadsMediaId: "historical-profile-root", submittedUrl:
      "https://www.threads.com/@meta/post/ProfileCrashExisting",
    canonicalUrl: "https://www.threads.com/@meta/post/ProfileCrashExisting",
    status: "ready", jobStatus: "ready", rootEntryId: "historical-profile-entry",
    createdAt: 4_205, updatedAt: 4_205,
  });
  const existing = await createThreadsSync(
    db, harness.captureQueue,
    "https://www.threads.com/@meta/post/ProfileCrashExisting", 4_206,
  );
  const existingMessage = harness.captureMessages.shift();
  if (!existingMessage) throw new Error("test_existing_profile_message_missing");
  const existingFetcher = providerFixture({
    threadsProfilePages: [{ data: [], nextCursor: "existing-profile-recovered" }],
  });
  await harness.setQueueMode({ captureReject: true });
  assert.deepEqual(await handleThreadsCaptureMessage(existingMessage,
    dependencies(existingFetcher)), { action: "retry", delaySeconds: 1 });
  await harness.setQueueMode({});
  assert.deepEqual(await handleThreadsCaptureMessage(existingMessage,
    dependencies(existingFetcher)), { action: "ack" });
  assert.deepEqual(harness.captureMessages, [{
    version: 1, type: "resolve-post", postId: existing.threadsPostId,
    generation: 2, cursor: "existing-profile-recovered",
  }]);
  harness.captureMessages.length = 0;

  const conversationSync = await createThreadsSync(
    db, harness.captureQueue, "https://www.threads.com/@meta/post/ConversationCrash", 4_210,
  );
  harness.captureMessages.length = 0;
  await claimThreadsJob(db, conversationSync.threadsPostId, 1, "resolving");
  await saveResolvedThreadsRoot(db, {
    postId: conversationSync.threadsPostId, generation: 1, profile: profile(),
    root: media("conversation-crash-root", "author-1", {
      rootPostId: null, repliedToId: null,
      permalink: "https://www.threads.com/@meta/post/ConversationCrash",
    }), profileCursor: null, conversationCursor: null, nowSeconds: 4_211,
  });
  const conversationMessage = {
    version: 1, type: "collect-conversation", postId: conversationSync.threadsPostId,
    generation: 1, cursor: null,
  };
  /** @type {Array<{ method: string, path: string }>} */
  const conversationCalls = [];
  const conversationFetcher = providerFixture({ calls: conversationCalls,
    threadsConversationPages: [{ data: [rawThreadsMedia(
      "conversation-crash-reply", "ConversationCrashReply", "author-1", {
        is_quote_post: true, quoted_post: { id: "conversation-crash-quote" },
      },
    )], nextCursor: "conversation-recovered" }] });
  await harness.setQueueMode({ captureReject: true });
  assert.deepEqual(await handleThreadsCaptureMessage(conversationMessage,
    dependencies(conversationFetcher)), { action: "retry", delaySeconds: 1 });
  assert.equal(await db.prepare(
    `SELECT conversation_cursor FROM threads_sync_jobs
     WHERE threads_post_id = ? AND generation = 1`,
  ).bind(conversationSync.threadsPostId).first("conversation_cursor"),
  "conversation-recovered");
  const conversationCallCount = conversationCalls.length;
  await harness.setQueueMode({});
  assert.deepEqual(await handleThreadsCaptureMessage(conversationMessage,
    dependencies(conversationFetcher)), { action: "ack" });
  assert.equal(conversationCalls.length, conversationCallCount);
  assert.deepEqual(harness.captureMessages, [
    { version: 1, type: "collect-conversation", postId: conversationSync.threadsPostId,
      generation: 1, cursor: "conversation-recovered" },
    { version: 1, type: "collect-quote", postId: conversationSync.threadsPostId,
      generation: 1, entryId: await db.prepare(
        `SELECT id FROM threads_entries WHERE threads_post_id = ?
         AND source_media_id = 'conversation-crash-reply'`,
      ).bind(conversationSync.threadsPostId).first("id"),
      quoteId: "conversation-crash-quote" },
  ]);
  harness.captureMessages.length = 0;

  const finalSync = await createThreadsSync(
    db, harness.captureQueue, "https://www.threads.com/@meta/post/FinalizeCrash", 4_220,
  );
  harness.captureMessages.length = 0;
  await claimThreadsJob(db, finalSync.threadsPostId, 1, "resolving");
  await saveResolvedThreadsRoot(db, {
    postId: finalSync.threadsPostId, generation: 1, profile: profile(),
    root: media("final-crash-root", "author-1", {
      rootPostId: null, repliedToId: null,
      permalink: "https://www.threads.com/@meta/post/FinalizeCrash",
    }), profileCursor: null, conversationCursor: "final-cursor", nowSeconds: 4_221,
  });
  await saveThreadsConversationPage(db, {
    postId: finalSync.threadsPostId, generation: 1, expectedCursor: null,
    entries: [], nextCursor: "final-cursor", nowSeconds: 4_221,
  });
  const finalMessage = { version: 1, type: "collect-conversation",
    postId: finalSync.threadsPostId, generation: 1, cursor: "final-cursor" };
  /** @type {Array<{ method: string, path: string }>} */
  const finalCalls = [];
  const finalFetcher = providerFixture({ calls: finalCalls,
    threadsConversationPages: { "final-cursor": { data: [] } } });
  await harness.setQueueMode({ captureReject: true });
  assert.deepEqual(await handleThreadsCaptureMessage(finalMessage,
    dependencies(finalFetcher)), { action: "retry", delaySeconds: 1 });
  const finalCallCount = finalCalls.length;
  await harness.setQueueMode({});
  assert.deepEqual(await handleThreadsCaptureMessage(finalMessage,
    dependencies(finalFetcher)), { action: "ack" });
  assert.equal(finalCalls.length, finalCallCount);
  assert.deepEqual(harness.captureMessages, [{
    version: 1, type: "finalize-content", postId: finalSync.threadsPostId, generation: 1,
  }]);
});

test("capture DLQ terminalizes only the current generation and source loss preserves snapshots", async () => {
  const db = (await harness.worker.getEnv()).PROD_DB;
  const empty = await createThreadsSync(
    db, harness.captureQueue, "https://threads.net/t/DlqEmpty", 4_300,
  );
  assert.deepEqual(await handleThreadsCaptureDeadLetter(harness.captureMessages.shift(), {
    db, nowSeconds: 4_301,
  }), { action: "ack" });
  assert.equal(await db.prepare(
    "SELECT status FROM threads_posts WHERE id = ?",
  ).bind(empty.threadsPostId).first("status"), "error");

  await seedThreadsArchive(db, {
    id: "dlq-snapshot", shortcode: "DlqSnapshot", threadsMediaId: "dlq-root",
    status: "ready", jobStatus: "ready", rootEntryId: "dlq-root-entry",
    createdAt: 4_302, updatedAt: 4_302,
  });
  const current = await createThreadsSync(
    db, harness.captureQueue, "https://threads.net/t/DlqSnapshot", 4_303,
  );
  harness.captureMessages.length = 0;
  assert.deepEqual(await handleThreadsCaptureDeadLetter({
    version: 1, type: "resolve-post", postId: current.threadsPostId,
    generation: 1, cursor: null,
  }, { db, nowSeconds: 4_304 }), { action: "ack" });
  assert.equal(await db.prepare(
    "SELECT status FROM threads_posts WHERE id = 'dlq-snapshot'",
  ).first("status"), "pending");
  assert.deepEqual(await handleThreadsCaptureDeadLetter({
    version: 1, type: "resolve-post", postId: current.threadsPostId,
    generation: 2, cursor: null,
  }, { db, nowSeconds: 4_305 }), { action: "ack" });
  assert.deepEqual(await db.prepare(
    "SELECT status, error_code FROM threads_posts WHERE id = 'dlq-snapshot'",
  ).first(), { status: "partial", error_code: "queue_retries_exhausted" });
  assert.equal(await db.prepare(
    "SELECT text FROM threads_entries WHERE id = 'dlq-root-entry'",
  ).first("text"), "Archived root");

  await seedThreadsArchive(db, {
    id: "unavailable-snapshot", shortcode: "UnavailableSnapshot",
    threadsMediaId: "unavailable-root", status: "ready", jobStatus: "ready",
    rootEntryId: "unavailable-root-entry", createdAt: 4_306, updatedAt: 4_306,
  });
  const unavailable = await createThreadsSync(
    db, harness.captureQueue, "https://threads.net/t/UnavailableSnapshot", 4_307,
  );
  const unavailableMessage = harness.captureMessages.pop();
  assert.deepEqual(await handleThreadsCaptureMessage(unavailableMessage, {
    db, captureQueue: harness.captureQueue, mediaQueue: harness.mediaQueue,
    fetcher: providerFixture({ threadsStatus: { profile_lookup: 404 } }),
    getAccessToken: async () => ({ accessToken: "token" }), nowSeconds: 4_308,
    deleteArchive: async () => ({ action: "ack" }),
  }), { action: "ack" });
  assert.deepEqual(await db.prepare(
    "SELECT status, error_code FROM threads_posts WHERE id = 'unavailable-snapshot'",
  ).first(), { status: "partial", error_code: "threads_post_unavailable" });
  assert.equal(await db.prepare(
    "SELECT text FROM threads_entries WHERE id = 'unavailable-root-entry'",
  ).first("text"), "Archived root");

  let deleted = 0;
  assert.deepEqual(await handleThreadsCaptureMessage({
    version: 1, type: "delete-archive", postId: "delete-delegate",
  }, { deleteArchive: async () => { deleted += 1; return { action: "ack" }; } }),
  { action: "ack" });
  assert.equal(deleted, 1);
  assert.deepEqual(await handleThreadsCaptureMessage({
    version: 1, type: "delete-archive", postId: "delete-delegate",
  }, { deleteArchive: async () => { throw new Error("temporary delete failure"); } }),
  { action: "retry", delaySeconds: 1 });
});

test("capture consumer terminalizes an unavailable quote once and drains poison work at 500", async () => {
  const db = (await harness.worker.getEnv()).PROD_DB;
  const sync = await createThreadsSync(
    db, harness.captureQueue, "https://www.threads.com/@meta/post/UnavailableQuote", 4_400,
  );
  harness.captureMessages.length = 0;
  await claimThreadsJob(db, sync.threadsPostId, 1, "resolving");
  const saved = await saveResolvedThreadsRoot(db, {
    postId: sync.threadsPostId, generation: 1, profile: profile(),
    root: media("unavailable-quote-root", "author-1", {
      rootPostId: null, repliedToId: null, quotedPostId: "missing-quote",
      permalink: "https://www.threads.com/@meta/post/UnavailableQuote",
    }), profileCursor: null, conversationCursor: null, nowSeconds: 4_401,
  });
  assert.equal(saved.quoteWork.length, 1);
  assert.equal((await saveThreadsConversationPage(db, {
    postId: sync.threadsPostId, generation: 1, expectedCursor: null,
    entries: [], nextCursor: null, nowSeconds: 4_401,
  })).applied, true);
  const quoteMessage = {
    version: 1, type: "collect-quote", postId: sync.threadsPostId, generation: 1,
    entryId: saved.quoteWork[0].parentEntryId, quoteId: saved.quoteWork[0].quoteId,
  };
  const dependencies = {
    db, captureQueue: harness.captureQueue, mediaQueue: harness.mediaQueue,
    fetcher: providerFixture({ threadsStatus: { media: 404 }, threadsMedia: {
      "missing-quote": rawThreadsMedia("missing-quote", "MissingQuote"),
    } }),
    getAccessToken: async () => ({ accessToken: "token" }), nowSeconds: 4_402,
    deleteArchive: async () => ({ action: "ack" }),
  };
  assert.deepEqual(await handleThreadsCaptureMessage(quoteMessage, dependencies),
    { action: "ack" });
  assert.deepEqual(await db.prepare(
    `SELECT quote_status, quote_error_code, quote_generation FROM threads_entries
     WHERE id = ?`,
  ).bind(saved.quoteWork[0].parentEntryId).first(), {
    quote_status: "error", quote_error_code: "threads_quote_unavailable",
    quote_generation: 1,
  });
  assert.equal(await db.prepare(
    `SELECT pending_quote_count FROM threads_sync_jobs
     WHERE threads_post_id = ? AND generation = 1`,
  ).bind(sync.threadsPostId).first("pending_quote_count"), 0);
  assert.deepEqual(harness.captureMessages, [{
    version: 1, type: "finalize-content", postId: sync.threadsPostId, generation: 1,
  }]);
  await db.prepare(
    `UPDATE threads_authors SET profile_media_status = 'ready'
     WHERE threads_user_id = 'author-1'`,
  ).run();
  assert.deepEqual(await handleThreadsCaptureMessage(harness.captureMessages.shift(),
    dependencies), { action: "ack" });
  assert.deepEqual(await db.prepare(
    `SELECT p.status, p.error_code, j.status AS job_status, j.error_code AS job_error_code
     FROM threads_posts p JOIN threads_sync_jobs j ON j.threads_post_id = p.id
     WHERE p.id = ? AND j.generation = 1`,
  ).bind(sync.threadsPostId).first(), {
    status: "partial", error_code: "threads_quote_unavailable",
    job_status: "partial", job_error_code: "threads_quote_unavailable",
  });

  assert.deepEqual(await handleThreadsCaptureMessage({ version: 2, type: "bad" }, {
    get db() { throw new Error("invalid message touched D1"); },
    get fetcher() { throw new Error("invalid message touched provider"); },
  }), { action: "ack" });
  await harness.captureQueue.send({
    version: 1, type: "delete-archive", postId: "poison-delete",
  });
  await assert.rejects(harness.drainCaptureQueue({
    deleteArchive: async () => ({ action: "retry", delaySeconds: 1 }),
  }), (error) => error instanceof Error &&
    error.message === "test_capture_queue_did_not_quiesce");
  assert.equal(harness.captureMessages.length, 1);
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
    `UPDATE threads_sync_jobs SET status = 'collecting', conversation_started = 0,
       conversation_completed = 0 WHERE threads_post_id = 'post-11'`,
  ).run();
  await saveThreadsConversationPage(db, {
    postId: "post-11", generation: 1, expectedCursor: null,
    entries, nextCursor: null, nowSeconds: 100,
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
    media: [mediaDescriptor(root.id, "root-1", "image", 0, "root alt")],
  });
  await saveThreadsConversationPage(db, {
    postId: sync.threadsPostId, generation: 1, expectedCursor: null,
    entries: [], nextCursor: null, nowSeconds: 3_001,
  });
  const rootEntryId = await db.prepare(
    "SELECT id FROM threads_entries WHERE threads_post_id = ? AND kind = 'root'",
  ).bind(sync.threadsPostId).first("id");
  const finalizeInput = {
    postId: sync.threadsPostId, generation: 1, nowSeconds: 3_002,
  };
  assert.equal((await finalizeThreadsContent(db, harness.mediaQueue, finalizeInput)).status, "media_pending");
  assert.equal(harness.mediaMessages.length, 2);
  await finalizeThreadsContent(db, harness.mediaQueue, finalizeInput);
  assert.equal(harness.mediaMessages.length, 4);
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

/** @param {D1Database} db @param {string} id @param {number} createdAt @param {string} [jobStatus] */
async function seedCollisionCandidate(db, id, createdAt, jobStatus = "resolving") {
  return seedThreadsArchive(db, {
    id, shortcode: `${id}Short`, threadsMediaId: null,
    submittedUrl: `https://threads.net/t/${id}Short`, canonicalUrl: null,
    status: "collecting", authorId: `${id}-seed-author`, username: id,
    displayName: id, rootEntryId: `${id}-unused-root`, withRoot: false,
    jobStatus, profileCompleted: false, conversationStarted: false,
    conversationCompleted: false, createdAt, updatedAt: createdAt,
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
  assert.deepEqual(await saveResolvedThreadsRoot(db, {
    postId: "newer-local", generation: 1, profile: profile("provider-owner", "provider"),
    root: collisionRoot(), profileCursor: null, conversationCursor: null, nowSeconds: 21,
  }), SAVED_NO_QUOTES);
  assert.deepEqual(await saveResolvedThreadsRoot(db, {
    postId: "older-local", generation: 1, profile: profile("provider-owner", "provider"),
    root: collisionRoot(), profileCursor: null, conversationCursor: null, nowSeconds: 22,
  }), SAVED_NO_QUOTES);
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
  assert.deepEqual(await saveResolvedThreadsRoot(db, {
    postId: "older-local", generation: 1, profile: profile("provider-owner", "provider"),
    root: collisionRoot(), profileCursor: null, conversationCursor: null, nowSeconds: 21,
  }), SAVED_NO_QUOTES);
  assert.deepEqual(await saveResolvedThreadsRoot(db, {
    postId: "newer-local", generation: 1, profile: profile("provider-owner", "provider"),
    root: collisionRoot(), profileCursor: null, conversationCursor: null, nowSeconds: 22,
  }), NOT_SAVED);
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
  await db.prepare(
    `INSERT INTO threads_media
       (id, entry_id, source_media_id, kind, ordinal, alt_text, status, created_at, updated_at)
     VALUES (?, ?, ?, 'image', 0, ?, 'pending', 10, 10)`,
  ).bind(`${id}-media`, row.rootEntryId, row.threadsMediaId, `${id} alt`).run();
  return { postId: id, generation: 1, nowSeconds: 20 };
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

/** @param {D1Database} db */
async function collisionPairSnapshot(db) {
  return {
    posts: await db.prepare(
      `SELECT * FROM threads_posts WHERE id IN ('older-local','newer-local') ORDER BY id`,
    ).all().then((result) => result.results),
    jobs: await db.prepare(
      `SELECT * FROM threads_sync_jobs
       WHERE threads_post_id IN ('older-local','newer-local')
       ORDER BY threads_post_id, generation`,
    ).all().then((result) => result.results),
  };
}

/** @param {D1Database} db @param {string} winnerJobStatus */
async function assertTerminalWinnerJobCannotClaim(db, winnerJobStatus) {
  await seedCollisionCandidate(db, "older-local", 10, winnerJobStatus);
  await seedCollisionCandidate(db, "newer-local", 20);
  assert.deepEqual(await saveResolvedThreadsRoot(db, {
    postId: "newer-local", generation: 1, profile: profile("provider-owner", "provider"),
    root: collisionRoot(), profileCursor: null, conversationCursor: null, nowSeconds: 21,
  }), SAVED_NO_QUOTES);
  const initialSnapshot = await collisionPairSnapshot(db);
  let beforeBatchSnapshot;
  const intercepted = interceptFirstBatch(db, async () => {
    beforeBatchSnapshot = await collisionPairSnapshot(db);
  });
  assert.deepEqual(await saveResolvedThreadsRoot(intercepted, {
    postId: "older-local", generation: 1, profile: profile("provider-owner", "provider"),
    root: collisionRoot(), profileCursor: null, conversationCursor: null, nowSeconds: 22,
  }), NOT_SAVED);
  if (!beforeBatchSnapshot) throw new Error("test_collision_claim_snapshot_missing");
  assert.deepEqual(beforeBatchSnapshot, initialSnapshot);
  assert.deepEqual(await collisionPairSnapshot(db), beforeBatchSnapshot);
  assert.equal(await db.prepare(
    "SELECT threads_media_id FROM threads_posts WHERE id = 'older-local'",
  ).first("threads_media_id"), null);
  assert.equal(await db.prepare(
    "SELECT threads_media_id FROM threads_posts WHERE id = 'newer-local'",
  ).first("threads_media_id"), "provider-shared-root");
  assert.equal(await db.prepare(
    "SELECT COUNT(*) AS count FROM threads_posts WHERE threads_media_id LIKE 'claim:%'",
  ).first("count"), 0);
}

for (const winnerJobStatus of ["media_pending", "ready", "partial", "error"]) {
  test(`Threads collision claim rejects initial ${winnerJobStatus} winner job before batch`, async () => {
    const db = (await harness.worker.getEnv()).PROD_DB;
    await assertTerminalWinnerJobCannotClaim(db, winnerJobStatus);
  });
}

/** @param {D1Database} db @param {() => Promise<unknown>} mutateLoser */
async function assertLoserRaceIsAllOrNothing(db, mutateLoser) {
  await seedCollisionCandidate(db, "older-local", 10);
  await seedCollisionCandidate(db, "newer-local", 20);
  assert.deepEqual(await saveResolvedThreadsRoot(db, {
    postId: "newer-local", generation: 1, profile: profile("provider-owner", "provider"),
    root: collisionRoot(), profileCursor: null, conversationCursor: null, nowSeconds: 21,
  }), SAVED_NO_QUOTES);
  let racedSnapshot;
  const raced = interceptFirstBatch(db, async () => {
    await mutateLoser();
    racedSnapshot = await collisionPairSnapshot(db);
  });
  assert.deepEqual(await saveResolvedThreadsRoot(raced, {
    postId: "older-local", generation: 1, profile: profile("provider-owner", "provider"),
    root: collisionRoot(), profileCursor: null, conversationCursor: null, nowSeconds: 22,
  }), NOT_SAVED);
  if (!racedSnapshot) throw new Error("test_collision_race_snapshot_missing");
  assert.deepEqual(await collisionPairSnapshot(db), racedSnapshot);
  assert.equal(await db.prepare(
    "SELECT threads_media_id FROM threads_posts WHERE id = 'older-local'",
  ).first("threads_media_id"), null);
  assert.equal(await db.prepare(
    "SELECT threads_media_id FROM threads_posts WHERE id = 'newer-local'",
  ).first("threads_media_id"), "provider-shared-root");
  assert.equal(await db.prepare(
    "SELECT COUNT(*) AS count FROM threads_posts WHERE threads_media_id LIKE 'claim:%'",
  ).first("count"), 0);
}

test("Threads collision loser race rejects a generation change before winner claim", async () => {
  const db = (await harness.worker.getEnv()).PROD_DB;
  await assertLoserRaceIsAllOrNothing(db, () => db.prepare(
    "UPDATE threads_posts SET sync_generation = 2 WHERE id = 'newer-local'",
  ).run());
});

test("Threads collision loser race rejects a non-deleting post-state change before winner claim", async () => {
  const db = (await harness.worker.getEnv()).PROD_DB;
  await assertLoserRaceIsAllOrNothing(db, () => db.prepare(
    "UPDATE threads_posts SET status = 'partial' WHERE id = 'newer-local'",
  ).run());
});

test("Threads collision loser race rejects a current-job status change before winner claim", async () => {
  const db = (await harness.worker.getEnv()).PROD_DB;
  await assertLoserRaceIsAllOrNothing(db, () => db.prepare(
    `UPDATE threads_sync_jobs SET status = 'ready'
     WHERE threads_post_id = 'newer-local' AND generation = 1`,
  ).run());
});

test("Threads collision loser race rejects deletion before winner claim", async () => {
  const db = (await harness.worker.getEnv()).PROD_DB;
  await assertLoserRaceIsAllOrNothing(db, () => db.prepare(
    "UPDATE threads_posts SET status = 'deleting' WHERE id = 'newer-local'",
  ).run());
});

test("Threads collision race leaves the newer owner untouched when the older winner becomes stale", async () => {
  const db = (await harness.worker.getEnv()).PROD_DB;
  await seedCollisionCandidate(db, "older-local", 10);
  await seedCollisionCandidate(db, "newer-local", 20);
  assert.deepEqual(await saveResolvedThreadsRoot(db, {
    postId: "newer-local", generation: 1, profile: profile("provider-owner", "provider"),
    root: collisionRoot(), profileCursor: null, conversationCursor: null, nowSeconds: 21,
  }), SAVED_NO_QUOTES);
  const loserBefore = await collisionLoserSnapshot(db);
  const raced = interceptFirstBatch(db, () => db.prepare(
    "UPDATE threads_posts SET sync_generation = 2 WHERE id = 'older-local'",
  ).run());
  assert.deepEqual(await saveResolvedThreadsRoot(raced, {
    postId: "older-local", generation: 1, profile: profile("provider-owner", "provider"),
    root: collisionRoot(), profileCursor: null, conversationCursor: null, nowSeconds: 22,
  }), NOT_SAVED);
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
  assert.deepEqual(await saveResolvedThreadsRoot(db, {
    postId: "newer-local", generation: 1, profile: profile("provider-owner", "provider"),
    root: collisionRoot(), profileCursor: null, conversationCursor: null, nowSeconds: 21,
  }), SAVED_NO_QUOTES);
  const loserBefore = await collisionLoserSnapshot(db);
  const raced = interceptFirstBatch(db, () => db.prepare(
    "UPDATE threads_posts SET status = 'deleting' WHERE id = 'older-local'",
  ).run());
  assert.deepEqual(await saveResolvedThreadsRoot(raced, {
    postId: "older-local", generation: 1, profile: profile("provider-owner", "provider"),
    root: collisionRoot(), profileCursor: null, conversationCursor: null, nowSeconds: 22,
  }), NOT_SAVED);
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
  ).first("count"), 1);
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
  ).first("count"), 1);
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
  await db.prepare(
    `INSERT INTO threads_media
       (id, entry_id, source_media_id, kind, ordinal, status, created_at, updated_at)
     VALUES ('partial-media-queue-thumb', 'partial-media-queue-root-entry',
       'partial-media-queue-source', 'video_thumbnail', 1, 'pending', 10, 10)`,
  ).run();
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
    jobStatus: "collecting", profileCompleted: true, conversationStarted: false,
    conversationCompleted: false, createdAt: 10, updatedAt: 10,
  });
  await saveThreadsConversationPage(db, {
    postId: row.id, generation: 1, expectedCursor: null,
    nextCursor: null, nowSeconds: 20,
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

/** @param {D1Database} db @param {{ postId?: string, shortcode?: string,
 * entryId?: string, media?: Array<{ id: string, sourceId: string,
 * kind: "image" | "video" | "video_thumbnail", ordinal: number }> }} [options] */
async function seedPendingMedia(db, options = {}) {
  const postId = options.postId ?? "media-post-1";
  const entryId = options.entryId ?? "media-entry-1";
  const mediaRows = options.media ?? [
    { id: "local-image", sourceId: "source-image", kind: "image", ordinal: 0 },
    { id: "local-video", sourceId: "source-video", kind: "video", ordinal: 1 },
    { id: "local-thumb", sourceId: "source-video", kind: "video_thumbnail", ordinal: 2 },
  ];
  await seedThreadsArchive(db, {
    id: postId, shortcode: options.shortcode ?? "MediaPostOne",
    threadsMediaId: "media-root-1", status: "collecting", jobStatus: "media_pending",
    rootEntryId: entryId, rootMediaType: "CAROUSEL_ALBUM", createdAt: 5_000,
    updatedAt: 5_000,
  });
  await db.prepare(
    `UPDATE threads_sync_jobs SET content_completed_at = 5000,
       expected_entry_count = 1, expected_media_count = ?, capture_lease = NULL
     WHERE threads_post_id = ? AND generation = 1`,
  ).bind(mediaRows.length + 1, postId).run();
  for (const row of mediaRows) await db.prepare(
    `INSERT INTO threads_media
       (id, entry_id, source_media_id, kind, ordinal, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'pending', 5000, 5000)`,
  ).bind(row.id, entryId, row.sourceId, row.kind, row.ordinal).run();
  return { postId, entryId, mediaRows };
}

/** @param {D1Database} db @param {typeof fetch} fetcher @param {Record<string, unknown>} [overrides] */
function mediaDependencies(db, fetcher, overrides = {}) {
  return {
    db, bucket: harness.mediaBucket, fetcher,
    getAccessToken: async () => ({ accessToken: "long-token" }),
    recalculateStatus: recalculateThreadsStatus, nowSeconds: 5_100, ...overrides,
  };
}

test("Threads media streams entry and profile objects before marking D1 ready and redelivery converges", async () => {
  const db = (await harness.worker.getEnv()).PROD_DB;
  const seeded = await seedPendingMedia(db);
  const fetcher = providerFixture({
    threadsMedia: {
      "source-image": rawThreadsMedia("source-image", "MediaImage", "author-1", {
        media_type: "IMAGE", media_url:
          "https://scontent.cdninstagram.com/media-image",
      }),
      "source-video": rawThreadsMedia("source-video", "MediaVideo", "author-1", {
        media_type: "VIDEO", media_url:
          "https://video.fbcdn.net/media-video", thumbnail_url:
          "https://scontent.cdninstagram.com/media-thumb",
      }),
    },
    mediaBodies: {
      "media-image": new Blob(["image"], { type: "image/jpeg" }),
      "media-video": new Blob(["video"], { type: "video/mp4" }),
      "media-thumb": new Blob(["thumb"], { type: "image/webp" }),
      "fixture-avatar": new Blob(["avatar"], { type: "image/png" }),
    },
  });
  let observedPending = false;
  const orderedBucket = {
    ...harness.mediaBucket,
    /** @param {string} key @param {ReadableStream<Uint8Array>} body
     * @param {{ httpMetadata: { contentType?: string } }} metadata */
    async put(key, body, metadata) {
      observedPending = observedPending || Number(await db.prepare(
        "SELECT COUNT(*) AS count FROM threads_media WHERE status = 'pending'",
      ).first("count")) > 0;
      return harness.mediaBucket.put(key, body, metadata);
    },
  };
  const dependencies = mediaDependencies(db, fetcher, { bucket: orderedBucket });
  for (const row of seeded.mediaRows) assert.deepEqual(await handleThreadsMediaMessage({
    version: 1, type: "archive-entry-media", postId: seeded.postId, generation: 1,
    entryId: seeded.entryId, mediaId: row.id,
  }, dependencies), { action: "ack" });
  assert.deepEqual(await handleThreadsMediaMessage({
    version: 1, type: "archive-profile", postId: seeded.postId, generation: 1,
    authorId: "author-1",
  }, dependencies), { action: "ack" });
  assert.equal(observedPending, true);
  assert.deepEqual(await db.prepare(
    `SELECT id, status, r2_key, content_type, bytes, etag, attempt_count
     FROM threads_media ORDER BY ordinal`,
  ).all().then((result) => result.results), [
    { id: "local-image", status: "ready",
      r2_key: "threads/posts/media-post-1/source-image/image-0",
      content_type: "image/jpeg", bytes: 5, etag: '"r2-5"', attempt_count: 1 },
    { id: "local-video", status: "ready",
      r2_key: "threads/posts/media-post-1/source-video/video-1",
      content_type: "video/mp4", bytes: 5, etag: '"r2-5"', attempt_count: 1 },
    { id: "local-thumb", status: "ready",
      r2_key: "threads/posts/media-post-1/source-video/video_thumbnail-2",
      content_type: "image/webp", bytes: 5, etag: '"r2-5"', attempt_count: 1 },
  ]);
  assert.deepEqual(await db.prepare(
    `SELECT profile_media_status, profile_r2_key, profile_content_type,
       profile_bytes, profile_etag FROM threads_authors WHERE threads_user_id = 'author-1'`,
  ).first(), {
    profile_media_status: "ready", profile_r2_key: "threads/authors/author-1/profile",
    profile_content_type: "image/png", profile_bytes: 6, profile_etag: '"r2-6"',
  });
  assert.equal(await db.prepare(
    "SELECT status FROM threads_sync_jobs WHERE threads_post_id = ?",
  ).bind(seeded.postId).first("status"), "ready");
  assert.equal(harness.mediaObjects().length, 4);
  assert.doesNotMatch(JSON.stringify(await db.prepare(
    "SELECT * FROM threads_media",
  ).all().then((result) => result.results)), /cdninstagram|fbcdn/);

  const before = structuredClone(harness.mediaObjects());
  assert.deepEqual(await handleThreadsMediaMessage({
    version: 1, type: "archive-entry-media", postId: seeded.postId, generation: 1,
    entryId: seeded.entryId, mediaId: "local-image",
  }, dependencies), { action: "ack" });
  assert.deepEqual(harness.mediaObjects(), before);
  assert.equal(await db.prepare(
    "SELECT attempt_count FROM threads_media WHERE id = 'local-image'",
  ).first("attempt_count"), 1);
});

test("Threads media removes an uncommitted R2 object when deletion wins after put", async () => {
  const db = (await harness.worker.getEnv()).PROD_DB;
  const seeded = await seedPendingMedia(db, { media: [
    { id: "delete-race-media", sourceId: "delete-race-source", kind: "image", ordinal: 0 },
  ] });
  const fetcher = providerFixture({
    threadsMedia: {
      "delete-race-source": rawThreadsMedia(
        "delete-race-source", "DeleteRaceSource", "author-1", {
          media_type: "IMAGE", media_url:
            "https://scontent.cdninstagram.com/delete-race",
        },
      ),
    },
    mediaBodies: {
      "delete-race": new Blob(["race"], { type: "image/jpeg" }),
    },
  });
  const bucket = {
    ...harness.mediaBucket,
    /** @param {string} key @param {ReadableStream<Uint8Array>} body
     * @param {{ httpMetadata: { contentType?: string } }} metadata */
    async put(key, body, metadata) {
      const result = await harness.mediaBucket.put(key, body, metadata);
      await db.prepare(
        "UPDATE threads_posts SET status = 'deleting' WHERE id = ?",
      ).bind(seeded.postId).run();
      return result;
    },
  };
  assert.deepEqual(await handleThreadsMediaMessage({
    version: 1, type: "archive-entry-media", postId: seeded.postId, generation: 1,
    entryId: seeded.entryId, mediaId: "delete-race-media",
  }, mediaDependencies(db, fetcher, { bucket })), { action: "ack" });
  assert.deepEqual(harness.mediaObjects(), []);
  assert.deepEqual(await db.prepare(
    "SELECT status, r2_key FROM threads_media WHERE id = 'delete-race-media'",
  ).first(), { status: "pending", r2_key: null });
});

test("Threads media retry reacquires a fresh provider URL and terminal corruption makes only that item partial", async () => {
  const db = (await harness.worker.getEnv()).PROD_DB;
  const seeded = await seedPendingMedia(db, { media: [
    { id: "fresh-media", sourceId: "fresh-source", kind: "image", ordinal: 0 },
    { id: "corrupt-media", sourceId: "corrupt-source", kind: "image", ordinal: 1 },
  ] });
  await db.prepare(
    `UPDATE threads_authors SET profile_media_status = 'ready',
       profile_r2_key = 'threads/authors/author-1/profile', profile_content_type = 'image/png',
       profile_bytes = 1, profile_etag = '"profile"' WHERE threads_user_id = 'author-1'`,
  ).run();
  let detailCalls = 0;
  /** @type {string[]} */
  const cdnCalls = [];
  /** @param {RequestInfo | URL} input @param {RequestInit} [init] */
  const freshFetcher = async (input, init = {}) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === "https://graph.threads.net") {
      detailCalls += 1;
      return Response.json(rawThreadsMedia("fresh-source", "FreshSource", "author-1", {
        media_type: "IMAGE", media_url: detailCalls === 1 ?
          "https://scontent.cdninstagram.com/expired" :
          "https://scontent.cdninstagram.com/fresh",
      }));
    }
    cdnCalls.push(url.pathname);
    if (url.pathname === "/expired") return new Response(null, { status: 503 });
    return new Response(new Blob(["fresh"], { type: "image/jpeg" }));
  };
  const message = {
    version: 1, type: "retry-media", postId: seeded.postId, generation: 1,
    mediaId: "fresh-media",
  };
  const dependencies = mediaDependencies(db, freshFetcher);
  assert.deepEqual(await handleThreadsMediaMessage(message, dependencies),
    { action: "retry", delaySeconds: 1 });
  assert.deepEqual(await handleThreadsMediaMessage(message, dependencies),
    { action: "ack" });
  assert.deepEqual(cdnCalls, ["/expired", "/fresh"]);
  assert.equal(await db.prepare(
    "SELECT attempt_count FROM threads_media WHERE id = 'fresh-media'",
  ).first("attempt_count"), 2);

  const corruptFetcher = providerFixture({
    threadsMedia: {
      "corrupt-source": rawThreadsMedia("corrupt-source", "CorruptSource", "author-1", {
        media_type: "IMAGE", media_url:
          "https://scontent.cdninstagram.com/corrupt",
      }),
    },
    mediaBodies: { corrupt: {
      body: new Uint8Array([1, 2, 3]),
      headers: { "Content-Type": "image/jpeg", "Content-Length": "4" },
    } },
  });
  assert.deepEqual(await handleThreadsMediaMessage({
    version: 1, type: "archive-entry-media", postId: seeded.postId, generation: 1,
    entryId: seeded.entryId, mediaId: "corrupt-media",
  }, mediaDependencies(db, corruptFetcher)), { action: "ack" });
  assert.deepEqual(await db.prepare(
    "SELECT status, error_code FROM threads_media WHERE id = 'corrupt-media'",
  ).first(), { status: "error", error_code: "media_byte_mismatch" });
  assert.equal(await db.prepare(
    "SELECT status FROM threads_media WHERE id = 'fresh-media'",
  ).first("status"), "ready");
  assert.equal(await db.prepare(
    "SELECT status FROM threads_sync_jobs WHERE threads_post_id = ?",
  ).bind(seeded.postId).first("status"), "partial");

  const recovered = providerFixture({
    threadsMedia: {
      "corrupt-source": rawThreadsMedia("corrupt-source", "CorruptSource", "author-1", {
        media_type: "IMAGE", media_url:
          "https://scontent.cdninstagram.com/recovered",
      }),
    },
    mediaBodies: { recovered: new Blob(["fixed"], { type: "image/jpeg" }) },
  });
  assert.deepEqual(await handleThreadsMediaMessage({
    version: 1, type: "retry-media", postId: seeded.postId, generation: 1,
    mediaId: "corrupt-media",
  }, mediaDependencies(db, recovered)), { action: "ack" });
  assert.deepEqual(await db.prepare(
    `SELECT status, ready_media_count, failed_media_count
     FROM threads_sync_jobs WHERE threads_post_id = ?`,
  ).bind(seeded.postId).first(), {
    status: "ready", ready_media_count: 3, failed_media_count: 0,
  });
});

test("profile media failure and media DLQ terminalize current pending items but preserve ready objects", async () => {
  const db = (await harness.worker.getEnv()).PROD_DB;
  const seeded = await seedPendingMedia(db, { media: [
    { id: "dlq-ready", sourceId: "ready-source", kind: "image", ordinal: 0 },
    { id: "dlq-pending", sourceId: "pending-source", kind: "image", ordinal: 1 },
  ] });
  const ready = await harness.mediaBucket.put(
    "threads/posts/media-post-1/ready-source/image-0",
    new Blob(["ready"], { type: "image/jpeg" }).stream(),
    { httpMetadata: { contentType: "image/jpeg" } },
  );
  await db.prepare(
    `UPDATE threads_media SET status = 'ready', r2_key = ?, content_type = 'image/jpeg',
       bytes = ?, etag = ? WHERE id = 'dlq-ready'`,
  ).bind(ready.key, ready.size, ready.httpEtag).run();
  const dependencies = mediaDependencies(db, providerFixture({ mediaBodies: {
    "fixture-avatar": new Blob(["not-an-image"], { type: "text/plain" }),
  } }));
  assert.deepEqual(await handleThreadsMediaMessage({
    version: 1, type: "archive-profile", postId: seeded.postId, generation: 1,
    authorId: "author-1",
  }, dependencies), { action: "ack" });
  assert.deepEqual(await db.prepare(
    `SELECT profile_media_status, profile_error_code FROM threads_authors
     WHERE threads_user_id = 'author-1'`,
  ).first(), { profile_media_status: "error", profile_error_code: "invalid_media_mime" });

  assert.deepEqual(await handleThreadsMediaDeadLetter({
    version: 1, type: "archive-entry-media", postId: seeded.postId, generation: 1,
    entryId: seeded.entryId, mediaId: "dlq-ready",
  }, dependencies), { action: "ack" });
  assert.equal(await db.prepare(
    "SELECT status FROM threads_media WHERE id = 'dlq-ready'",
  ).first("status"), "ready");
  assert.ok(harness.mediaObjects().some((object) => object.key === ready.key));

  assert.deepEqual(await handleThreadsMediaDeadLetter({
    version: 1, type: "retry-media", postId: seeded.postId, generation: 1,
    mediaId: "dlq-pending",
  }, dependencies), { action: "ack" });
  assert.deepEqual(await db.prepare(
    "SELECT status, error_code FROM threads_media WHERE id = 'dlq-pending'",
  ).first(), { status: "error", error_code: "media_retries_exhausted" });
  assert.deepEqual(await db.prepare(
    `SELECT status, ready_media_count, failed_media_count
     FROM threads_sync_jobs WHERE threads_post_id = ?`,
  ).bind(seeded.postId).first(), {
    status: "partial", ready_media_count: 1, failed_media_count: 2,
  });
});

test("Threads media serves archive-scoped full HEAD and one exact range with private headers", async () => {
  const db = (await harness.worker.getEnv()).PROD_DB;
  const seeded = await seedPendingMedia(db, { media: [
    { id: "serve-media", sourceId: "serve-source", kind: "video", ordinal: 0 },
  ] });
  const object = await harness.mediaBucket.put(
    "threads/posts/media-post-1/serve-source/video-0",
    new Blob(["0123456789"], { type: "video/mp4" }).stream(),
    { httpMetadata: { contentType: "video/mp4" } },
  );
  await db.prepare(
    `UPDATE threads_media SET status = 'ready', r2_key = ?, content_type = 'video/mp4',
       bytes = ?, etag = ? WHERE id = 'serve-media'`,
  ).bind(object.key, object.size, object.httpEtag).run();
  const url = `https://app.test/threads/${seeded.postId}/media/serve-media`;
  const common = {
    "accept-ranges": "bytes", "cache-control": "private, no-cache",
    "content-disposition": "inline", "content-length": "10",
    "content-type": "video/mp4", etag: '"r2-10"',
    "x-content-type-options": "nosniff",
  };
  const full = await serveThreadsMedia(new Request(url), {
    db, bucket: harness.mediaBucket,
  });
  assert.equal(full.status, 200);
  for (const [name, value] of Object.entries(common))
    assert.equal(full.headers.get(name), value, name);
  assert.equal(await full.text(), "0123456789");

  await harness.setR2Mode({ getReject: true });
  const head = await serveThreadsMedia(new Request(url, { method: "HEAD" }), {
    db, bucket: harness.mediaBucket,
  });
  assert.equal(head.status, 200);
  assert.equal(head.body, null);
  assert.equal(head.headers.get("content-length"), "10");
  await harness.setR2Mode({});

  const range = await serveThreadsMedia(new Request(url, {
    headers: { Range: "bytes=2-5" },
  }), { db, bucket: harness.mediaBucket });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get("content-range"), "bytes 2-5/10");
  assert.equal(range.headers.get("content-length"), "4");
  assert.equal(await range.text(), "2345");

  for (const raw of ["bytes=20-30", "bytes=0-1,4-5"]) {
    const invalid = await serveThreadsMedia(new Request(url, {
      headers: { Range: raw },
    }), { db, bucket: harness.mediaBucket });
    assert.equal(invalid.status, 416);
    assert.equal(invalid.headers.get("content-range"), "bytes */10");
  }
  assert.equal((await serveThreadsMedia(new Request(
    "https://app.test/threads/another-post/media/serve-media",
  ), { db, bucket: harness.mediaBucket })).status, 404);
  await db.prepare(
    "UPDATE threads_media SET status = 'error' WHERE id = 'serve-media'",
  ).run();
  assert.equal((await serveThreadsMedia(new Request(url), {
    db, bucket: harness.mediaBucket,
  })).status, 404);
});

/** @param {D1Database} db @param {string} id @param {string} entryId @param {string} key */
async function seedDeletingArchive(db, id, entryId, key) {
  await seedThreadsArchive(db, {
    id, shortcode: id, threadsMediaId: `${id}-source`, status: "deleting",
    authorId: "shared-delete-author", username: "shared", displayName: "Shared",
    rootEntryId: entryId, createdAt: id.endsWith("a") ? 6_000 : 6_001,
    updatedAt: 6_010,
  });
  await db.prepare(
    `INSERT INTO threads_media
       (id, entry_id, source_media_id, kind, ordinal, status, r2_key,
        content_type, bytes, etag, created_at, updated_at)
     VALUES (?, ?, ?, 'image', 0, 'ready', ?, 'image/jpeg', 1, '"entry"', 6000, 6000)`,
  ).bind(`${id}-media`, entryId, `${id}-source`, key).run();
}

/** @param {string} postId */
const deletingEntryKey = (postId) =>
  `threads/posts/${postId}/${postId}-source/image-0`;

test("Threads deletion keeps shared profiles until unreferenced and concurrent archive order converges", async () => {
  const db = (await harness.worker.getEnv()).PROD_DB;
  const profileKey = "threads/authors/shared-delete-author/profile";
  await seedDeletingArchive(db, "delete-a", "delete-entry-a", deletingEntryKey("delete-a"));
  await seedDeletingArchive(db, "delete-b", "delete-entry-b", deletingEntryKey("delete-b"));
  await db.prepare(
    `UPDATE threads_authors SET profile_media_status = 'ready', profile_r2_key = ?,
       profile_content_type = 'image/jpeg', profile_bytes = 1, profile_etag = '"profile"'
     WHERE threads_user_id = 'shared-delete-author'`,
  ).bind(profileKey).run();
  for (const key of [
    deletingEntryKey("delete-a"), deletingEntryKey("delete-b"), profileKey,
  ]) await harness.mediaBucket.put(
    key, new Blob(["x"], { type: "image/jpeg" }).stream(),
    { httpMetadata: { contentType: "image/jpeg" } },
  );
  assert.deepEqual(await deleteThreadsArchive({ type: "delete-archive", postId: "delete-a" }, {
    db, bucket: harness.mediaBucket,
  }), { action: "ack" });
  assert.equal(await db.prepare(
    "SELECT COUNT(*) AS count FROM threads_posts WHERE id = 'delete-a'",
  ).first("count"), 1);
  const firstDelete = await deleteThreadsArchive({
    version: 1, type: "delete-archive", postId: "delete-a",
  }, {
    db, bucket: harness.mediaBucket,
  });
  assert.equal(await db.prepare(
    "SELECT COUNT(*) AS count FROM threads_posts WHERE id = 'delete-a'",
  ).first("count"), 0);
  assert.deepEqual(firstDelete, { action: "ack" });
  assert.equal(await db.prepare(
    "SELECT profile_media_status FROM threads_authors WHERE threads_user_id = 'shared-delete-author'",
  ).first("profile_media_status"), "ready");
  assert.ok(harness.mediaObjects().some((object) => object.key === profileKey));
  assert.deepEqual(await deleteThreadsArchive({
    version: 1, type: "delete-archive", postId: "delete-b",
  }, {
    db, bucket: harness.mediaBucket,
  }), { action: "ack" });
  assert.equal(await db.prepare(
    "SELECT COUNT(*) AS count FROM threads_authors WHERE threads_user_id = 'shared-delete-author'",
  ).first("count"), 0);
  assert.deepEqual(harness.mediaObjects(), []);

  await seedDeletingArchive(db, "delete-concurrent-a", "delete-concurrent-entry-a",
    deletingEntryKey("delete-concurrent-a"));
  await seedDeletingArchive(db, "delete-concurrent-b", "delete-concurrent-entry-b",
    deletingEntryKey("delete-concurrent-b"));
  await db.prepare(
    `UPDATE threads_authors SET profile_media_status = 'ready', profile_r2_key = ?,
       profile_content_type = 'image/jpeg', profile_bytes = 1, profile_etag = '"profile"'
     WHERE threads_user_id = 'shared-delete-author'`,
  ).bind(profileKey).run();
  for (const key of [
    deletingEntryKey("delete-concurrent-a"),
    deletingEntryKey("delete-concurrent-b"), profileKey,
  ]) await harness.mediaBucket.put(
    key, new Blob(["x"], { type: "image/jpeg" }).stream(),
    { httpMetadata: { contentType: "image/jpeg" } },
  );
  const results = await Promise.all(["delete-concurrent-a", "delete-concurrent-b"].map(
    (postId) => deleteThreadsArchive({ version: 1, type: "delete-archive", postId }, {
      db, bucket: harness.mediaBucket,
    }),
  ));
  assert.deepEqual(results, [{ action: "ack" }, { action: "ack" }]);
  assert.equal(await db.prepare(
    "SELECT COUNT(*) AS count FROM threads_posts WHERE id LIKE 'delete-concurrent-%'",
  ).first("count"), 0);
  assert.equal(await db.prepare(
    "SELECT COUNT(*) AS count FROM threads_authors WHERE threads_user_id = 'shared-delete-author'",
  ).first("count"), 0);
  assert.deepEqual(harness.mediaObjects(), []);
});

test("Threads deletion leaves tombstones on object failure and retries a deleting profile after its post is gone", async () => {
  const db = (await harness.worker.getEnv()).PROD_DB;
  const entryKey = deletingEntryKey("delete-retry");
  await seedDeletingArchive(db, "delete-retry", "delete-retry-entry", entryKey);
  await harness.mediaBucket.put(
    entryKey, new Blob(["x"], { type: "image/jpeg" }).stream(),
    { httpMetadata: { contentType: "image/jpeg" } },
  );
  await harness.setR2Mode({ deleteReject: true });
  assert.deepEqual(await deleteThreadsArchive({
    version: 1, type: "delete-archive", postId: "delete-retry",
  }, {
    db, bucket: harness.mediaBucket,
  }), { action: "retry", delaySeconds: 1 });
  assert.equal(await db.prepare(
    "SELECT status FROM threads_posts WHERE id = 'delete-retry'",
  ).first("status"), "deleting");
  await harness.setR2Mode({});

  const profileKey = "threads/authors/shared-delete-author/profile";
  await harness.mediaBucket.put(
    profileKey, new Blob(["p"], { type: "image/jpeg" }).stream(),
    { httpMetadata: { contentType: "image/jpeg" } },
  );
  await db.prepare(
    `UPDATE threads_authors SET profile_media_status = 'ready', profile_r2_key = ?,
       profile_content_type = 'image/jpeg', profile_bytes = 1, profile_etag = '"p"'
     WHERE threads_user_id = 'shared-delete-author'`,
  ).bind(profileKey).run();
  let rejectProfile = true;
  const bucket = {
    ...harness.mediaBucket,
    /** @param {string} key */
    async delete(key) {
      if (key === profileKey && rejectProfile) throw new Error("test_profile_delete_rejection");
      return harness.mediaBucket.delete(key);
    },
  };
  assert.deepEqual(await deleteThreadsArchive({
    version: 1, type: "delete-archive", postId: "delete-retry",
  }, {
    db, bucket,
  }), { action: "retry", delaySeconds: 1 });
  assert.equal(await db.prepare(
    "SELECT COUNT(*) AS count FROM threads_posts WHERE id = 'delete-retry'",
  ).first("count"), 0);
  assert.deepEqual(await db.prepare(
    `SELECT profile_media_status, profile_r2_key FROM threads_authors
     WHERE threads_user_id = 'shared-delete-author'`,
  ).first(), { profile_media_status: "deleting", profile_r2_key: profileKey });
  rejectProfile = false;
  assert.deepEqual(await deleteThreadsArchive({
    version: 1, type: "delete-archive", postId: "delete-retry",
  }, {
    db, bucket,
  }), { action: "ack" });
  assert.equal(await db.prepare(
    "SELECT COUNT(*) AS count FROM threads_authors WHERE threads_user_id = 'shared-delete-author'",
  ).first("count"), 0);
  assert.equal(harness.mediaObjects().length, 0);
});

test("delete-object removes only an exact D1-referenced key and media drain is bounded", async () => {
  const db = (await harness.worker.getEnv()).PROD_DB;
  const seeded = await seedPendingMedia(db, { media: [
    { id: "object-media", sourceId: "object-source", kind: "image", ordinal: 0 },
  ] });
  const referenced = "threads/posts/media-post-1/object-source/image-0";
  const unreferenced = "threads/unreferenced";
  for (const key of [referenced, unreferenced]) await harness.mediaBucket.put(
    key, new Blob(["x"], { type: "image/jpeg" }).stream(),
    { httpMetadata: { contentType: "image/jpeg" } },
  );
  await db.prepare(
    `UPDATE threads_media SET status = 'ready', r2_key = ?, content_type = 'image/jpeg',
       bytes = 1, etag = '"x"' WHERE id = 'object-media'`,
  ).bind(referenced).run();
  const dependencies = mediaDependencies(db, providerFixture());
  assert.deepEqual(await handleThreadsMediaMessage({
    version: 1, type: "delete-object", objectKey: unreferenced,
  }, dependencies), { action: "ack" });
  assert.ok(harness.mediaObjects().some((object) => object.key === unreferenced));
  assert.deepEqual(await handleThreadsMediaMessage({
    version: 1, type: "delete-object", objectKey: referenced,
  }, dependencies), { action: "ack" });
  assert.equal(harness.mediaObjects().some((object) => object.key === referenced), false);

  void seeded;
  harness.mediaMessages.push(...Array.from({ length: 501 }, () => ({})));
  await assert.rejects(harness.drainMediaQueue(),
    /test_media_queue_did_not_quiesce/);
});
