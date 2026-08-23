# Threads Post Archive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a separate authenticated Threads archive that captures public root posts, every reply authored by the root author, one quote level, links, author identity, and durable image/video/profile binaries in private R2 storage.

**Architecture:** Keep one Cloudflare Worker and add focused Threads domain, provider, OAuth, archive-store, capture-queue, and media modules. HTTP submission creates an idempotent D1 sync generation, a capture Queue walks official Meta API cursors, and independent media Queue messages stream provider media into private R2 so item failures remain partial and retryable.

**Tech Stack:** Node.js 24.18.0, native JavaScript ESM with checked JSDoc, Cloudflare Workers, D1, R2, Queues/DLQ, Web Crypto, semantic server-rendered HTML, native CSS, browser ESM, Node test runner, Wrangler test harness, and Playwright.

**Spec:** `docs/superpowers/specs/2026-08-24-threads-post-archive-design.md`

## Global Constraints

- Execute in an isolated worktree created with `superpowers:using-git-worktrees`; do not implement in the current dirty root checkout.
- Begin only after `migrations/0002_repository_activity.sql` and `migrations/0003_repository_notes.sql` plus their source/tests are committed and green. Preserve those contracts and add `migrations/0004_threads_archive.sql` after them.
- Keep Node.js at `24.18.0`, Wrangler at `4.114.0`, TypeScript at `7.0.2`, and the existing zero production `dependencies` contract.
- Do not add a frontend framework, router, ORM, OpenAI/Meta SDK, build step, CDN asset, embed script, HTML scraper, or third-party media downloader.
- Request exactly `threads_basic`, `threads_profile_discovery`, and `threads_read_replies`; never request Threads publishing, management, deletion, search, mention, or insight scopes.
- Archive only the root post, root-author replies at every depth and count, and one quote level. Exclude every other user's replies and keep nested quotes as a permalink only.
- Treat existing entry text and ready media as immutable. A sync adds unseen root-author replies and refreshes profile data; it never mirrors source deletion.
- Keep R2 private. The browser accesses archived media only through an authenticated same-origin Worker route.
- Preserve the existing `SameSite=Strict` PIN session. Authenticate the cross-site OAuth callback only with the ten-minute signed `SameSite=Lax` OAuth-state cookie created by an authenticated connect request.
- Use strict input/body/query/response schemas, fixed safe error codes/copy, CSRF on mutations, provider/CDN allowlists, bounded redirects, redacted telemetry, and streaming instead of buffering media.
- Follow red-green-refactor. Every task must finish with its focused tests and all previously green tests passing before its commit.
- Do not deploy or provision Cloudflare/Meta resources until Task 12's full verification and explicit release workflow gates pass.

---

## File Structure

### Create

- `migrations/0004_threads_archive.sql` — normalized Threads archive, job, media, author, link, and encrypted credential schema.
- `src/threads-domain.js` — pure URL/query/link normalization and Queue-message validation.
- `src/threads-api.js` — official Meta token/read endpoints, redirects, pagination, response limits, and strict provider mapping.
- `src/threads-oauth.js` — state-cookie signing, AES-GCM token storage, connect/callback completion, access-token retrieval, refresh, and disconnect.
- `src/threads.js` — D1 archive reads/writes, sync generations, content persistence, aggregation, deletion leases, and typed Queue production.
- `src/threads-capture.js` — capture Queue/DLQ state machine and provider traversal.
- `src/thread-media.js` — R2 archive Queue/DLQ work, CDN validation, streaming writes, authenticated range reads, and cleanup.
- `public/assets/threads.css` — `/threads` and Threads detail responsive presentation.
- `public/assets/thread-capture.js` — enhanced URL submission and returned-card navigation.
- `public/assets/thread-panel.js` — status polling, reply expansion, item retry, sync, and delete-dialog behavior.
- `test/unit/threads-domain.test.js` — pure domain tests.
- `test/unit/threads-api.test.js` — official provider contract tests.
- `test/unit/threads-oauth.test.js` — state/cipher/token lifecycle tests.
- `test/unit/thread-media.test.js` — media URL, byte, range, and response tests.
- `test/integration/threads.test.js` — migration, D1 store, generation, capture, media, and deletion integration tests.
- `test/integration/threads-app.test.js` — authenticated Threads HTTP/OAuth/Queue/scheduled route tests.
- `test/e2e/threads.spec.js` — enhanced, mobile, accessibility, and no-JavaScript archive workflows.

### Modify

- `src/worker.js` — bindings, routing, handlers, CSP, telemetry envelope, assets, Queue and scheduled exports.
- `src/html.js` — shared Repository/Threads navigation and Threads list/detail renderers.
- `src/telemetry.js` — safe Threads route templates/provider dimensions only.
- `public/assets/app.js` and `public/modulepreload.json` — import and preload Threads browser modules.
- `test/support/harness.js` — Threads provider modes, Queue drains, R2 access, OAuth values, and seed helpers.
- `test/support/provider-fixture-worker.js` — exact Graph Threads/CDN/OAuth fixture boundaries.
- `test/unit/html.test.js`, `test/unit/interface-policy.test.js`, `test/unit/browser-gates.test.js`, `test/unit/provider-fixture-worker.test.js`, `test/unit/worker.test.js`, `test/unit/telemetry.test.js`, and `test/unit/source-policy.test.js` — rendering, asset, browser, CSP, boundary, route, and redaction assertions.
- `test/integration/app.test.js` and `test/integration/repositories.test.js` — unchanged Repository regression and migration inventory.
- `test/e2e/accessibility.spec.js`, `test/e2e/native-no-js.spec.js`, `test/e2e/responsive.spec.js`, and `test/e2e/release-smoke.spec.js` — shared-navigation, new-page, and deployed-resource coverage.
- `wrangler.jsonc` and `worker-configuration.d.ts` — exact R2, Queue/DLQ, cron, vars, and secret types.
- `scripts/release.mjs`, `test/unit/release.test.js`, `test/unit/workflow-policy.test.js`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `.github/workflows/rollback.yml`, and `docs/operations/release.md` — immutable release resource/secret/migration verification.
- `README.md` — local fixture setup and Threads resource/scope documentation.

---

### Task 1: Add the normalized Threads archive schema

**Files:**
- Create: `migrations/0004_threads_archive.sql`
- Create: `test/integration/threads.test.js`
- Modify: `test/integration/repositories.test.js`
- Test: `test/integration/threads.test.js`

**Interfaces:**
- Consumes: committed migrations `0001_initial.sql`, `0002_repository_activity.sql`, and `0003_repository_notes.sql`.
- Produces: D1 tables `threads_authors`, `threads_posts`, `threads_entries`, `threads_links`, `threads_media`, `threads_sync_jobs`, and `threads_oauth_credentials`, with the indexes and cascades used by Tasks 4-12.

- [ ] **Step 1: Write the failing migration inventory test**

Add a focused test that queries `sqlite_schema`, `PRAGMA foreign_key_list`, and `PRAGMA index_list`. Assert all seven new tables exist, `threads_entries` and `threads_media` cascade from their parents, and the two partial entry-identity indexes have distinct names.

```js
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
});
```

Update the existing global migration-table expectation to include `repository_notes` and these seven tables without weakening its exact comparison.

- [ ] **Step 2: Run the migration tests and verify the red state**

Run:

```powershell
node --test --test-name-pattern="Threads archive schema|migration creates" test/integration/threads.test.js test/integration/repositories.test.js
```

Expected: FAIL because `0004_threads_archive.sql` and its tables do not exist.

- [ ] **Step 3: Create the migration with exact constraints**

Create `migrations/0004_threads_archive.sql` with this schema. Keep the two partial entry indexes: one source identity for root/reply entries and one parent-scoped identity for repeated quotes.

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE threads_authors (
  threads_user_id TEXT PRIMARY KEY NOT NULL,
  username TEXT NOT NULL,
  display_name TEXT NOT NULL,
  profile_media_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (profile_media_status IN ('pending', 'ready', 'error')),
  profile_r2_key TEXT,
  profile_content_type TEXT,
  profile_etag TEXT,
  profile_bytes INTEGER CHECK (profile_bytes IS NULL OR profile_bytes >= 0),
  profile_error_code TEXT,
  profile_refreshed_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE threads_posts (
  id TEXT PRIMARY KEY NOT NULL,
  shortcode TEXT NOT NULL UNIQUE,
  threads_media_id TEXT UNIQUE,
  submitted_url TEXT NOT NULL,
  canonical_url TEXT,
  root_author_id TEXT REFERENCES threads_authors(threads_user_id),
  status TEXT NOT NULL CHECK (status IN ('pending','collecting','ready','partial','error','deleting')),
  error_code TEXT,
  sync_generation INTEGER NOT NULL DEFAULT 1 CHECK (sync_generation >= 1),
  last_successful_sync_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX threads_posts_order_idx ON threads_posts(created_at DESC, id DESC);
CREATE INDEX threads_posts_status_order_idx ON threads_posts(status, created_at DESC, id DESC);
CREATE INDEX threads_posts_author_idx ON threads_posts(root_author_id, id);

CREATE TABLE threads_entries (
  id TEXT PRIMARY KEY NOT NULL,
  threads_post_id TEXT NOT NULL REFERENCES threads_posts(id) ON DELETE CASCADE,
  source_media_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('root','author_reply','quote')),
  parent_entry_id TEXT REFERENCES threads_entries(id) ON DELETE CASCADE,
  source_parent_media_id TEXT,
  author_id TEXT NOT NULL REFERENCES threads_authors(threads_user_id),
  text TEXT NOT NULL DEFAULT '',
  permalink TEXT,
  published_at TEXT NOT NULL,
  media_type TEXT NOT NULL CHECK (media_type IN ('TEXT_POST','IMAGE','VIDEO','CAROUSEL_ALBUM','REPOST_FACADE')),
  alt_text TEXT,
  nested_quote_permalink TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  CHECK ((kind = 'quote' AND parent_entry_id IS NOT NULL) OR
         (kind != 'quote' AND parent_entry_id IS NULL))
);

CREATE UNIQUE INDEX threads_entries_primary_source_idx
ON threads_entries(threads_post_id, source_media_id)
WHERE kind IN ('root','author_reply');
CREATE UNIQUE INDEX threads_entries_quote_source_idx
ON threads_entries(threads_post_id, parent_entry_id, source_media_id)
WHERE kind = 'quote';
CREATE INDEX threads_entries_reply_order_idx
ON threads_entries(threads_post_id, published_at, source_media_id)
WHERE kind = 'author_reply';

CREATE TABLE threads_links (
  id TEXT PRIMARY KEY NOT NULL,
  entry_id TEXT NOT NULL REFERENCES threads_entries(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('body','attachment')),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  UNIQUE(entry_id, url)
);

CREATE TABLE threads_media (
  id TEXT PRIMARY KEY NOT NULL,
  entry_id TEXT NOT NULL REFERENCES threads_entries(id) ON DELETE CASCADE,
  source_media_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('image','video','video_thumbnail')),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  alt_text TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready','error')),
  r2_key TEXT,
  content_type TEXT,
  bytes INTEGER CHECK (bytes IS NULL OR bytes >= 0),
  etag TEXT,
  error_code TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(entry_id, source_media_id, kind, ordinal)
);

CREATE INDEX threads_media_entry_status_idx ON threads_media(entry_id, status, ordinal);

CREATE TABLE threads_sync_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  threads_post_id TEXT NOT NULL REFERENCES threads_posts(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  status TEXT NOT NULL CHECK (status IN ('queued','resolving','collecting','media_pending','ready','partial','error')),
  profile_cursor TEXT,
  conversation_cursor TEXT,
  pending_quote_count INTEGER NOT NULL DEFAULT 0 CHECK (pending_quote_count >= 0),
  expected_entry_count INTEGER NOT NULL DEFAULT 0 CHECK (expected_entry_count >= 0),
  expected_media_count INTEGER NOT NULL DEFAULT 0 CHECK (expected_media_count >= 0),
  ready_media_count INTEGER NOT NULL DEFAULT 0 CHECK (ready_media_count >= 0),
  failed_media_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_media_count >= 0),
  error_code TEXT,
  queued_at INTEGER NOT NULL,
  started_at INTEGER,
  content_completed_at INTEGER,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE(threads_post_id, generation)
);

CREATE INDEX threads_sync_jobs_status_idx ON threads_sync_jobs(status, updated_at, id);

CREATE TABLE threads_oauth_credentials (
  singleton_id INTEGER PRIMARY KEY NOT NULL CHECK (singleton_id = 1),
  provider_user_id TEXT NOT NULL,
  encrypted_access_token TEXT NOT NULL,
  token_nonce TEXT NOT NULL,
  scopes_json TEXT NOT NULL CHECK (json_valid(scopes_json) AND json_type(scopes_json) = 'array'),
  expires_at INTEGER NOT NULL,
  refreshed_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

- [ ] **Step 4: Add constraint and cascade cases**

In `test/integration/threads.test.js`, insert two author replies and the same quote under both parents, assert both quotes succeed, assert a duplicate quote under the same parent fails, delete the root archive, and assert entries/links/media/jobs are gone. Insert `singleton_id = 2` and assert the credential check fails.

- [ ] **Step 5: Run focused tests and all existing integration tests**

Run:

```powershell
node --test test/integration/threads.test.js
npm run test:integration
git diff --check
```

Expected: all commands PASS.

- [ ] **Step 6: Commit the schema slice**

```powershell
git add migrations/0004_threads_archive.sql test/integration/threads.test.js test/integration/repositories.test.js
git commit -m "feat: add Threads archive schema"
```

---

### Task 2: Add pure Threads URL, query, link, and message validation

**Files:**
- Create: `src/threads-domain.js`
- Create: `test/unit/threads-domain.test.js`
- Test: `test/unit/threads-domain.test.js`

**Interfaces:**
- Consumes: `AppError` from `src/domain.js`.
- Produces:
  - `normalizeThreadsUrl(raw) -> { kind, submittedUrl, canonicalUrl, username, shortcode }`
  - `parseThreadsListQuery(url) -> { page }`
  - `parseThreadsDetailQuery(url) -> { repliesPage }`
  - `extractThreadsLinks(text, attachmentUrl) -> Array<{ url, source, ordinal }>`
  - `validateCaptureMessage(raw)` and `validateMediaMessage(raw)` returning exact version-1 message objects.

- [ ] **Step 1: Write failing domain tests**

Cover canonical `threads.com`, legacy `threads.net`, `/t/{shortcode}`, whitespace, tracking query removal, fragments, NFC, duplicate query keys, malformed encoding, HTTP, credentials, explicit ports, lookalike hosts, extra path segments, unsafe link schemes, punctuation trimming, duplicate body/attachment links, and Queue messages with extra keys.

```js
assert.deepEqual(
  normalizeThreadsUrl(" https://www.threads.net/@Meta/post/AbC_12?xmt=tracking#top "),
  {
    kind: "canonical",
    submittedUrl: "https://www.threads.net/@Meta/post/AbC_12",
    canonicalUrl: "https://www.threads.com/@Meta/post/AbC_12",
    username: "Meta",
    shortcode: "AbC_12",
  },
);
assert.deepEqual(
  extractThreadsLinks("문서 https://example.com/a). 다시 https://example.com/a", "https://meta.com"),
  [
    { url: "https://example.com/a", source: "body", ordinal: 0 },
    { url: "https://meta.com/", source: "attachment", ordinal: 1 },
  ],
);
```

- [ ] **Step 2: Run the unit test and verify it fails**

Run:

```powershell
node --test test/unit/threads-domain.test.js
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/threads-domain.js`.

- [ ] **Step 3: Implement URL and query normalization**

Use exact hosts and path regexes; discard search/fragment only after validating HTTPS, empty credentials, and the default port.

```js
import { AppError } from "./domain.js";

const HOSTS = new Set(["threads.com", "www.threads.com", "threads.net", "www.threads.net"]);
const HANDLE = /^[A-Za-z0-9._]{1,64}$/;
const SHORTCODE = /^[A-Za-z0-9_-]{1,128}$/;

export function normalizeThreadsUrl(raw) {
  let url;
  try { url = new URL(String(raw).trim()); }
  catch { throw new AppError("invalid_threads_url", 400); }
  if (url.protocol !== "https:" || !HOSTS.has(url.hostname.toLowerCase()) ||
    url.username || url.password || url.port)
    throw new AppError("invalid_threads_url", 400);
  let parts;
  try { parts = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean).map(decodeURIComponent); }
  catch { throw new AppError("invalid_threads_url", 400); }
  const canonical = parts.length === 3 && parts[0].startsWith("@") && parts[1] === "post";
  const short = parts.length === 2 && parts[0] === "t";
  const username = canonical ? parts[0].slice(1).normalize("NFC") : null;
  const shortcode = (canonical ? parts[2] : short ? parts[1] : "").normalize("NFC");
  if ((!canonical && !short) || (username !== null && !HANDLE.test(username)) || !SHORTCODE.test(shortcode))
    throw new AppError("invalid_threads_url", 400);
  const submittedUrl = canonical
    ? `https://${url.hostname.toLowerCase()}/@${encodeURIComponent(username)}/post/${encodeURIComponent(shortcode)}`
    : `https://${url.hostname.toLowerCase()}/t/${encodeURIComponent(shortcode)}`;
  return {
    kind: canonical ? "canonical" : "short", submittedUrl,
    canonicalUrl: canonical
      ? `https://www.threads.com/@${encodeURIComponent(username)}/post/${encodeURIComponent(shortcode)}`
      : null,
    username, shortcode,
  };
}
```

Implement query parsers by rejecting every unknown/duplicated key and defaulting invalid or absent positive pages to 1. List accepts only `page`; detail accepts only `repliesPage`.

- [ ] **Step 4: Implement deterministic link and Queue-message validation**

Scan only explicit `http://` and `https://` text candidates, trim terminal sentence punctuation without changing URL-internal punctuation, normalize with `new URL`, allow only HTTP(S), deduplicate by normalized `href`, and append a non-duplicate attachment URL. Define closed key sets for every message type and reject extra/missing/type-invalid fields with `invalid_threads_queue_message`.

```js
const CAPTURE_TYPES = Object.freeze({
  "resolve-post": new Set(["version", "type", "postId", "generation", "cursor"]),
  "collect-conversation": new Set(["version", "type", "postId", "generation", "cursor"]),
  "collect-quote": new Set(["version", "type", "postId", "generation", "entryId", "quoteId"]),
  "finalize-content": new Set(["version", "type", "postId", "generation"]),
  "delete-archive": new Set(["version", "type", "postId"]),
});
```

Media message key sets cover `archive-entry-media`, `archive-profile`, `retry-media`, and `delete-object`. IDs must be non-empty strings, generations positive integers, cursors string-or-null, and `version` exactly 1.

- [ ] **Step 5: Run focused and aggregate unit checks**

Run:

```powershell
node --test test/unit/threads-domain.test.js
npm run check:types
npm run check:source
```

Expected: all commands PASS.

- [ ] **Step 6: Commit the domain slice**

```powershell
git add src/threads-domain.js test/unit/threads-domain.test.js
git commit -m "feat: validate Threads archive inputs"
```

---

### Task 3: Implement the official Threads provider client and fixture boundary

**Files:**
- Create: `src/threads-api.js`
- Create: `test/unit/threads-api.test.js`
- Modify: `test/support/harness.js`
- Modify: `test/support/provider-fixture-worker.js`
- Modify: `test/unit/provider-fixture-worker.test.js`
- Test: `test/unit/threads-api.test.js`

**Interfaces:**
- Consumes: normalized URL objects from Task 2, `AppError`, and an injected `fetcher`.
- Produces:
  - `THREADS_SCOPES = ["threads_basic", "threads_profile_discovery", "threads_read_replies"]`
  - `resolveThreadsPostUrl(fetcher, normalized, signal)`
  - `exchangeThreadsCode(fetcher, input)`, `exchangeLongLivedThreadsToken(fetcher, input)`, and `refreshThreadsAccessToken(fetcher, input)`
  - `fetchThreadsProfile(fetcher, input)`
  - `fetchThreadsProfilePostsPage(fetcher, input)`
  - `fetchThreadsMedia(fetcher, input)`
  - `fetchThreadsConversationPage(fetcher, input)`
  - strict mapped provider types named `ThreadsProfile`, `ThreadsMedia`, and `ThreadsPage` in JSDoc.

- [ ] **Step 1: Write provider contract tests first**

Test exact hosts, methods, bearer authorization, query fields, response byte caps, mapping, cursor extraction, retry-after conversion, timeouts, short-link redirect bounds, and rejection of unknown response keys/types. Include root, image, video, carousel children, quote, reply owner/root/replied-to, empty text, and omitted optional fields.

```js
const page = await fetchThreadsConversationPage(fetcher, {
  accessToken: "secret", mediaId: "root-1", after: "cursor-1",
  signal: AbortSignal.timeout(1000),
});
assert.deepEqual(page, {
  data: [{
    id: "reply-1", ownerId: "author-1", username: "meta", text: "reply",
    permalink: "https://www.threads.com/@meta/post/reply1",
    timestamp: "2026-08-24T00:00:00+0000", mediaType: "TEXT_POST",
    mediaUrl: null, thumbnailUrl: null, children: [], quotedPostId: null,
    linkAttachmentUrl: null, altText: null, rootPostId: "root-1", repliedToId: "root-1",
  }],
  nextCursor: null,
});
```

- [ ] **Step 2: Run the provider tests and verify they fail**

Run:

```powershell
node --test test/unit/threads-api.test.js test/unit/provider-fixture-worker.test.js
```

Expected: FAIL because the Threads client and fixture routes do not exist.

- [ ] **Step 3: Implement bounded request and response helpers**

Use `https://graph.threads.net/v1.0` and `Authorization: Bearer <token>`. Define `readJsonAtMost(response, 1_048_576)`, `plainObject`, exact-key validation, ISO timestamp validation, non-empty provider IDs, the closed media enum, and a `threadsProviderError(response)` mapper. Provider errors expose only fixed codes and an integer `retryAfter`; never include response bodies, request URLs, tokens, or query strings.

```js
export const THREADS_SCOPES = Object.freeze([
  "threads_basic", "threads_profile_discovery", "threads_read_replies",
]);
const GRAPH = "https://graph.threads.net/v1.0";
const MEDIA_FIELDS = [
  "id", "media_product_type", "media_type", "media_url", "permalink", "owner",
  "username", "text", "timestamp", "shortcode", "thumbnail_url", "children",
  "is_quote_post", "quoted_post", "link_attachment_url", "alt_text", "root_post", "replied_to",
].join(",");
```

Every exported operation accepts an `AbortSignal`; token endpoints send their documented parameters without logging them. Map `429` to `threads_rate_limited`, authentication/scope failures to `threads_reconnect_required`, provider `404`/restricted content to `threads_post_unavailable`, `5xx`/network to `threads_provider_unavailable`, and malformed success bodies to `threads_provider_protocol_error`.

- [ ] **Step 4: Implement redirect, page, profile, detail, conversation, and token calls**

`resolveThreadsPostUrl` returns canonical inputs unchanged. For short inputs, issue at most three manual GET redirects, require every `Location` to normalize as an allowed Threads URL, cancel unused bodies, and require a final canonical post shape.

Page functions return `{ data, nextCursor }`, where `nextCursor` comes only from a same-provider `paging.next` URL whose sole pagination value is `after`; reject repeated or malformed cursors in the capture layer. `fetchThreadsProfile` maps `id`, `username`, `name`, and `threads_profile_picture_url`. Token calls map only `access_token`, `user_id`, `token_type`, and `expires_in` as appropriate.

- [ ] **Step 5: Extend both provider fixtures with exact boundaries**

Add fixture routes for:

```text
GET  https://www.threads.com/t/RootShort
POST https://graph.threads.net/v1.0/oauth/access_token
GET  https://graph.threads.net/v1.0/access_token
GET  https://graph.threads.net/v1.0/refresh_access_token
GET  https://graph.threads.net/v1.0/profile_lookup
GET  https://graph.threads.net/v1.0/profile_posts
GET  https://graph.threads.net/v1.0/{media-id}
GET  https://graph.threads.net/v1.0/{media-id}/conversation
GET  https://scontent.cdninstagram.com/{fixture-object}
```

Reject every unexpected method, host, path, field projection, cursor, or authorization shape with `502 provider_fixture_unexpected_request`. Extend `providerFixture(options)` with `threadsProfilePages`, `threadsConversationPages`, `threadsMedia`, `threadsStatus`, `threadsRetryAfter`, `mediaBodies`, and `calls`; keep all existing GitHub/OpenAI defaults unchanged.

- [ ] **Step 6: Run provider, fixture, type, and source tests**

Run:

```powershell
node --test test/unit/threads-api.test.js test/unit/provider-fixture-worker.test.js
npm run check:types
npm run check:source
```

Expected: all commands PASS and fixture tests prove no request falls through to global fetch.

- [ ] **Step 7: Commit the provider slice**

```powershell
git add src/threads-api.js test/unit/threads-api.test.js test/support/harness.js test/support/provider-fixture-worker.js test/unit/provider-fixture-worker.test.js
git commit -m "feat: add official Threads API client"
```

---

### Task 4: Add OAuth state, encrypted credentials, refresh, and disconnect

**Files:**
- Create: `src/threads-oauth.js`
- Create: `test/unit/threads-oauth.test.js`
- Modify: `test/integration/threads.test.js`
- Modify: `test/support/harness.js`
- Test: `test/unit/threads-oauth.test.js`
- Test: `test/integration/threads.test.js`

**Interfaces:**
- Consumes: Task 3 token functions and `THREADS_SCOPES`; D1 `threads_oauth_credentials`; a 32-byte base64 `THREADS_TOKEN_KEY`.
- Produces:
  - `beginThreadsOAuth(input) -> { location, setCookie }`
  - `finishThreadsOAuth(db, input) -> { providerUserId, scopes, setCookie }`
  - `getThreadsAccessToken(db, input) -> { accessToken, providerUserId, expiresAt, scopes }`
  - `refreshStoredThreadsCredential(db, input) -> { refreshed, reconnectRequired }`
  - `disconnectThreads(db) -> boolean`
  - `clearThreadsOAuthCookie()`.

- [ ] **Step 1: Write failing state-cookie and cipher tests**

Use fixed crypto bytes by injecting `randomBytes`. Assert the state cookie is `__Host-threads_oauth_state`, Secure, HttpOnly, SameSite=Lax, Path=/, and Max-Age=600; the signed payload binds state/session nonce/expiry; altered/expired/wrong-state cookies fail; the PIN cookie is not required at callback. Assert two encryptions of one token use different nonces and decrypt correctly only with the configured key.

```js
const TOKEN_KEY = "cmVwby1hdGxhcy10aHJlYWRzLXRlc3Qta2V5LTAwMDE=";
const started = await beginThreadsOAuth({
  appId: "app-1", redirectUri: "https://app.test/threads/oauth/callback",
  sessionNonce: "pin-session-1", tokenKey: TOKEN_KEY, nowSeconds: 1000,
  randomBytes: (length) => new Uint8Array(length).fill(7),
});
assert.match(started.location, /^https:\/\/threads\.net\/oauth\/authorize\?/);
assert.match(started.setCookie,
  /^__Host-threads_oauth_state=.*; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=600$/);
```

- [ ] **Step 2: Write failing credential integration tests**

Assert successful callback exchange writes only ciphertext/nonce/scope JSON/expiry; raw token is absent from all text D1 columns. Assert exact-scope validation, refresh within seven days, no refresh outside the window, expired-token reconnect, atomic nonce rotation, and disconnect retaining `threads_posts` rows.

- [ ] **Step 3: Run focused tests and verify failure**

Run:

```powershell
node --test test/unit/threads-oauth.test.js
node --test --test-name-pattern="Threads OAuth|credential" test/integration/threads.test.js
```

Expected: FAIL because `src/threads-oauth.js` does not exist.

- [ ] **Step 4: Implement signed OAuth state without changing the PIN cookie**

Import `THREADS_TOKEN_KEY` as HKDF input material. Derive separate `state-hmac-v1` and `token-aes-v1` 256-bit keys with SHA-256, the fixed salt `repo-atlas-threads-v1`, and distinct `info` values. Encode a versioned JSON payload `{ v: 1, state, sessionNonce, expiresAt }`, sign the base64url payload with the derived HMAC-SHA-256 key, and compare signatures in constant time. `finishThreadsOAuth` reads the OAuth cookie, verifies its signature/expiry/state, rejects duplicated or unknown callback fields before exchange, and always returns an expired clear-cookie header on success or failure.

```js
const OAUTH_COOKIE = "__Host-threads_oauth_state";
const STATE_SECONDS = 600;
export const clearThreadsOAuthCookie = () =>
  `${OAUTH_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
```

- [ ] **Step 5: Implement AES-GCM credentials and lifecycle operations**

Use the derived `token-aes-v1` AES-GCM key, a fresh 12-byte nonce, base64url ciphertext/nonce, and `threads-access-token-v1` as additional authenticated data. Validate decrypted UTF-8 as a non-empty bounded token. Store only the exact sorted granted scopes. Use `db.batch` so token rotation and timestamps commit together; map malformed rows or crypto failures to `threads_reconnect_required` without exposing values. Add `THREADS_APP_ID: "test-threads-app"` to harness vars and add fixed test-only `THREADS_APP_SECRET` plus the 32-byte base64 `THREADS_TOKEN_KEY` above to harness secrets.

Refresh when `expiresAt - nowSeconds <= 604800` and `expiresAt > nowSeconds`. `getThreadsAccessToken` calls refresh first, then returns a decrypted token only when every required scope is present.

- [ ] **Step 6: Run OAuth and integration tests**

Run:

```powershell
node --test test/unit/threads-oauth.test.js
node --test test/integration/threads.test.js
npm run check:types
```

Expected: all commands PASS.

- [ ] **Step 7: Commit the OAuth slice**

```powershell
git add src/threads-oauth.js test/unit/threads-oauth.test.js test/integration/threads.test.js test/support/harness.js
git commit -m "feat: secure Threads OAuth credentials"
```

---

### Task 5: Implement archive reads, sync generations, and immutable content persistence

**Files:**
- Create: `src/threads.js`
- Modify: `test/integration/threads.test.js`
- Modify: `test/support/harness.js`
- Test: `test/integration/threads.test.js`

**Interfaces:**
- Consumes: Task 1 schema, Task 2 normalized URLs/links/message validation, and Queue bindings exposing `send(message, options?)`.
- Produces:
  - `createThreadsSync(db, captureQueue, rawUrl, nowSeconds)`
  - `listThreadsArchives(db, { page })`
  - `getThreadsArchive(db, id, { repliesPage })`
  - `claimThreadsJob(db, postId, generation, status)`
  - `saveResolvedThreadsRoot(db, input)`
  - `saveThreadsConversationPage(db, input)`
  - `saveThreadsQuote(db, input)`
  - `finalizeThreadsContent(db, mediaQueue, input)`
  - `markThreadsJobError(db, input)` and `recalculateThreadsStatus(db, input)`
  - `startThreadsDeletion(db, captureQueue, postId, nowSeconds)`.

- [ ] **Step 1: Write failing archive and generation integration tests**

Add tests for first capture, duplicate capture incrementing the generation, duplicate active submission returning the same job, Queue-send failure recording `error/queue_unavailable`, list page size 10/clamping/order, detail reply page size 20, immutable existing entry text, new reply insertion, other-author exclusion at the service boundary, repeat quote parents, stale generation not advancing root status, and source disappearance retaining ready data.

```js
const first = await createThreadsSync(env.PROD_DB, queue,
  "https://www.threads.com/@meta/post/RootShort", 1000);
assert.deepEqual(first, {
  threadsPostId: first.threadsPostId, generation: 1, duplicate: false, status: "pending",
});
assert.deepEqual(queue.messages, [{
  version: 1, type: "resolve-post", postId: first.threadsPostId, generation: 1, cursor: null,
}]);
```

- [ ] **Step 2: Run the service tests and verify failure**

Run:

```powershell
node --test --test-name-pattern="Threads archive|Threads sync|immutable" test/integration/threads.test.js
```

Expected: FAIL because `src/threads.js` and its exports do not exist.

- [ ] **Step 3: Implement strict D1 result validation and sync creation**

Follow `src/repositories.js`: wrap non-`AppError` exceptions as `storage_unavailable`, validate `success/meta.changes`, exact row shapes, non-negative counts, enums, arrays, and timestamps. Insert/update the post and job in one D1 batch, then send the typed Queue message. If send fails, update that generation to `error` with `queue_unavailable` and set the root to `error` only when it has no usable snapshot.

Use shortcode as the initial unique identity and provider media ID as the post-discovery identity. If discovery reveals a media ID already owned by another local row, retain the older row and mark the newer pending row `error/threads_archive_duplicate`.

- [ ] **Step 4: Implement list/detail mapping and immutable page writes**

List returns:

```js
{
  archives: [{
    id, canonicalUrl, status, errorCode, author, root, quote,
    firstReplies, replyCount, mediaProgress, syncGeneration, createdAt, updatedAt,
  }],
  page, totalPages, total,
}
```

Detail returns `{ archive, replies, repliesPage, totalReplyPages, totalReplies }`. Fetch author/link/media data without N+1 queries by scoping bulk queries to the current archive page/entry IDs. Root/reply upserts use the primary partial identity and change only `last_seen_at`; quote upserts use parent plus quote source ID. Insert links with first ordinal and `ON CONFLICT(entry_id,url) DO NOTHING`.

- [ ] **Step 5: Implement finalization, aggregation, retry bookkeeping, and deletion lease**

`finalizeThreadsContent` succeeds only when the current generation has no profile/conversation cursor and `pending_quote_count = 0`. It inserts missing media rows with the exact child media's nullable `alt_text`, sends one small media message per pending item/profile, sets expected counts, and is safe when redelivered. Ready counts produce `ready`; terminal failures produce `partial`; unresolved root with no snapshot produces `error`.

`startThreadsDeletion` changes only a non-deleting existing archive to `deleting`, blocks sync/retry, sends `{ version:1,type:"delete-archive",postId }`, and records `queue_unavailable` if enqueue fails without deleting rows.

- [ ] **Step 6: Extend the harness with deterministic Queue doubles and seed helpers**

Add `seedThreadsArchive(db, overrides)`, `captureMessages`, `mediaMessages`, queue bindings whose `send` validates structured-cloneable bodies, and `setQueueMode({ captureReject, mediaReject })`. Reset arrays and modes in `reset()` without altering GitHub/Notes helpers.

- [ ] **Step 7: Run service, Repository regression, and type tests**

Run:

```powershell
node --test test/integration/threads.test.js test/integration/repositories.test.js
npm run check:types
git diff --check
```

Expected: all commands PASS.

- [ ] **Step 8: Commit the archive-store slice**

```powershell
git add src/threads.js test/integration/threads.test.js test/support/harness.js
git commit -m "feat: persist Threads archive generations"
```

---

### Task 6: Implement the capture Queue state machine

**Files:**
- Create: `src/threads-capture.js`
- Modify: `test/integration/threads.test.js`
- Modify: `test/support/harness.js`
- Test: `test/integration/threads.test.js`

**Interfaces:**
- Consumes: Tasks 3-5 provider/OAuth/store operations and validated capture messages.
- Produces:
  - `handleThreadsCaptureMessage(rawMessage, dependencies)`
  - `handleThreadsCaptureDeadLetter(rawMessage, dependencies)`
  - dependency shape `{ db, captureQueue, mediaQueue, fetcher, getAccessToken, nowSeconds, signal }`.

- [ ] **Step 1: Write failing end-to-end capture-consumer integration tests**

Model two profile pages before the shortcode match, three conversation pages containing other-user and root-author replies at multiple depths, more than ten author replies, a carousel, one repeated quote under two parents, a quote containing a nested quote, cursor replay, transient `429`, stale generations, and a root that becomes unavailable after an earlier ready snapshot.

```js
await handleThreadsCaptureMessage({
  version: 1, type: "collect-conversation", postId, generation: 1, cursor: null,
}, dependencies);
const replies = await env.PROD_DB.prepare(
  "SELECT source_media_id FROM threads_entries WHERE threads_post_id = ? AND kind = 'author_reply' ORDER BY published_at, source_media_id",
).bind(postId).all();
assert.equal(replies.results.length, 12);
assert.equal(replies.results.some((row) => row.source_media_id === "other-user-reply"), false);
```

- [ ] **Step 2: Run capture tests and verify failure**

Run:

```powershell
node --test --test-name-pattern="capture consumer|conversation cursor|capture DLQ" test/integration/threads.test.js
```

Expected: FAIL because the capture handler does not exist.

- [ ] **Step 3: Implement typed dispatch, leases, and cursor continuations**

Validate every raw message before D1/provider work. For `resolve-post`, claim the current generation, resolve a short URL if needed, load/refresh the token, fetch one profile-post page, persist the next cursor in the same batch as progress, and enqueue exactly one continuation or the first conversation message. Detect a repeated cursor before enqueue and terminate with `threads_provider_protocol_error`.

For `collect-conversation`, fetch one flattened page, compare each reply's stable `ownerId` to the stored root author ID, persist only matches, increment quote work for each included entry with a quote ID, commit the next cursor, and enqueue either the continuation or quote/finalization work.

- [ ] **Step 4: Implement quote and finalization barriers**

`collect-quote` stores one quote under the requesting parent, resolves its author/media, records only `quotedPost.permalink` for a nested quote, decrements `pending_quote_count` once, and enqueues finalization only when conversation paging is complete and the count reaches zero. If the quote is unavailable, record a fixed quote error on the current job, decrement the barrier, and allow partial finalization.

`finalize-content` calls Task 5 finalization; repeat deliveries observe existing media rows/messages and do not increase expected counts.

- [ ] **Step 5: Implement retry and DLQ classification**

Return a structured result `{ action: "ack" }` for success/terminal provider errors and `{ action: "retry", delaySeconds }` for network, Meta `429`, provider `5xx`, D1/R2/Queue transient errors. Clamp provider delay to 1-900 seconds. `handleThreadsCaptureDeadLetter` records `queue_retries_exhausted` on the addressed current job, maps root-unavailable-without-snapshot to `error`, and otherwise preserves content as `partial`.

- [ ] **Step 6: Add harness `drainCaptureQueue()`**

Drain FIFO messages through `handleThreadsCaptureMessage`, apply ack/retry results deterministically, cap test drains at 500 messages, and throw `test_capture_queue_did_not_quiesce` if the cap is reached. Provider modes decide when a retried response becomes successful.

- [ ] **Step 7: Run capture and complete integration tests**

Run:

```powershell
node --test test/integration/threads.test.js
npm run test:integration
npm run check:types
```

Expected: all commands PASS.

- [ ] **Step 8: Commit the capture pipeline**

```powershell
git add src/threads-capture.js test/integration/threads.test.js test/support/harness.js
git commit -m "feat: collect Threads conversations asynchronously"
```

---

### Task 7: Stream media into private R2 and serve authenticated ranges

**Files:**
- Create: `src/thread-media.js`
- Create: `test/unit/thread-media.test.js`
- Modify: `test/integration/threads.test.js`
- Modify: `test/support/harness.js`
- Test: `test/unit/thread-media.test.js`
- Test: `test/integration/threads.test.js`

**Interfaces:**
- Consumes: Task 2 media-message validation, Task 3 media-detail lookup, Task 4 access-token retrieval, Task 5 media/job rows and status aggregation, a private `R2Bucket`, and an injected fetcher.
- Produces:
  - `handleThreadsMediaMessage(rawMessage, dependencies)`
  - `handleThreadsMediaDeadLetter(rawMessage, dependencies)`
  - `serveThreadsMedia(request, dependencies) -> Response`
  - `parseSingleRange(rawRange, size) -> null | { offset, length, contentRange }`
  - dependency shape `{ db, bucket, fetcher, getAccessToken, recalculateStatus, nowSeconds, signal, maximumBytes? }`.

- [ ] **Step 1: Write failing unit tests for CDN validation, streaming, and ranges**

Accept only HTTPS hosts equal to or ending in `.cdninstagram.com` or `.fbcdn.net`; reject suffix lookalikes, credentials, custom ports, downgrades, and more than three redirects. Test image/video MIME, declared length, missing length with counted bytes, truncated streams, injected 32-byte limit, deterministic keys, one valid byte range, suffix/open ranges, unsatisfiable ranges, and multiple ranges.

```js
assert.deepEqual(parseSingleRange("bytes=10-19", 100), {
  offset: 10, length: 10, contentRange: "bytes 10-19/100",
});
assert.deepEqual(parseSingleRange("bytes=-10", 100), {
  offset: 90, length: 10, contentRange: "bytes 90-99/100",
});
assert.throws(() => parseSingleRange("bytes=0-1,4-5", 100), /invalid_media_range/);
```

- [ ] **Step 2: Write failing integration tests for entry/profile media and cleanup**

Seed pending image, video, thumbnail, and profile jobs. Assert successful R2 `put` updates D1 only after completion; repeated delivery converges on one key; corrupt media marks only that row error and archive partial; retry reacquires a fresh provider URL; profile failure contributes to partial; deletion removes archive objects and only unreferenced author profiles.

- [ ] **Step 3: Run the media tests and verify failure**

Run:

```powershell
node --test test/unit/thread-media.test.js
node --test --test-name-pattern="Threads media|R2|range|profile media" test/integration/threads.test.js
```

Expected: FAIL because `src/thread-media.js` does not exist.

- [ ] **Step 4: Implement bounded provider download and R2 writes**

Use manual redirects and cancel every unused response body. Reject non-success status, unsupported MIME, invalid/negative length, and a declared size above `maximumBytes` (default `5 * 1024 ** 3`). Pipe the provider body through a counting `TransformStream`; abort above the limit, compare the final byte count with a declared length, and delete the just-written object if the count is inconsistent.

```js
const CDN_SUFFIXES = Object.freeze([".cdninstagram.com", ".fbcdn.net"]);
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const VIDEO_TYPES = new Set(["video/mp4", "video/webm"]);
const entryKey = ({ postId, sourceMediaId, kind, ordinal }) =>
  `threads/posts/${postId}/${sourceMediaId}/${kind}-${ordinal}`;
const profileKey = (authorId) => `threads/authors/${authorId}/profile`;
```

Pass the counted stream directly to `bucket.put(key, stream, { httpMetadata: { contentType } })`. Persist only returned `key`, `size`, `httpEtag`, and validated MIME. Never persist a source CDN URL.

- [ ] **Step 5: Implement media-message state transitions and DLQ handling**

For entry/profile archive jobs, obtain a valid access token and reacquire provider details by stable source ID before download. Claim only pending/error current rows, increment attempt count once, write R2, then mark ready and recalculate the current archive/job. Terminal validation errors mark only the item error; transient errors return retry with delay. DLQ marks `media_retries_exhausted`, preserves any prior ready object, and recalculates partial state.

For `delete-object`, delete the exact D1-referenced key idempotently. The archive deletion branch deletes all entry keys, deletes profile keys only for authors becoming unreferenced, and finally performs the Task 5 D1 cascade/orphan-author batch.

- [ ] **Step 6: Implement authenticated full, HEAD, and range reads**

Look up media by both `threadsPostId` and local `mediaId`; never accept an R2 key. Return 404 for missing/non-ready/mismatched rows. Use `bucket.head` for HEAD and `bucket.get(key, { range: { offset, length } })` for one valid range. Return exact headers:

```text
Accept-Ranges: bytes
Cache-Control: private, no-cache
Content-Disposition: inline
Content-Length: <selected bytes>
Content-Type: <stored MIME>
ETag: <quoted stored ETag>
X-Content-Type-Options: nosniff
```

Return 206 plus `Content-Range` for a valid range and 416 plus `Content-Range: bytes */<size>` for invalid/unsatisfiable/multiple ranges.

- [ ] **Step 7: Extend the harness with an in-memory R2 double and media drain**

The double implements `put`, `get`, `head`, and `delete`, consumes streams, records metadata, and returns R2-shaped objects. Expose `mediaObjects()`, `setR2Mode({ putReject, getReject, deleteReject })`, and `drainMediaQueue()` with the same 500-message quiescence guard used by capture.

- [ ] **Step 8: Run media, integration, type, and source checks**

Run:

```powershell
node --test test/unit/thread-media.test.js test/integration/threads.test.js
npm run check:types
npm run check:source
git diff --check
```

Expected: all commands PASS and tests prove large bodies are never read with `arrayBuffer`, `blob`, `bytes`, `json`, or `text`.

- [ ] **Step 9: Commit the media slice**

```powershell
git add src/thread-media.js test/unit/thread-media.test.js test/integration/threads.test.js test/support/harness.js
git commit -m "feat: archive Threads media in private R2"
```

---

### Task 8: Render the Threads list/detail pages and responsive states

**Files:**
- Modify: `src/html.js`
- Create: `public/assets/threads.css`
- Modify: `test/unit/html.test.js`
- Modify: `test/unit/interface-policy.test.js`
- Test: `test/unit/html.test.js`
- Test: `test/unit/interface-policy.test.js`

**Interfaces:**
- Consumes: Task 5 list/detail mapped objects and existing `document`, escaping, CSRF, asset, and logout patterns in `src/html.js`.
- Produces: `renderThreadsIndexPage(view)`, `renderThreadsDetailPage(view)`, and shared authenticated Repository/Threads navigation.

- [ ] **Step 1: Write failing semantic HTML tests**

Assert shared navigation on Repository and Threads pages, `aria-current`, connect/reconnect state, exact URL form, pending/partial/error/progress states, author image/name/username/time, escaped text, safe link anchors, image/video/quote markup, first three replies, the real all-replies href, reply pagination, sync/retry/delete forms, media URLs scoped by post/media ID, and no provider CDN/embed/script URL.

```js
assert.match(html, /<nav aria-label="주요 메뉴">[\s\S]*Repository[\s\S]*Threads[\s\S]*<\/nav>/);
assert.match(html, /<a href="\/threads" aria-current="page">Threads<\/a>/);
assert.equal((html.match(/data-thread-author-reply/g) ?? []).length, 3);
assert.match(html, /href="\/threads\/post-1#author-replies">작성자 답글 12개 모두 보기<\/a>/);
assert.doesNotMatch(html, /threads\.net\/embed|cdninstagram\.com|<script[^>]+src="https:/);
```

- [ ] **Step 2: Write failing CSS policy and geometry tests**

Add `threads.css` to the exact CSS inventory. Assert every rule is inside the existing cascade layers, 44px action targets, bounded media aspect ratios, overflow-safe text/URLs, responsive one/two-column galleries, visible keyboard focus, reduced motion, and a single-column 360px layout without horizontal overflow.

- [ ] **Step 3: Run renderer and policy tests and verify failure**

Run:

```powershell
node --test --test-name-pattern="Threads|CSS inventory" test/unit/html.test.js test/unit/interface-policy.test.js
```

Expected: FAIL because renderers and `threads.css` do not exist.

- [ ] **Step 4: Add shared navigation and fixed message copy**

Create one `appNavigation(active)` helper used by Repository index/detail/Notes and Threads pages. Keep logout adjacent but outside the nav. Extend the fixed `MESSAGE` table with only approved safe flashes: `threads_connected`, `threads_disconnected`, `threads_capture_queued`, `threads_sync_queued`, `threads_retry_queued`, and `threads_delete_queued`.

- [ ] **Step 5: Implement Threads list and detail renderers**

The list page renders ten archive cards. Each card uses:

```html
<article data-thread-archive data-thread-status="collecting">
  <header class="thread-author">
    <img data-thread-author-image alt="">
    <strong data-thread-author-name></strong>
    <span data-thread-author-username></span>
    <time data-thread-published-at></time>
  </header>
  <div data-thread-root><p data-thread-text></p><div data-thread-media></div></div>
  <section data-thread-quote hidden></section>
  <section id="author-replies" data-thread-replies></section>
  <div class="thread-actions"><a data-thread-all-replies></a></div>
</article>
```

Render text with `htmlText`; render links from stored normalized link rows only. Author images use the authenticated profile media route and empty alt beside textual identity. Images use meaningful provider alt text when stored and a fixed Korean fallback otherwise. Videos use `<video controls preload="metadata">` and the archived thumbnail route. Dates use `<time datetime="provider ISO">YYYY.MM.DD</time>` in `Asia/Seoul`.

The list shows three replies; the detail page shows twenty chronological replies per page with real numbered links. Both include no-JavaScript sync, retry, disconnect, and confirmed deletion forms.

- [ ] **Step 6: Implement responsive Threads CSS**

Use existing tokens/layers. Keep profile/media/reply/quote/card class names Threads-specific, place metadata and actions with Grid/Flex, clamp only list-preview text (never detail text), use `aspect-ratio` plus `object-fit`, and use `@media (min-width: 840px)` for the multi-column media layout. Add `@media (prefers-reduced-motion: reduce)` for polling/progress visual transitions.

- [ ] **Step 7: Run HTML, CSS, accessibility-source, and type checks**

Run:

```powershell
node --test test/unit/html.test.js test/unit/interface-policy.test.js
npm run lint:css
npm run check:types
npm run check:source
```

Expected: all commands PASS and existing Repository HTML assertions remain unchanged except shared navigation.

- [ ] **Step 8: Commit the server presentation**

```powershell
git add src/html.js public/assets/threads.css test/unit/html.test.js test/unit/interface-policy.test.js
git commit -m "feat: render Threads archive pages"
```

---

### Task 9: Add authenticated HTTP, OAuth callback, Queue, scheduled, media, CSP, and telemetry boundaries

**Files:**
- Modify: `src/worker.js`
- Modify: `src/telemetry.js`
- Create: `test/integration/threads-app.test.js`
- Modify: `test/integration/app.test.js`
- Modify: `test/unit/worker.test.js`
- Modify: `test/unit/telemetry.test.js`
- Modify: `test/unit/source-policy.test.js`
- Test: `test/integration/threads-app.test.js`

**Interfaces:**
- Consumes: Tasks 4-8 OAuth/store/capture/media/rendering contracts and injected bindings.
- Produces:
  - authenticated routes from the spec;
  - exported `handleThreadsQueue(batch, env, context, fetcher)` and `handleThreadsScheduled(env, context, fetcher, nowSeconds)`;
  - default Worker `fetch`, `queue`, and `scheduled` handlers;
  - safe route templates `/threads`, `/threads/:id`, `/threads/:id/sync`, `/threads/:id/delete`, `/threads/:id/media/:mediaId`, `/threads/:id/media/:mediaId/retry`, `/threads/connect`, `/threads/oauth/callback`, and `/threads/disconnect`.

- [ ] **Step 1: Write failing route/auth/schema tests**

Cover GET/POST `/threads`, detail HTML/JSON, strict list/detail queries, duplicate capture, sync, retry, delete, media GET/HEAD/range, connect, callback with no PIN cookie but valid signed OAuth cookie, invalid/expired/mismatched state, disconnect, unauthenticated media, extra/duplicated form fields, unsupported methods, JSON shapes, and raw-ID-free telemetry templates.

```js
const callback = await harness.worker.fetch(
  `${session.origin}/threads/oauth/callback?code=code-1&state=${state}`,
  { headers: { Cookie: oauthCookie } },
);
assert.equal(callback.status, 303);
assert.equal(callback.headers.get("location"), "/threads?flash=threads_connected");
assert.match(callback.headers.get("set-cookie"), /Max-Age=0/);
```

- [ ] **Step 2: Write failing Queue/scheduled/CSP/telemetry tests**

Construct fake `MessageBatch` objects for each primary/DLQ queue name and assert per-message ack/retry/delay behavior. Assert the daily scheduled handler refreshes only a token within seven days. Update exact app CSP assertions to add only `media-src 'self'`; login CSP remains byte-for-byte unchanged. Assert telemetry records a safe `threadsStatus` category and never text, token, state, code, media URL, CDN query, or provider path.

- [ ] **Step 3: Run worker boundary tests and verify failure**

Run:

```powershell
node --test test/unit/worker.test.js test/unit/telemetry.test.js
node --test test/integration/threads-app.test.js
```

Expected: FAIL because the routes and event handlers do not exist.

- [ ] **Step 4: Extend runtime selection and fail-closed bindings**

Add these runtime values with exact type checks before any Threads operation:

```js
{
  threadsMedia: env.THREADS_MEDIA,
  threadsCaptureQueue: env.THREADS_CAPTURE_QUEUE,
  threadsMediaQueue: env.THREADS_MEDIA_QUEUE,
  threadsAppId: env.THREADS_APP_ID,
  threadsAppSecret: env.THREADS_APP_SECRET,
  threadsTokenKey: env.THREADS_TOKEN_KEY,
  threadsCaptureQueueName: env.THREADS_CAPTURE_QUEUE_NAME,
  threadsMediaQueueName: env.THREADS_MEDIA_QUEUE_NAME,
  threadsCaptureDlqName: env.THREADS_CAPTURE_DLQ_NAME,
  threadsMediaDlqName: env.THREADS_MEDIA_DLQ_NAME,
}
```

Do not make GitHub routes depend on Threads bindings: validate the Threads subset lazily when a Threads HTTP/Queue/scheduled path uses it. Test runtime may use fixture/fake bindings; production provider fetch remains native `globalThis.fetch` through the observed redacting wrapper.

- [ ] **Step 5: Implement exact routing and response contracts**

Use separate non-overlapping regexes:

```js
const THREADS_POST_PATH = /^\/threads\/([0-9a-f-]+)(?:\/(sync|delete))?$/;
const THREADS_MEDIA_PATH = /^\/threads\/([0-9a-f-]+)\/media\/([0-9a-f-]+)(?:\/(retry))?$/;
```

Handle fixed OAuth/connect/disconnect routes before dynamic matches. Require the PIN session everywhere except callback; callback uses only Task 4 state validation. Apply existing origin/CSRF/form parsing to mutations. Permit query parameters only on list, detail, and callback. On list/detail, validate one optional fixed allowlisted `flash` with the existing `flashFrom` pattern, remove it, and pass the clean URL to Task 2's page parser. Enhanced responses use exact spec keys and fixed safe errors. Polling detail JSON returns an ETag derived from post generation/status/update time.

- [ ] **Step 6: Implement Queue and scheduled handlers**

Route `batch.queue` by the four exact env queue-name values. Process messages independently: acknowledge terminal/success results, call `retry({ delaySeconds })` for transient results, and never retry one message by throwing the whole batch. Primary capture/media queues call Tasks 6/7; DLQs call their terminal handlers. Unknown queue names acknowledge nothing and throw `threads_queue_not_configured` so configuration tests fail closed.

`scheduled` accepts only the configured daily cron event, calls `refreshStoredThreadsCredential`, and passes its promise through `context.waitUntil`; it does not trigger content sync.

- [ ] **Step 7: Add CSP, route telemetry, provider category, and safe error copy**

Change authenticated app CSP to:

```text
default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' https://github.com https://avatars.githubusercontent.com; media-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'
```

Add safe Threads route templates to `pageRoute`, `safeRouteTemplate`, and `telemetry.js`. Extend observed state with `threadsStatus` values `none|ok|not_found|rate_limited|reconnect_required|error`; inspect only the request hostname and response status, and log no path/query/header/body.

- [ ] **Step 8: Run route, security, telemetry, integration, and type checks**

Run:

```powershell
node --test test/unit/worker.test.js test/unit/telemetry.test.js test/unit/source-policy.test.js
node --test test/integration/threads-app.test.js test/integration/app.test.js
npm run check:types
npm run check:source
```

Expected: all commands PASS, existing login/Repository/CSP behavior remains green, and callback succeeds without weakening the PIN cookie.

- [ ] **Step 9: Commit the Worker boundary**

```powershell
git add src/worker.js src/telemetry.js test/integration/threads-app.test.js test/integration/app.test.js test/unit/worker.test.js test/unit/telemetry.test.js test/unit/source-policy.test.js
git commit -m "feat: expose authenticated Threads archive routes"
```

---

### Task 10: Configure R2, Queue/DLQ, cron, generated types, and immutable release policy

**Files:**
- Modify: `wrangler.jsonc`
- Modify: `worker-configuration.d.ts`
- Modify: `scripts/release.mjs`
- Modify: `test/unit/release.test.js`
- Modify: `test/unit/workflow-policy.test.js`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `.github/workflows/rollback.yml`
- Modify: `docs/operations/release.md`
- Test: `test/unit/release.test.js`
- Test: `test/unit/workflow-policy.test.js`

**Interfaces:**
- Consumes: production resource names, seven required Worker secrets, test-only distinct resources, and Tasks 7/9 event handlers.
- Produces: exact production/test bindings, queue-name vars used by Task 9, daily cron, regenerated `Env`, release archive compatibility, preflight/rollback binding verification, and updated runbook.

- [ ] **Step 1: Write failing exact-configuration and release tests**

Extend config tests to require:

```js
const expectedSecrets = [
  "OPENAI_API_KEY", "PROD_IP_HMAC_KEY", "PROD_PIN_DIGEST", "PROD_PIN_SALT",
  "PROD_SESSION_KEY", "THREADS_APP_SECRET", "THREADS_TOKEN_KEY",
];
const productionResources = {
  r2: "gx-threads-media",
  capture: "gx-threads-capture",
  media: "gx-threads-media",
  captureDlq: "gx-threads-capture-dlq",
  mediaDlq: "gx-threads-media-dlq",
  cron: "0 3 * * *",
};
```

Require test names prefixed `repo-atlas-test-`, exact producer bindings, four consumers with primary retry/DLQ configuration and active DLQ consumers, batch size 1 for media, no production IDs/names in `env.test`, and `THREADS_APP_ID = "test-threads-app"` only in test config.

Release tests must initially fail when `r2_buckets`, `queues`, or `triggers` are present but not allowlisted/copied/verified, when either Threads secret is missing, when queue names differ from vars, or when rollback does not compare the exact active bindings and cron.

- [ ] **Step 2: Run release/config tests and verify failure**

Run:

```powershell
node --test test/unit/release.test.js test/unit/workflow-policy.test.js
```

Expected: FAIL because the config and release policy do not yet know Threads resources.

- [ ] **Step 3: Add exact production and test Wrangler resources**

Add top-level production `r2_buckets`, `queues.producers`, `queues.consumers`, and `triggers.crons`, and repeat isolated equivalents under `env.test`. Primary consumers use `max_retries: 3` and their corresponding `dead_letter_queue`; DLQ consumers use `max_retries: 0`. Use `max_batch_size: 1` for media/deletion and at most 10 for capture/DLQ recording. Add the four exact queue names as vars so `batch.queue` routing has no suffix heuristic.

Add `THREADS_APP_SECRET` and `THREADS_TOKEN_KEY` to both exact `secrets.required` arrays. Production `THREADS_APP_ID` is supplied by the protected GitHub environment variable of that exact name after Meta approval; test config uses `test-threads-app`.

- [ ] **Step 4: Regenerate and check Worker types**

Run:

```powershell
npx wrangler types worker-configuration.d.ts --env test
npx wrangler types worker-configuration.d.ts --env test --check
```

Inspect the generated `Env` and require `THREADS_MEDIA: R2Bucket`, both `Queue` producer bindings, app/secret/key strings, and all four queue-name strings.

- [ ] **Step 5: Preserve and verify new sections in immutable releases**

Add `r2_buckets`, `queues`, and `triggers` to `RELEASE_WRANGLER_SECTIONS`. Add a required `--threads-app-id` argument to `release:create`; validate it as a non-empty bounded decimal app ID and write it to candidate `vars.THREADS_APP_ID`. The release workflow passes the protected GitHub environment variable `THREADS_APP_ID`. When creating a release, discard only test resources and preserve the exact production bucket, producers, consumers/DLQs, cron, and queue-name vars. Extend manifest verification so unknown extra resources fail closed.

Update release and rollback workflows to query the latest/candidate/active Worker version and require exactly:

- one D1 binding `PROD_DB`;
- one private R2 binding `THREADS_MEDIA` with bucket `gx-threads-media`;
- Queue producer bindings `THREADS_CAPTURE_QUEUE` and `THREADS_MEDIA_QUEUE` with their exact queues;
- the scheduled `0 3 * * *` trigger;
- the existing assets/rate-limit bindings;
- seven exact Worker secrets;
- `THREADS_APP_ID` and four queue-name vars from the protected production environment.

Do not echo secret values. Rollback must verify the target version declares the same resources before allocation change.

- [ ] **Step 6: Update CI evidence and operations documentation**

Keep existing eight test-summary gates. Add configuration assertions to CI before test evidence is written. Update `docs/operations/release.md` with the R2/Queue/DLQ/cron inventory, Meta approval/scopes, secret names, D1 backup/migration order through 0004, private-bucket check, queue backlog/DLQ inspection, token reconnect, controlled live smoke, rollback behavior, and explicit prohibition on direct production deploys.

- [ ] **Step 7: Run release, workflow, type, and compatibility tests**

Run:

```powershell
node --test test/unit/release.test.js test/unit/workflow-policy.test.js
npx wrangler types worker-configuration.d.ts --env test --check
npm run check:types
npm run release:compatibility -- --previous-dir .release/verify
git diff --check
```

Expected: unit/type/diff commands PASS. Compatibility PASS is required when the named verified release directory exists; if it does not exist in the isolated worktree, create the current immutable release through the documented `release:create` fixture flow used by `test/unit/release.test.js`, then rerun compatibility against those two generated local directories. Do not contact production.

- [ ] **Step 8: Commit the infrastructure and release contract**

```powershell
git add wrangler.jsonc worker-configuration.d.ts scripts/release.mjs test/unit/release.test.js test/unit/workflow-policy.test.js .github/workflows/ci.yml .github/workflows/release.yml .github/workflows/rollback.yml docs/operations/release.md
git commit -m "feat: configure Threads archive resources"
```

---

### Task 11: Add progressive capture, polling, reply expansion, retry, and delete behavior

**Files:**
- Create: `public/assets/thread-capture.js`
- Create: `public/assets/thread-panel.js`
- Modify: `public/assets/app.js`
- Modify: `public/modulepreload.json`
- Modify: `src/worker.js`
- Modify: `test/unit/browser-gates.test.js`
- Modify: `test/unit/interface-policy.test.js`
- Create: `test/e2e/threads.spec.js`
- Test: `test/e2e/threads.spec.js`

**Interfaces:**
- Consumes: Task 9 exact same-origin HTML/JSON/action contracts, Task 10 configured test resources, and the existing `formJson` helper.
- Produces: autonomous `thread-capture` and `thread-panel` custom elements; no exported global state.

- [ ] **Step 1: Write failing browser-source gate tests**

Assert `app.js` imports both modules, asset allowlists/preloads include both files and `threads.css`, every fetch is same-origin with `credentials: "same-origin"`, no `innerHTML`/external connection exists, polling uses visibility and abort signals, all user strings reach DOM through `textContent`, and modified clicks retain native navigation.

- [ ] **Step 2: Write failing Playwright behavior cases**

In `test/e2e/threads.spec.js`, specify capture returning a pending card, status progression, polling stop, 12 root-author replies with first three then full in-card expansion, modified-click detail navigation, partial-media retry preserving data, sync adding a thirteenth reply, delete cancel/focus/confirm, session expiry, and mobile/no-JavaScript fallbacks.

- [ ] **Step 3: Run browser gate and selected Chromium tests and verify failure**

Run:

```powershell
node --test test/unit/browser-gates.test.js test/unit/interface-policy.test.js
npx playwright test test/e2e/threads.spec.js --project=chromium
```

Expected: FAIL because the browser modules and enhanced behavior do not exist.

- [ ] **Step 4: Implement `thread-capture`**

Intercept only an unmodified primary submit on the contained form. Disable only the submit control, preserve the URL on failure, submit with `formJson`, validate exact response keys/types/ID/status, navigate to `/threads/:id` on accepted capture, and expose fixed Korean live-region copy. Abort a previous request when the element disconnects or a new submit begins.

- [ ] **Step 5: Implement `thread-panel` polling and reply expansion**

Poll only cards whose status is `pending` or `collecting` with delays `[1000, 2000, 5000, 10000]`, send `If-None-Match`, stop while `document.visibilityState !== "visible"`, resume one timer on visibility, and stop on terminal status or disconnect. Validate JSON before applying author/progress/status fields.

On an unmodified primary all-replies click, fetch detail pages sequentially, create reply/time/link/media nodes with DOM APIs, append in chronological order, and set the button/link label to the exact loaded count. Abort on close/disconnect and keep the real href for modified/no-JavaScript navigation.

- [ ] **Step 6: Implement enhanced sync, retry, and deletion focus behavior**

Use `formJson` for sync and item retry; disable only the relevant action and keep stored content visible on error. The shared native delete dialog displays author plus root date using `textContent`, assigns the validated action URL, enables confirm only afterward, returns focus on cancel/Escape, and after successful removal focuses the list heading or empty-state heading.

- [ ] **Step 7: Import assets and regenerate module preloads**

Add:

```js
import "./thread-capture.js";
import "./thread-panel.js";
```

to `public/assets/app.js`, add both JS files and `threads.css` to the Worker's exact asset set, then run:

```powershell
npm run preloads
```

Inspect `public/modulepreload.json` and require sorted exact entries for the two new modules plus all existing modules.

- [ ] **Step 8: Run source, browser, and focused E2E checks**

Run:

```powershell
node --test test/unit/browser-gates.test.js test/unit/interface-policy.test.js
npm run check:source
npm run check:types
npx playwright test test/e2e/threads.spec.js --project=chromium
```

Expected: all commands PASS.

- [ ] **Step 9: Commit the enhanced client**

```powershell
git add public/assets/thread-capture.js public/assets/thread-panel.js public/assets/app.js public/modulepreload.json src/worker.js test/unit/browser-gates.test.js test/unit/interface-policy.test.js test/e2e/threads.spec.js
git commit -m "feat: enhance Threads archive interactions"
```

---

### Task 12: Complete fixture-backed browser coverage and final verification

**Files:**
- Modify: `test/support/harness.js`
- Modify: `test/support/provider-fixture-worker.js`
- Modify: `test/e2e/threads.spec.js`
- Modify: `test/e2e/accessibility.spec.js`
- Modify: `test/e2e/native-no-js.spec.js`
- Modify: `test/e2e/responsive.spec.js`
- Modify: `test/e2e/release-smoke.spec.js`
- Modify: `test/unit/provider-fixture-worker.test.js`
- Modify: `README.md`
- Test: `test/e2e/threads.spec.js`

**Interfaces:**
- Consumes: complete application, test bindings, exact provider fixture, Queue/R2 handlers, and release policy from Tasks 1-11.
- Produces: deterministic local/browser proof of the approved product contract and updated local setup documentation.

- [ ] **Step 1: Make the test harness exercise real configured events**

Keep direct fake-Queue/R2 drains for focused integration tests. For browser tests, use the Wrangler test environment's configured Queues, private R2, D1, and fixture service. Add `waitForThreadsArchive(id, expectedStatus, timeoutMs = 10000)` that polls authenticated JSON with bounded delay and dumps `server.debug()` on timeout. Expose `remoteWorker.scheduled({ cron: "0 3 * * *", scheduledTime })` for token-refresh E2E setup.

- [ ] **Step 2: Complete canonical browser scenarios**

Use one fixture root containing text, a normalized external link, image, video+thumbnail, a two-child carousel, twelve root-author replies across three cursor pages, two other-user replies, a repeated one-level quote, and a nested quote permalink. Verify:

- capture returns immediately and transitions pending/collecting to ready;
- D1 has root plus exactly twelve author replies and no other-user reply;
- R2 serves authenticated image/video/profile bytes and native video issues a valid range request;
- list renders first three replies and enhanced expansion renders all twelve once;
- repeated capture adds a thirteenth reply without changing existing text/media ETags;
- one corrupt image produces partial while text/video remain readable, then item retry reaches ready;
- delete cancellation restores focus and confirmed asynchronous deletion removes D1 and non-shared R2 objects.

- [ ] **Step 3: Complete no-JavaScript, mobile, accessibility, and security scenarios**

With JavaScript disabled, verify connect-state explanation, native capture redirect, detail page, twenty-reply pagination, sync, retry, confirmed deletion, and logout. At 360px and 840px assert no horizontal overflow and usable media controls. Run axe on empty, collecting, ready, partial, detail, OAuth reconnect, and deletion-dialog states. Assert unauthenticated and cross-archive media requests fail and no browser request targets Meta Graph/CDN/embed/script origins.

- [ ] **Step 4: Update local documentation**

In `README.md`, add the Threads archive purpose, local fixture behavior, required production resources/scopes/secrets by name, `npx wrangler d1 migrations apply PROD_DB --local --env test`, and the fact that fixture tests do not require a real Meta token. Keep direct production provisioning/deployment commands in the protected operations runbook, not the README.

- [ ] **Step 5: Run the complete verification suite from a clean state**

Run:

```powershell
npm run check
npm test
npm run test:e2e
npx wrangler types worker-configuration.d.ts --env test --check
git diff --check
git status --short
```

Expected: every command PASS. `git status --short` shows only the intended tracked Task 12 changes before commit and no generated test/result artifacts.

- [ ] **Step 6: Review the implementation against every spec section**

Use these exact searches and inspect every match:

```powershell
rg -n "threads_(basic|profile_discovery|read_replies)|THREADS_(MEDIA|CAPTURE_QUEUE|MEDIA_QUEUE|APP_ID|APP_SECRET|TOKEN_KEY)|media-src|threads\.com|threads\.net" src public wrangler.jsonc scripts test .github docs/operations README.md
rg -n "innerHTML|outerHTML|insertAdjacentHTML|cdninstagram|fbcdn|access_token|oauth.*code|THREADS_APP_SECRET|THREADS_TOKEN_KEY" src public test scripts
rg -n "threads_posts|threads_entries|threads_media|threads_sync_jobs|threads_oauth_credentials" migrations src test
```

Require exactly three OAuth scopes, no browser provider/CDN access, no token/code/state/body logging, no source CDN URL in D1, no other-user reply insertion, parent-scoped quote identity, private authenticated media, additive sync, partial success, and deletion cleanup.

- [ ] **Step 7: Commit final browser/docs verification**

```powershell
git add test/support/harness.js test/support/provider-fixture-worker.js test/e2e/threads.spec.js test/e2e/accessibility.spec.js test/e2e/native-no-js.spec.js test/e2e/responsive.spec.js test/e2e/release-smoke.spec.js test/unit/provider-fixture-worker.test.js README.md
git commit -m "test: verify Threads archive workflows"
```

- [ ] **Step 8: Stop before production operations**

Report the exact test commands/results, commits, pending Meta app approval state, and resource-provisioning prerequisites. Do not create Cloudflare resources, set secrets, apply remote migrations, publish a Worker version, promote traffic, or run the controlled live-provider smoke without the user's explicit deployment authorization.

---

## Plan Completion Criteria

- All twelve task commits exist in order and each task's focused red/green evidence was recorded.
- The complete verification suite passes from a clean isolated worktree.
- The implementation matches the approved spec, including the corrected SameSite OAuth callback and parent-scoped repeated-quote identity.
- Existing Repository, Notes, authentication, CSP, telemetry, release, accessibility, responsive, and no-JavaScript behavior remains green.
- No production action occurred during implementation verification.
