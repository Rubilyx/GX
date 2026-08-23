# Repository Notes CRUD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Replace the single personal-note field with a normalized, titleless Note collection that supports repository-scoped CRUD, dates, card counts/previews, and five-item numbered pagination.

**Architecture:** Add a repository_notes child table and a focused storage module, then join Note summaries into repository list queries. Expose HTML/JSON Note routes through the existing Worker, use server-rendered pages as the mobile/no-JavaScript baseline, and enhance desktop card clicks with the existing repo-panel dialog and safe DOM construction.

**Tech Stack:** Cloudflare Workers, D1/SQLite migrations, JavaScript ESM with TypeScript checking, server-rendered HTML, Web Components, CSS cascade layers, Node test runner, Wrangler test harness, Playwright, axe-core.

**Spec:** docs/superpowers/specs/2026-08-23-repository-notes-crud-design.md

## Global Constraints

- Note bodies are titleless, trimmed, NFC-normalized, non-empty, and at most 4,000 Unicode code units.
- Notes sort by created_at DESC, id DESC; editing never changes list position.
- Page size is exactly 5.
- Dates display in Asia/Seoul as YYYY.MM.DD; modification is shown only when updated_at > created_at.
- Existing repositories.personal_note values are not migrated, copied, displayed, searched, or overwritten.
- Keep the legacy personal_note column physically present; do not rebuild repositories.
- Do not add dependencies or change GitHub/OpenAI provider requests.
- Preserve all unrelated dirty and untracked workspace files, including migrations/0002_repository_activity.sql and repo-atlas-card-evaluation.html.
- Do not push, open a pull request, create a GitHub release, run GitHub Actions, or perform any GitHub operation.
- Direct Cloudflare delivery must keep the exact existing production bindings, variables, secrets, Worker subdomain settings, and one 100% active version.

## File Map

- Create migrations/0003_repository_notes.sql: creates the Note table and repository/order index without data migration.
- Create src/notes.js: owns Note validation consumption, D1 CRUD, pagination, row mapping, summary reads, and storage protocol errors.
- Modify src/domain.js: validates a Note body and parses the Note page query; removes personalNote from repository category/tag edits.
- Modify src/repositories.js: joins noteCount/latestNote into repository reads, searches Note rows, and stops mapping/writing personalNote.
- Modify src/worker.js: recognizes Note collection/item routes, enforces method/query/form policies, returns HTML/JSON, and records safe route templates.
- Modify src/html.js: renders Note-aware cards, the shared desktop manager shell, the server Note page, dates, numbered pagination, and updated detail/delete copy.
- Modify public/assets/repo-panel.js: implements dialog list loading and Note create/edit/delete/pagination enhancement.
- Modify public/assets/repositories.css: styles the Note manager, dated list items, inline edit state, numbered navigation, and delete confirmation.
- Modify test/support/harness.js: adds deterministic Note seeding for integration and browser setup.
- Modify test/unit/domain.test.js: covers Note normalization and page parsing.
- Modify test/integration/repositories.test.js: covers migration, cascade, card summaries, Note search, and retired legacy fields.
- Create test/integration/notes.test.js: covers the Note storage service and pagination boundaries.
- Modify test/integration/app.test.js: covers routes, forms, JSON/HTML responses, authentication, CSRF, and safe telemetry names.
- Modify test/unit/html.test.js: locks card, Note page/dialog, dates, escaping, forms, and pagination markup.
- Modify test/unit/interface-policy.test.js: locks new CSS/state selectors and target sizes.
- Modify test/e2e/app.spec.js: covers enhanced desktop CRUD, count/preview synchronization, pagination, and focus.
- Modify test/e2e/native-no-js.spec.js: covers mobile/no-JavaScript Note CRUD and real page links.
- Modify test/e2e/accessibility.spec.js: covers dialog/page names, live status, keyboard flow, and axe.
- Verify public/modulepreload.json: remains unchanged because no new browser module is introduced.

---

### Task 1: Add the normalized Note schema, validation, and storage service

**Files:**
- Create: migrations/0003_repository_notes.sql
- Create: src/notes.js
- Create: test/integration/notes.test.js
- Modify: src/domain.js
- Modify: test/unit/domain.test.js
- Modify: test/integration/repositories.test.js
- Modify: test/support/harness.js

**Interfaces:**
- Consumes: AppError from src/domain.js, D1 prepare/bind/first/all/run, crypto.randomUUID(), and the repository foreign key from migrations/0001_initial.sql.
- Produces: validateRepositoryNote(raw), parseNotePage(url), listRepositoryNotes(db, repositoryId, requestedPage), createRepositoryNote(db, repositoryId, rawBody), updateRepositoryNote(db, repositoryId, noteId, rawBody), deleteRepositoryNote(db, repositoryId, noteId), getRepositoryNoteSummary(db, repositoryId), and seedRepositoryNote(db, overrides).

- [ ] **Step 1: Write failing domain tests**

Add imports for validateRepositoryNote and parseNotePage, then add:

    test("normalizes and bounds a repository Note body", () => {
      assert.equal(validateRepositoryNote("  cafe\u0301  "), "café");
      assert.equal(validateRepositoryNote("x".repeat(4000)).length, 4000);
      for (const value of ["   ", "x".repeat(4001), null, 12]) {
        assert.throws(
          () => validateRepositoryNote(value),
          (error) => error instanceof AppError &&
            error.code === "invalid_repository_note" && error.status === 400,
        );
      }
    });

    test("accepts only the Note list page query", () => {
      assert.equal(parseNotePage(new URL("https://app.test/repositories/repo-1/notes")).page, 1);
      assert.equal(parseNotePage(new URL("https://app.test/repositories/repo-1/notes?page=3")).page, 3);
      for (const search of ["?page=0", "?page=1&page=2", "?q=x"]) {
        assert.throws(
          () => parseNotePage(new URL("https://app.test/repositories/repo-1/notes" + search)),
          /invalid_note_query/,
        );
      }
    });

- [ ] **Step 2: Run the domain tests and verify RED**

Run:

    node --test test/unit/domain.test.js

Expected: FAIL because both exports are missing.

- [ ] **Step 3: Implement domain validation and page parsing**

In src/domain.js add:

    export function validateRepositoryNote(raw) {
      if (typeof raw !== "string")
        throw new AppError("invalid_repository_note", 400);
      const body = raw.trim().normalize("NFC");
      if (!body || body.length > 4_000)
        throw new AppError("invalid_repository_note", 400);
      return body;
    }

    export function parseNotePage(url) {
      for (const key of url.searchParams.keys()) {
        if (key !== "page" || url.searchParams.getAll(key).length !== 1)
          throw new AppError("invalid_note_query", 400);
      }
      const raw = url.searchParams.get("page");
      if (raw === null) return { page: 1 };
      if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw)))
        throw new AppError("invalid_note_query", 400);
      return { page: Number(raw) };
    }

Run the domain test again and require it to pass.

- [ ] **Step 4: Write failing migration and storage tests**

In test/integration/repositories.test.js, construct a v2 repository containing personal_note = "legacy must not migrate", apply migrations/0003_repository_notes.sql statement by statement, and assert:

    assert.equal(await env.PROD_DB.prepare(
      "SELECT COUNT(*) FROM repository_notes",
    ).first("COUNT(*)"), 0);
    assert.deepEqual(
      await env.PROD_DB.prepare("PRAGMA foreign_key_list(repository_notes)").all()
        .then((result) => result.results.map((row) => [row.table, row.from, row.on_delete])),
      [["repositories", "repository_id", "CASCADE"]],
    );

Insert one Note, delete the parent repository, and assert the child count is zero.

In test/integration/notes.test.js, add focused tests that:

- return an empty page with page 1 and totalPages 1 for an existing repository;
- return null for a missing repository;
- create a trimmed/NFC body and a UUID Note;
- list six deterministic rows as five on page 1 and one on page 2;
- clamp page 99 to page 2;
- update a repository-scoped Note without changing createdAt and with updatedAt greater than createdAt;
- reject updating/deleting the same Note through another repository ID;
- delete the intended Note;
- return noteCount/latestNote under stable created-order semantics;
- map failed or malformed D1 responses to storage_unavailable.

Add this deterministic helper to test/support/harness.js:

    export async function seedRepositoryNote(db, overrides = {}) {
      const row = {
        id: "note-1", repositoryId: "repo-1", body: "Note body",
        createdAt: 1, updatedAt: 1, ...overrides,
      };
      await db.prepare(
        "INSERT INTO repository_notes " +
        "(id, repository_id, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(row.id, row.repositoryId, row.body, row.createdAt, row.updatedAt).run();
      return row;
    }

- [ ] **Step 5: Run storage tests and verify RED**

Run:

    node --test test/integration/notes.test.js
    node --test --test-name-pattern="repository notes migration" test/integration/repositories.test.js

Expected: FAIL because the migration, helper, and src/notes.js do not exist.

- [ ] **Step 6: Create the migration**

Create migrations/0003_repository_notes.sql with exactly:

    PRAGMA foreign_keys = ON;

    CREATE TABLE repository_notes (
      id TEXT PRIMARY KEY NOT NULL,
      repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX repository_notes_repository_order_idx
    ON repository_notes (repository_id, created_at DESC, id DESC);

Do not add any legacy-data INSERT.

- [ ] **Step 7: Implement src/notes.js**

Use PAGE_SIZE = 5 and strict row guards. The core statements must be:

    SELECT 1 AS present FROM repositories WHERE id = ?

    SELECT COUNT(*) AS count
    FROM repository_notes
    WHERE repository_id = ?

    SELECT id, repository_id, body, created_at, updated_at
    FROM repository_notes
    WHERE repository_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT ? OFFSET ?

    INSERT INTO repository_notes (id, repository_id, body)
    SELECT ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM repositories WHERE id = ?)
    RETURNING id, repository_id, body, created_at, updated_at

    UPDATE repository_notes
    SET body = ?, updated_at = max(unixepoch(), updated_at + 1)
    WHERE repository_id = ? AND id = ?
    RETURNING id, repository_id, body, created_at, updated_at

    DELETE FROM repository_notes
    WHERE repository_id = ? AND id = ?

Implement getRepositoryNoteSummary with one aggregate row and a correlated newest-body subquery:

    SELECT
      COUNT(*) AS note_count,
      (
        SELECT body
        FROM repository_notes AS newest
        WHERE newest.repository_id = ?
        ORDER BY newest.created_at DESC, newest.id DESC
        LIMIT 1
      ) AS latest_note
    FROM repository_notes
    WHERE repository_id = ?

Return { noteCount, latestNote }, validate non-negative integer counts and string-or-null latestNote, enforce mutation changes of zero or one, and translate unexpected D1 failures to new AppError("storage_unavailable", 503).

- [ ] **Step 8: Run Task 1 checks and verify GREEN**

Run:

    node --test test/unit/domain.test.js
    node --test test/integration/notes.test.js
    node --test --test-name-pattern="repository notes migration" test/integration/repositories.test.js
    npm run check:types
    git diff --check

Expected: every test/check exits 0.

- [ ] **Step 9: Create a local-only Task 1 commit**

Do not contact GitHub. Stage only Task 1 paths after inspecting their diffs:

    git diff -- migrations/0003_repository_notes.sql src/domain.js src/notes.js test/unit/domain.test.js test/integration/notes.test.js test/integration/repositories.test.js test/support/harness.js
    git add -- migrations/0003_repository_notes.sql src/domain.js src/notes.js test/unit/domain.test.js test/integration/notes.test.js test/integration/repositories.test.js test/support/harness.js
    git commit -m "feat: add repository note storage"

If a listed tracked path contains pre-existing user changes that cannot be separated safely, do not commit that path; leave it modified and record the reason in the execution checkpoint.

---

### Task 2: Join Note summaries into repositories and retire the legacy field

**Files:**
- Modify: src/domain.js
- Modify: src/repositories.js
- Modify: test/unit/domain.test.js
- Modify: test/integration/repositories.test.js

**Interfaces:**
- Consumes: repository_notes from Task 1 and the existing getRepository, listRepositories, updateRepository contracts.
- Produces: repository.noteCount: number, repository.latestNote: string|null, updateRepository(db, id, { primaryCategory, tags }), and Note-aware text search.

- [ ] **Step 1: Write failing repository contract tests**

Update domain tests so validateRepositoryEdit accepts exactly:

    assert.deepEqual(validateRepositoryEdit({
      primaryCategory: "Backend", tags: [" Node JS ", "node-js"],
    }), { primaryCategory: "Backend", tags: ["node-js"] });

Require personalNote to be rejected as an extra field.

In repository integration tests:

- seed two repositories;
- seed three Notes on the first at createdAt 10, 20, and 20 with IDs note-a, note-b, note-c;
- assert getRepository and listRepositories return noteCount 3 and latestNote from note-c;
- assert the second returns noteCount 0 and latestNote null;
- assert q matches a body that appears only in a non-newest Note;
- assert literal %, _, and backslash Note searches keep existing wildcard escaping;
- assert updateRepository updates only category/tags and leaves all Note rows unchanged;
- assert repository objects no longer have an own personalNote property.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

    node --test test/unit/domain.test.js
    node --test --test-name-pattern="Note summary|Note body search|repository edit excludes" test/integration/repositories.test.js

Expected: FAIL because repository reads still expose personalNote, search the legacy column, and do not compute summaries.

- [ ] **Step 3: Narrow repository edit validation**

Change EDIT_KEYS and validateRepositoryEdit so the only accepted keys are primaryCategory and tags. Remove normalizedPersonalNote and validatePersonalNote only after rg confirms no remaining approved caller needs them:

    rg -n "validatePersonalNote|personalNote|updatePersonalNote" src test

Keep Note body validation exclusively under validateRepositoryNote.

- [ ] **Step 4: Implement Note-aware repository selects**

Introduce one reusable SQL projection string in src/repositories.js:

    r.*,
    (
      SELECT COUNT(*)
      FROM repository_notes AS note_count_rows
      WHERE note_count_rows.repository_id = r.id
    ) AS note_count,
    (
      SELECT newest.body
      FROM repository_notes AS newest
      WHERE newest.repository_id = r.id
      ORDER BY newest.created_at DESC, newest.id DESC
      LIMIT 1
    ) AS latest_note

Use it in getRepository and listRepositories. Map and validate:

    noteCount: Number(row.note_count),
    latestNote: row.latest_note

Reject a non-integer/negative count or a latest value that is neither string nor null as storage_unavailable. Remove personalNote from mapRepository.

Replace the legacy search branch with:

    OR EXISTS (
      SELECT 1
      FROM repository_notes AS note_search
      WHERE note_search.repository_id = r.id
        AND note_search.body LIKE ? ESCAPE '\' COLLATE NOCASE
    )

Bind one additional copy of the escaped pattern. Update updateRepository to write only primary_category and updated_at, then replace tags in the existing batch. Delete updatePersonalNote and its import sites only after Task 3 supplies the new routes.

- [ ] **Step 5: Run Task 2 checks and verify GREEN**

Run:

    node --test test/unit/domain.test.js
    node --test test/integration/repositories.test.js
    npm run check:types
    npm run check:source
    git diff --check

Expected: all commands exit 0, with existing refresh/activity behavior still passing.

- [ ] **Step 6: Create a local-only Task 2 commit**

Do not push:

    git diff -- src/domain.js src/repositories.js test/unit/domain.test.js test/integration/repositories.test.js
    git add -- src/domain.js src/repositories.js test/unit/domain.test.js test/integration/repositories.test.js
    git commit -m "feat: expose repository note summaries"

Use the same overlapping-dirty-path safeguard from Task 1.

---

### Task 3: Add authenticated Note routes and server-rendered management

**Files:**
- Modify: src/worker.js
- Modify: src/html.js
- Modify: test/integration/app.test.js
- Modify: test/unit/html.test.js
- Modify: test/unit/telemetry.test.js

**Interfaces:**
- Consumes: all Task 1 Note service functions, Task 2 repository shape, existing enhanced Accept negotiation, auth/CSRF helpers, document(), htmlText(), htmlAttr(), csrf(), and error response boundary.
- Produces: GET/POST Note collection routes, POST Note item/delete routes, renderRepositoryNotesPage(view), Note-aware cards, and safe route template /repositories/:id/notes.

- [ ] **Step 1: Write failing worker integration tests**

Add helpers that submit authenticated URL-encoded forms with the existing session/CSRF fixture. Cover:

    GET /repositories/repo-1/notes?page=2
    POST /repositories/repo-1/notes
    POST /repositories/repo-1/notes/note-1
    POST /repositories/repo-1/notes/note-1/delete

For JSON Accept, assert exact response keys:

    assert.deepEqual(Object.keys(listJson).sort(),
      ["notes", "page", "repository", "total", "totalPages"]);
    assert.deepEqual(Object.keys(listJson.repository).sort(),
      ["id", "name", "owner", "summary"]);
    assert.deepEqual(createJson.noteSummary,
      { noteCount: 1, latestNote: "새 Note" });

Also assert:

- unauthenticated GET redirects and unauthenticated JSON returns session_expired;
- every mutation rejects absent/invalid CSRF;
- create/update reject empty and 4,001-character bodies;
- duplicate/extra form fields return invalid_form;
- delete requires confirm=yes;
- a repository/note mismatch returns repository_note_not_found;
- GET with page=0 or an extra query returns invalid_note_query;
- query strings on mutations return invalid_query;
- GET on an item path and DELETE/PATCH methods return 405 or 404 under the exact route policy;
- HTML mutations redirect to the Note page with fixed flash codes.

- [ ] **Step 2: Write failing HTML renderer tests**

Update the repository fixture to use noteCount/latestNote instead of personalNote. Require:

    <a data-repository-link href="/repositories/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/notes">Note 3</a>

and an escaped newest preview. For zero Notes require visible Note and no .repository-memo.

Add renderRepositoryNotesPage tests for:

- heading owner/name and escaped summary;
- new form action ending in /notes with csrf and body maxlength 4000;
- five list items with body, creation time, optional modification time;
- Asia/Seoul YYYY.MM.DD date text at a UTC day boundary;
- update actions ending in /notes/:noteId;
- delete actions ending in /notes/:noteId/delete with confirm=yes;
- page 2 of 3 with previous, links 1/2/3, next, and aria-current=page;
- empty state;
- escaped Note body and confirmation data;
- detail page heading “분류 편집”, no personalNote textarea, and a Note manager link;
- repository delete warning saying all Notes are deleted.

- [ ] **Step 3: Run Task 3 tests and verify RED**

Run:

    node --test test/integration/app.test.js
    node --test test/unit/html.test.js

Expected: FAIL because the new paths are unmatched and the renderer still uses the legacy textarea/dialog.

- [ ] **Step 4: Implement route recognition and method/query policy**

In src/worker.js add:

    const REPOSITORY_PATH =
      /^\/repositories\/([0-9a-f-]+)(?:\/(activity|refresh|delete))?$/;
    const REPOSITORY_NOTES_PATH =
      /^\/repositories\/([0-9a-f-]+)\/notes(?:\/([0-9a-f-]+)(?:\/(delete))?)?$/;

Update knownRoute so:

- a Note collection allows GET and POST;
- a Note item and item/delete allow POST only;
- existing repository rules remain unchanged.

Permit query parameters only on root GET, repository detail GET, and Note collection GET. Parse the Note page with parseNotePage. Add /repositories/:id/notes to pageRoute and safeRouteTemplate without ever including raw IDs.

Add a narrow JSON repository projection:

    function noteRepository(repository) {
      return {
        id: repository.id, owner: repository.owner, name: repository.name,
        summary: repository.summary,
      };
    }

Implement:

- renderRepositoryNotes(): getRepository, listRepositoryNotes, JSON or renderRepositoryNotesPage;
- create route: form fields csrf/body, createRepositoryNote, getRepositoryNoteSummary;
- update route: form fields csrf/body, updateRepositoryNote, getRepositoryNoteSummary;
- delete route: form fields csrf/confirm, require yes, deleteRepositoryNote, getRepositoryNoteSummary.

Return repository_not_found for a missing parent and repository_note_not_found for a missing repository-scoped Note. Add fixed flash codes repository_note_created, repository_note_updated, and repository_note_deleted to the allowlist and message map.

- [ ] **Step 5: Implement server HTML and card contracts**

In src/html.js:

- change the card Note href to detail + "/notes";
- derive label from noteCount;
- derive preview only from latestNote;
- replace the legacy textarea dialog with an empty enhanced Note manager shell containing stable data selectors for heading, summary, create form, status, list, pagination, close, and delete confirmation;
- add noteDate(unixSeconds) using Intl.DateTimeFormat formatToParts with timeZone "Asia/Seoul" and join year/month/day as YYYY.MM.DD;
- add notePageHref(repositoryId, page);
- add a private noteListMarkup(view) used by renderRepositoryNotesPage;
- remove personalNote from the repository edit form and rename its section;
- link the detail page to /repositories/:id/notes;
- update repository deletion copy to “모든 Note”.

All body, owner, name, date attributes, IDs, hrefs, and excerpts pass through htmlText/htmlAttr. The server page uses real forms and links and must not depend on client JavaScript.

- [ ] **Step 6: Update telemetry policy tests**

Require safeRouteTemplate and pageRoute to map the Note manager to /repositories/:id/notes. Assert raw repository and Note IDs never appear in telemetry records. Preserve all existing allowed route templates.

- [ ] **Step 7: Run Task 3 checks and verify GREEN**

Run:

    node --test test/integration/app.test.js
    node --test test/unit/html.test.js
    node --test test/unit/telemetry.test.js
    npm run check:types
    npm run check:source
    git diff --check

Expected: every command exits 0.

- [ ] **Step 8: Create a local-only Task 3 commit**

Do not push:

    git diff -- src/worker.js src/html.js test/integration/app.test.js test/unit/html.test.js test/unit/telemetry.test.js
    git add -- src/worker.js src/html.js test/integration/app.test.js test/unit/html.test.js test/unit/telemetry.test.js
    git commit -m "feat: add repository note routes"

Use the overlapping-dirty-path safeguard.

---

### Task 4: Enhance desktop Note CRUD and style both presentations

**Files:**
- Modify: public/assets/repo-panel.js
- Modify: public/assets/repositories.css
- Modify: test/unit/interface-policy.test.js
- Modify: test/e2e/app.spec.js
- Modify: test/e2e/native-no-js.spec.js
- Modify: test/e2e/accessibility.spec.js
- Verify: public/modulepreload.json

**Interfaces:**
- Consumes: Task 3 data selectors and JSON shapes, formJson(), setText(), the existing desktop breakpoint at 840px, and existing dialog/focus patterns.
- Produces: loadNotes(url, page), DOM-rendered five-row Note pages, create/update/delete actions, card synchronization, and accessible confirmation/focus behavior.

- [ ] **Step 1: Write failing CSS policy tests**

Require owned declarations for:

- a bounded desktop Note dialog with safe viewport max-height and internal overflow;
- a grid/flex Note manager layout with 44px minimum interactive targets;
- .repository-note-list as an unstyled list with divided items;
- body white-space: pre-wrap and overflow-wrap: anywhere;
- metadata/date text at the approved smaller secondary style;
- inline edit textarea minimum height;
- numbered pagination with aria-current styling;
- danger hover color without layout change;
- mobile Note page width and no horizontal overflow.

Keep the already-approved refresh icon assertions at an 18px SVG, transparent hover background, and danger hover color.

- [ ] **Step 2: Write failing browser scenarios**

Replace the old single-note E2E with a serial desktop scenario:

1. Open the first card's Note link at desktop width and assert focus is in the new textarea.
2. Create Notes “Note 1” through “Note 6”.
3. Assert the card label is Note 6 and preview is Note 6.
4. Assert dialog page 1 shows five rows and numbered links 1 and 2.
5. Open page 2 and assert only Note 1 appears.
6. Edit Note 1, assert creation text remains and modification text appears, and assert it stays on page 2.
7. Open its delete confirmation, assert date and excerpt, cancel, and assert focus returns to its delete button.
8. Confirm deletion, assert the clamped refreshed page is page 1 and focus is on the list/empty heading.
9. Delete the newest Note and assert card count/preview change immediately.
10. Close the dialog and assert focus returns to the card Note link.

Add:

- a request failure test that preserves draft text and re-enables retry;
- native-no-JavaScript create/edit/delete/page-link coverage using real forms;
- mobile navigation coverage proving the card link opens the Note page rather than a modal;
- axe checks for the open manager and deletion confirmation;
- a keyboard-only create/edit/cancel flow.

- [ ] **Step 3: Run policy and browser tests and verify RED**

Run:

    node --test test/unit/interface-policy.test.js
    npx playwright test test/e2e/app.spec.js test/e2e/native-no-js.spec.js test/e2e/accessibility.spec.js --project=chromium

Expected: policy tests fail for absent selectors and browser tests fail because the old single textarea flow remains.

- [ ] **Step 4: Refactor repo-panel Note state**

Keep repository deletion and activity refresh behavior unchanged. Replace only the old syncCardMemo/open/saveNote code with state:

    this.noteState = {
      opener: null,
      repositoryId: "",
      listUrl: "",
      page: 1,
      controller: null,
      deleteOpener: null,
    };

Use these methods with the exact responsibilities:

- openNotes(event, dialog): validate same-origin /repositories/:id/notes, fetch JSON, populate heading/summary/list, open, focus textarea.
- loadNotes(dialog, url): abort the prior list request, fetch JSON, validate all IDs/body/timestamps/page fields, and call renderNotes.
- renderNotes(dialog, result): build li, p, time, form, textarea, buttons, links with createElement/textContent/setAttribute only.
- createNote(event, dialog, form): formJson, validate { note, noteSummary }, syncCardNotes, clear draft, load page 1.
- beginEdit(event, dialog): replace one body's presentation with the inline form while retaining a cancelable copy.
- updateNote(event, dialog, form): formJson, sync summary, reload current page.
- openNoteDelete(event, dialog): fill the fixed confirmation with note date and a textContent excerpt of at most 80 characters.
- deleteNote(event, dialog, form): formJson, sync summary, close confirmation, reload current page, focus the refreshed list heading.
- syncCardNotes(article, noteSummary): set Note/Note N and create/update/remove only the newest preview.
- closeNotes(dialog): abort active requests, reset forms/state, close, and return focus to the opener.

Use a fixed NOTE_MESSAGE map for invalid_repository_note, repository_note_not_found, session_expired, and storage_unavailable. Never place server error strings or Note bodies into innerHTML.

Intercept numbered links only for plain primary clicks while the desktop dialog is open. Modified clicks and mobile keep native navigation.

- [ ] **Step 5: Add the approved CSS**

In the existing components layer, style:

    dialog[data-repository-dialog] {
      width: min(44rem, calc(100vw - 2 * var(--space-4)));
      max-height: calc(100vh - 2 * var(--space-4));
      overflow: auto;
    }

    .repository-note-list {
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .repository-note-body {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }

    .repository-note-meta {
      color: var(--color-text-secondary);
      font-size: var(--text-sm);
    }

    .repository-note-pagination {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      align-items: center;
    }

Add borders/spacing between list items, inline edit layout, 44px minimum controls, current-page styling, empty state, confirmation target, success/error live-state colors, and mobile page containment using existing tokens. Keep the Note card action at 44px and do not change the approved refresh control.

- [ ] **Step 6: Regenerate and verify browser dependency metadata**

Run:

    npm run preloads
    git diff -- public/modulepreload.json

Expected: public/modulepreload.json remains the same because repo-panel.js adds no new import.

- [ ] **Step 7: Run Task 4 checks and verify GREEN**

Run:

    node --test test/unit/interface-policy.test.js
    npm run lint:css
    npx playwright test test/e2e/app.spec.js test/e2e/native-no-js.spec.js test/e2e/accessibility.spec.js --project=chromium --project=mobile-chrome --project=chromium-no-js
    npm run check:types
    npm run check:source
    git diff --check

Expected: all selected tests pass; only project-incompatible tests may be explicitly skipped.

- [ ] **Step 8: Create a local-only Task 4 commit**

Do not push:

    git diff -- public/assets/repo-panel.js public/assets/repositories.css public/modulepreload.json test/unit/interface-policy.test.js test/e2e/app.spec.js test/e2e/native-no-js.spec.js test/e2e/accessibility.spec.js
    git add -- public/assets/repo-panel.js public/assets/repositories.css public/modulepreload.json test/unit/interface-policy.test.js test/e2e/app.spec.js test/e2e/native-no-js.spec.js test/e2e/accessibility.spec.js
    git commit -m "feat: add paginated Note management"

Use the overlapping-dirty-path safeguard.

---

### Task 5: Verify, migrate, and deploy directly to Cloudflare

**Files:**
- Verify all Task 1-4 files.
- Do not modify GitHub workflow files.
- Preserve the D1 backup outside the repository.

**Interfaces:**
- Consumes: the complete Note feature, Wrangler 4.114.0, authenticated Cloudflare access, Worker gx, D1 gx-production, and the exact current production binding set.
- Produces: a backed-up and migrated production D1 database, one immutable Worker version promoted to 100%, and production CRUD/readback evidence without GitHub.

- [ ] **Step 1: Run the complete local verification set**

Run:

    npm run check:types
    npm run lint:css
    npm run check:source
    node --test --test-reporter=spec test/unit/*.test.js
    node --test --test-reporter=spec test/integration/*.test.js
    npx playwright test
    git diff --check
    git status --short

Expected: every executable check exits 0. If the current Node runtime is below package.json engines 24.18.0, run all version-independent focused suites, preserve the engine requirement, and report the exact release-test blocker rather than weakening it.

- [ ] **Step 2: Self-review against the approved spec**

Run:

    rg -n "personalNote|personal_note|updatePersonalNote|/note\b|Memo" src public test
    rg -n "repository_notes|Note [0-9]|data-repository-note|pageSize|PAGE_SIZE" src public migrations test

Confirm:

- personal_note remains only in legacy schema/storage compatibility tests and is absent from user responses/forms/search;
- no visible Memo label or old /note mutation route remains;
- every Note write includes repository scope and CSRF;
- page size is 5 in one service constant;
- date rendering uses Asia/Seoul and exact YYYY.MM.DD;
- no Note body reaches innerHTML;
- repository/activity/GitHub/OpenAI behavior is unchanged.

- [ ] **Step 3: Establish an exact local release identifier**

Create local-only commits for any safely separable remaining feature paths, without pushing. Set the release identifier to the resulting lowercase 40-character local HEAD:

    $releaseId = (git rev-parse HEAD).Trim()
    if ($releaseId -notmatch '^[0-9a-f]{40}$') { throw "invalid_release_id" }

If overlapping user changes prevented a complete local commit, compute a deterministic lowercase SHA-256 manifest over every deployed source/config/asset/migration file, use its first 40 hexadecimal characters, and record the manifest beside the local verification evidence. Do not stage, commit, or upload unrelated files.

- [ ] **Step 4: Read back the exact Cloudflare targets before mutation**

Run authenticated read-only Wrangler/API checks and verify:

- account and Worker name resolve to the intended gx Worker;
- D1 binding PROD_DB resolves to gx-production with ID 5e031f7f-52cc-495a-9cd9-e080bd0090ac;
- the active deployment has exactly one version at 100%;
- the Worker has the existing 13 bindings: ASSETS, PROD_DB, REPORT_RATE_LIMITER, five variables, and five secret bindings;
- workers.dev remains enabled and preview URLs remain disabled.

Stop before mutation if any target or binding differs.

- [ ] **Step 5: Back up D1 and inspect pending migrations**

Create an explicit timestamped directory outside C:\Work\G2-D, preserve it after deployment, and run:

    npx wrangler d1 migrations list PROD_DB --remote
    npx wrangler d1 export PROD_DB --remote --output "<backup-directory>\gx-production-before-notes.sql" --skip-confirmation

Verify the export exists and has non-zero length. Require 0003_repository_notes.sql to be pending; also require 0002_repository_activity.sql to be either already applied or the next valid pending predecessor. Do not apply migrations if the ledger order differs.

- [ ] **Step 6: Apply the D1 migration and read back schema**

Run:

    npx wrangler d1 migrations apply PROD_DB --remote

Then query remote D1 and require:

- repository_notes exists;
- repository_notes_repository_order_idx exists;
- PRAGMA foreign_key_list(repository_notes) reports repositories/repository_id/CASCADE;
- SELECT COUNT(*) FROM repository_notes is zero immediately after migration, proving no personal_note copy occurred.

- [ ] **Step 7: Upload an immutable Worker version without routing traffic**

First compile without upload:

    npx wrangler versions upload --name gx --keep-vars --strict --var "RELEASE_ID:$releaseId" --tag $releaseId --message "repository Note CRUD $releaseId" --dry-run

Require exit 0. Then repeat without --dry-run, capture the returned version ID, and use Cloudflare readback to confirm that version has the exact 13 bindings and expected release variable. Secret values must not be printed. Do not create a GitHub release and do not change routes or subdomain settings.

- [ ] **Step 8: Promote exactly the verified version**

Run:

    npx wrangler versions deploy "$versionId@100%" --name gx --message "repository Note CRUD $releaseId" --yes

Read back deployments and require exactly one active version at 100%, matching versionId.

- [ ] **Step 9: Verify production behavior and clean only test Notes**

Against https://gx.zra.workers.dev/:

1. require /health HTTP 200, status ok, and releaseId;
2. authenticate with the production smoke credential without printing it;
3. select the explicit repository ID 25031d57-b3fc-4b87-955f-b54aba7eec57 from the supplied feedback;
4. create six temporary Notes with a unique releaseId prefix and record every returned Note ID;
5. verify Note 6 through Note 2 appear on page 1, Note 1 appears on page 2, all creation dates use YYYY.MM.DD, and the card reads Note 6;
6. edit the recorded oldest Note and verify it remains on page 2 with a modification date;
7. delete only the six recorded temporary Note IDs through their repository-scoped endpoints;
8. verify the list returns to zero Notes, the card returns to Note with no preview, and no unrelated repository row changed;
9. require workers.dev enabled, previews disabled, exact bindings, and the same one-version 100% allocation.

Because the new table starts empty by approved design, any pre-existing row before step 4 is an unexpected production condition: stop and report it instead of deleting it.

- [ ] **Step 10: Record the deployment checkpoint locally**

Record the release ID, Worker version ID, migration ledger result, backup path, local test counts, production CRUD result, active allocation, and binding-name readback in the task handoff. Do not record credentials, tokens, cookies, secret values, or a Note body containing user data.

---

## Plan Self-Review

- Spec coverage: Tasks 1-5 cover the normalized model, no legacy migration, body validation, stable order, dates, CRUD, five-row numbered pages, card count/preview, search, desktop enhancement, mobile/no-JavaScript fallback, deletion confirmation, focus, security, tests, and GitHub-free Cloudflare delivery.
- Placeholder scan: the plan contains no TBD, TODO, “implement later”, generic error-handling instruction, or reference to an undefined neighboring interface.
- Type consistency: Note uses id/repositoryId/body/createdAt/updatedAt; summaries use noteCount/latestNote; pages use notes/page/totalPages/total consistently from storage through HTTP and UI.
- Safety: every Note mutation is repository-scoped; production backup precedes migration; deployment readback precedes promotion; smoke cleanup targets only IDs created by the smoke session.
