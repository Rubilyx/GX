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

## Scoped review fix round 1

### Scope and commit

- Review baseline: clean `8e8bc8e`.
- Implementation/test commit: `3d4d610` (`fix: guarantee durable profile cleanup recovery`).
- The round changed only the four ruled profile retry/cleanup executor gaps. The
  approved page ceiling, pending-first aggregation, client rendering/control
  reconciliation, security boundaries, and release configuration were not
  changed.

### Root causes and fixes

1. **Post terminality was missing from retry authorization.** The profile retry
   CTE and its target-update CAS both admitted every non-deleting post. A
   schema-valid collecting post could therefore be mutated when its job fields
   looked terminal. Both predicates now require the post itself to be exactly
   `ready`, `partial`, or `error`. The test snapshots the complete post/job/author
   rows and Queue before rejection, then proves the same profile retries after
   only the post becomes terminal.
2. **Durable cleanup was evaluated after an origin-scoped read.** An
   `archive-profile` message for a gone/stale origin returned before consulting
   the author-global cleanup ledger. `cleanupAuthorProfileState` now reads by
   author identity first and owns both superseded ready-author keys and deleting
   author tombstones. Primary and DLQ profile paths invoke it before any origin
   post/generation early return. A gone origin with a shared survivor deletes the
   old immutable key and its D1 owner without provider work or a survivor message.
3. **Cleanup preceded lifecycle reconciliation.** A winning CAS could become
   globally ready, fail deletion of its old immutable object, and leave the
   addressed archive/job in `media_pending` across every primary retry. All
   winning/ambiguous ready paths now recalculate first, then attempt author-global
   cleanup. Four consecutive cleanup failures leave the durable owner intact but
   expose `ready` post/job state with a completed timestamp; provider/download
   work occurs only on the winning attempt.
4. **Configured DLQs had no executor after ACK.** Both DLQ consumers are
   configured with `max_retries: 0`; calling `retry()` from them cannot guarantee
   another delivery. Media DLQ now attempts author-global cleanup directly.
   Delete DLQ invokes the real deletion executor before applying the existing
   visible restoration fallback. If R2 is still unavailable, the existing D1
   cleanup-key row or deleting-author tombstone remains owned and the DLQ ACK is
   safe.
5. **The daily scheduled event refreshed only OAuth.** It now runs cleanup before
   credential refresh and selects a deterministic maximum of 25 author owners or
   deleting tombstones. Each owner is isolated: a failing R2 delete retains that
   owner and does not block later rows in the selected page. No Queue re-enqueue
   or producer send is used, so producer failure cannot remove the guaranteed
   executor. In the bounded test, 26 owners plus a rejection at owner 00 leave
   exactly owners 00 and 25 after the first run; the second run clears both.

### Strict RED/GREEN evidence

All Node/NPM/NPX commands again prepended the exact Node 24.18.0 directory to
`PATH`.

RED command:

`node --test --test-name-pattern="profile retry rejects a collecting post|superseded profile cleanup runs when its origin is gone|winning profile recalculates terminal status|profile and deletion DLQs retain scheduled cleanup|scheduled profile cleanup processes" test/integration/threads.test.js`

- 0/5 passed.
- Collecting post retry did not reject.
- Origin-gone cleanup left the old R2 object and D1 owner.
- Cleanup failure left post/job `collecting`/`media_pending` with null completion.
- Origin-gone primary delivery ACKed instead of retrying durable cleanup.
- Scheduled execution left all 26 owners instead of processing a bounded page.

GREEN command (final test name includes failure isolation):

`node --test --test-name-pattern="profile retry rejects a collecting post|superseded profile cleanup runs when its origin is gone|winning profile recalculates terminal status|profile and deletion DLQs retain scheduled cleanup|scheduled profile cleanup isolates" test/integration/threads.test.js`

- 5/5 passed, 0 failed, 0 skipped.
- The Queue-exhaustion test drives four primary deliveries and both zero-retry
  DLQ consumers through the actual worker Queue dispatcher before scheduled
  recovery.
- Nearby pre-existing additive replacement, ambiguous ready-CAS, upload-DLQ,
  deletion tombstone, and shared-author recovery focus passed 8/8 during
  development. Existing scheduled integration passed 1/1 and scheduled unit
  dispatch/wiring passed 2/2.

### Reduced final verification

- Fresh committed-state `npm run check` — PASS: types, CSS, source policy, and
  332 unit cases; 331 passed, 0 failed, 1 intentional Windows symlink skip.
- New fix-round focused integration — 5/5 passed.
- Existing cycle-2 integration command — 7/7 passed: both page ceilings,
  pending-first aggregation, terminal profile retry/replacement cleanup, and
  last/shared-author deletion ownership.
- Focused Chromium cycle-2 regressions — 3/3 passed.
- Focused SSR/profile unit regressions — 2/2 passed.
- `npx wrangler types worker-configuration.d.ts --env test --check` — PASS with
  Wrangler 4.114.0; checked-in types are current.
- `git diff --check` — PASS.
- Final `git status --short` — empty after the report commit.

Per the user's standing minimal-verification instruction, full `npm test`, the
full 403-case E2E matrix, and Task 12 audits were not rerun. The prior clean
`e6ad184` baseline remains the most recent full-suite evidence (integration
185/185; E2E 342 passed / 61 intentional skips).

### Self-review and residual concerns

- Scheduled recovery is deliberately bounded to 25 author owners per daily run.
  A large backlog or persistent R2 outage can delay cleanup, but cannot orphan it:
  D1 ownership/tombstones remain until a successful delete, failed rows are
  isolated, and subsequent cron runs resume deterministically.
- DLQ handlers ACK after their direct attempt because the deployed DLQ consumers
  have zero retries. Safety comes from durable D1 ownership plus the independent
  scheduled executor, not from unsupported DLQ retry semantics.
- No migration change was required in this round. Cleanup keys remain
  author-scoped and validated; R2 deletion still precedes owner removal; shared
  active profile objects remain untouched.
- No load-bearing scoped finding remains open.

### No-production confirmation for fix round 1

No production/live Meta request, Cloudflare API/resource action, secret access,
remote D1 operation, release action, deployment, traffic change, or repository
push occurred. All new Queue exhaustion, DLQ, scheduled, D1, and R2 evidence came
from the isolated local harness.
