# Root Page Design Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the five approved root-page refinements: a smaller page title, verified select-indicator clearance, English card labels, GitHub new-tab title links, and GitHub owner avatars.

**Architecture:** Keep rendering server-side in `src/html.js`, use narrowly scoped repository-page CSS, and preserve the existing internal detail/dialog enhancement through a secondary link. Load owner images directly from GitHub with a narrowly expanded app-page CSP and no schema, proxy, JavaScript, or dependency changes.

**Tech Stack:** Cloudflare Worker JavaScript, semantic HTML, native CSS, Node.js test runner, Playwright Chromium

## Post-deployment revision

The latest approved feedback supersedes every title-link requirement below:

- render owner/name as a non-interactive `.repository-title` span, not an anchor;
- keep `View details` as the card's only navigation;
- render the exact fallback `AI 분석 실패` for an error-state repository without a stored summary;
- retarget HTML, CSS-policy, integration, and responsive tests from `data-repository-source-link` to `.repository-title`;
- replace the GitHub new-tab browser test with a test proving the title is not inside an anchor.

All avatar, CSP, heading, select, English-label, responsive, and verification requirements remain unchanged. This section takes precedence over conflicting text in the original tasks below.

## Global Constraints

- At 1389x1379, the root-page `Repo Atlas` heading must compute to no more than 36px; global login/detail `h1` typography must remain unchanged.
- Native selects must keep at least 32px inline-end padding; do not replace the platform indicator.
- Card `dt` copy must be exactly `Primary category`, `Tags`, `Stars`, `Forks`, `Language`, and `Analysis status`; do not translate values or other pages.
- The owner/name title must open the canonical GitHub repository in a new tab with `target="_blank"` and `rel="noreferrer"`.
- Keep internal analysis/edit access via a secondary `View details` link using the existing `data-repository-link` enhancement.
- Render a decorative 40x40 circular owner avatar with explicit dimensions, lazy loading, async decoding, and no referrer.
- Extend only app-page `img-src` to `https://github.com` and `https://avatars.githubusercontent.com`; login CSP remains exact and unchanged.
- Preserve every unrelated uncommitted working-tree change. Do not deploy, commit, or push.

---

### Task 1: Lock card markup, copy, navigation, and CSP in failing tests

**Files:**
- Modify: `test/unit/html.test.js:69-114`
- Modify: `test/integration/app.test.js:507-526`
- Modify: `test/e2e/app.spec.js:60-78,256-275`
- Modify: `src/html.js:117-122`
- Modify: `src/worker.js:25-26`

**Interfaces:**
- Consumes: repository `owner`, `name`, and `id`; existing HTML escaping helpers and `data-repository-link` dialog enhancement.
- Produces: `data-repository-source-link`, a decorative owner image, an external GitHub title link, and a retained internal `data-repository-link`.

- [ ] **Step 1: Write failing HTML-rendering assertions**

Replace the card-title assertion with checks equivalent to:

```js
assert.match(html,
  /<img class="repository-avatar" src="https:\/\/github\.com\/a%2Fb%3Cscript%3E\.png\?size=80" alt="" width="40" height="40" loading="lazy" decoding="async" referrerpolicy="no-referrer">/);
assert.match(html,
  /<a data-repository-source-link href="https:\/\/github\.com\/a%2Fb%3Cscript%3E\/x%3Fy%22%3E%3Cimg%20src%3Dx%3E" target="_blank" rel="noreferrer"><span class="repository-owner">a\/b&lt;script&gt;\/<\/span><span class="repository-name">x\?y&quot;&gt;&lt;img src=x&gt;<\/span><\/a>/);
assert.match(html,
  /<a data-repository-link href="\/repositories\/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa">View details<\/a>/);
assert.match(html,
  /<dl><dt>Primary category<\/dt><dd>[\s\S]*?<dt>Tags<\/dt>[\s\S]*?<dt>Stars<\/dt>[\s\S]*?<dt>Forks<\/dt>[\s\S]*?<dt>Language<\/dt>[\s\S]*?<dt>Analysis status<\/dt>/);
for (const korean of ["주 분류", "태그", "별", "포크", "언어", "분석 상태"])
  assert.doesNotMatch(html.match(/<article>[\s\S]*?<\/article>/)?.[0] ?? "", new RegExp(`<dt>${korean}<\\/dt>`));
```

Keep the existing hostile owner/name fixture so these assertions prove URL-component encoding and HTML-context escaping rather than only happy-path output.

- [ ] **Step 2: Write failing CSP assertions**

Change only the two expected app-page policies in `test/integration/app.test.js` to include:

```text
img-src 'self' https://github.com https://avatars.githubusercontent.com
```

Keep the login policy assertion at exactly `img-src 'self'`.

- [ ] **Step 3: Write the failing enhanced-browser navigation assertion**

In `test/e2e/app.spec.js`, keep the existing dialog test on `[data-repository-link]`, and add a Chromium test that verifies the title-link contract without depending on GitHub response availability:

```js
test("repository title targets GitHub in a new tab", async ({ page }) => {
  await loginAndSeed(page);
  const source = page.locator("[data-repository-source-link]").first();
  await expect(source).toHaveAttribute("href", "https://github.com/OpenAI/example");
  await expect(source).toHaveAttribute("target", "_blank");
  await expect(source).toHaveAttribute("rel", "noreferrer");
});
```

Update the existing browser-error flow to continue clicking `[data-repository-link]`, so it still exercises the internal dialog rather than navigating off-site.

- [ ] **Step 4: Run the focused tests and verify RED**

Run:

```powershell
node --test --test-reporter=spec test/unit/html.test.js
node --test --test-reporter=spec test/integration/app.test.js
npx playwright test test/e2e/app.spec.js --project=chromium
```

Expected: HTML tests fail because the image, English labels, source link, and secondary detail link do not exist; integration fails because app CSP lacks GitHub image origins; the new browser assertion fails because `data-repository-source-link` does not exist. Existing fixture/runtime errors are not acceptable substitutes.

- [ ] **Step 5: Implement the minimal server-rendered card markup**

In `repositoryCard`, compute URL strings from encoded components:

```js
const owner = encodeURIComponent(repository.owner);
const name = encodeURIComponent(repository.name);
const github = `https://github.com/${owner}/${name}`;
const avatar = `https://github.com/${owner}.png?size=80`;
const detail = `/repositories/${encodeURIComponent(repository.id)}`;
```

Render this semantic structure, keeping the existing summary and values:

```html
<article>
  <h2>
    <img class="repository-avatar" src="..." alt="" width="40" height="40" loading="lazy" decoding="async" referrerpolicy="no-referrer">
    <a data-repository-source-link href="..." target="_blank" rel="noreferrer">...</a>
  </h2>
  <p>...</p>
  <dl>...English dt labels...</dl>
  <a data-repository-link href="/repositories/:id">View details</a>
</article>
```

Pass dynamic attribute values through `htmlAttr` and visible values through `htmlText`. Do not place whitespace between the owner/name spans, preserving the accessible text `owner/name`.

- [ ] **Step 6: Narrowly extend app CSP**

Change `APP_CSP` only:

```js
const APP_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' https://github.com https://avatars.githubusercontent.com; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
```

- [ ] **Step 7: Run the focused tests and verify GREEN**

Run the three Step 4 commands again. Expected: all focused HTML, integration, and Chromium navigation tests pass with no browser console or CSP errors.

### Task 2: Lock and implement the root-title and avatar layout

**Files:**
- Modify: `test/unit/interface-policy.test.js:412-470`
- Modify: `test/e2e/responsive.spec.js:3-137`
- Modify: `public/assets/repositories.css:4-82`

**Interfaces:**
- Consumes: the new `.repository-avatar` and `data-repository-source-link` markup from Task 1 plus existing spacing tokens.
- Produces: page-scoped heading typography and a responsive avatar/title grid contained within every repository card.

- [ ] **Step 1: Write failing CSS-policy expectations**

Add exact declarations:

```js
assertOwnRule(repositories, ".index-header > h1", {
  "font-size": "min(var(--text-xl), 2.25rem)",
});
assertOwnRule(repositories, "repo-panel article h2", {
  display: "grid",
  "grid-template-columns": "2.5rem minmax(0, 1fr)",
  gap: "var(--space-3)",
  "align-items": "start",
});
assertOwnRule(repositories, ".repository-avatar", {
  display: "block",
  width: "2.5rem",
  height: "2.5rem",
  "border-radius": "50%",
  "object-fit": "cover",
});
```

Retarget the existing stacked-title assertion from `repo-panel article h2 > a` to `a[data-repository-source-link]`. Add `a[data-repository-link]` to the selectors that own the normalized 44px navigation-target declarations.

- [ ] **Step 2: Extend the responsive browser test**

Add the exact reported case:

```js
{ width: 1389, height: 1379, columns: 12, gutter: 32, gap: 24, filter: 4, gallery: 3, max: 1200 },
```

Select the title with `[data-repository-source-link]`, the avatar with `.repository-avatar`, and return:

```js
headingFontSize: Number.parseFloat(getComputedStyle(heading).fontSize),
avatarWidth: avatar.getBoundingClientRect().width,
avatarHeight: avatar.getBoundingClientRect().height,
avatarRadius: getComputedStyle(avatar).borderRadius,
avatarLeft: avatar.getBoundingClientRect().left,
avatarRight: avatar.getBoundingClientRect().right,
cardLeft: avatar.closest("article").getBoundingClientRect().left,
cardRight: avatar.closest("article").getBoundingClientRect().right,
```

Assert:

```js
expect(layout.headingFontSize).toBeLessThanOrEqual(36);
expect(Math.abs(layout.avatarWidth - 40)).toBeLessThanOrEqual(1);
expect(Math.abs(layout.avatarHeight - 40)).toBeLessThanOrEqual(1);
expect(layout.avatarRadius).toBe("50%");
expect(layout.avatarLeft).toBeGreaterThanOrEqual(layout.cardLeft);
expect(layout.avatarRight).toBeLessThanOrEqual(layout.cardRight);
```

Keep the existing 32px select-padding and no-horizontal-overflow assertions unchanged.

- [ ] **Step 3: Run the focused layout tests and verify RED**

Run:

```powershell
node --test --test-reporter=spec test/unit/interface-policy.test.js
npx playwright test test/e2e/responsive.spec.js --project=chromium
```

Expected: policy tests fail because the page-title and avatar rules do not exist; Chromium reports a 46px desktop heading and/or missing avatar geometry.

- [ ] **Step 4: Implement the minimal CSS**

Add:

```css
.index-header > h1 { font-size: min(var(--text-xl), 2.25rem); }

repo-panel article h2 {
  display: grid;
  grid-template-columns: 2.5rem minmax(0, 1fr);
  gap: var(--space-3);
  align-items: start;
}

.repository-avatar {
  display: block;
  width: 2.5rem;
  height: 2.5rem;
  border-radius: 50%;
  object-fit: cover;
}
```

Move the existing vertical-title link rule to `a[data-repository-source-link]`. Include `a[data-repository-link]` with the existing standalone navigation target rules, without changing colors or card padding.

- [ ] **Step 5: Run the focused layout tests and verify GREEN**

Run the two Step 3 commands again. Expected: both pass at every listed viewport, including 1389x1379, with no horizontal overflow.

### Task 3: Verify the complete working tree

**Files:**
- Verify: `src/html.js`
- Verify: `src/worker.js`
- Verify: `public/assets/repositories.css`
- Verify: `public/assets/core.css`
- Verify: `test/unit/html.test.js`
- Verify: `test/unit/interface-policy.test.js`
- Verify: `test/integration/app.test.js`
- Verify: `test/e2e/app.spec.js`
- Verify: `test/e2e/responsive.spec.js`

**Interfaces:**
- Consumes: complete uncommitted working tree, including earlier select/filter/card changes.
- Produces: fresh evidence that the combined source passes static, unit, integration, and focused browser checks.

- [ ] **Step 1: Run repository checks**

```powershell
npm run check:types
npm run lint:css
npm run check:source
npm run test:unit
npm run test:integration
npx playwright test test/e2e/app.spec.js test/e2e/responsive.spec.js --project=chromium
```

Expected: every command exits 0 with no warnings, failures, browser console errors, CSP violations, or horizontal-overflow assertions.

- [ ] **Step 2: Inspect the final diff**

```powershell
git diff --check
git status --short
git diff -- src/html.js src/worker.js public/assets/repositories.css public/assets/core.css test/unit/html.test.js test/unit/interface-policy.test.js test/integration/app.test.js test/e2e/app.spec.js test/e2e/responsive.spec.js
```

Expected: no whitespace errors; only the requested changes plus the user's pre-existing uncommitted work are present. Do not modify, stage, commit, push, or deploy unrelated files.
