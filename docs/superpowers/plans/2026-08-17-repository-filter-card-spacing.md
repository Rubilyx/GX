# Repository Filter and Card Spacing Implementation Plan

> **Historical record:** Do not execute this plan's direct Wrangler deployment steps. All current production releases must follow [`docs/operations/release.md`](../../operations/release.md), including merge-to-main, exact-SHA CI, evidence, and the protected `Release` workflow.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tighten repository-card label/value column spacing, place the filter action beside the tag field, and increase native select Chevron clearance before deploying directly to Cloudflare.

**Architecture:** Keep the existing semantic HTML and implement the behavior entirely through the shared control CSS and repository-page responsive CSS. Protect the design with source-policy assertions plus real Chromium geometry checks, then deploy the verified working tree directly with Wrangler and read the production result back.

**Tech Stack:** CSS Grid, Node.js test runner, Playwright Chromium, Cloudflare Workers/Wrangler

## Global Constraints

- Keep the repository definition-list row gap at `var(--space-2)` (8px) and column gap at `var(--space-3)` (12px).
- Use `max-content minmax(0, 1fr)` for repository-card fact columns.
- Below 600px, keep search, category, tag, and submit action in one vertical column.
- From 600px, use two equal columns so tag and the fit-content submit action share the second row.
- From 840px, use three flexible field columns plus one auto-sized action column.
- Increase native `select` inline-end padding to `var(--space-8)` (32px); do not replace the platform Chevron.
- Do not change HTML, labels, control order, keyboard behavior, accessible names, colors, typography, or JavaScript.
- Do not create a Git commit or push to GitHub; deploy the verified working tree directly to `https://gx.zra.workers.dev/`.

---

### Task 1: Lock the intended CSS and browser layout in failing tests

**Files:**
- Modify: `test/unit/interface-policy.test.js:330,497-522`
- Modify: `test/e2e/responsive.spec.js:3-87`

**Interfaces:**
- Consumes: existing CSS parser helpers and the seeded repository-index fixture.
- Produces: source-policy expectations and browser geometry assertions that fail against the current equal-width facts, full-row button, three-column desktop filter, and 24px select padding.

- [ ] **Step 1: Update the source-policy expectations**

Change the core select expectation to:

```js
assertOwnRule(core, "select", { "padding-inline-end": "var(--space-8)" });
```

Change the card grid expectation to:

```js
assertOwnRule(repositories, "repo-panel article dl", {
  "grid-template-columns": "max-content minmax(0, 1fr)",
});
```

Keep the 600px filter expectation at `repeat(2, minmax(0, 1fr))`, and assert the 840px filter template explicitly:

```js
assertOwnRule(media[0].children, "repo-filter > form", {
  "grid-template-columns": width === "840px"
    ? "repeat(3, minmax(0, 1fr)) auto"
    : "repeat(2, minmax(0, 1fr))",
});
```

- [ ] **Step 2: Add real-browser layout measurements**

Update each 840px-and-wider scenario's `filter` value from `3` to `4`. In the page evaluation, obtain `#q`, `#category`, `#tag`, the filter submit button, and the first repository card's fact rows. Select the `dt` whose text has the greatest rendered width with a DOM `Range`, pair it with its following `dd`, and return these scalar values:

```js
searchTop: search.closest("label").getBoundingClientRect().top,
categoryTop: category.closest("label").getBoundingClientRect().top,
tagTop: tag.closest("label").getBoundingClientRect().top,
tagBottom: tag.closest("label").getBoundingClientRect().bottom,
buttonTop: submit.getBoundingClientRect().top,
buttonBottom: submit.getBoundingClientRect().bottom,
factColumnGap: factValue.getBoundingClientRect().left - widestFactTextRight,
```

Use independently derived literal expectations:

```js
expect(layout.selectPaddingEnd).toBeGreaterThanOrEqual(32);
expect(Math.abs(layout.factColumnGap - 12)).toBeLessThanOrEqual(1);
if (scenario.width >= 600)
  expect(Math.abs(layout.buttonBottom - layout.tagBottom)).toBeLessThanOrEqual(1);
if (scenario.width >= 840) {
  expect(Math.abs(layout.searchTop - layout.tagTop)).toBeLessThanOrEqual(1);
  expect(Math.abs(layout.categoryTop - layout.tagTop)).toBeLessThanOrEqual(1);
} else if (scenario.width < 600) {
  expect(layout.buttonTop).toBeGreaterThanOrEqual(layout.tagBottom);
}
```

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```powershell
npm run test:unit
npx playwright test test/e2e/responsive.spec.js --project=chromium
```

Expected: the unit test fails on `var(--space-6)`, `repeat(2, minmax(0, 1fr))`, and/or the 840px three-column filter; Chromium fails on 24px padding, the full-row button, or the oversized fact-column gap. These are the intended missing behaviors, not selector or fixture errors.

### Task 2: Implement the minimal CSS layout change

**Files:**
- Modify: `public/assets/core.css:85`
- Modify: `public/assets/repositories.css:21-27,70-74,156-169`
- Test: `test/unit/interface-policy.test.js`
- Test: `test/e2e/responsive.spec.js`

**Interfaces:**
- Consumes: spacing tokens `--space-2`, `--space-3`, and `--space-8`; existing semantic form and definition-list markup.
- Produces: responsive filter placement and content-sized card fact labels without DOM or behavior changes.

- [ ] **Step 1: Increase the native select indicator clearance**

```css
select { padding-inline-end: var(--space-8); }
```

- [ ] **Step 2: Release the filter button from the full row and tighten card fact columns**

Delete the base rule `repo-filter button { grid-column: 1 / -1; }` and change the card fact declaration to:

```css
repo-panel article dl {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: var(--space-2) var(--space-3);
}
```

- [ ] **Step 3: Add the four-track desktop filter template**

Keep the 600px template unchanged and replace only the 840px filter rule with:

```css
repo-filter > form { grid-template-columns: repeat(3, minmax(0, 1fr)) auto; }
```

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run:

```powershell
npm run test:unit
npx playwright test test/e2e/responsive.spec.js --project=chromium
```

Expected: both commands pass with no warnings or browser errors.

### Task 3: Verify the working tree and deploy directly to Cloudflare

**Files:**
- Verify: `public/assets/core.css`
- Verify: `public/assets/repositories.css`
- Verify: `test/unit/interface-policy.test.js`
- Verify: `test/e2e/responsive.spec.js`
- Deploy: `src/worker.js`, `public/**`, `wrangler.jsonc`

**Interfaces:**
- Consumes: the complete uncommitted working tree, existing Cloudflare secrets/bindings, and Wrangler authentication.
- Produces: a 100% production deployment at `gx.zra.workers.dev` plus health and immutable-CSS readback evidence.

- [ ] **Step 1: Run the project verification suite**

```powershell
npm run check:types
npm run lint:css
npm run check:source
node --test --test-reporter=spec test/unit/interface-policy.test.js
npm run test:integration
npx playwright test test/e2e/responsive.spec.js --project=chromium
```

Expected: all task-relevant source checks, interface-policy tests, integration tests, and the Chromium responsive test pass. The full Windows unit baseline may continue to report the same three `local_npm_missing` failures from the standalone `npx node@24.18.0` runtime and five existing CRLF-sensitive workflow-policy failures; no new failure is acceptable.

- [ ] **Step 2: Confirm deployment scope without creating a commit**

```powershell
git status --short
git diff --check
```

Expected: the intended CSS/test/plan changes and pre-existing user changes remain uncommitted, and `git diff --check` reports no whitespace errors.

- [ ] **Step 3: Create and promote a Cloudflare Worker version**

Generate a unique 40-character lowercase hexadecimal release identifier from the current UTC time and a random GUID, upload with the production variables and existing bindings, then promote the returned version to 100%:

```powershell
$releaseSeed = "$(Get-Date -AsUTC -Format o)-$([guid]::NewGuid())"
$releaseId = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($releaseSeed))).ToLower().Substring(0, 40)
npx wrangler versions upload --var "ENVIRONMENT:deployed" --var "PRODUCTION_HOST:gx.zra.workers.dev" --var "OPENAI_MODEL:gpt-5.6-terra" --var "RELEASE_ID:$releaseId" --var "TRUSTED_TYPES_MODE:report-only"
npx wrangler versions deploy "<uploaded-version-id>@100%" --yes
```

Capture the actual uploaded version ID from Wrangler output and substitute it exactly in the promotion command. Do not run Git commit, push, or PR commands.

- [ ] **Step 4: Read production back**

Request `/health` and `/assets/core.css` plus `/assets/repositories.css` with a cache-busting query. Confirm HTTP 200, the expected release ID, `var(--space-8)`, `max-content minmax(0, 1fr)`, the four-track desktop filter, and absence of the old full-row filter-button declaration. Also confirm the root route still redirects unauthenticated requests to `/login`.
