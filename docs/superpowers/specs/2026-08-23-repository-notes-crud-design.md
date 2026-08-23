# Repository Notes CRUD Design

## Goal

Replace the repository's single overwrite-only personal note with a technically complete, titleless Note collection. Each repository can own multiple Notes that can be created, listed, edited, and deleted, with stable newest-created-first ordering, visible dates, and numbered pagination at five Notes per page.

## Scope

- Add a normalized D1 child table for repository Notes.
- Show `Note` when a repository has no Notes and `Note N` when it has one or more.
- Keep only the newest-created Note as the repository-card preview.
- Open an enhanced Note manager from the card on supported desktop primary clicks.
- Provide the same CRUD capability as a server-rendered page for mobile, modified clicks, and JavaScript-disabled navigation.
- Show five Notes per page with previous, numbered, and next navigation.
- Show `YYYY.MM.DD` creation dates and a modification date only after an edit.
- Confirm each destructive Note deletion with the target date and an escaped body excerpt.
- Keep repository search capable of finding text in any of the repository's Notes.

This feature is a technical feasibility implementation. Existing values in `repositories.personal_note` are intentionally not migrated or displayed.

## Explicit Exclusions

- Do not add Note titles, labels, rich text, Markdown rendering, attachments, pinning, sharing, or per-Note permissions.
- Do not migrate, copy, merge, or delete existing `repositories.personal_note` values.
- Do not reorder a Note after editing it.
- Do not add optimistic concurrency or conflict resolution; the last valid save wins.
- Do not change GitHub or OpenAI provider requests.
- Do not perform GitHub pushes, pull requests, releases, Actions runs, or any other GitHub operation.

## Data Model

Create `migrations/0003_repository_notes.sql`; preserve the existing untracked/in-progress `0002_repository_activity.sql` rather than renumbering or replacing it.

```sql
CREATE TABLE repository_notes (
  id TEXT PRIMARY KEY NOT NULL,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX repository_notes_repository_order_idx
ON repository_notes (repository_id, created_at DESC, id DESC);
```

The migration creates an empty table and index only. It contains no `INSERT ... SELECT` from `repositories.personal_note`. The legacy column remains physically present to avoid a destructive SQLite table rebuild, but application reads and writes stop using it.

Note bodies are strings trimmed and normalized to NFC before persistence. An empty normalized body or a body longer than 4,000 Unicode code units is rejected with `invalid_repository_note` and HTTP `400`.

Every Note ID is a server-generated UUID. All update and delete predicates include both `repository_id` and Note `id`, so a Note cannot be mutated through another repository's route. Deleting a repository deletes its Notes through the foreign key.

`created_at` defines list order and never changes. An edit advances `updated_at` monotonically so even a rapid same-second edit is distinguishable from creation. The display adds the modification date only when `updated_at > created_at`.

## Repository Query Contract

Repository list rows gain two application properties:

- `noteCount`: non-negative integer count of related rows.
- `latestNote`: the body of the first row under `created_at DESC, id DESC`, or `null`.

The list query obtains both values without one query per card. Text search replaces the legacy `r.personal_note LIKE ...` clause with an `EXISTS` subquery over `repository_notes.body` using the same escaped `LIKE ... COLLATE NOCASE` semantics as other searchable fields.

The general repository mapper and repository detail JSON stop exposing `personalNote`. Repository category/tag editing stops accepting or writing it. The repository detail page is renamed from “분류와 메모 편집” to “분류 편집” and links to its Note manager instead of presenting the legacy textarea.

## Note Service Contract

A focused `src/notes.js` module owns Note storage and strict D1 result validation. It exposes:

```js
listRepositoryNotes(db, repositoryId, requestedPage)
createRepositoryNote(db, repositoryId, rawBody)
updateRepositoryNote(db, repositoryId, noteId, rawBody)
deleteRepositoryNote(db, repositoryId, noteId)
getRepositoryNoteSummary(db, repositoryId)
```

The list result is `null` when the parent repository does not exist. Otherwise it contains `{ notes, page, totalPages, total }`, with `pageSize` fixed at `5`, at least one logical page for an empty list, and an out-of-range positive page clamped to the last page. Invalid or missing page input becomes page 1.

Each Note maps to `{ id, repositoryId, body, createdAt, updatedAt }`. Create and update return that mapped Note or `null` when their parent/target does not exist. Delete returns `false` when the repository-scoped target does not exist. Storage protocol failures map to the existing `storage_unavailable` error.

## Routes and Responses

Add these authenticated routes:

- `GET /repositories/:repositoryId/notes?page=N` lists five Notes.
- `POST /repositories/:repositoryId/notes` creates one Note from `body`.
- `POST /repositories/:repositoryId/notes/:noteId` updates one Note from `body`.
- `POST /repositories/:repositoryId/notes/:noteId/delete` deletes one Note after `confirm=yes`.

Every mutation retains the existing same-origin authentication, strict form schema, request-size limit, and CSRF verification. Query strings are accepted only on the Note-list GET route. Unknown nested paths, extra form fields, malformed IDs, invalid media types, and unsupported methods continue through the current safe error boundary.

Requests that explicitly accept `application/json` receive structured JSON:

- List: `{ repository, notes, page, totalPages, total }`, where `repository` contains only `id`, `owner`, `name`, and `summary` needed by the manager.
- Create/update: `{ note, noteSummary }`.
- Delete: `{ repositoryId, noteId, noteSummary }`.

`noteSummary` is `{ noteCount, latestNote }` and lets the card update immediately. The client then reloads the relevant five-row list, preventing duplicated pagination logic between mutation responses and the list endpoint.

Normal HTML GET renders the complete Note management page. Successful HTML mutations redirect back to `/repositories/:repositoryId/notes` or the requested safe page and expose a fixed flash message. Errors never echo Note content into plain responses.

## Server-Rendered UI

The card Note link points to `/repositories/:repositoryId/notes`, preserving a functional navigation target without JavaScript. Its visible label is `Note` for zero Notes and `Note N` otherwise. If `latestNote` is non-null, the existing preview region renders only that escaped body; no Note means no preview.

The Note page and desktop dialog share the same semantic structure:

1. repository heading and read-only AI summary;
2. a labelled new-Note textarea with 4,000-character maximum and `저장` button;
3. a live status region;
4. a newest-created-first list of up to five Notes;
5. numbered pagination with `이전` and `다음` when applicable.

Each list item contains an escaped body, a `<time>` creation date formatted in the `Asia/Seoul` calendar as `YYYY.MM.DD`, an optional modification `<time>`, an edit control, and a delete control. Editing replaces only that item's body presentation with an inline textarea plus `저장` and `취소`; its position is unchanged after saving.

Page links use `?page=N`, expose the active page with `aria-current="page"`, and retain real `href` navigation. The empty state clearly states that no Notes have been saved.

## Desktop Enhancement

At the existing desktop breakpoint, a plain primary click on `Note`/`Note N` is intercepted. The client fetches the link as JSON, opens the Note dialog, and renders the list using DOM node APIs and `textContent`; it does not inject response strings with `innerHTML`.

Create, update, delete, and numbered page navigation use same-origin fetches. While a request is active, only the relevant controls are disabled. Failures keep the user's textarea content, display a fixed Korean error in the live region, and allow retry.

After each successful mutation:

- the card label and latest preview update from `noteSummary`;
- create loads page 1;
- update reloads the current page without reordering;
- delete reloads the current page, which the server clamps if its last row was removed.

Opening the dialog moves focus to the new-Note textarea. Closing returns focus to the originating card link. Cancelling deletion returns focus to the originating delete button. After successful deletion removes that control, focus moves to the refreshed list heading or empty-state heading rather than a detached element.

## Delete Confirmation

The deletion confirmation is separate from repository deletion. It shows a fixed warning plus the selected Note's `YYYY.MM.DD` creation date and a plain-text excerpt. The excerpt is client-generated from the already validated body, limited to a compact length, and assigned with `textContent`.

The confirmation submits `csrf` and `confirm=yes` to the Note-specific delete URL. The destructive control uses the existing danger color conventions. Repository deletion copy changes from “개인 메모” to “모든 Note” and continues to require its own confirmation.

## Error Handling and Security

- Empty or oversized bodies return `invalid_repository_note` without changing storage.
- Missing repositories and repository-scoped Note mismatches return `repository_not_found` or `repository_note_not_found` as appropriate, both with HTTP `404`.
- D1 response-shape violations and database exceptions return `storage_unavailable` with HTTP `503`.
- User text is escaped in server HTML and assigned only through safe DOM text APIs in the client.
- Mutations reject missing, duplicated, or extra fields and require CSRF.
- JSON responses contain no CSRF token, secrets, legacy `personal_note`, or unrelated repository metadata.
- Search patterns continue escaping `\\`, `%`, and `_` before `LIKE` binding.

## Testing

Implementation follows red-green-refactor.

- Domain tests cover trim/NFC normalization, empty bodies, 4,000/4,001 boundaries, and non-string input.
- Migration integration tests prove the table/index contract, no legacy data copy, and repository delete cascade.
- Note service integration tests cover stable ordering, monotonic update time, repository scoping, CRUD, five-row pages, page clamping, and malformed D1 responses.
- Repository integration tests cover `noteCount`, `latestNote`, Note body search, and removal of the legacy mapper/edit contract.
- Worker integration tests cover HTML/JSON lists, all three mutations, authentication, CSRF, form schemas, error codes, query policy, and route telemetry templates.
- HTML unit tests cover `Note N`, escaped latest preview, dated list items, edit/delete forms, empty state, numbered pagination, detail-page changes, and deletion copy.
- Client/browser tests cover desktop opening, CRUD, inline edit/cancel, delete confirmation, card synchronization, page 1/2 boundaries at six Notes, focus recovery, mobile navigation, no-JavaScript CRUD, and axe accessibility.
- Type checking, CSS linting, source checks, complete unit/integration tests, selected Chromium/mobile/no-JavaScript E2E tests, and `git diff --check` run before deployment.

## Delivery

The user has explicitly prohibited GitHub operations and requested direct Cloudflare production reflection at `https://gx.zra.workers.dev/`. No push, pull request, release, or GitHub Action is permitted.

Production delivery must still preserve safety controls: inspect the exact target account/database, back up D1, apply only the pending migrations in order, create a new immutable Worker version with the current exact bindings/secrets/variables, verify the unrouted version where possible, promote only that version to 100%, and read back `/health`, active version allocation, exact bindings, Note migration state, authenticated CRUD, pagination, and cascade behavior. Do not print secret values or modify routes/subdomain settings.
