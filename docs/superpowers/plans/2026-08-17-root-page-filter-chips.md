# Root Page Filter Chips Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the root page more compact, move search above repository capture, replace the primary-category select with bookmarkable category chips, and rename the populated results heading to `Repository`.

**Architecture:** Keep all filtering server-rendered and progressively enhanced. `renderIndexPage()` will build same-origin category links from the existing filter state, while the existing native GET form retains search and tag controls; CSS will provide the single-row scrolling chip bar and updated responsive grid without adding browser-side state.

**Tech Stack:** Cloudflare Worker HTML renderer, native HTML/CSS, JavaScript ES modules, Node.js test runner, Playwright Chromium, Wrangler.

## Global Constraints

- The root-page `Repo Atlas` heading must compute to exactly `32px` (`2rem`); global login and detail `h1` typography must not change.
- Root-page order must be header, status, search/tag filter form, GitHub repository capture form, category filter bar, repository results, pagination, and dialog.
- Remove only the root filter's `주 분류` select; keep the native search, tag, page, and submit controls.
- Render `All` followed by every supplied category in its supplied order.
- Category links preserve nonempty `q` and `tag`, set the selected nonempty `category`, and always set `page=1`.
- Exactly one category link owns `aria-current="page"`; `All` owns it when `category` is empty.
- Populated results use the exact heading `Repository`; the existing empty-result heading remains unchanged.
- Category chips are one horizontal row with overflow scrolling, no text wrapping, and at least a `44px` target height.
- Add no dependency, client-side category state, multi-select behavior, counts, icons, sticky behavior, or hidden scrollbar.
- Preserve existing repository cards, capture behavior, detail dialog, authentication, escaping, and CSP behavior.
- Do not invent or configure Git author identity. If a commit cannot be created, leave the verified changes uncommitted and report that fact.

---

### Task 1: Server-rendered category navigation and root DOM hierarchy

**Files:**
- Modify: `test/unit/html.test.js:69-124`
- Modify: `src/html.js:128-149`

**Interfaces:**
- Consumes: `htmlText(value)`, `htmlAttr(value)`, `options(values, selected, emptyLabel)`, `view.categories`, and `view.filters`.
- Produces: private `categoryHref(filters, category): string`, private `categoryFilter(categories, filter): string`, `.category-filter` navigation markup, and the revised `renderIndexPage(view)` order.

- [ ] **Step 1: Add focused failing HTML tests**

In `test/unit/html.test.js`, update `index exposes complete native forms and safe enhancement controls` and add a separate category-navigation test with these assertions:

```js
const filterIndex = html.indexOf("<repo-filter>");
const captureIndex = html.indexOf("<repo-capture>");
const categoriesIndex = html.indexOf('<nav class="category-filter" aria-label="Primary category">');
const resultsIndex = html.indexOf('<h2 id="results">Repository</h2>');
assert.ok(filterIndex < captureIndex);
assert.ok(captureIndex < categoriesIndex);
assert.ok(categoriesIndex < resultsIndex);
assert.doesNotMatch(html, /id="category"|name="category"|>주 분류<select/);
assert.match(html, /<h2 id="results">Repository<\/h2>/);
```

Use a dedicated safe fixture to verify the links and active state rather than coupling URL assertions to the existing hostile repository fixture:

```js
test("index category chips preserve filters and expose one active category", () => {
  const html = renderIndexPage({
    releaseId: "abc123", modulePreloads: [], csrfToken: "csrf", repositories: [repository],
    filters: { q: "llm tools", category: "Backend", tag: "python", page: 4 },
    categories: ["Backend", "Data & AI"], availableTags: ["python"],
    page: 4, totalPages: 4, flash: "",
  });
  const categoryNav = html.match(/<nav class="category-filter"[\s\S]*?<\/nav>/)?.[0] ?? "";
  assert.match(categoryNav,
    /<a href="\/\?q=llm\+tools&amp;tag=python&amp;page=1">All<\/a>/);
  assert.match(categoryNav,
    /<a href="\/\?q=llm\+tools&amp;category=Backend&amp;tag=python&amp;page=1" aria-current="page">Backend<\/a>/);
  assert.match(categoryNav,
    /<a href="\/\?q=llm\+tools&amp;category=Data\+%26\+AI&amp;tag=python&amp;page=1">Data &amp; AI<\/a>/);
  assert.equal((categoryNav.match(/aria-current="page"/g) ?? []).length, 1);
});
```

Replace the old hostile category-option assertion with a chip-label and encoded-link assertion. In the empty-result fixture, assert that the navigation remains available and `All` is active:

```js
assert.match(empty,
  /<nav class="category-filter" aria-label="Primary category"><a href="\/\?page=1" aria-current="page">All<\/a>/);
```

- [ ] **Step 2: Run the HTML unit test and verify RED**

Run:

```powershell
node --test --test-reporter=spec test/unit/html.test.js
```

Expected: FAIL because the capture form precedes the filter form, `#category` still exists, the heading is Korean, and `.category-filter` is absent.

- [ ] **Step 3: Implement category URL and navigation helpers**

In `src/html.js`, keep `pageHref()` unchanged for pagination and add:

```js
/** @param {{ q?: string, tag?: string }} filters @param {string} category */
function categoryHref(filters, category) {
  const query = new URLSearchParams();
  if (filters.q) query.set("q", filters.q);
  if (category) query.set("category", category);
  if (filters.tag) query.set("tag", filters.tag);
  query.set("page", "1");
  return `/?${htmlAttr(query.toString())}`;
}

/** @param {string[]} categories @param {{ q?: string, category?: string, tag?: string }} filter */
function categoryFilter(categories, filter) {
  const chips = [["", "All"], ...categories.map((category) => [category, category])];
  return `<nav class="category-filter" aria-label="Primary category">${chips.map(([value, label]) =>
    `<a href="${categoryHref(filter, value)}"${value === filter.category ? ' aria-current="page"' : ""}>${htmlText(label)}</a>`).join("")}</nav>`;
}
```

In `renderIndexPage(view)`:

- change `<h2 id="results">저장한 저장소</h2>` to `<h2 id="results">Repository</h2>`;
- render `<repo-filter>` before `<repo-capture>`;
- remove the category label/select from the GET form;
- keep the `q`, `tag`, hidden `page`, and submit controls;
- render `${categoryFilter(view.categories ?? CATEGORIES, filter)}` as the first child of `<repo-panel>`, before `${list}`.

Keep the existing one-line document template, but move its complete `<repo-filter>` block before its complete `<repo-capture>` block. Inside `<repo-panel>`, insert `${categoryFilter(view.categories ?? CATEGORIES, filter)}` directly before `${list}${pagination}`; leave the existing dialog markup after pagination.

- [ ] **Step 4: Run the HTML unit test and verify GREEN**

Run:

```powershell
node --test --test-reporter=spec test/unit/html.test.js
```

Expected: all HTML unit tests PASS.

- [ ] **Step 5: Commit the rendering change if Git identity exists**

```powershell
git add src/html.js test/unit/html.test.js
git commit -m "feat: add repository category chips"
```

If Git reports missing author identity, do not configure one; continue with the changes uncommitted.

---

### Task 2: Compact heading, chip styling, and responsive filter columns

**Files:**
- Modify: `test/unit/interface-policy.test.js:413-545`
- Modify: `public/assets/repositories.css:1-190`

**Interfaces:**
- Consumes: `.index-header`, `repo-filter > form`, `.category-filter`, `.category-filter > a`, and existing design tokens from `tokens.css`.
- Produces: a `2rem` root heading, a scroll-contained chip row, selected chip styling, and a three-column search/tag/action filter row at `600px` and above.

- [ ] **Step 1: Add failing CSS policy assertions**

Change the heading assertion to:

```js
assertOwnRule(repositories, ".index-header > h1", {
  "font-size": "2rem",
});
```

In the navigation target test, add `.category-filter > a` to the selectors that must own:

```js
{ display: "inline-flex", "align-items": "center", "min-block-size": "2.75rem" }
```

Add exact rules for the chip bar and chip states:

```js
assertOwnRule(repositories, ".category-filter", {
  display: "flex",
  gap: "var(--space-2)",
  "max-width": "100%",
  "overflow-x": "auto",
});
assertOwnRule(repositories, ".category-filter > a", {
  display: "inline-flex",
  "align-items": "center",
  "min-block-size": "2.75rem",
  "flex-shrink": "0",
  padding: "0 var(--space-4)",
  color: "var(--color-text-primary)",
  "background-color": "var(--color-bg-surface)",
  border: "1px solid var(--color-border-default)",
  "border-radius": "999px",
  "text-decoration": "none",
  "white-space": "nowrap",
});
assertOwnRule(repositories, '.category-filter > a[aria-current="page"]', {
  color: "#ffffff",
  "background-color": "var(--color-action-primary)",
  "border-color": "var(--color-action-primary)",
});
```

Change the responsive filter expectation so the `600px` media rule owns:

```js
{ "grid-template-columns": "repeat(2, minmax(0, 1fr)) auto" }
```

Remove the requirement for a separate `840px` filter override; retain the gallery and detail assertions at that breakpoint.

- [ ] **Step 2: Run the CSS policy unit test and verify RED**

Run:

```powershell
node --test --test-reporter=spec test/unit/interface-policy.test.js
```

Expected: FAIL on the old `2.25rem` heading, missing `.category-filter` rules, and the old filter grid.

- [ ] **Step 3: Implement the minimal CSS**

In `public/assets/repositories.css`:

```css
.index-header > h1 { font-size: 2rem; }

.category-filter {
  display: flex;
  gap: var(--space-2);
  max-width: 100%;
  overflow-x: auto;
}

.category-filter > a {
  display: inline-flex;
  align-items: center;
  min-block-size: 2.75rem;
  flex-shrink: 0;
  padding: 0 var(--space-4);
  color: var(--color-text-primary);
  background-color: var(--color-bg-surface);
  border: 1px solid var(--color-border-default);
  border-radius: 999px;
  text-decoration: none;
  white-space: nowrap;
}

.category-filter > a[aria-current="page"] {
  color: #ffffff;
  background-color: var(--color-action-primary);
  border-color: var(--color-action-primary);
}

repo-panel > * + * { margin-top: var(--layout-gap); }
```

At `@media (min-width: 600px)`, use:

```css
repo-filter > form { grid-template-columns: repeat(2, minmax(0, 1fr)) auto; }
```

Remove the `repo-filter > form` declaration from the `840px` media query. Preserve all repository gallery declarations.

- [ ] **Step 4: Run CSS and source checks and verify GREEN**

Run:

```powershell
node --test --test-reporter=spec test/unit/interface-policy.test.js
npm run lint:css
npm run check:source
```

Expected: all three commands exit `0`.

- [ ] **Step 5: Commit the CSS change if Git identity exists**

```powershell
git add public/assets/repositories.css test/unit/interface-policy.test.js
git commit -m "style: compact root filters and category bar"
```

If Git reports missing author identity, do not configure one; continue with the changes uncommitted.

---

### Task 3: Integration and browser behavior coverage

**Files:**
- Modify: `test/integration/app.test.js:101-139`
- Modify: `test/e2e/app.spec.js:36-45`
- Modify: `test/e2e/responsive.spec.js:1-120`

**Interfaces:**
- Consumes: server-rendered `.category-filter`, exact category query URLs, the remaining native filter controls, and Playwright's `loginAndSeed(page)` fixture.
- Produces: regression coverage for real Worker responses, category navigation, active state, DOM order, heading size, responsive columns, and page-level overflow.

- [ ] **Step 1: Add failing integration assertions**

In the native-forms integration test, read the filtered response once and assert its navigation contract:

```js
const filteredHtml = await filtered.text();
assert.match(filteredHtml,
  /<span class="repository-title"><span class="repository-owner">OpenAI\/<\/span><span class="repository-name">example<\/span><\/span>/);
assert.match(filteredHtml,
  /<a href="\/\?q=example&amp;tag=example&amp;page=1">All<\/a>/);
assert.match(filteredHtml,
  /<a href="\/\?q=example&amp;category=Backend&amp;tag=example&amp;page=1" aria-current="page">Backend<\/a>/);
assert.doesNotMatch(filteredHtml, /id="category"|name="category"/);
```

- [ ] **Step 2: Run the targeted integration test and verify RED**

Run:

```powershell
node --test --test-reporter=spec --test-name-pattern="native forms" test/integration/app.test.js
```

Expected: FAIL because the old response still renders the category select and no category links.

- [ ] **Step 3: Retarget the Playwright filter test to category links**

Replace the old select-based test with:

```js
test("category chips preserve search and tag in one canonical query", async ({ page }) => {
  await loginAndSeed(page);
  await page.getByLabel("검색").fill("example");
  await page.getByLabel("태그").selectOption("example");
  await expect(page).toHaveURL(/\?q=example&tag=example&page=1$/);
  await expect(page.locator("#category")).toHaveCount(0);
  await page.getByRole("link", { name: "Backend", exact: true }).click();
  await expect(page).toHaveURL(/\?q=example&category=Backend&tag=example&page=1$/);
  await expect(page.getByRole("link", { name: "Backend", exact: true }))
    .toHaveAttribute("aria-current", "page");
  expect(new URL(page.url()).search).toBe("?q=example&category=Backend&tag=example&page=1");
});
```

In `test/e2e/responsive.spec.js`:

- change each width's expected filter columns from `2`/`4` to `3` at widths `>= 600px`;
- remove `#category` and its label from required nodes and measurements;
- use `#tag` for select padding verification;
- query `.category-filter` and `repo-capture > form`;
- assert `headingFontSize === 32`;
- assert filter precedes capture, capture precedes category navigation, and navigation precedes the result section;
- assert `.category-filter` has `overflow-x: auto` and does not create document-level overflow.

The returned layout metrics should include:

```js
filterBottom: filter.getBoundingClientRect().bottom,
captureTop: capture.getBoundingClientRect().top,
captureBottom: capture.getBoundingClientRect().bottom,
categoryTop: categoryNav.getBoundingClientRect().top,
categoryBottom: categoryNav.getBoundingClientRect().bottom,
galleryTop: gallery.getBoundingClientRect().top,
categoryOverflowX: getComputedStyle(categoryNav).overflowX,
```

Assert:

```js
expect(layout.headingFontSize).toBe(32);
expect(layout.filterBottom).toBeLessThanOrEqual(layout.captureTop);
expect(layout.captureBottom).toBeLessThanOrEqual(layout.categoryTop);
expect(layout.categoryBottom).toBeLessThanOrEqual(layout.galleryTop);
expect(layout.categoryOverflowX).toBe("auto");
```

- [ ] **Step 4: Run integration and Chromium suites and verify GREEN**

Run:

```powershell
node --test --test-reporter=spec --test-name-pattern="native forms" test/integration/app.test.js
npx playwright test test/e2e/app.spec.js test/e2e/responsive.spec.js --project=chromium
```

Expected: the targeted integration test and all 15 Chromium tests PASS.

- [ ] **Step 5: Commit the behavioral coverage if Git identity exists**

```powershell
git add test/integration/app.test.js test/e2e/app.spec.js test/e2e/responsive.spec.js
git commit -m "test: cover root category navigation"
```

If Git reports missing author identity, do not configure one; continue with the changes uncommitted.

---

### Task 4: Full verification and production deployment

**Files:**
- Verify: `src/html.js`
- Verify: `public/assets/repositories.css`
- Verify: `test/unit/html.test.js`
- Verify: `test/unit/interface-policy.test.js`
- Verify: `test/integration/app.test.js`
- Verify: `test/e2e/app.spec.js`
- Verify: `test/e2e/responsive.spec.js`

**Interfaces:**
- Consumes: the complete working tree and existing Wrangler production configuration.
- Produces: verification evidence, one immutable Worker version, a 100% production deployment, and external health/asset readback.

- [ ] **Step 1: Run fresh static and focused verification**

```powershell
git diff --check
npm run check:types
npm run lint:css
npm run check:source
node --test --test-reporter=spec test/unit/html.test.js test/unit/interface-policy.test.js
npx playwright test test/e2e/app.spec.js test/e2e/responsive.spec.js --project=chromium
```

Expected: every command exits `0`; Chromium reports 15 passing tests.

- [ ] **Step 2: Run the full integration suite**

```powershell
npm run test:integration
```

Expected: 54 tests PASS.

- [ ] **Step 3: Audit the known full-unit baseline**

```powershell
npm run test:unit
```

Expected in the current Windows environment: all feature-related tests PASS; only the previously observed release-policy failures caused by Node `24.15.0` versus `.nvmrc` `24.18.0` and CRLF-sensitive workflow-policy failures remain. Stop if any new or differently located failure appears.

- [ ] **Step 4: Upload, promote, and read back one immutable Worker version**

Run one PowerShell session so the generated release and Worker version identities remain exact through promotion and verification:

```powershell
$ErrorActionPreference = 'Stop'
$deploySeed = "$(Get-Date -AsUTC -Format o)-$([guid]::NewGuid())"
$deployReleaseId = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($deploySeed))).ToLower().Substring(0,40)
Write-Output "DEPLOY_RELEASE_ID=$deployReleaseId"
$uploadOutput = npx wrangler versions upload --env="" --var "ENVIRONMENT:deployed" --var "PRODUCTION_HOST:gx.zra.workers.dev" --var "OPENAI_MODEL:gpt-5.6-terra" --var "RELEASE_ID:$deployReleaseId" --var "TRUSTED_TYPES_MODE:report-only" 2>&1
$uploadOutput | Write-Output
$versionMatch = [regex]::Match(($uploadOutput -join "`n"), 'Worker Version ID:\s*([0-9a-f-]{36})')
if (-not $versionMatch.Success) { throw 'worker_version_id_missing' }
$workerVersionId = $versionMatch.Groups[1].Value
Write-Output "DEPLOY_WORKER_VERSION_ID=$workerVersionId"
npx wrangler versions deploy "$workerVersionId@100%" --yes --env=""
$health = Invoke-RestMethod -Uri 'https://gx.zra.workers.dev/health' -Method Get
if ($health.status -ne 'ok' -or $health.releaseId -ne $deployReleaseId) { throw 'health_readback_mismatch' }
$rootHeaders = curl.exe -sS -D - -o NUL --max-redirs 0 'https://gx.zra.workers.dev/'
if (($rootHeaders -join "`n") -notmatch 'HTTP/\S+ 303' -or ($rootHeaders -join "`n") -notmatch '(?im)^location: /login\s*$') { throw 'root_redirect_mismatch' }
$css = (Invoke-WebRequest -Uri "https://gx.zra.workers.dev/assets/$deployReleaseId/repositories.css").Content
if (-not $css.Contains('.category-filter')) { throw 'category_filter_rule_missing' }
if (-not $css.Contains('.index-header > h1 { font-size: 2rem; }')) { throw 'compact_heading_rule_missing' }
```

Expected: Wrangler reports the parsed Worker version at `100%`, health returns the generated release ID, the root returns `303` with `Location: /login`, and the immutable stylesheet contains the new category and heading rules. Report both deployment identities, exact test counts, known baseline failures, and whether Git author identity prevented commits.
