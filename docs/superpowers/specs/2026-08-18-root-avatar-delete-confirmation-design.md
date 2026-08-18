# Root Avatar and Delete Confirmation Design

## Goal

Apply the root-page card feedback at the supplied 1389×1379 desktop viewport: repository avatars render at 45px square, card delete glyphs rest in light gray and turn red on interaction, and deletion is gated by a compact centered modal dialog.

## Scope

- Change only repository-card avatar sizing, delete-trigger colors, delete-dialog desktop presentation, and their regression coverage.
- Preserve the current three-column desktop gallery, card content, 44px delete target, detail-preview side panel, authenticated deletion route, CSRF validation, and no-JavaScript fallback.
- Do not add dependencies, image assets, endpoints, optimistic updates, undo behavior, or bulk deletion.

## Avatar Sizing

Each `.repository-avatar` has an intrinsic `width` and `height` of `45` and CSS `width` and `height` of `45px`. The repository title grid reserves the same 45px first column so the image and title remain aligned without overflow. The avatar remains circular, lazy-loaded, asynchronously decoded, and cropped with `object-fit: cover`.

The explicit pixel value follows the supplied feedback exactly. It does not reuse the 2.5rem spacing value because 2.5rem resolves to 40px at the current root font size.

## Delete Trigger

The card-level delete link keeps its absolute top-right placement and minimum 44×44px pointer target. Its `×` glyph uses the existing light-gray secondary-text token at rest. Hover changes only the glyph color to the existing danger red token; the transparent background, zero border, zero radius, opacity, shadow, and transform remain unchanged.

Keyboard focus keeps the existing global `:focus-visible` outline around the full target. No additional focus-only glyph color is introduced. The accessible label continues to include the repository owner and name.

## Delete Confirmation Modal

The existing shared native deletion `<dialog>` and its behavior remain authoritative. Activating a valid card delete link names the selected repository, assigns the corresponding `/repositories/:id/delete` form action, enables the confirm button, and opens the dialog modally.

At all viewport sizes, the deletion dialog is a compact content-height surface centered in the viewport. At the supplied 1389×1379 viewport it does not inherit the full-height, right-aligned desktop presentation used by the repository detail dialog. A delete-specific selector restores automatic height, centered margins, a 32rem maximum width with 1rem viewport gutters, and a complete panel border radius. The detail-preview dialog remains a right-side panel at desktop widths.

Cancel and Escape close the modal without mutation and return focus to the originating `×`. Confirm submits the existing native form with the server-rendered CSRF token and `confirm=yes`; the server remains responsible for authentication, validation, deletion, error handling, and the success redirect.

If dialog enhancement is unavailable or JavaScript is disabled, the delete link continues to navigate to `/repositories/:id#delete-heading`, where the existing detail-page confirmation is required. No card action performs an immediate GET deletion.

## Testing

- HTML unit coverage requires the avatar's intrinsic dimensions to be `45` by `45` and preserves the safe image attributes.
- CSS policy coverage requires a 45px avatar and title-grid column, a secondary-text resting glyph, a danger-red hover glyph, the unchanged 44px target, and a delete-specific centered desktop modal override.
- Browser coverage checks the avatar's computed 45×45px size at the supplied desktop viewport and verifies that hover changes only the glyph from light gray to red.
- Browser deletion coverage continues to verify repository naming, Cancel, Escape, focus restoration, CSRF-backed confirmation, correct route selection, and success feedback.
- Accessibility, responsive, no-JavaScript, integration, type, source-policy, and CSS lint suites remain green.

## Delivery Constraints

Preserve all unrelated and pre-existing working-tree changes. Per the established repository delivery constraint, do not create a commit or perform a GitHub operation unless the user explicitly requests one.
