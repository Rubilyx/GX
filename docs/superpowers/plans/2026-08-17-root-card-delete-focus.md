# Root Card Delete and Filter Polish Implementation Plan

> **Historical record:** Do not execute this plan's direct Wrangler deployment steps. All current production releases must follow [`docs/operations/release.md`](../../operations/release.md), including merge-to-main, exact-SHA CI, evidence, and the protected `Release` workflow.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a safe top-right repository-card delete flow while polishing root search focus, placeholder, and empty-status spacing.

**Architecture:** Keep all HTML server-rendered and progressively enhanced. `src/html.js` emits accessible fallback links and one inert shared delete dialog, `repo-filter.js` tracks pointer-origin filter focus, and `repo-panel.js` validates a card target before arming the existing CSRF-protected delete form. Existing routes, data access, and category behavior remain unchanged.

**Tech Stack:** Cloudflare Worker modules, native HTML forms and `<dialog>`, Web Components, layered CSS, Node.js 24.18.0 test runner, Playwright 1.62.1, Stylelint 17.14.1, Wrangler 4.114.0.

## Global Constraints

- Use Node.js `24.18.0` with a sibling npm installation; in this workspace the verified runtime is `C:\Work\G2-D\.superpowers\sdd\2026-08-17-root-page-filter-chips\pinned-node-24.18.0\node.exe`.
- Preserve the global keyboard `:focus-visible` rule; suppress an outline only on pointer-marked `#q` and `#tag`.
- Reuse `POST /repositories/:id/delete`, the current CSRF token, and `confirm=yes`; add no endpoint and no direct no-JavaScript deletion.
- The no-JavaScript `×` fallback is `/repositories/:id#delete-heading`.
- Keep category chips, repository metadata, pagination, authentication, capture, and detail-page deletion semantics unchanged.
- Use existing design tokens and `.visually-hidden`; add no dependency, image, color token, inline event handler, or optimistic state.
- Preserve unrelated dirty-worktree changes. Per user instruction, do not commit, push, open a PR, or run GitHub operations.
- Follow red-green-refactor for every production change and record the failing reason before implementation.

---

### Task 1: Server-render the accessible search and delete contracts

**Files:**
- Modify: `test/unit/html.test.js:66-136`
- Modify: `test/e2e/native-no-js.spec.js:3-31`
- Modify: `src/html.js:117-166`

**Interfaces:**
- Consumes: `htmlText(value)`, `htmlAttr(value)`, `csrf(token)`, `repositoryCard(repository)`, and `renderIndexPage(view)`.
- Produces: `#q[placeholder="검색"]`; a visually hidden native search label; one `a[data-repository-delete]` per card; one `dialog[data-repository-delete-dialog]` containing `form[data-repository-delete-form]`; and a proven no-JavaScript fallback link.

- [ ] **Step 1: Add failing HTML assertions**

Extend `index exposes complete native forms and safe enhancement controls` with real rendered-output assertions:

```js
assert.match(html,
  /<label for="q"><span class="visually-hidden">검색<\/span><input id="q" name="q" type="search" maxlength="100" placeholder="검색"/);
assert.doesNotMatch(html, /<label for="q">검색<input/);

const card = html.match(/<article>[\s\S]*?<\/article>/)?.[0] ?? "";
assert.match(card,
  /<a data-repository-delete href="\/repositories\/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa#delete-heading" aria-label="[^"]+ 삭제"><span aria-hidden="true">×<\/span><\/a>/);

const deleteDialog = html.match(
  /<dialog data-repository-delete-dialog[\s\S]*?<\/dialog>/,
)?.[0] ?? "";
assert.match(deleteDialog, /aria-labelledby="repository-delete-dialog-heading"/);
assert.match(deleteDialog, /<strong data-repository-delete-name><\/strong>/);
assert.match(deleteDialog, /<form method="post" data-repository-delete-form>/);
assert.match(deleteDialog, /name="csrf" value="csrf&quot;x"/);
assert.match(deleteDialog, /<input type="hidden" name="confirm" value="yes">/);
assert.match(deleteDialog,
  /<button type="submit" class="button-danger" data-repository-delete-confirm disabled>삭제<\/button>/);
assert.match(deleteDialog, /<form method="dialog"><button type="submit">취소<\/button><\/form>/);
assert.doesNotMatch(deleteDialog, /<form[^>]+action=/);
```

Also extend the empty-list assertions so there is no card trigger but the shared inert dialog still exists:

```js
assert.doesNotMatch(empty, /data-repository-delete href=/);
assert.match(empty, /<dialog data-repository-delete-dialog/);
```

- [ ] **Step 2: Repair the stale no-JavaScript category interaction and establish its baseline**

The root category select was intentionally removed by the preceding approved feature. Replace only the stale line in `native-no-js.spec.js`:

```js
await page.getByLabel("주 분류").selectOption("Backend");
```

with the current native category navigation:

```js
await page.getByRole("link", { name: "Backend", exact: true }).click();
```

Run the existing no-JavaScript flow before adding the new delete assertion:

```powershell
$node='C:\Work\G2-D\.superpowers\sdd\2026-08-17-root-page-filter-chips\pinned-node-24.18.0\node.exe'
& $node node_modules/playwright/cli.js test test/e2e/native-no-js.spec.js --project=chromium-no-js
```

Expected: 1 passed. If it does not pass, stop and diagnose the unrelated native-flow regression before adding new behavior.

- [ ] **Step 3: Add the failing no-JavaScript delete-fallback assertion**

Immediately after the existing filtered-card count assertion and before logout, add:

```js
await page.getByRole("link", { name: "OpenAI/example 삭제", exact: true }).click();
await expect(page).toHaveURL(/\/repositories\/[0-9a-f-]+#delete-heading$/);
await expect(page.getByRole("heading", { name: "저장소 삭제", exact: true })).toBeVisible();
await page.getByRole("link", { name: "저장소 목록" }).click();
```

Keep the existing later detail-page checkbox and delete submission; the first activation must only navigate to explicit confirmation.

- [ ] **Step 4: Run the focused tests and confirm RED for the new contract**

```powershell
& $node --test --test-reporter=spec test/unit/html.test.js
& $node node_modules/playwright/cli.js test test/e2e/native-no-js.spec.js --project=chromium-no-js
```

Expected: the HTML unit test fails because the placeholder, delete fallback link, and delete dialog are absent; the no-JavaScript test fails at the missing named delete link. Both failures must be caused by the unimplemented card contract.

- [ ] **Step 5: Add the minimal server markup**

In `repositoryCard`, place this link first inside `<article>`; continue using the existing encoded `detail` path:

```js
const label = `${repository.owner}/${repository.name} 삭제`;
const remove = `<a data-repository-delete href="${htmlAttr(`${detail}#delete-heading`)}" aria-label="${htmlAttr(label)}"><span aria-hidden="true">×</span></a>`;
```

In the existing return template, change its opening from `` `<article><h2>` `` to `` `<article>${remove}<h2>` `` and leave the title, summary, facts, and `View details` fragments byte-for-byte unchanged.

Change only the search label fragment in `renderIndexPage`:

```html
<label for="q"><span class="visually-hidden">검색</span><input id="q" name="q" type="search" maxlength="100" placeholder="검색" value="${htmlAttr(filter.q)}"></label>
```

Add one shared delete dialog after the existing detail-preview dialog inside `repo-panel`:

```js
const deleteDialog = `<dialog data-repository-delete-dialog aria-labelledby="repository-delete-dialog-heading"><h2 id="repository-delete-dialog-heading">저장소 삭제</h2><p><strong data-repository-delete-name></strong> 저장소를 삭제하시겠습니까?</p><p>저장소와 개인 메모가 영구 삭제됩니다.</p><form method="post" data-repository-delete-form>${csrf(view.csrfToken)}<input type="hidden" name="confirm" value="yes"><button type="submit" class="button-danger" data-repository-delete-confirm disabled>삭제</button></form><form method="dialog"><button type="submit">취소</button></form></dialog>`;
```

Interpolate `deleteDialog` after the existing detail dialog. Do not add an `action` attribute to its POST form; `repo-panel.js` will validate a card link, assign the action, and enable the submit control together.

- [ ] **Step 6: Run the focused HTML and no-JavaScript tests and confirm GREEN**

```powershell
& $node --test --test-reporter=spec test/unit/html.test.js
& $node node_modules/playwright/cli.js test test/e2e/native-no-js.spec.js --project=chromium-no-js
```

Expected: every HTML unit test passes, including attribute-escaping assertions for the hostile fixture, and the no-JavaScript flow passes without deleting on first `×` activation.

- [ ] **Step 7: Record scope without committing**

```powershell
git diff --check -- src/html.js test/unit/html.test.js test/e2e/native-no-js.spec.js
git diff -- src/html.js test/unit/html.test.js test/e2e/native-no-js.spec.js
```

Expected: no whitespace error; keep the working tree uncommitted as requested.

---

### Task 2: Apply card, status, and pointer-focus styling

**Files:**
- Modify: `test/unit/interface-policy.test.js:460-570`
- Modify: `test/e2e/app.spec.js:36-70`
- Modify: `public/assets/repositories.css:23-115`
- Modify: `public/assets/repo-filter.js:3-27`

**Interfaces:**
- Consumes: server-rendered `a[data-repository-delete]`, `.repository-title`, empty `main > p[role="status"]`, `#q`, `#tag`, and the global `:focus-visible` rule.
- Produces: the transient `data-pointer-focus` attribute on only `#q` or `#tag`; CSS positioning for `.repository-delete`; and empty-status collapse.

- [ ] **Step 1: Add failing CSS-policy assertions**

Add these exact rule checks to `detail and status declarations belong to real rules in the required media subtree` and the standalone target test:

```js
assertOwnRule(repositories, 'main > p[role="status"]:empty', { display: "none" });
assertOwnRule(repositories, "repo-panel article", { position: "relative" });
assertOwnRule(repositories, "repo-panel article h2", {
  "padding-inline-end": "2.75rem",
});
assertOwnRule(repositories,
  "repo-filter #q[data-pointer-focus]:focus, repo-filter #tag[data-pointer-focus]:focus",
  { outline: "none" });
assertOwnRule(repositories, "a[data-repository-delete]", {
  position: "absolute",
  "inset-block-start": "var(--space-2)",
  "inset-inline-end": "var(--space-2)",
  display: "inline-flex",
  "align-items": "center",
  "justify-content": "center",
  "min-inline-size": "2.75rem",
  "min-block-size": "2.75rem",
});
```

Read `core.css` in the same test and retain the existing assertion that its `:focus-visible` rule owns the solid primary outline; do not duplicate or weaken it.

- [ ] **Step 2: Run the CSS-policy test and confirm RED**

```powershell
& $node --test --test-reporter=spec test/unit/interface-policy.test.js
```

Expected: failures name the absent empty-status, relative-card, title-clearance, pointer-focus, and delete-target declarations.

- [ ] **Step 3: Add a failing browser focus-modality test**

Add to `test/e2e/app.spec.js`:

```js
test("filter hides pointer focus chrome and preserves keyboard focus", async ({ page }) => {
  await loginAndSeed(page);
  const search = page.getByLabel("검색", { exact: true });
  const tag = page.getByLabel("태그", { exact: true });

  await search.click();
  await expect(search).toHaveAttribute("data-pointer-focus", "");
  await expect(search).toHaveCSS("outline-style", "none");

  await page.keyboard.press("Tab");
  await expect(tag).toBeFocused();
  await expect(tag).not.toHaveAttribute("data-pointer-focus");
  await expect(tag).toHaveCSS("outline-style", "solid");
});
```

- [ ] **Step 4: Run the new browser test and confirm RED**

```powershell
& $node node_modules/playwright/cli.js test test/e2e/app.spec.js --project=chromium --grep "filter hides pointer"
```

Expected: failure because pointer-origin controls do not receive `data-pointer-focus`.

- [ ] **Step 5: Implement pointer-origin focus tracking**

In `RepoFilter.connectedCallback`, before the existing select-change enhancement, add:

```js
for (const control of form.querySelectorAll("#q, #tag")) {
  if (!(control instanceof HTMLInputElement || control instanceof HTMLSelectElement)) continue;
  control.addEventListener("pointerdown", () => { control.dataset.pointerFocus = ""; });
  control.addEventListener("keydown", () => { delete control.dataset.pointerFocus; });
  control.addEventListener("blur", () => { delete control.dataset.pointerFocus; });
}
```

Do not set a document-global modality flag and do not touch category links or form buttons.

- [ ] **Step 6: Implement the exact CSS rules**

Add to the components layer in `repositories.css`:

```css
main > p[role="status"]:empty { display: none; }

repo-filter #q[data-pointer-focus]:focus,
repo-filter #tag[data-pointer-focus]:focus { outline: none; }

a[data-repository-delete] {
  position: absolute;
  inset-block-start: var(--space-2);
  inset-inline-end: var(--space-2);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-inline-size: 2.75rem;
  min-block-size: 2.75rem;
  color: var(--color-status-danger);
  background: var(--color-bg-surface);
  border: 1px solid transparent;
  border-radius: 999px;
  font-size: var(--text-lg);
  line-height: 1;
  text-decoration: none;
}

a[data-repository-delete]:hover {
  background: var(--color-bg-danger);
  border-color: var(--color-status-danger);
}
```

Add `position: relative` to the existing `repo-panel article` rule and `padding-inline-end: 2.75rem` to the existing `repo-panel article h2` rule. Do not create duplicate rules for either selector.

- [ ] **Step 7: Run focused style, browser, type, and lint checks and confirm GREEN**

```powershell
& $node --test --test-reporter=spec test/unit/interface-policy.test.js
& $node node_modules/playwright/cli.js test test/e2e/app.spec.js --project=chromium --grep "filter hides pointer"
& $node node_modules/typescript/bin/tsc -p tsconfig.json
& $node node_modules/stylelint/bin/stylelint.mjs "public/assets/*.css"
```

Expected: all four commands exit 0.

- [ ] **Step 8: Record scope without committing**

```powershell
git diff --check -- public/assets/repositories.css public/assets/repo-filter.js test/unit/interface-policy.test.js test/e2e/app.spec.js
git diff -- public/assets/repositories.css public/assets/repo-filter.js test/unit/interface-policy.test.js test/e2e/app.spec.js
```

Expected: no whitespace error and no unrelated file edit.

---

### Task 3: Enhance the card delete fallback into a confirmation dialog

**Files:**
- Modify: `test/e2e/app.spec.js:62-145`
- Modify: `test/e2e/accessibility.spec.js:15-46`
- Modify: `public/assets/repo-panel.js:1-61`

**Interfaces:**
- Consumes: `a[data-repository-delete]`, its same-origin `/repositories/:id#delete-heading` fallback, card `.repository-owner` and `.repository-name`, `dialog[data-repository-delete-dialog]`, `form[data-repository-delete-form]`, and `[data-repository-delete-confirm]`.
- Produces: `RepoPanel.openDelete(event, dialog): boolean`; a validated `/repositories/:id/delete` form action; modal copy; submit enablement; and focus restoration.

- [ ] **Step 1: Add a failing card-delete browser test**

Add to `test/e2e/app.spec.js`:

```js
test("card delete confirms, restores focus, and submits the protected native form", async ({ page }) => {
  await loginAndSeed(page);
  const opener = page.getByRole("link", { name: "OpenAI/example 삭제", exact: true });
  const dialog = page.locator("[data-repository-delete-dialog]");

  await expect(opener).toHaveAttribute("href", /\/repositories\/[0-9a-f-]+#delete-heading$/);
  await opener.click();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("[data-repository-delete-name]")).toHaveText("OpenAI/example");
  await dialog.getByRole("button", { name: "취소", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();

  await opener.click();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();

  await opener.click();
  const deletion = page.waitForRequest((request) =>
    request.method() === "POST" && /\/repositories\/[0-9a-f-]+\/delete$/.test(new URL(request.url()).pathname));
  await dialog.getByRole("button", { name: "삭제", exact: true }).click();
  const request = await deletion;
  expect(request.postData()).toContain("confirm=yes");
  expect(request.postData()).toContain("csrf=");
  await expect(page).toHaveURL(/\/\?flash=repository_deleted$/);
  await expect(page.getByText("저장소를 삭제했습니다.", { exact: true })).toBeVisible();
});
```

- [ ] **Step 2: Extend the accessibility test with the open delete dialog**

In `index and detail have no serious or critical axe violations`, return to `/`, activate the named delete link, assert the delete dialog is visible, and call the existing `expectNoBlockingAxe(page)` helper before closing it with Escape.

```js
await page.goto("/");
await page.getByRole("link", { name: "OpenAI/example 삭제", exact: true }).click();
await expect(page.locator("[data-repository-delete-dialog]")).toBeVisible();
await expectNoBlockingAxe(page);
await page.keyboard.press("Escape");
```

- [ ] **Step 3: Run the new browser coverage and confirm RED**

```powershell
& $node node_modules/playwright/cli.js test test/e2e/app.spec.js --project=chromium --grep "card delete confirms"
```

Expected: the fallback link navigates to the detail page because no delete-dialog enhancement exists yet.

- [ ] **Step 4: Refactor the primary-click predicate once**

At module scope in `repo-panel.js`, add and use this predicate from both the existing detail opener and the new delete opener:

```js
/** @param {MouseEvent} event */
function plainPrimaryClick(event) {
  return event.button === 0 && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
}
```

Replace the existing repeated button/modifier condition in `open` with `!plainPrimaryClick(event)` without changing the desktop-only detail-dialog breakpoint.

- [ ] **Step 5: Wire the shared delete dialog defensively**

In `connectedCallback`, keep detail enhancement independent and add delete-dialog setup only when the required nodes are native elements:

```js
const deleteDialog = this.querySelector("[data-repository-delete-dialog]");
const deleteForm = deleteDialog?.querySelector("[data-repository-delete-form]");
const deleteConfirm = deleteDialog?.querySelector("[data-repository-delete-confirm]");
if (deleteDialog instanceof HTMLDialogElement && typeof deleteDialog.showModal === "function" &&
  deleteForm instanceof HTMLFormElement && deleteConfirm instanceof HTMLButtonElement) {
  deleteDialog.addEventListener("close", () => {
    deleteForm.removeAttribute("action");
    deleteConfirm.disabled = true;
    this.deleteOpener?.focus();
    this.deleteOpener = null;
  });
}
```

Route panel clicks to `openDelete` before the existing detail opener. If delete-dialog support is missing, do not prevent the fallback link.

- [ ] **Step 6: Implement `openDelete` with same-origin validation**

Add this class method, keeping DOM writes text-only through `setText`:

```js
/** @param {MouseEvent} event @param {HTMLDialogElement} dialog */
openDelete(event, dialog) {
  const target = event.target;
  const link = target instanceof Element ? target.closest("[data-repository-delete]") : null;
  if (!(link instanceof HTMLAnchorElement) || !plainPrimaryClick(event)) return false;
  event.preventDefault();
  const original = link.href;
  try {
    const source = new URL(original);
    const match = /^\/repositories\/([0-9a-f-]+)$/.exec(source.pathname);
    if (source.origin !== location.origin || !match || source.hash !== "#delete-heading")
      throw new Error("invalid_delete_link");
    const article = link.closest("article");
    const owner = article?.querySelector(".repository-owner");
    const name = article?.querySelector(".repository-name");
    const form = dialog.querySelector("[data-repository-delete-form]");
    const confirm = dialog.querySelector("[data-repository-delete-confirm]");
    if (!(owner instanceof HTMLElement) || !(name instanceof HTMLElement) ||
      !(form instanceof HTMLFormElement) || !(confirm instanceof HTMLButtonElement))
      throw new Error("missing_delete_nodes");
    setText(dialog, "[data-repository-delete-name]", `${owner.textContent}${name.textContent}`);
    form.setAttribute("action", `${source.pathname}/delete`);
    confirm.disabled = false;
    this.deleteOpener = link;
    dialog.showModal();
  } catch {
    location.href = original;
  }
  return true;
}
```

Declare `this.deleteOpener` as `HTMLElement | null` beside the existing detail opener and ensure the delegated click handler does not invoke the detail path after `openDelete` returns `true`.

- [ ] **Step 7: Run delete, accessibility, type, and source checks and confirm GREEN**

```powershell
& $node node_modules/playwright/cli.js test test/e2e/app.spec.js --project=chromium --grep "card delete confirms"
& $node node_modules/playwright/cli.js test test/e2e/accessibility.spec.js --project=chromium
& $node node_modules/typescript/bin/tsc -p tsconfig.json
& $node scripts/check-source.mjs
```

Expected: all commands exit 0; cancel/Escape restore focus and confirm deletes only the selected repository.

- [ ] **Step 8: Record scope without committing**

```powershell
git diff --check -- public/assets/repo-panel.js test/e2e/app.spec.js test/e2e/accessibility.spec.js
git diff -- public/assets/repo-panel.js test/e2e/app.spec.js test/e2e/accessibility.spec.js
```

Expected: no whitespace errors or unrelated behavior changes.

---

### Task 4: Prove progressive enhancement and deploy the verified bytes

**Files:**
- Verify: `src/**`, `public/**`, `test/**`
- Deploy: Cloudflare Worker `gx` at `https://gx.zra.workers.dev/`

**Interfaces:**
- Consumes: card fallback `/repositories/:id#delete-heading`, existing detail checkbox/form, Worker health endpoint, immutable `/assets/:release/repositories.css` route, and Wrangler version deployment.
- Produces: final verification evidence, one immutable Worker version, and 100% production promotion.

- [ ] **Step 1: Capture the exact pre-verification scope hash**

```powershell
$scope = git ls-files -- src public test
$before = foreach ($path in $scope) {
  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash
  [pscustomobject]@{ Path=$path; Sha256=$hash }
}
$before | ConvertTo-Json | Set-Content -LiteralPath '.superpowers\root-card-delete-before.json' -Encoding utf8
```

Expected: every tracked source/public/test file is represented once. The JSON is verification evidence, not a deployment input.

- [ ] **Step 2: Run the complete pinned-runtime gate once**

```powershell
git diff --check
& $node node_modules/typescript/bin/tsc -p tsconfig.json
& $node node_modules/stylelint/bin/stylelint.mjs "public/assets/*.css"
& $node scripts/check-source.mjs
& $node --test --test-reporter=spec test/unit/html.test.js test/unit/interface-policy.test.js
& $node node_modules/playwright/cli.js test test/e2e/app.spec.js test/e2e/responsive.spec.js --project=chromium
& $node node_modules/playwright/cli.js test test/e2e/accessibility.spec.js --project=chromium
& $node node_modules/playwright/cli.js test test/e2e/native-no-js.spec.js --project=chromium-no-js
& $node --test --test-reporter=spec test/integration/*.test.js
& $node --test --test-reporter=spec test/unit/*.test.js
```

Expected: static checks exit 0; focused units, Chromium, accessibility, no-JavaScript, and integration have zero failures. The full unit command may exit 1 only for the five already documented CRLF-sensitive `workflow-policy.test.js` failures, with no release-policy or feature failure and the existing Windows Developer Mode skip. Stop before deployment on any other result; do not auto-retry a failed command.

- [ ] **Step 3: Prove verification did not mutate deployment bytes**

```powershell
$after = foreach ($path in $scope) {
  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash
  [pscustomobject]@{ Path=$path; Sha256=$hash }
}
$mismatches = Compare-Object ($before | ForEach-Object { "$($_.Path) $($_.Sha256)" }) ($after | ForEach-Object { "$($_.Path) $($_.Sha256)" })
if ($mismatches) { $mismatches; throw 'verified_bytes_changed' }
```

Expected: zero mismatches.

- [ ] **Step 4: Upload one immutable version and promote it to 100%**

```powershell
$release = (git diff --binary HEAD -- src public test | git hash-object --stdin).Trim()
$upload = & $node node_modules/wrangler/bin/wrangler.js versions upload --env="" --var "ENVIRONMENT:deployed" --var "PRODUCTION_HOST:gx.zra.workers.dev" --var "OPENAI_MODEL:gpt-5.6-terra" --var "RELEASE_ID:$release" --var "TRUSTED_TYPES_MODE:report-only" 2>&1
$uploadExit = $LASTEXITCODE
$upload | ForEach-Object { Write-Output $_ }
if ($uploadExit -ne 0) { throw "wrangler_upload_failed:$uploadExit" }
$uploadText = $upload -join "`n"
$uuidMatches = [regex]::Matches($uploadText, '(?i)\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b')
$versionIds = @($uuidMatches | ForEach-Object { $_.Value.ToLowerInvariant() } | Select-Object -Unique)
if ($versionIds.Count -ne 1) { throw 'wrangler_version_id_missing_or_ambiguous' }
$version = $versionIds[0]
```

Promote only the single parsed immutable version:

```powershell
& $node node_modules/wrangler/bin/wrangler.js versions deploy "$version@100%" --yes --env=""
```

Expected: both native exit codes are 0 and Wrangler reports Worker `gx` at 100%. If upload fails, do not promote; if promotion fails, stop and report the uploaded immutable version without claiming production completion.

- [ ] **Step 5: Read production back independently**

```powershell
$health = Invoke-RestMethod -Uri 'https://gx.zra.workers.dev/health'
if ($health.status -ne 'ok' -or $health.releaseId -ne $release) { throw 'health_release_mismatch' }
curl.exe -sS -D - -o NUL --max-redirs 0 https://gx.zra.workers.dev/
$css = Invoke-WebRequest -Uri "https://gx.zra.workers.dev/assets/$release/repositories.css" -UseBasicParsing
if ($css.StatusCode -ne 200 -or $css.Content -notmatch 'data-repository-delete' -or
  $css.Content -notmatch 'p\[role="status"\]:empty' -or
  $css.Content -notmatch 'data-pointer-focus') { throw 'production_css_mismatch' }
```

Expected: health exposes the exact release, root returns `303 Location: /login`, and immutable CSS is 200 with all three new policy selectors. Allow one bounded 30-second asset-propagation readback only if the immediate immutable asset request returns 404; do not retry functional test failures.

- [ ] **Step 6: Recheck scoped hashes and preserve the working tree**

Repeat Step 5 after production readback. Record the release ID, Worker version UUID, Wrangler native exit codes, test counts, known CRLF failures, root/health/CSS readbacks, and zero hash mismatches. Do not commit, push, create a PR, or delete the working tree.
