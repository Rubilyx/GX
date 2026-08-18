# Delete Hover Color-Only Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the repository delete link's circular surface and make hover change only the `×` glyph from danger red to the existing darker danger-hover color.

**Architecture:** Keep the current server markup, 44px target, native fallback, dialog behavior, and global keyboard outline unchanged. Encode the visual contract in the existing CSS-policy test and a real Chromium computed-style test before making the minimal component CSS change.

**Tech Stack:** Layered CSS, native ES modules, Node.js 24.18.0 test runner, Playwright, TypeScript, Stylelint, Cloudflare Workers/Wrangler.

## Global Constraints

- Preserve the 2.75rem by 2.75rem delete target and its absolute top-right position.
- Default glyph color remains `var(--color-status-danger)`; hover glyph color becomes `var(--color-action-danger-hover)`.
- Default and hover states have a transparent background, zero border, and zero radius; hover owns no visual declaration except `color`.
- Preserve the global solid `:focus-visible` outline for keyboard users.
- Do not change HTML, JavaScript, delete routing, CSRF, dialog behavior, dependencies, or design tokens.
- Use the pinned runtime at `.superpowers/sdd/2026-08-17-root-page-filter-chips/pinned-node-24.18.0/node.exe` and confirm `v24.18.0`.
- Do not stage, commit, push, open a PR, or perform any GitHub operation. Preserve the current normal-repository worktree and branch.
- Deploy only after the complete gate and scoped hash comparison pass.

---

### Task 1: Specify and implement the color-only delete hover

**Files:**
- Modify: `test/unit/interface-policy.test.js:481-490`
- Modify: `test/e2e/app.spec.js:83-121`
- Modify: `public/assets/repositories.css:99-120`

**Interfaces:**
- Consumes: `a[data-repository-delete]`, `--color-status-danger`, `--color-action-danger-hover`, and the global `:focus-visible` rule.
- Produces: a borderless transparent 44px delete target whose hover state changes only the computed glyph color.

- [ ] **Step 1: Add the failing CSS-policy contract**

Extend the existing delete-target assertion in `test/unit/interface-policy.test.js`:

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
  color: "var(--color-status-danger)",
  background: "transparent",
  border: "0",
  "border-radius": "0",
});
assert.ok(deleteTarget);
const deleteHover = assertOwnRule(repositories, "a[data-repository-delete]:hover", {
  color: "var(--color-action-danger-hover)",
});
assert.deepEqual([...deleteHover.declarations.keys()], ["color"]);
```

Keep the existing global `:focus-visible` assertion unchanged.

- [ ] **Step 2: Add the failing real-browser hover test**

Add before the confirmation-flow test in `test/e2e/app.spec.js`:

```js
test("card delete hover changes only the glyph color", async ({ page }) => {
  await loginAndSeed(page);
  const opener = page.getByRole("link", { name: "OpenAI/example 삭제", exact: true });
  const visualState = () => opener.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      color: style.color,
      backgroundColor: style.backgroundColor,
      borderTopStyle: style.borderTopStyle,
      borderRadius: style.borderRadius,
      boxShadow: style.boxShadow,
      opacity: style.opacity,
      transform: style.transform,
    };
  });
  const resting = await visualState();
  expect(resting).toEqual({
    color: "rgb(159, 47, 45)",
    backgroundColor: "rgba(0, 0, 0, 0)",
    borderTopStyle: "none",
    borderRadius: "0px",
    boxShadow: "none",
    opacity: "1",
    transform: "none",
  });

  await opener.hover();
  expect(await visualState()).toEqual({ ...resting, color: "rgb(127, 38, 36)" });
});
```

The production mutation caught by this test is restoring any circular background/border/radius or changing any hover visual property other than glyph color.

- [ ] **Step 3: Run both focused checks and confirm RED**

```powershell
$node = 'C:\Work\G2-D\.superpowers\sdd\2026-08-17-root-page-filter-chips\pinned-node-24.18.0\node.exe'
& $node --version
& $node --test --test-reporter=spec test/unit/interface-policy.test.js
& $node node_modules/playwright/cli.js test test/e2e/app.spec.js --project=chromium --grep "card delete hover"
```

Expected: Node prints `v24.18.0`; the unit check fails because the current base rule owns a surface/background and circular radius; Chromium fails because resting/hover computed styles still expose the circular treatment.

- [ ] **Step 4: Apply the minimal CSS implementation**

Replace only the visual declarations in `public/assets/repositories.css`:

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
  color: var(--color-status-danger);
  background: transparent;
  border: 0;
  border-radius: 0;
  font-size: var(--text-lg);
  line-height: 1;
  text-decoration: none;
}

a[data-repository-delete]:hover { color: var(--color-action-danger-hover); }
```

- [ ] **Step 5: Run focused GREEN and scoped regression checks**

```powershell
& $node --test --test-reporter=spec test/unit/interface-policy.test.js
& $node node_modules/playwright/cli.js test test/e2e/app.spec.js --project=chromium --grep "card delete hover"
& $node node_modules/playwright/cli.js test test/e2e/app.spec.js --project=chromium
& $node node_modules/playwright/cli.js test test/e2e/accessibility.spec.js --project=chromium
& $node node_modules/playwright/cli.js test test/e2e/responsive.spec.js --project=chromium
& $node node_modules/playwright/cli.js test test/e2e/native-no-js.spec.js --project=chromium-no-js
& $node node_modules/typescript/bin/tsc -p tsconfig.json
& $node node_modules/stylelint/bin/stylelint.mjs "public/assets/*.css"
& $node scripts/check-source.mjs
git diff --check -- public/assets/repositories.css test/unit/interface-policy.test.js test/e2e/app.spec.js
```

Expected: policy 7/7; hover 1/1; app 17/17; accessibility 4 pass plus one expected WebKit-only skip; responsive 1/1; no-JavaScript 1/1; static checks and scoped diff check exit 0.

---

### Task 2: Verify exact bytes and deploy one immutable Worker version

**Files:**
- Verify: tracked `src/**`, `public/**`, and `test/**`
- Record: `.superpowers/sdd/2026-08-18-delete-hover-color-only/verification-report.md`
- Deploy: Cloudflare Worker `gx` at `https://gx.zra.workers.dev/`

**Interfaces:**
- Consumes: verified working-tree bytes, the Worker health endpoint, immutable asset route, and Wrangler version deployment.
- Produces: one deterministic release ID, one immutable Worker UUID promoted at 100%, and production readback evidence.

- [ ] **Step 1: Capture the exact tracked-byte baseline**

```powershell
$scope = @(git ls-files -- src public test)
$before = foreach ($path in $scope) {
  [pscustomobject]@{ Path=$path; Sha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash }
}
```

Expected: 47 unique tracked paths.

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

Expected: static and feature gates exit 0; focused units 15/15; Chromium app plus responsive 18/18; accessibility 4 pass with one expected WebKit-only skip; no-JavaScript 1/1; integration 54/54. The full unit command may exit 1 only for exactly 211 pass, the five documented CRLF-sensitive `workflow-policy.test.js` failures, and the one Windows Developer Mode skip, with no other failure. Allow at least 240 seconds for the integration command so its native exit code is captured. Do not retry a functional failure.

- [ ] **Step 3: Prove verification did not mutate deployment bytes**

```powershell
$after = foreach ($path in $scope) {
  [pscustomobject]@{ Path=$path; Sha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash }
}
$mismatches = Compare-Object ($before | ForEach-Object { "$($_.Path) $($_.Sha256)" }) `
  ($after | ForEach-Object { "$($_.Path) $($_.Sha256)" })
if ($mismatches) { throw 'verified_bytes_changed' }
```

Expected: 47 before, 47 after, zero mismatches.

- [ ] **Step 4: Upload and promote exactly one version**

```powershell
$release = (git diff --binary HEAD -- src public test | git hash-object --stdin).Trim()
$upload = & $node node_modules/wrangler/bin/wrangler.js versions upload --env="" `
  --var "ENVIRONMENT:deployed" --var "PRODUCTION_HOST:gx.zra.workers.dev" `
  --var "OPENAI_MODEL:gpt-5.6-terra" --var "RELEASE_ID:$release" `
  --var "TRUSTED_TYPES_MODE:report-only" 2>&1
$uploadExit = $LASTEXITCODE
if ($uploadExit -ne 0) { throw "wrangler_upload_failed:$uploadExit" }
$ids = @([regex]::Matches(($upload -join "`n"),
  '(?i)\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b') |
  ForEach-Object { $_.Value.ToLowerInvariant() } | Select-Object -Unique)
if ($ids.Count -ne 1) { throw 'wrangler_version_id_missing_or_ambiguous' }
$version = $ids[0]
& $node node_modules/wrangler/bin/wrangler.js versions deploy "$version@100%" --yes --env=""
if ($LASTEXITCODE -ne 0) { throw 'wrangler_promote_failed' }
```

Expected: one upload, one parsed UUID, one promotion at 100%; never promote after a failed upload.

- [ ] **Step 5: Read production back and recheck bytes**

```powershell
$health = Invoke-RestMethod -Uri 'https://gx.zra.workers.dev/health'
if ($health.status -ne 'ok' -or $health.releaseId -ne $release) { throw 'health_release_mismatch' }
$headers = (& curl.exe -sS -D - -o NUL --max-redirs 0 'https://gx.zra.workers.dev/') -join "`n"
if ($headers -notmatch '(?im)^HTTP/\S+ 303\b' -or $headers -notmatch '(?im)^location:\s*/login\s*$')
  { throw 'root_redirect_mismatch' }
$css = Invoke-WebRequest -Uri "https://gx.zra.workers.dev/assets/$release/repositories.css" -UseBasicParsing
if ($css.StatusCode -ne 200 -or $css.Content -notmatch 'background:\s*transparent' -or
  $css.Content -notmatch 'border:\s*0' -or $css.Content -notmatch 'border-radius:\s*0' -or
  $css.Content -notmatch 'color:\s*var\(--color-action-danger-hover\)')
  { throw 'production_delete_hover_css_mismatch' }
```

Allow one bounded 30-second retry only if the immediate immutable CSS request returns 404. Recompute all 47 scoped hashes after readback and require zero mismatch. Record the release, Worker UUID, native exits/counts, readbacks, and hash proof in the verification report. Preserve the branch and worktree without Git or GitHub writes.
