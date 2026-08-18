# Delete Hover Color-Only Design

> **Historical record:** Do not execute this design's direct deployment instructions. All current production releases must follow [`docs/operations/release.md`](../../operations/release.md), including merge-to-main, exact-SHA CI, evidence, and the protected `Release` workflow.

## Goal

Repository card delete links keep their 44px pointer target and keyboard accessibility, but no longer render a circular surface. Hover changes only the `×` glyph color from the existing danger red to the existing darker danger-hover token.

## Scope

- Change only the repository delete-link styling and its automated regression coverage.
- Preserve the server-rendered delete link, confirmation dialog, no-JavaScript fallback, form submission, focus restoration, and card layout.
- Preserve the absolute top-right position and the minimum 2.75rem by 2.75rem target.
- Do not add a new token, asset, icon, dependency, or JavaScript behavior.

## Visual Contract

The base `a[data-repository-delete]` rule will retain its current danger text color and alignment while using a transparent background, zero border, and zero border radius. It will therefore have no circular surface in default or hover state.

The hover rule will own only the glyph color change, using `var(--color-action-danger-hover)`. It will not add a background, border, shadow, scale, or opacity change.

The global `:focus-visible` outline remains unchanged. Keyboard users therefore retain a visible outline around the full 44px target even though pointer hover has no enclosing circle.

## Verification

- A CSS-policy test will require the transparent, borderless, square base target and the darker hover color, and will reject hover background or border declarations.
- A Chromium interaction test will confirm that hover changes the computed glyph color while background transparency, border absence, and zero radius remain unchanged.
- Existing delete-dialog, accessibility, responsive, and no-JavaScript tests must continue to pass.
- Static checks, integration coverage, scoped byte hashes, and production readback must pass before completion.

## Delivery Constraints

The verified working-tree bytes will be deployed directly to the existing Cloudflare Worker after the local gate passes. Per the user's established instruction, no GitHub operation or commit will be created; the current branch and worktree remain preserved.
