# Root Avatar and Delete Confirmation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render 45px repository avatars, use a light-gray-to-red delete glyph hover, and present deletion as a compact centered modal at the supplied 1389×1379 desktop viewport.

**Architecture:** Keep the existing server-rendered card markup, native shared delete dialog, progressive-enhancement controller, and protected deletion endpoint. Change intrinsic image dimensions and repository-page CSS, with parser-based unit policy tests and Playwright geometry/state tests guarding the requested presentation.

**Tech Stack:** Cloudflare Worker, semantic HTML, native CSS, browser ESM, Node test runner, Playwright.

## Global Constraints

- Preserve the current three-column desktop gallery, card content, 44px delete target, detail-preview side panel, authenticated deletion route, CSRF validation, and no-JavaScript fallback.
- Do not add dependencies, image assets, endpoints, optimistic updates, undo behavior, or bulk deletion.
- Preserve all unrelated and pre-existing working-tree changes.
- Do not create a commit or perform a GitHub operation unless the user explicitly requests one.

---

### Task 1: Align the avatar markup and card title grid at 45px

**Files:**
- Modify: `test/unit/html.test.js:99-101`
- Modify: `test/unit/interface-policy.test.js:475-507`
- Modify: `test/e2e/responsive.spec.js:139-141`
- Modify: `src/html.js:126`
- Modify: `public/assets/repositories.css:86-90,121-127`

**Interfaces:**
- Consumes: `renderIndexPage(view)` repository card rendering and the existing `.repository-avatar`/title grid DOM contract.
- Produces: `<img width="45" height="45">`, a `45px` title-grid column, and a computed 45×45px avatar at every responsive reference width.

- [ ] **Step 1: Write the failing HTML, CSS-policy, and responsive assertions**

In `test/unit/html.test.js`, require the new intrinsic dimensions:

```js
assert.match(html,
  /<img class="repository-avatar" src="https:\/\/github\.com\/a%2Fb%3Cscript%3E\.png\?size=80" alt="" width="45" height="45" loading="lazy" decoding="async" referrerpolicy="no-referrer">/);
```

In `test/unit/interface-policy.test.js`, update the title and avatar declarations:

```js
assertOwnRule(repositories, "repo-panel article h2", {
  display: "grid",
  "grid-template-columns": "45px minmax(0, 1fr)",
  gap: "var(--space-3)",
  "align-items": "start",
  "padding-inline-end": "2.75rem",
});
assertOwnRule(repositories, ".repository-avatar", {
  display: "block",
  width: "45px",
  height: "45px",
  "border-radius": "50%",
  "object-fit": "cover",
});
```

In `test/e2e/responsive.spec.js`, require the computed dimensions across the existing matrix, including 1389×1379:

```js
expect(Math.abs(layout.avatarWidth - 45)).toBeLessThanOrEqual(1);
expect(Math.abs(layout.avatarHeight - 45)).toBeLessThanOrEqual(1);
```

- [ ] **Step 2: Run the scoped tests and verify RED**

Run:

```powershell
node --test --test-reporter=spec test/unit/html.test.js test/unit/interface-policy.test.js
npx playwright test test/e2e/responsive.spec.js --project=chromium
```

Expected: the HTML test reports `width="40" height="40"`; the CSS policy reports `2.5rem`; and the responsive test measures about 40px.

- [ ] **Step 3: Implement the minimal avatar changes**

In `src/html.js`, replace the exact attribute pair:

```text
width="40" height="40"
```

with:

```text
width="45" height="45"
```

In `public/assets/repositories.css`, keep the grid and image dimensions synchronized:

```css
repo-panel article h2 {
  display: grid;
  grid-template-columns: 45px minmax(0, 1fr);
  gap: var(--space-3);
  align-items: start;
  padding-inline-end: 2.75rem;
}

.repository-avatar {
  display: block;
  width: 45px;
  height: 45px;
  border-radius: 50%;
  object-fit: cover;
}
```

- [ ] **Step 4: Run the scoped tests and verify GREEN**

Run the two commands from Step 2 again.

Expected: both unit files pass and the responsive Chromium suite measures 45×45px without overflow at every reference width.

- [ ] **Step 5: Review the scoped diff without committing**

Run:

```powershell
git diff -- src/html.js public/assets/repositories.css test/unit/html.test.js test/unit/interface-policy.test.js test/e2e/responsive.spec.js
```

Expected: only the avatar's intrinsic size, CSS size/grid track, and their assertions change in this task.

---

### Task 2: Apply delete colors and isolate the centered confirmation modal

**Files:**
- Modify: `test/unit/interface-policy.test.js:475-507`
- Modify: `test/e2e/app.spec.js:92-149`
- Modify: `public/assets/repositories.css:99-119,243-258`

**Interfaces:**
- Consumes: `a[data-repository-delete]`, `[data-repository-delete-dialog]`, the existing `RepoPanel.openDelete(event, dialog)` behavior, and the protected native delete form.
- Produces: `var(--color-text-secondary)` at rest, `var(--color-status-danger)` on hover only, and a content-height centered delete dialog while `[data-repository-dialog]` remains a full-height right-side desktop panel.

- [ ] **Step 1: Write the failing CSS-policy assertions**

Update the delete target and hover expectations in `test/unit/interface-policy.test.js`:

```js
const deleteTarget = assertOwnRule(repositories, "a[data-repository-delete]", {
  position: "absolute",
  "inset-block-start": "var(--space-2)",
  "inset-inline-end": "var(--space-2)",
  display: "inline-flex",
  "align-items": "center",
  "justify-content": "center",
  "min-inline-size": "2.75rem",
  "min-block-size": "2.75rem",
  color: "var(--color-text-secondary)",
  background: "transparent",
  border: "0",
  "border-radius": "0",
});
assert.ok(deleteTarget);
const deleteHover = assertOwnRule(repositories, "a[data-repository-delete]:hover", {
  color: "var(--color-status-danger)",
});
assert.deepEqual([...deleteHover.declarations.keys()], ["color"]);
```

After the existing responsive-rule loop in `test/unit/interface-policy.test.js`, locate the desktop subtree and require the delete-specific override:

```js
const desktop = descendants(repositories).filter((node) => node.kind === "at-rule" &&
  node.prelude === normalizeAtRule("@media (min-width: 840px)"));
assert.equal(desktop.length, 1);
assertOwnRule(desktop[0].children, "dialog[data-repository-delete-dialog]", {
  width: "min(32rem, calc(100% - 2rem))",
  "max-height": "calc(100% - 2rem)",
  height: "auto",
  margin: "auto",
  "border-radius": "var(--radius-panel)",
});
```

- [ ] **Step 2: Write the failing browser assertions for color and geometry**

In the existing hover test in `test/e2e/app.spec.js`, change the expected computed colors while preserving all non-color comparisons:

```js
expect(resting).toEqual({
  color: "rgb(107, 105, 99)",
  backgroundColor: "rgba(0, 0, 0, 0)",
  borderTopStyle: "none",
  borderRadius: "0px",
  boxShadow: "none",
  opacity: "1",
  transform: "none",
});

await opener.hover();
expect(await visualState()).toEqual({ ...resting, color: "rgb(159, 47, 45)" });
```

At the beginning of the existing delete-confirmation test, before `loginAndSeed(page)`, set the supplied desktop viewport:

```js
await page.setViewportSize({ width: 1389, height: 1379 });
```

Immediately after the existing repository-name assertion, add the compact-centering assertions:

```js
const geometry = await dialog.evaluate((element) => {
  const box = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return {
    width: box.width,
    height: box.height,
    centerX: box.left + box.width / 2,
    centerY: box.top + box.height / 2,
    radius: style.borderTopLeftRadius,
  };
});
expect(geometry.width).toBeLessThanOrEqual(512);
expect(geometry.height).toBeLessThan(1379);
expect(Math.abs(geometry.centerX - 1389 / 2)).toBeLessThanOrEqual(1);
expect(Math.abs(geometry.centerY - 1379 / 2)).toBeLessThanOrEqual(1);
expect(geometry.radius).toBe("12px");
```

- [ ] **Step 3: Run the scoped tests and verify RED**

Run:

```powershell
node --test --test-reporter=spec test/unit/interface-policy.test.js
npx playwright test test/e2e/app.spec.js --project=chromium --grep "card delete"
```

Expected: the policy and browser color checks report the existing red-to-dark-red values, and the geometry check reports the existing right-aligned full-height desktop dialog.

- [ ] **Step 4: Implement the minimal CSS state and modal overrides**

In `public/assets/repositories.css`, change only the glyph colors:

```css
a[data-repository-delete] {
  position: absolute;
  inset-block-start: var(--space-2);
  inset-inline-end: var(--space-2);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-inline-size: 2.75rem;
  min-block-size: 2.75rem;
  color: var(--color-text-secondary);
  background: transparent;
  border: 0;
  border-radius: 0;
  font-size: var(--text-lg);
  line-height: 1;
  text-decoration: none;
}

a[data-repository-delete]:hover {
  color: var(--color-status-danger);
}
```

After the general desktop `dialog` rule inside `@media (min-width: 840px)`, isolate the deletion dialog:

```css
dialog[data-repository-delete-dialog] {
  width: min(32rem, calc(100% - 2rem));
  max-height: calc(100% - 2rem);
  height: auto;
  margin: auto;
  border-radius: var(--radius-panel);
}
```

Do not modify `repo-panel.js`, `src/worker.js`, or the delete form markup: the existing modal behavior, form action validation, focus restoration, CSRF token, and `confirm=yes` submission already satisfy the requested interaction.

- [ ] **Step 5: Run the scoped tests and verify GREEN**

Run the two commands from Step 3 again.

Expected: parser policy passes; the glyph rests at `rgb(107, 105, 99)` and hovers at `rgb(159, 47, 45)` without other visual changes; and the delete dialog is compact and centered at 1389×1379.

- [ ] **Step 6: Verify the detail dialog remains a right-side panel**

Run:

```powershell
npx playwright test test/e2e/app.spec.js --project=chromium --grep "desktop repository link"
```

Expected: the existing detail-dialog behavior passes without changes.

- [ ] **Step 7: Review the scoped diff without committing**

Run:

```powershell
git diff -- public/assets/repositories.css test/unit/interface-policy.test.js test/e2e/app.spec.js
```

Expected: only the delete resting/hover colors, delete-specific desktop dialog geometry, and their tests change in this task.

---

### Task 3: Run the complete repository verification gate

**Files:**
- Verify only; no planned file modifications.

**Interfaces:**
- Consumes: all Task 1 and Task 2 changes.
- Produces: evidence that static policy, unit, integration, responsive, accessibility, native fallback, and browser behavior remain valid.

- [ ] **Step 1: Run static checks and all Node tests**

Run:

```powershell
npm run check
npm test
```

Expected: both commands exit 0 with no warnings or failures.

- [ ] **Step 2: Run the complete browser suite**

Run:

```powershell
npm run test:e2e
```

Expected: all configured desktop, mobile, and no-JavaScript projects pass with no failures.

- [ ] **Step 3: Inspect final scope and preserve the dirty worktree**

Run:

```powershell
git status --short
git diff --check
git diff -- src/html.js public/assets/repositories.css test/unit/html.test.js test/unit/interface-policy.test.js test/e2e/responsive.spec.js test/e2e/app.spec.js
```

Expected: `git diff --check` exits 0; the intended files include only the approved delta layered over pre-existing work; unrelated changes remain untouched; no commit or GitHub operation is performed.
