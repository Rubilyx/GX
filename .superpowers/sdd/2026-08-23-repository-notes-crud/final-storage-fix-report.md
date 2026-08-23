# Final storage fix report

## Scope

This final-review fix is limited to repository/Note storage and its focused integration coverage. It does not change Note page parsing, monotonic timestamps, public response shapes, UI/CSS/E2E behavior, migrations, or production state.

## Root causes and reproduction

1. Task 2 removed `personalNote` from `mapRepository`, but its shared repository projection still began with `r.*`. A read-boundary probe captured both `getRepository` and `listRepositories` executing wildcard projections, so SQLite/D1 still materialized the physically retained `personal_note` column before the mapper discarded it.
2. Task 1 implemented `listRepositoryNotes` as three independent D1 statements: parent presence, Note count, then page rows. Each statement was locally shape-checked, but their relationship was not. A deterministic D1 probe returned `{ "notes": [], "page": 1, "totalPages": 2, "total": 6 }` without error, reproducing the cross-read inconsistency.
3. `migrations/0003_repository_notes.sql` already defined the approved ordering index, but the migration integration test asserted only the empty-table, foreign-key, and cascade contracts. It did not protect the index name, columns, or descending order.

The pre-fix focused Note/repository/migration tests all passed, demonstrating that the existing coverage did not catch these findings.

## Design choice

- Repository detail/list reads now share a maintainable explicit projection containing every field consumed by `mapRepository` and excluding `personal_note`. Note-count/latest-Note subqueries and Note-body search are unchanged.
- Note listing now uses one SQLite statement. A parent-repository CTE anchors existence, a windowed CTE assigns the stable `created_at DESC, id DESC` order and total, and a page-metadata CTE clamps the requested page before the final five-row join. The one statement gives D1 one read snapshot without retries.
- The result validator requires successful D1 output, an exact parent repository ID, identical safe integer total/page metadata on every row, the approved clamped page, repository-scoped Note rows, exact page cardinality, and strict newest-first order. Empty repositories require one all-null sentinel row; a missing parent produces no rows and remains `null`. Violations become `storage_unavailable` through the existing error boundary.
- The D1 harness evaluates division involving numeric bindings as real arithmetic. The page-ceiling expression therefore casts the quotient to `INTEGER`; a diagnostic run reproduced `page: 1.8` before this cast for an exact five-Note boundary.
- Migration coverage now reads SQLite index metadata and asserts `repository_notes_repository_order_idx` over `repository_id`, `created_at DESC`, and `id DESC`.

## TDD evidence

### RED

- `node --test --test-name-pattern="never request the legacy|repository notes migration" test/integration/repositories.test.js`
  - The new legacy-read poison test failed with `storage_unavailable` from `getRepository`; the new index characterization assertion passed against the already-correct migration.
- `node --test --test-name-pattern="one D1 snapshot|another repository|stable newest-first|cardinality inconsistent" test/integration/notes.test.js`
  - The one-snapshot boundary test failed with `storage_unavailable` because the implementation attempted a separate `.first()` read.
  - Cross-repository, reversed-order, and impossible-cardinality cases each failed with `Missing expected rejection`.

### GREEN

- The same focused RED commands passed after the implementation.
- `node --test test/integration/notes.test.js` — 12 passed, 0 failed.
- `node --test test/integration/repositories.test.js` — 38 passed, 0 failed.
- `node --test --test-name-pattern="repository notes migration" test/integration/repositories.test.js` — 1 passed, 0 failed.
- `npm run check:types` — exit 0.
- `npm run check:source` — exit 0.
- `git diff --check -- src/notes.js src/repositories.js test/integration/notes.test.js test/integration/repositories.test.js` — exit 0; only Git line-ending advisories were emitted.

## Files and delivery

- `src/notes.js`
- `src/repositories.js`
- `test/integration/notes.test.js`
- `test/integration/repositories.test.js`
- `.superpowers/sdd/2026-08-23-repository-notes-crud/final-storage-fix-report.md`

Planned local commit subject: `fix: make Note reads consistent`. The resulting hash is recorded in the final handoff because a commit cannot embed its own hash. No deployment, GitHub operation, UI/CSS/E2E edit, migration mutation, or public API change is part of this fix.

## Concerns

No open storage concern. The repository has parallel uncommitted UI/HTML/CSS/E2E changes owned by another agent; they are deliberately excluded from this fix's staging and commit.
