import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { startHarness } from "../support/harness.js";

let harness;
before(async () => { harness = await startHarness(); });
beforeEach(async () => { await harness.reset(); });
after(async () => { await harness.close(); });

test("0004 creates the normalized Threads archive schema", async () => {
  const env = await harness.worker.getEnv();
  const tables = await env.PROD_DB.prepare(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'threads_%' ORDER BY name",
  ).all();
  assert.deepEqual(tables.results.map((row) => row.name), [
    "threads_authors", "threads_entries", "threads_links", "threads_media",
    "threads_oauth_credentials", "threads_posts", "threads_sync_jobs",
  ]);
  const indexes = await env.PROD_DB.prepare(
    "SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'threads_entries' ORDER BY name",
  ).all();
  assert.ok(indexes.results.some((row) => row.name === "threads_entries_primary_source_idx"));
  assert.ok(indexes.results.some((row) => row.name === "threads_entries_quote_source_idx"));
  for (const table of ["threads_entries", "threads_media", "threads_links", "threads_sync_jobs"]) {
    const foreignKeys = await env.PROD_DB.prepare(`PRAGMA foreign_key_list(${table})`).all();
    assert.ok(foreignKeys.results.some((row) => row.on_delete === "CASCADE"), table);
  }
});

test("Threads entries enforce identity, quote parents, cascades, and OAuth singleton", async () => {
  const db = await harness.worker.getEnv().then((env) => env.PROD_DB);
  await db.prepare("INSERT INTO threads_authors (threads_user_id, username, display_name) VALUES ('author', 'author', 'Author'), ('reply', 'reply', 'Reply')").run();
  await db.prepare("INSERT INTO threads_posts (id, shortcode, submitted_url, status, root_author_id) VALUES ('post', 'short', 'https://www.threads.net/t/short', 'ready', 'author')").run();
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
