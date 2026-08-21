# Repository Card Compaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore detail and Memo actions on analysis-error cards and render existing category, tag, and metric data in a compact, accessible card layout.

**Architecture:** Keep server-rendered HTML and the existing progressive-enhancement custom element. Refactor only `repositoryCard` into escaped field groups inside its semantic `dl`, keep failure text and action URLs unchanged, and replace the table-like card metadata CSS with explicit taxonomy and three-column metric styling.

**Tech Stack:** JavaScript ESM, server-rendered HTML, CSS cascade layers, Node test runner, custom CSS policy tests, Playwright, axe-core.

**Spec:** `docs/superpowers/specs/2026-08-21-repository-card-compaction-design.md`

## Global Constraints

- Do not render `repository.description` as an AI-failure fallback; keep `AI 분석 실패`.
- Do not change the visible `Memo` label, its detail-page `href`, or add `#personal-note`.
- Do not change the visible `×`, delete-link contract, dialogs, routes, database, GitHub request, or OpenAI request.
- Preserve `article`, `h2`, summary paragraph, semantic `dl`, 20px card padding, 48px avatar, 44px action targets, and one/two/three-column gallery breakpoints.
- Do not add dependencies, migrations, recent-activity data, tag provenance, or tag filtering.
- Preserve the untracked `repo-atlas-card-evaluation.html` file.
- Release verification remains pinned to Node `24.18.0`; do not weaken that requirement for the local Node `24.15.0` runtime.

## File Map

- `src/html.js`: owns HTML escaping, compact metric presentation, repository-card markup, status fallback, and action URLs.
- `public/assets/repositories.css`: owns repository-card field grouping, badges, metric columns, wrapping, spacing, and responsive overflow behavior.
- `test/unit/html.test.js`: locks rendered card semantics, escaping, failure behavior, action preservation, exclusions, and metric boundaries.
- `test/unit/interface-policy.test.js`: locks the approved CSS declarations and preserved interaction dimensions.
- `test/e2e/app.spec.js`: verifies rendered error-card behavior and 44px actions in the running application.
- `test/e2e/responsive.spec.js`: verifies the three metric columns stay inside cards without page overflow at all reference widths.
- `test/e2e/accessibility.spec.js`: keeps axe and keyboard coverage and moves its ready-card assertion from the removed status badge to the existing summary text.

---

### Task 1: Compact server-rendered metadata and restore error-card actions

**Files:**
- Modify: `test/unit/html.test.js:90-219`
- Modify: `test/unit/html.test.js:248-270`
- Modify: `src/html.js:116-132`

**Interfaces:**
- Consumes: the existing repository view shape used by `renderIndexPage(view)` and the existing `htmlText`, `htmlAttr`, `statusKey`, and `statusText` helpers.
- Produces: private `compactMetric(value: number): string`, private badge/field HTML generated inside `repositoryCard`, `.repository-metadata`, `.repository-badge-list`, `.repository-badge`, `.repository-badge--primary`, and `data-repository-field` values `category`, `tags`, `stars`, `forks`, and `language` for Task 2.

- [ ] **Step 1: Write failing renderer tests for the approved behavior**

Update the main index assertion so it requires grouped fields, individual escaped badges, no card-level Analysis status field, and unchanged delete markup. Replace the error-card action exclusion with a contract that both ready and error cards expose the same URLs and labels.

Add this focused test near the existing failure/action tests, using literal expected values rather than the formatter under test:

```js
test("index compacts card metadata without replacing AI failure content", () => {
  const html = renderIndexPage({
    releaseId: "abc123", modulePreloads: [], csrfToken: "csrf",
    repositories: [
      {
        ...repository, summary: null, description: "GitHub fallback must stay hidden",
        primaryCategory: null, tags: [], primaryLanguage: null,
        stars: 999, forks: 1_000,
      },
      {
        ...repository, id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        analysisStatus: "ready", summary: "분석 완료 요약",
        primaryCategory: "Design", tags: ["safe", `tag<script>`],
        primaryLanguage: "JavaScript", stars: 10_500, forks: 1_000_000,
      },
    ],
    filters: { q: "", category: "", tag: "", page: 1 }, categories: [],
    availableTags: [], page: 1, totalPages: 1, flash: "",
  });
  const cards = html.match(/<article[^>]*>[\s\S]*?<\/article>/g) ?? [];

  assert.equal(cards.length, 2);
  assert.match(cards[0], /<p data-analysis-summary-status="error">AI 분석 실패<\/p>/);
  assert.doesNotMatch(cards[0], /GitHub fallback must stay hidden|<dt>Analysis status<\/dt>/);
  assert.match(cards[0], /data-repository-field="stars"[\s\S]*?<dd>999<\/dd>/);
  assert.match(cards[0], /data-repository-field="forks"[\s\S]*?<dd>1K<\/dd>/);
  assert.match(cards[1], /data-repository-field="stars"[\s\S]*?<dd>10\.5K<\/dd>/);
  assert.match(cards[1], /data-repository-field="forks"[\s\S]*?<dd>1M<\/dd>/);
  assert.match(cards[1], /<span class="repository-badge">tag&lt;script&gt;<\/span>/);
  assert.doesNotMatch(cards[1], /tag<script>/);
  for (const card of cards) {
    assert.match(card, /<div class="repository-actions"><a href="\/repositories\/[^"]+">자세히 보기<\/a><a data-repository-link href="\/repositories\/[^"]+">Memo<\/a><\/div>/);
  }
});
```

Change `analysis status hooks admit only fixed own values` so index-card assertions use `data-analysis-summary-status` and `data-analysis-card-status`; keep the detail-page `data-analysis-status` checks unchanged because detail pages still render `statusBadge`.

- [ ] **Step 2: Run the focused unit test and verify RED**

Run:

```powershell
node --test test/unit/html.test.js
```

Expected: FAIL because error cards have no `.repository-actions`, card metadata has direct `dt`/`dd` children, Stars/Forks are raw integers, tags are one comma-separated string, and Analysis status is still visible.

- [ ] **Step 3: Implement the minimal private metric formatter**

Add immediately before `repositoryCard` in `src/html.js`:

```js
/** @param {number} value */
function compactMetric(value) {
  if (value < 1_000) return String(value);
  const divisor = value < 1_000_000 ? 1_000 : 1_000_000;
  const suffix = value < 1_000_000 ? "K" : "M";
  const scaled = Math.round((value / divisor) * 10) / 10;
  return `${scaled}${suffix}`;
}
```

Do not export it. Repository validation already guarantees non-negative safe integer Stars/Forks; do not add a second validation policy in the renderer.

- [ ] **Step 4: Implement grouped, escaped card metadata and unconditional actions**

Inside `repositoryCard`, build badge markup only with `htmlText`:

```js
  const category = repository.primaryCategory || "미분류";
  const tags = repository.tags?.length ? repository.tags : ["없음"];
  const tagBadges = tags.map((tag) =>
    `<span class="repository-badge">${htmlText(tag)}</span>`).join("");
  const metadata = `<dl class="repository-metadata"><div data-repository-field="category"><dt>Primary category</dt><dd><span class="repository-badge repository-badge--primary">${htmlText(category)}</span></dd></div><div data-repository-field="tags"><dt>Tags</dt><dd><span class="repository-badge-list">${tagBadges}</span></dd></div><div data-repository-field="stars"><dt>Stars</dt><dd>${htmlText(compactMetric(repository.stars))}</dd></div><div data-repository-field="forks"><dt>Forks</dt><dd>${htmlText(compactMetric(repository.forks))}</dd></div><div data-repository-field="language"><dt>Language</dt><dd>${htmlText(repository.primaryLanguage || "알 수 없음")}</dd></div></dl>`;
```

Make actions unconditional while preserving the exact strings and URLs:

```js
  const actions = `<div class="repository-actions"><a href="${htmlAttr(detail)}">자세히 보기</a><a data-repository-link href="${htmlAttr(detail)}">Memo</a></div>`;
```

Use `${metadata}${actions}` in the returned article. Remove only the card-level Analysis status `dt`/`dd`; keep `statusBadge` for repository detail pages. Do not read `repository.description`.

- [ ] **Step 5: Run renderer tests and verify GREEN**

Run:

```powershell
node --test test/unit/html.test.js
```

Expected: all `html.test.js` tests PASS with no warnings.

- [ ] **Step 6: Run source checks for the renderer change**

Run:

```powershell
npm run check:types
npm run check:source
```

Expected: both commands exit `0`.

- [ ] **Step 7: Commit Task 1**

```powershell
git add -- src/html.js test/unit/html.test.js
git commit -m "feat: compact repository card metadata"
```

---

### Task 2: Style compact fields and verify responsive application behavior

**Files:**
- Modify: `test/unit/interface-policy.test.js:577-629`
- Modify: `test/e2e/app.spec.js:139-207`
- Modify: `test/e2e/responsive.spec.js:19-145`
- Modify: `test/e2e/accessibility.spec.js:72-89`
- Modify: `public/assets/repositories.css:191-227`
- Verify unchanged: `test/e2e/native-no-js.spec.js`

**Interfaces:**
- Consumes: Task 1's `.repository-metadata`, `.repository-badge-list`, `.repository-badge`, `.repository-badge--primary`, and five `data-repository-field` values.
- Produces: a three-column metric grid, full-width wrapping category/tag rows, bounded wrapping values, restored error-card actions, and responsive/browser evidence without changing JavaScript enhancement behavior.

- [ ] **Step 1: Write failing CSS policy assertions**

In `detail and status declarations belong to real rules in the required media subtree`, replace the old table-like card `dl` assertions with exact rules for the new selectors:

```js
  assertOwnRule(repositories, ".repository-metadata", {
    display: "grid",
    "grid-template-columns": "repeat(3, minmax(0, 1fr))",
    gap: "var(--space-3)",
  });
  assertOwnRule(repositories, ".repository-metadata > div", { "min-width": "0" });
  assertOwnRule(repositories,
    '.repository-metadata > :where([data-repository-field="category"], [data-repository-field="tags"])',
    { "grid-column": "1 / -1" });
  assertOwnRule(repositories, ".repository-badge-list", {
    display: "flex", "flex-wrap": "wrap", gap: "var(--space-2)",
  });
  assertOwnRule(repositories, ".repository-badge", {
    display: "inline-flex", "align-items": "center",
    "max-width": "100%",
    padding: "var(--space-1) var(--space-2)",
    border: "1px solid var(--color-border-default)",
    "border-radius": "999px", "font-size": "var(--text-sm)",
  });
  assertOwnRule(repositories, ".repository-badge--primary", {
    color: "#ffffff", "background-color": "var(--color-action-primary)",
    "border-color": "var(--color-action-primary)",
  });
```

Also require visible `dt` labels, wrapping `dd` values, and a shared top separator for the Stars/Forks/Language groups. Keep existing assertions for 20px card padding, 48px avatar, 44px targets, actions, error colors, detail-page `.repository-facts`, and gallery breakpoints.

- [ ] **Step 2: Update browser expectations before CSS implementation**

In `test/e2e/app.spec.js`:

- Rename `analysis failure cards keep red failure accents without a detail link` to `analysis failure cards keep one failure message and expose both actions`.
- Keep the `AI 분석 실패` and error-color assertions.
- Replace badge assertions with `await expect(card.locator('[data-analysis-status="error"]')).toHaveCount(0)`.
- Require exact `자세히 보기` and `Memo` links inside the error card without changing their labels or `href` patterns.
- In the uneven-content target-size test, assert six links are present and every returned height equals `44` rather than comparing with a hard-coded four-element array.

In `test/e2e/responsive.spec.js`, replace the old `factColumnGap` measurement with:

```js
      const metadata = card.querySelector(".repository-metadata");
      const badges = [...card.querySelectorAll(".repository-badge")];
      if (!(metadata instanceof HTMLElement) || badges.length === 0)
        throw new Error("responsive_repository_metadata_missing");
      const metadataBox = metadata.getBoundingClientRect();
```

Return and assert these literals for every reference width:

```js
        metadataColumns: getComputedStyle(metadata).gridTemplateColumns.split(" ").length,
        metadataInsideCard: metadataBox.left >= cardBox.left && metadataBox.right <= cardBox.right,
        badgeOverflow: badges.some((badge) => badge.scrollWidth > badge.clientWidth),
```

Expected values are `metadataColumns: 3`, `metadataInsideCard: true`, `badgeOverflow: false`, and existing page `overflow: false`.

In `test/e2e/accessibility.spec.js`, rename `capture announces only changed live status text and status has non-color text` to `capture announces only changed live status text and ready cards retain summary text`. Replace the removed badge assertion with the provider fixture's literal summary:

```js
    await expect(page.locator('[data-analysis-summary-status="ready"]'))
      .toHaveText("예제 저장소의 핵심 사용법을 보여준다.");
```

- [ ] **Step 3: Run policy tests and verify RED**

Run:

```powershell
node --test test/unit/interface-policy.test.js
```

Expected: FAIL because the new metadata and badge selectors do not yet exist.

If the browser harness is available under the pinned environment, also run:

```powershell
npx playwright test test/e2e/app.spec.js test/e2e/responsive.spec.js --project=chromium
```

Expected before CSS: at least the new computed metadata-style assertions FAIL. A harness startup failure is environmental and does not replace the required unit-level RED result.

- [ ] **Step 4: Replace table-like card metadata CSS with compact field rules**

In `public/assets/repositories.css`, remove only the old selectors scoped to `repo-panel article dl`, its direct `dt`/`dd`, and its last `dd`. Do not change `.repository-facts` detail-page rules.

Add inside `@layer components`:

```css
  .repository-metadata {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--space-3);
  }

  .repository-metadata > div { min-width: 0; }

  .repository-metadata > :where(
    [data-repository-field="category"],
    [data-repository-field="tags"]
  ) { grid-column: 1 / -1; }

  .repository-metadata dt {
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
  }

  .repository-metadata dd {
    margin-top: var(--space-1);
    overflow-wrap: anywhere;
  }

  .repository-badge-list {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .repository-badge {
    display: inline-flex;
    align-items: center;
    max-width: 100%;
    padding: var(--space-1) var(--space-2);
    background-color: var(--color-bg-subtle);
    border: 1px solid var(--color-border-default);
    border-radius: 999px;
    font-size: var(--text-sm);
    overflow-wrap: anywhere;
  }

  .repository-badge--primary {
    color: #ffffff;
    background-color: var(--color-action-primary);
    border-color: var(--color-action-primary);
  }

  .repository-metadata > :where(
    [data-repository-field="stars"],
    [data-repository-field="forks"],
    [data-repository-field="language"]
  ) {
    padding-block-start: var(--space-3);
    border-top: 1px solid var(--color-border-subtle);
  }

  .repository-metadata > :where(
    [data-repository-field="stars"],
    [data-repository-field="forks"],
    [data-repository-field="language"]
  ) dd { font-weight: 650; }
```

If stylelint rejects multiline `:where`, reformat the selector without changing its selector list or declarations. Do not weaken lint configuration.

- [ ] **Step 5: Run CSS policy and lint checks and verify GREEN**

Run:

```powershell
node --test test/unit/interface-policy.test.js
npm run lint:css
```

Expected: both commands exit `0` with all assertions passing and no stylelint warnings.

- [ ] **Step 6: Run focused browser verification**

Run:

```powershell
npx playwright test test/e2e/app.spec.js test/e2e/responsive.spec.js test/e2e/accessibility.spec.js test/e2e/native-no-js.spec.js --project=chromium --project=mobile-chrome --project=chromium-no-js
```

Expected: all selected compatible tests PASS; project-specific skips are allowed. Verify specifically that 390px has no horizontal page overflow, the metadata grid reports three columns, error cards expose both actions, Memo still reads `Memo`, delete still reads `×`, keyboard focus remains visible, and axe has no serious/critical violations.

- [ ] **Step 7: Run the complete runtime-independent verification set**

Run:

```powershell
npm run check:types
npm run lint:css
npm run check:source
node --test test/unit/html.test.js test/unit/interface-policy.test.js
git diff --check
git status --short
```

Expected: all checks before `git status` exit `0`; status lists only the intended Task 2 files plus the preserved untracked evaluation report. Do not run a release creation or modify the Node engine requirement.

- [ ] **Step 8: Commit Task 2**

```powershell
git add -- public/assets/repositories.css test/unit/interface-policy.test.js test/e2e/app.spec.js test/e2e/responsive.spec.js test/e2e/accessibility.spec.js
git commit -m "feat: tighten repository card layout"
```

- [ ] **Step 9: Review final diff against exclusions**

Run:

```powershell
git diff HEAD~2 -- src/html.js public/assets/repositories.css test/unit/html.test.js test/unit/interface-policy.test.js test/e2e/app.spec.js test/e2e/responsive.spec.js test/e2e/accessibility.spec.js
```

Confirm the diff contains no `repository.description` fallback, no change from `Memo`, no `#personal-note`, no replacement of `×`, no migration, no dependency change, and no edit to `repo-atlas-card-evaluation.html`.
