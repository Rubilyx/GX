# Remediation cycle 2 report

## Scope and result

- Baseline: clean `e6ad184`.
- Implementation commit: `1bac3c3` (`fix: close Threads archive remediation gaps`).
- Compatibility-test commit: `0153187` (`test: align migration and pending replay coverage`).
- All five ruled residuals are fixed with focused RED/GREEN evidence.
- The final verification scope was reduced at the user's explicit request after
  implementation: fresh `npm run check`, cycle-2 focused integration, focused
  Chromium, focused SSR/profile unit tests, Wrangler type drift, and clean Git
  checks only. Full integration and the full 403-case browser matrix were not
  rerun; the last full baseline at `e6ad184` remained green (integration 185/185;
  browser 342 passed / 61 intentional skips).
- No production, live Meta, Cloudflare, remote migration, release, or push
  operation was performed.

## Root causes and fixes

### 1. Page-10,000 continuation ceiling

Root cause: both cursor transitions guarded the pre-increment counter with
`< 10000`, so a stored count of 9,999 accepted the current page and also inserted
the page-10,001 cursor/continuation. The transaction had no post-increment branch.

Fix:

- Profile discovery increments and persists page 10,000, retains the last
  accepted cursor when a forbidden next cursor is present, suppresses the next
  ledger row, and raises `threads_provider_protocol_error` after the committed
  transaction.
- Conversation capture uses the same rule while retaining all current-page
  entries, media descriptors, and quote work in its transaction.
- Neither phase enqueues page 10,001. Existing replay, `A → B → A`, generation,
  lease, and deleting-post fences remain unchanged.

### 2. Outstanding media dominates terminal failure

Root cause: aggregation selected root/failure outcomes before `pending_count`, and
the pending calculation did not conservatively include leased entry/profile work.
That could publish `partial` while another item was still pending and make the
browser stop polling before late-ready reconciliation.

Fix:

- `pending_count` now covers pending media plus any entry upload lease, and
  pending/deleting profiles plus any profile upload lease.
- `media_pending` takes precedence over missing-root/error/partial aggregation.
  Partial/error can become terminal only when the pending count is zero.
- The client rejects a terminal detail snapshot whose progress still reports
  pending work. It keeps the prior polling state and accepts the next complete
  snapshot, where the late-ready object is rendered.
- The prior finalization replay test now explicitly proves a pending item is
  re-enqueued and stays `media_pending` until it settles; only then does the
  durable failure aggregate to `partial`.

### 3. Terminal-only profile retry

Root cause: the profile branch of the constant-query retry lookup required an
error profile and current generation but did not require discovery/conversation
completion or a terminal job. An early profile error could therefore move the
whole job to `media_pending`, clear completion, and strand later capture work.

Fix:

- Selection and the atomic target mutation both require terminal post/job state,
  completed profile and conversation phases, no capture lease or pending quotes,
  and non-null content/job completion timestamps.
- An active-capture retry returns `threads_media_not_found` without changing the
  post, job, author, queue, or completion fields.
- The read model supplies a boolean `profileMedia.retryable` using the same
  terminal predicate. SSR, JSON URL construction, client validation, and dynamic
  author rendering expose the retry action only when that flag is true.
- Terminal profile retry continues through the prior constant-query service and
  correctly moves the terminal archive to `media_pending`.

### 4. Durable superseded-profile ownership and complete deletion

Root cause: a successful profile CAS overwrote `profile_r2_key` without retaining
an owner for the prior immutable key. Last-archive cleanup then used
`COALESCE(profile_pending_r2_key, profile_r2_key)`, selecting only one key and
losing active/pending/superseded versions.

Fix:

- Migration 0004 adds `threads_profile_cleanup_keys`, keyed by immutable R2 key
  and cascading from its author, with deterministic author/created/key indexing.
- A replacement with an old ready object uses one D1 batch to CAS-install the new
  profile and insert durable cleanup ownership for the old key. A first-time
  profile still uses the prior single CAS path.
- Superseded cleanup validates the author-scoped immutable key, deletes R2 first,
  and deletes the D1 owner only after R2 succeeds. If R2 or the following D1
  removal fails, replay repeats an idempotent R2 delete while ownership remains.
- A ready-profile redelivery runs cleanup before aggregation and performs no Meta
  or R2 upload work.
- Last-reference deletion transactionally enumerates active and pending profile
  keys into the cleanup ledger after the archive cascade makes the author truly
  unreferenced. Existing superseded rows remain independent. Cleanup combines
  the legacy active tombstone and every owned key without `COALESCE` loss.
- The last archive's post may remain gone on an R2 failure, preserving the prior
  tombstone behavior; the author row and cleanup owners survive for queue replay.
- Shared-author deletion does not transfer or delete any profile version. The
  concurrent two-archive last-reference behavior still converges in one delivery
  order because the transaction removing the final reference owns the keys.

### 5. Client renderer and deletion-reconciliation parity

Root causes: dynamic media rendered retry forms without SSR's pending/error copy;
body linkification used only the first `indexOf` match for each stored URL; and
deletion disabled card controls without a terminal-restoration reset.

Fix:

- Dynamic media adds the exact SSR Korean pending and failure text.
- Linkification enumerates every non-overlapping occurrence of each validated
  stored URL, preserving deterministic overlap ordering and safe DOM-node APIs.
- A deleting-to-ready/partial/error complete reconciliation re-enables card
  buttons and removes reply-link `aria-disabled`. Rebuilt retry forms still obey
  media/profile eligibility, while prior poll-generation and expanded-reply
  cancellation fences remain intact.

## RED evidence

All Node/NPM/NPX commands in this cycle used Node 24.18.0 by prepending
`C:\Users\axsio\AppData\Local\Temp\repo-atlas-threads-node-v24.18.0` to `PATH`.

- Page ceiling:
  `node --test --test-name-pattern="profile page 10000|conversation page 10000" test/integration/threads.test.js`
  — 0/2; both phases queued one forbidden continuation.
- Aggregation:
  `node --test --test-name-pattern="pending media dominates" test/integration/threads.test.js`
  — 0/1; actual status was terminal `partial` instead of `media_pending`.
- Profile terminal gate and replacement replay:
  `node --test --test-name-pattern="additive profile refresh|profile replacement retains cleanup" test/integration/threads.test.js`
  — 0/2; active retry was not rejected, and a failed superseded-key delete ACKed
  because no cleanup owner existed.
- Schema and last/shared deletion:
  `node --test --test-name-pattern="0004 creates|last-archive deletion owns|deleting one shared archive retains" test/integration/threads.test.js`
  — 0/3; the cleanup table was absent and distinct profile versions were not
  owned/enumerated.
- Profile action rendering:
  `node --test --test-name-pattern="profile retry renders" test/unit/html.test.js`
  — 0/1; an active collecting archive rendered the profile retry URL.
- Client behavior:
  `npx playwright test test/e2e/threads.spec.js --project=chromium --grep="terminal response with pending|dynamic reply media|delete DLQ terminal"`
  — 0/3; polling stopped after one terminal-but-pending snapshot, only one of two
  URL occurrences became a link and state copy was absent, and restored sync
  remained disabled.

The RED assertions used real D1 state and the actual browser component. Expected
values were hand-derived from the rulings rather than copied from implementation.

## GREEN and compatibility evidence

- Early ceiling compatibility focus (including existing ledger/cap cases): 4/4.
- Combined schema/ceiling/profile/aggregation focus initially passed 6/8. The two
  deletion failures identified an invalid new assertion that D1's post-delete
  change count excluded FK cascades; removing only that assertion made the
  deletion focus 2/2. Product behavior and ownership gates were not weakened.
- Existing ambiguous-ready, concurrent shared deletion, tombstone retry, and the
  new last/shared deletion cases: 5/5.
- Compatibility assertions discovered before the user reduced verification:
  `node --test --test-name-pattern="migration creates the complete table inventory|finalization replays only pending" test/integration/repositories.test.js test/integration/threads.test.js`
  — 2/2 after adding the cleanup table to the inventory and aligning replay with
  the approved pending-first lifecycle.

## Final reduced verification

- `npm run check` — PASS at committed `0153187`. TypeScript, CSS, source policy,
  and unit gates are green: 332 total, 331 passed, 0 failed, 1 intentional Windows
  symlink skip.
- Cycle-2 focused integration:
  `node --test --test-name-pattern="profile page 10000|conversation page 10000|pending media dominates|additive profile refresh|profile replacement retains cleanup|last-archive deletion owns|deleting one shared archive retains" test/integration/threads.test.js`
  — 7/7 passed, 0 failed, 0 skipped.
- Focused Chromium:
  `npx playwright test test/e2e/threads.spec.js --project=chromium --grep="terminal response with pending|dynamic reply media|delete DLQ terminal"`
  — 3/3 passed.
- Focused SSR/profile:
  `node --test --test-name-pattern="Threads index renders|profile retry renders" test/unit/html.test.js`
  — 2/2 passed.
- `npx wrangler types worker-configuration.d.ts --env test --check` — PASS with
  Wrangler 4.114.0; checked-in types are current.
- `git diff --check` — PASS apart from the repository's existing Windows
  LF-to-CRLF notices.
- Final `git status --short` — empty after this report commit.

The user explicitly stopped the planned broad verification. A broad `npm test`
had completed its unit phase (331 passed / 1 skip) and was interrupted during
integration. Its two observed compatibility assertions were fixed and verified
2/2 as recorded above; the incomplete broad run is not reported as a passing
gate. Full integration and full E2E were intentionally not rerun. The immediately
preceding clean `e6ad184` baseline had full integration 185/185 and full browser
342 passed / 61 intentional skips.

## Migration and security audit

- Migration 0004 remains an internally consistent, unmerged/unapplied feature
  migration. The cleanup table has an author FK with `ON DELETE CASCADE`, a
  non-negative timestamp check, immutable primary key ownership, and a stable
  author scan index.
- Cursor ledger FK/uniqueness, quote-parent triggers, upload lease constraints,
  and all prior generation/deletion fences remain in place.
- Profile cleanup accepts only conservative author-scoped version keys. R2 is
  deleted before ownership is cleared; shared authors retain all active, pending,
  and superseded objects.
- Media serving remains authenticated, archive-scoped, private/no-store, and
  range-safe. No provider/CDN URL was added to D1 or client JSON.
- Client changes continue to use validated same-origin URLs, validated external
  URLs, `textContent`, and DOM node construction; no HTML sink was introduced.
- Provider auth/transient classification, reconnect persistence, token storage,
  logging/telemetry safe fields, release boundaries, and private R2 bindings were
  not changed in this cycle.

## Self-review and residual concerns

- The cleanup ledger deliberately permits multiple superseded versions per
  author and processes them serially. This favors replay clarity over parallel R2
  deletion; the bounded number of versions is controlled by replacement events.
- A deletion may remove the last post before a profile R2 failure, as it did
  before this cycle. Durable author/cleanup tombstones now make that state safe and
  replayable rather than attempting to restore a deleted archive.
- The large `thread-panel.js` remains a readability concern, but this cycle's
  parity changes share its validation/render/poll/mutation state. A cosmetic split
  was not warranted and no new architectural coupling was introduced.
- No load-bearing cycle-2 product or security concern remains open. Live Meta app
  approval, resource provisioning, remote migration, release creation, and smoke
  tests remain external deployment prerequisites.

## No-production confirmation

No Cloudflare resource was read or mutated; no secret was read or set; no remote
D1 migration or backup ran; no Worker was uploaded, promoted, rolled back, or
allocated traffic; no repository push occurred; and no live Meta request was
made. All Queue, R2, D1, provider, and browser evidence used the isolated local
test environment.
