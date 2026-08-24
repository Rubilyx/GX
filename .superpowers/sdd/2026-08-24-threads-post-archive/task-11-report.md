# Task 11 report — progressive Threads browser interactions

## Status

Complete. Commit: `dff78ea feat: enhance Threads archive interactions`.

## Delivered

- Added autonomous `thread-capture` and `thread-panel` custom elements with no exported global state.
- Capture intercepts valid submits, disables only the active submitter, uses the existing same-origin `formJson` boundary, strictly validates the accepted capture result, aborts superseded/disconnected requests, preserves the current page on failure, and reports fixed Korean live-region copy.
- Pending/collecting cards poll with the bounded `1000, 2000, 5000, 10000` schedule, ETags/304, one visibility-aware timer, same-origin credentials, abort signals, exact nested response validation, and terminal/session stop.
- Plain all-replies clicks fetch 20-row detail pages sequentially, validate before DOM mutation, preserve modified/native navigation, create text/link/time/media nodes without HTML sinks, deduplicate, retain chronological order, support collapse abort, and show the exact loaded count.
- Sync and media retry intercept only their own forms, keep stored content on errors, and validate exact action results. A terminal sync refreshes an already-expanded reply set.
- Added one shared native delete dialog per panel. It assigns only a validated same-origin action, enables confirm only after assignment, fills author/date with `textContent`, restores opener focus on cancel/Escape, and focuses the list or generated empty-state heading after removal.
- Preserved all native capture/sync/retry/delete forms and real reply detail hrefs for no-JavaScript operation.
- Added the required custom-element hosts, focus targets, shared dialog, entry IDs, and app/modulepreload wiring to server-rendered Threads pages.
- The test harness now serves real checked-in browser assets through the existing immutable release asset route while retaining rejection, missing-asset, MIME/cache, and reset behavior.
- Added the two modules to the Worker exact asset set and regenerated the sorted preload manifest.

## TDD evidence

RED was observed before implementation:

- Focused browser/HTML/interface tests: 5 failures caused by missing modules, hosts, dialog/focus targets, and CSS.
- Focused Chromium suite: all 4 behavior cases failed before production browser JavaScript and hosts existed.

GREEN behavior coverage includes pending capture and polling stop, 12-reply expansion and modified click, partial-media retry, sync adding reply 13, delete cancel/Escape/confirm focus, session stop, 360px containment, and a JavaScript-disabled native capture.

## Fresh verification

- `npm run test:unit`: 320 passed, 0 failed, 1 intentional Windows symlink skip.
- `node --test test/integration/app.test.js`: 30 passed, 0 failed.
- `node --test test/unit/browser-gates.test.js test/unit/interface-policy.test.js`: 16 passed, 0 failed.
- `npx playwright test test/e2e/threads.spec.js --project=chromium`: 4 passed, 0 failed.
- `npm run check:source`: passed.
- `npm run check:types`: passed.
- `npm run lint:css`: passed.
- `git diff --check`: passed; only repository line-ending conversion notices were emitted.

## Self-review

- Task 9 JSON keys, action paths, ETag semantics, CSRF forms, and response status values were not changed.
- Every browser fetch is either `formJson` or an explicit same-origin-credentialed request; no external browser connection API or unsafe HTML sink was added.
- Polling owns at most one timer per card and aborts both status/reply requests on visibility loss or disconnect.
- User/provider strings enter created DOM through `textContent` or validated URL/date properties.
- Native controls remain present and functional without JavaScript.

## Concerns

None known. No production, deployment, dependency, or provider contract changes were made.

## Fix round 1 — CSRF, safe delete fallback, staged replies, cancellation, and sync fencing

Commit: `0376905 fix: harden Threads browser state`.

### Findings addressed

- Thread media rendering now receives the page CSRF token through root and reply renderers and emits the exact escaped hidden `csrf` input in every native retry form.
- Enhanced retry verification asserts the exact JSON result, multipart CSRF field, queued UI transition, and real Queue consumer effect through D1 `attempt_count`. JavaScript-disabled retry verifies the native URL-encoded CSRF submission, fixed redirect, and the same Queue effect.
- Delete enhancement validates the native form action as the exact same-origin `/threads/:id/delete` path before preventing default or assigning dialog state. A corrupt external action now remains a native disclosure click; it neither opens the dialog nor navigates to the unvalidated action.
- Reply expansion now tracks explicit `loading` and `expanded` state. All pages are fetched and validated into staged data, including global count/order/dedup checks, before one `DocumentFragment` commit. A malformed later page leaves the original three replies, label, and collapsed state untouched.
- A second plain activation during loading increments the expansion epoch, aborts the active request, restores the collapsed label, preserves focus, discards the stage, and does not start another request.
- Cards now carry their validated sync generation. Sync success clears the existing timer, increments the poll epoch, aborts and nulls the old controller, clears ETag/terminal state, applies the new generation/status, and schedules a fresh poll. Delayed old-generation data cannot mutate or stop the new generation.
- The deferred module-split Minor was intentionally not addressed in this round.

### TDD evidence

RED was observed before production changes:

- HTML retry-form test failed because the form contained no CSRF input.
- Enhanced and JavaScript-disabled retry cases failed to prove a queued UI/Queue state transition.
- Corrupt delete action navigated to the external action instead of retaining native behavior.
- A malformed page 2 left 20 live replies instead of the original 3.
- A second loading activation started request 2 instead of canceling request 1.
- A delayed generation-1 poll overwrote generation 2 with terminal `error` and stopped polling.

Each focused test passed after its isolated implementation change.

### Fresh fix-round verification

- `node --test test/unit/browser-gates.test.js test/unit/html.test.js test/unit/interface-policy.test.js`: 35 passed, 0 failed.
- `npx playwright test test/e2e/threads.spec.js --project=chromium`: 9 passed, 0 failed.
- `npm run test:unit`: 320 passed, 0 failed, 1 intentional Windows symlink skip.
- `node --test test/integration/app.test.js`: 30 passed, 0 failed.
- `npm run check:types`: passed.
- `npm run check:source`: passed.
- `npm run lint:css`: passed.
- `git diff --check`: passed; only repository line-ending conversion notices were emitted.

One first full-unit attempt had an unrelated `checkCompatibility` child-process timeout after 120 seconds. Its exact focused rerun passed in 4.5 seconds, and the fresh second full-unit run passed completely in 40 seconds.

### Fix-round self-review

- No Task 9 JSON/action/ETag/CSRF contract changed.
- Invalid delete actions are never used for enhanced navigation or dialog submission.
- Reply DOM mutation occurs only once, after all requested pages and cross-page invariants pass.
- Abort epochs protect both reply staging and polling from stale asynchronous completion.
- Native forms, same-origin credentials, modified-link navigation, custom-element hosts, and DOM sink policy remain intact.

### Remaining concern

Only the explicitly deferred module-split Minor remains; it was not changed here.

## Fix round 2 — preserve expanded state when cancelling refresh

Commit: this fix-round commit, `fix: preserve expanded reply refresh state`.

### Finding addressed

- A terminal poll can refresh an already-expanded reply set. While that refresh was loading, a plain activation aborted the request but always restored the collapsed “모두 보기” label, even though the existing expanded nodes and `expanded=true` state remained.
- The cancellation label now derives from the pre-load visible state: initial expansion cancellation remains collapsed with no staged additions, while expanded-refresh cancellation preserves the existing nodes and “접기” label. A following activation still performs an atomic true collapse.
- The deferred `thread-panel.js` module-split Minor was not changed.

### TDD evidence

The focused Chromium regression expanded 12 replies, held the automatic terminal refresh, cancelled it through the visible control, and failed RED with 12 nodes still visible under “작성자 답글 12개 모두 보기”.

After the one-branch lifecycle fix, the initial-loading and expanded-refresh cancellation cases passed together: the former retained 3 nodes/“모두 보기”, and the latter retained 12 nodes/“접기” before a subsequent click collapsed to 3.

### Verification

- `npx playwright test test/e2e/threads.spec.js --project=chromium --grep "second activation|cancelling an expanded reply refresh"`: 2 passed, 0 failed.
- `npx playwright test test/e2e/threads.spec.js --project=chromium`: 10 passed, 0 failed.
- `node --test test/unit/browser-gates.test.js test/unit/html.test.js test/unit/interface-policy.test.js`: 35 passed, 0 failed.
- `npm run check:types`: passed.
- `npm run check:source`: passed.
- `git diff --check`: passed; only repository line-ending conversion notices were emitted.

### Self-review

- The production change is confined to the existing loading-cancellation branch and does not alter fetch, validation, staging, polling, sync, delete, or native fallback contracts.
- Cancellation continues to abort and invalidate the in-flight refresh; no staged nodes can commit afterward.
- DOM nodes, label text, and `expanded` state now remain coherent for both ruled pre-load states.
- No known concern remains beyond the explicitly deferred module split.
