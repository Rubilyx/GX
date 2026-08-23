# Threads Post Archive Design

## Goal

Add a separate authenticated Threads archive to Repo Atlas. A user submits a public Threads post URL, the application captures the post and every reply written by the original author through Meta's official Threads API, and it stores text and metadata in D1 plus image, video, thumbnail, and author-profile binaries in a private R2 bucket. The archive remains usable when the source post or source media later disappears.

## Confirmed Product Contract

- Add a dedicated `/threads` page reachable from shared `Repository` and `Threads` navigation.
- Accept public Threads post URLs from current `threads.com` and legacy `threads.net` hosts, including canonical and supported short-link forms.
- Use only Meta's official Threads API and official URL redirects. Do not scrape Threads HTML or load Meta embed markup or scripts.
- Archive the selected root post and every top-level or nested reply authored by the root-post author, without a reply-count limit.
- Exclude replies written by every other user.
- Archive one level of quoted-post text, author, published date, links, and media. For a quote inside that quoted post, retain only the next quote's permalink when Meta supplies it.
- Preserve the root post's and included replies' text, author, published date, permalink, HTTP(S) links, images, videos, carousel children, video thumbnails, and media alt text when supplied.
- Store author profile image, display name, and `@username`.
- Copy media binaries into Cloudflare R2. Do not depend on expiring Meta CDN URLs for display.
- Return from URL submission immediately and perform collection asynchronously.
- Show only the first three author replies on an archive card. An enhanced browser can load and expand all author replies inside the card; the server-rendered detail page provides a paginated fallback.
- Treat a repeated URL submission or explicit sync as an additive refresh. Add newly discovered author replies, retain every existing content/media snapshot, and refresh only author profile data.
- Allow partial success. Preserve content and successful media when an individual quote, image, video, thumbnail, or profile image cannot be archived, and offer item-level retry where meaningful.

## Explicit Exclusions

- Do not archive replies by users other than the root-post author.
- Do not recursively archive quote chains beyond one quoted post.
- Do not mirror source deletions into the archive.
- Do not overwrite existing archived entry text or media during a sync and do not add edit-version history.
- Do not add automatic scheduled content synchronization. A sync is triggered by repeat URL submission or the archive's sync action.
- Do not publish, reply to, delete, like, repost, moderate, or retrieve insights for Threads content.
- Do not add keyword search, tags, AI analysis, OCR, transcription, media transcoding, or image resizing.
- Do not expose the R2 bucket publicly or use third-party scraping/downloading services.
- Do not change the existing single-user PIN authentication model.

## Existing-System Fit

Repo Atlas is a no-build, zero-runtime-dependency Cloudflare Worker application. It renders semantic HTML on the server, progressively enhances supported interactions with native browser ESM, persists structured records in D1, and protects all application state with a signed PIN session and CSRF checks. The Threads archive follows those boundaries:

- `src/worker.js` retains exact-host routing, authentication, security headers, safe error responses, and runtime binding selection.
- New provider, orchestration, and media responsibilities live in focused modules rather than expanding the GitHub-specific modules.
- The browser never calls Meta or R2 directly.
- The existing Repository capture, analysis, notes, filtering, and deletion contracts remain unchanged except for shared navigation and adding `media-src 'self'` to the authenticated app CSP for same-origin archived video.

The implementation uses `migrations/0004_threads_archive.sql`. It preserves the in-progress `0002_repository_activity.sql` and the already designed `0003_repository_notes.sql`; the Threads migration must not be applied until both earlier migrations are present in the target release.

## Architecture

The existing Worker remains the only deployed Worker. It gains HTTP, queue, and scheduled handlers backed by the following modules:

### `src/threads-domain.js`

Owns Threads URL normalization, strict list/detail query parsing, link extraction, entry/media enum validation, and fixed input limits. It has no network or storage dependencies.

### `src/threads-api.js`

Owns all calls to `graph.threads.net`, token exchange/refresh, public-profile and profile-post pagination, post detail, conversation pagination, child media lookup, quoted-post lookup, and strict response validation. It accepts an injected fetcher and never sees D1, R2, HTML, or Queue bindings.

The requested authorization scopes are exactly:

- `threads_basic`
- `threads_profile_discovery`
- `threads_read_replies`

Publishing, deletion, insight, mention, keyword-search, and reply-management scopes are not requested.

### `src/threads.js`

Owns D1 persistence, sync-generation leases, idempotent upserts, author-reply filtering, content-status aggregation, Queue message production, deletion coordination, and mapping storage rows into application objects. It communicates with Meta through the `threads-api.js` interface and with media storage through queue messages.

### `src/thread-media.js`

Owns provider-media URL validation, bounded redirects, MIME and byte validation, streaming R2 writes, deterministic object keys, authenticated reads with single-range support, and object cleanup. It never renders HTML and never accepts an arbitrary user-provided media URL.

### `src/html.js` and `public/assets/`

Server renderers add the Threads list/detail/connect states and reusable cards. New `threads.css`, `thread-capture.js`, and `thread-panel.js` assets implement progressive enhancement with DOM node APIs and `textContent`, not response-string `innerHTML`.

## Cloudflare Bindings and Secrets

Add these production and isolated test resources:

- D1: reuse `PROD_DB`.
- R2 binding `THREADS_MEDIA` backed by a private production bucket and a separate test bucket.
- Queue producer/consumer binding `THREADS_CAPTURE_QUEUE` for discovery and structured-content work.
- Queue producer/consumer binding `THREADS_MEDIA_QUEUE` for one media/archive operation per message.
- Dead-letter queues for capture and media jobs, each configured with an active consumer that records terminal job state rather than silently discarding messages.
- A daily scheduled trigger used only to refresh an unexpired long-lived Meta token when it is within seven days of expiry.

Add `THREADS_APP_ID` as a non-secret environment value and add `THREADS_APP_SECRET` plus a random 256-bit `THREADS_TOKEN_KEY` as Worker secrets. The test environment uses distinct non-production values and a provider fixture.

## URL Contract and Post Resolution

An accepted URL must use HTTPS, have no username, password, or explicit port, and use a recognized Threads host. Fragments and share-tracking query parameters are discarded. Supported post paths are:

- `/@{username}/post/{shortcode}`
- `/t/{shortcode}` when the URL resolves through at most three Threads-host redirects to a canonical post URL

Owner handles and shortcodes are decoded once, normalized to NFC, length checked, and rejected if they contain path separators or unsupported characters. The canonical stored URL uses `https://www.threads.com/@{username}/post/{shortcode}`.

The capture consumer requests the public profile, then walks `profile_posts` pages until it finds the exact shortcode or the provider exhausts its cursor. Each page and next cursor are persisted before a continuation message is acknowledged. A repeated cursor or a post whose profile listing is exhausted without a match fails with a fixed unavailable code; the implementation never falls back to HTML parsing.

## Data Model

### `threads_posts`

One row represents one locally archived root post.

- `id`: server-generated UUID primary key.
- `shortcode`: normalized source shortcode, unique and non-null.
- `threads_media_id`: provider media ID, unique once resolved and nullable only while pending.
- `submitted_url`, `canonical_url`: normalized source/provenance URLs.
- `root_author_id`: references `threads_authors` after discovery.
- `status`: `pending`, `collecting`, `ready`, `partial`, `error`, or `deleting`.
- `error_code`: nullable fixed application code.
- `sync_generation`: positive integer incremented for each accepted sync.
- `last_successful_sync_at`, `created_at`, `updated_at`: Unix seconds.

Order list rows by `created_at DESC, id DESC`; add indexes for status/order and root author.

### `threads_authors`

- `threads_user_id`: provider user ID primary key.
- `username`, `display_name`: current NFC-normalized profile values.
- `profile_media_status`: `pending`, `ready`, or `error`.
- `profile_r2_key`, `profile_content_type`, `profile_etag`, `profile_bytes`: nullable until ready.
- `profile_error_code`, `profile_refreshed_at`, `created_at`, `updated_at`.

Authors are shared across archives. An author and profile object are removed only when no remaining entry references that author.

### `threads_entries`

Stores root posts, included author replies, and one-level quoted posts.

- `id`: server-generated UUID primary key.
- `threads_post_id`: archive parent with `ON DELETE CASCADE`.
- `source_media_id`: provider media ID.
- `kind`: `root`, `author_reply`, or `quote`.
- `parent_entry_id`: the local quoting entry for a `quote`; otherwise nullable.
- `source_parent_media_id`: provider `replied_to` ID when supplied, retained even if that other user's entry is excluded.
- `author_id`: references `threads_authors`.
- `text`, `permalink`, `published_at`, `media_type`, `alt_text`.
- `nested_quote_permalink`: only the next quote's URL, nullable.
- `first_seen_at`, `last_seen_at`, `created_at`.

Enforce uniqueness on `(threads_post_id, source_media_id)`. Root and author replies use `published_at ASC, source_media_id ASC` for deterministic chronology. Quotes render within their parent entry and do not occupy the reply timeline.

An existing entry is immutable except for `last_seen_at`. A sync inserts only unseen provider media IDs.

### `threads_links`

- `id`: UUID primary key.
- `entry_id`: parent entry with `ON DELETE CASCADE`.
- `url`: normalized absolute HTTP(S) URL.
- `source`: `body` or `attachment`.
- `ordinal`: original deterministic order.

Links are extracted from text and the API's link-attachment field. Exact duplicates within an entry are stored once at their first ordinal.

### `threads_media`

- `id`: UUID primary key.
- `entry_id`: parent entry with `ON DELETE CASCADE`.
- `source_media_id`: child/provider media ID used to reacquire a fresh CDN URL.
- `kind`: `image`, `video`, or `video_thumbnail`.
- `ordinal`: media order within the entry.
- `status`: `pending`, `ready`, or `error`.
- `r2_key`, `content_type`, `bytes`, `etag`: set only after a completed R2 write.
- `error_code`, `attempt_count`, `created_at`, `updated_at`.

Enforce uniqueness on `(entry_id, source_media_id, kind, ordinal)`. Do not persist Meta CDN URLs or their query strings. A retry reacquires a current URL from the provider using source IDs.

### `threads_sync_jobs`

- `id`: UUID primary key.
- `threads_post_id`, `generation`: unique archive/generation pair.
- `status`: `queued`, `resolving`, `collecting`, `media_pending`, `ready`, `partial`, or `error`.
- Persisted provider cursor plus expected, ready, and failed counts for entries and media.
- Fixed `error_code`, `queued_at`, `started_at`, `content_completed_at`, `completed_at`, `updated_at`.

Only the current generation may advance the root row's status. Stale queue deliveries may complete their own idempotent writes but cannot overwrite a newer generation's job or status.

### `threads_oauth_credentials`

A single fixed-key row stores provider user ID, encrypted access token, AES-GCM nonce, exact granted-scope JSON, token expiry, and refresh/update timestamps. Token encryption uses `THREADS_TOKEN_KEY` with a fresh nonce for every write. Plain tokens never enter logs, telemetry, HTML, or JSON responses.

## OAuth and Token Lifecycle

`GET /threads/connect` creates a cryptographically random, session-bound OAuth state value in a `Secure`, `HttpOnly`, `SameSite=Lax`, `__Host-` cookie with a ten-minute lifetime, then redirects to Meta with the exact scopes above. The callback requires an authenticated PIN session, exact state equality, the configured production origin, a provider authorization code, and no duplicated/unknown query fields.

On success the Worker exchanges the code, validates the granted scopes, obtains a long-lived token, encrypts it, stores it atomically, clears the state cookie, and redirects to `/threads?flash=threads_connected`. Failed or denied authorization stores no credential.

The daily scheduled handler refreshes only an unexpired token that expires within seven days. A capture job performs the same check before a provider call. Successful refresh rotates the encrypted token and nonce atomically. An expired token or missing required scope marks provider work `threads_reconnect_required` without repeatedly retrying. `POST /threads/disconnect` deletes only the credential; archived content and R2 media remain available.

## Queue Protocol

Queue messages contain a version, job type, local IDs, sync generation, and provider cursor or media locator. They contain no access token, post text, profile data, or persisted CDN URL.

### Capture queue

Supported typed jobs are:

- `resolve-post`: normalize a resolved URL and traverse public profile pages to locate the shortcode.
- `collect-conversation`: fetch root details and paginated flattened conversation results.
- `collect-quote`: fetch one quoted post and record only a nested quote permalink.
- `finalize-content`: run only after every conversation page and one-level quote job for the generation has reached a terminal state, atomically verify content completion, create missing media rows, fan out media messages, and set job counts. Repeated finalization is idempotent.
- `delete-archive`: delete archive-owned objects and rows after all cleanup succeeds.

Each cursor page is one idempotent message cycle, which prevents a post with many replies from exceeding one consumer invocation. Conversation filtering compares the stable `owner.id` with the root author ID; only provider records with that ID become `author_reply` entries. A missing owner ID on a reply is treated as an invalid provider record rather than guessed from display text.

### Media queue

Supported jobs archive entry images, videos, thumbnails, author profile images, or retry/deletion work. Before download the consumer reacquires current provider details by stable source ID when its original URL is unavailable or a retry occurs.

The consumer validates HTTPS, an explicit Meta CDN suffix allowlist, at most three allowlisted redirects, a successful response, allowed image/video MIME, and the provider's length. It pipes the response `ReadableStream` directly to R2 and counts streamed bytes without buffering. A single-part object may not exceed 5 GiB. Missing/incorrect length, truncated data, disallowed redirect, unsupported MIME, or excess size fails only that media row. Profile-image jobs participate in the same generation counters and partial/ready aggregation as entry-media jobs.

R2 keys are deterministic:

- Entry media: `threads/posts/{threadsPostId}/{sourceMediaId}/{kind}-{ordinal}`
- Author profiles: `threads/authors/{threadsUserId}/profile`

The D1 row receives the R2 key, MIME, byte count, and ETag only after `put` succeeds. At-least-once redelivery therefore converges on one row and one object key.

Transient Meta `429` responses honor `Retry-After`; transient Meta/R2/Queue `5xx` failures use delayed retry. Validation, permission, and unavailable-source failures are terminal for that message. Messages that exhaust configured retries move to a DLQ whose consumer records the fixed terminal error and `partial` or `error` status.

## Capture and Synchronization Flow

1. `POST /threads` validates authentication, same origin, CSRF, exact form fields, and URL size/shape.
2. A new shortcode inserts `threads_posts`, generation 1, and a queued sync job. A known shortcode increments `sync_generation` and creates a new queued job without duplicating the archive.
3. The response redirects immediately to the archive detail with a fixed created/sync-queued flash; enhanced JSON returns the local ID and status.
4. Capture jobs resolve the provider ID, store the root profile, root entry, all conversation pages, included author replies, links, carousel children, and one-level quotes.
5. D1 page writes use prepared statements and atomic `batch` calls. A page cursor is advanced only in the same successful batch as its entries.
6. `finalize-content` creates only missing media rows and media messages. Ready media rows are never re-downloaded by a normal sync.
7. Content completion plus all media ready produces `ready`. Content completion with any terminal media, quote, or profile failure produces `partial`. Failure to resolve or read the root post produces `error` only when no previous usable snapshot exists; otherwise the old snapshot remains visible with a failed latest-sync notice.
8. A media retry creates a new media message and changes only that media row to `pending`. Job/post aggregation recalculates after completion.

No sync removes an entry, link, or ready media object that is absent at the provider.

## Routes and Response Contracts

Every Threads application route, including the OAuth callback and archived-media route, requires the existing PIN session. Only the pre-existing login, health, telemetry, and CSP-report boundaries retain their current unauthenticated behavior. Every state-changing application request requires existing same-origin and CSRF validation.

### Pages and data

- `GET /threads?page=N`: list ten archives newest-created-first. It accepts only one positive `page` parameter and clamps an out-of-range page to the final logical page.
- `POST /threads`: accept exact fields `csrf` and `url`; create or queue an additive sync.
- `GET /threads/:id?repliesPage=N`: render a complete detail page with twenty author replies per page. Enhanced JSON returns root, quote, first/current reply page, media states, progress counts, and fixed action URLs; it never returns provider tokens or CDN URLs.
- `POST /threads/:id/sync`: accept exact field `csrf` and queue the next generation.
- `POST /threads/:id/delete`: accept exact fields `csrf` and `confirm=yes`, mark the archive `deleting`, and queue cleanup.
- `POST /threads/:id/media/:mediaId/retry`: accept exact field `csrf` and retry only a failed media item scoped to that archive.
- `GET` or `HEAD /threads/:id/media/:mediaId`: serve a ready R2 object scoped to the archive and authenticated session.

The enhanced list polls `GET /threads/:id` with `Accept: application/json` only while the current status is pending or collecting. It uses an ETag and increasing delay, stops when the page is hidden, and stops permanently on ready, partial, error, deletion, or session expiry.

### OAuth

- `GET /threads/connect`
- `GET /threads/oauth/callback?code=...&state=...` or the provider's exact denied-error form
- `POST /threads/disconnect` with exact field `csrf`

Unknown nested routes, malformed IDs, duplicated/unknown fields or query keys, invalid media types, and unsupported methods continue through the current safe routing boundary.

## Authenticated Media Delivery

The R2 bucket has no public development or custom domain. The Worker media route:

- verifies the session and archive-scoped media ID;
- supports full responses and one RFC-compatible byte range;
- returns `206` with `Content-Range` for a valid range and `416` for invalid or multiple ranges;
- returns the stored `Content-Type`, `Content-Length`, quoted ETag, `Accept-Ranges: bytes`, `X-Content-Type-Options: nosniff`, and `Cache-Control: private, no-cache`;
- uses `Content-Disposition: inline` with no provider-derived filename;
- streams R2 directly to the response.

The route never accepts an R2 key or source URL from the client.

## Server-Rendered UI

The shared authenticated header adds `Repository` and `Threads` navigation with `aria-current="page"`. `/threads` is titled `Threads Archive` and presents, in order:

1. Meta connection state and connect/reconnect/disconnect action;
2. a labelled Threads post URL capture form;
3. a fixed status/live region;
4. archive cards;
5. server pagination.

Each card renders:

- a decorative archived profile image beside display name, `@username`, and a semantic `<time>`;
- escaped root text with separately rendered safe links;
- a same-origin R2 image gallery or native `<video controls preload="metadata">` with the archived thumbnail when ready;
- an inset one-level quote card with its own author/date/text/link/media state;
- the first three chronological author replies;
- a real `/threads/:id#author-replies` link labelled `작성자 답글 N개 모두 보기` when more replies exist;
- capture/sync progress or partial/error details using fixed Korean copy;
- sync, failed-media retry, original-post, and delete actions.

An enhanced primary click on the all-replies link fetches reply pages and expands them in the originating card. It creates DOM elements and assigns user content with `textContent`. Modified clicks and JavaScript-disabled clients navigate to the detail page. The detail page exposes all the same content with twenty chronological replies per page.

Deletion uses a dedicated native dialog naming the author and root-post date. Confirm is disabled until the client has assigned the exact archive action. Cancelling restores focus; successful removal moves focus to the list heading or empty state. The no-JavaScript detail form uses the same `confirm=yes` contract.

## Deletion and Retention

Deleting an archive is asynchronous because D1 and R2 cannot share one transaction.

1. The authenticated mutation atomically marks the archive `deleting`, disables further sync/retry, and queues `delete-archive`.
2. The deletion job lists the exact R2 keys already referenced by archive media rows. It also identifies author profile objects whose authors will have no references after this archive is removed.
3. It deletes those objects idempotently, then deletes the `threads_posts` row. Foreign keys cascade to entries, links, media, and jobs; the same D1 batch deletes author rows that have no remaining entry references.
4. A failure leaves the tombstoned row and object-key inventory available for retry; the UI reports deletion pending or failed rather than claiming completion.

Disconnecting Meta does not delete archives. Source deletion, edit, or disappearance never deletes or overwrites archived snapshots.

## Error Model

Use fixed application codes and fixed Korean user messages. Never echo provider bodies, URLs with queries, tokens, source text, or storage internals into errors.

- Invalid URL/form/query/body: HTTP `400`, no mutation.
- Missing archive/media or archive-scoped mismatch: HTTP `404`.
- Duplicate active sync: return the existing current job as a successful idempotent result.
- Private, deleted, geo-gated, copyright-restricted, or provider-exhausted root post: `threads_post_unavailable`.
- Expired credential or missing approved scope: `threads_reconnect_required`; no automatic retry.
- Meta rate limit: delayed Queue retry using a bounded `Retry-After`.
- Meta transient error/timeout: bounded Queue retry.
- Invalid Meta response shape or cursor loop: `threads_provider_protocol_error`.
- D1 protocol/exception: `storage_unavailable`.
- R2 write/read/cleanup exception: media/deletion retry state without data loss.
- Queue send failure during HTTP submission: set the D1 job to `error` with `queue_unavailable` and return a retryable safe response; never claim the job was queued.
- Individual quote/profile/media terminal failure: `partial`; root and successful items remain readable.

## Security and Privacy

- Use exact provider hosts and HTTPS; reject credentials, custom ports, downgrade redirects, and redirects leaving the allowlist.
- Fetch media only from a provider response tied to a validated source media ID. The user cannot submit a media URL.
- Enforce bounded JSON response bytes and strict plain-object/field/type/timestamp/enum validation before persistence.
- Stream large media to stay within Worker memory limits and abort at the declared platform boundary.
- Keep R2 private and require the existing signed session on every media request.
- Escape all server HTML. Client code uses safe DOM creation and `textContent`; it does not use `innerHTML` for API content.
- Activate only normalized HTTP(S) links. New-window links use `noopener noreferrer` and do not send a referrer.
- Add only `media-src 'self'` to the authenticated app CSP for native archived-video playback. Keep the CSP free of Meta embed/script origins and permit no new third-party browser connection.
- Encrypt OAuth tokens with AES-GCM, rotate nonces, redact provider request paths/query values, and never log Threads text, CDN query strings, OAuth codes, state values, or tokens.
- Telemetry records only safe route templates, status buckets, provider class, media type, size bucket, duration bucket, and fixed error dimensions.

## Testing Strategy

Implementation follows red-green-refactor.

### Unit tests

- URL normalization: current/legacy hosts, canonical/short forms, tracking removal, redirect bounds, malformed encoding, credentials, ports, paths, and Unicode.
- Link extraction: punctuation, duplicates, unsafe schemes, attachment order, and escaping.
- Provider validation: all requested fields, enums, timestamps, cursor loops, oversized JSON, malformed children/quotes/replies, and redacted errors.
- Reply filtering: root author at top-level and arbitrary nesting, more than ten author replies, excluded other users, missing owner IDs, and stable chronological ordering.
- HTML: shared navigation, connection states, cards, dates, links, galleries, video, quotes, three-reply preview, partial errors, pagination, forms, and escaped content.
- Source/interface policy: no provider token/CDN/browser leaks and retained CSP boundaries.

### D1 and service integration tests

- Migration schema, indexes, checks, foreign keys, and coexistence with migrations 0001-0003.
- New capture, duplicate submission, additive sync, immutable existing entries, provider-ID uniqueness, and stale-generation races.
- Profile refresh and shared-author reference cleanup.
- Cursor/page atomicity, content finalization, media count aggregation, partial/ready/error transitions, DLQ terminal state, and deletion tombstones.
- OAuth encryption round-trip, nonce rotation, scope validation, refresh window, disconnect retention, and expired-token behavior.

### Provider, Queue, and R2 fixture tests

Extend the test-only provider fixture with exact Meta Graph and CDN boundaries. It models canonical resolution, old posts across multiple profile pages, paginated flattened conversations, mixed authors, nested author replies, carousels, videos, one-level/nested quotes, tracking links, `429`, transient `5xx`, invalid bodies, expiring CDN URLs, truncation, incorrect MIME/length, and oversized streams.

Verify at-least-once duplicate delivery, per-message acknowledgement/retry, delayed retry, both DLQs, fresh-URL reacquisition, deterministic object keys, direct streaming, authenticated full/HEAD/range reads, item retry, and idempotent cleanup.

### Browser tests

- Desktop and mobile URL capture, pending polling, completion, partial success, item retry, sync, and deletion.
- More than ten author replies with the first-three preview and in-card expansion.
- Modified-link and JavaScript-disabled detail navigation, reply pagination, sync, retry, and deletion.
- Image/video/quote rendering, native video range playback, session expiry, and reconnect state.
- Keyboard navigation, focus entry/recovery, reduced-motion behavior, responsive layout, and axe accessibility in Chromium plus the existing cross-browser policy suite.

### Verification commands

Before release run:

```powershell
npm run check
npm test
npm run test:e2e
git diff --check
```

The complete existing Repository, authentication, telemetry, CSP, release-policy, and no-JavaScript suites must remain green.

## Release and Operational Verification

Update the release manifest and workflow policy for the exact R2, two Queue, two DLQ, scheduled-trigger, environment-variable, and secret contracts. Test and production resources must remain distinct.

Before production promotion:

1. confirm Meta app approval for the three exact scopes;
2. inspect the exact Cloudflare account, Worker, D1 database, private R2 bucket, Queue/DLQ resources, bindings, and scheduled trigger without printing secrets;
3. back up production D1;
4. verify migrations 0002 and 0003 are present, then apply only pending migrations including 0004;
5. create and verify the immutable Worker release through the repository's release workflow;
6. authenticate and connect Meta through the production origin;
7. archive one controlled public post containing text, an HTTP(S) link, image/video media, more than ten root-author replies, and a one-level quote;
8. verify D1 rows, private R2 objects, range playback, additive sync, partial retry, and asynchronous delete cleanup without exposing content or tokens in logs;
9. verify `/health`, Repository capture, PIN login/logout, CSP, and active version allocation before declaring completion.

App approval or a public fixture not yet being available blocks only the final live-provider smoke check; it does not relax unit, fixture, integration, security, or release verification.
