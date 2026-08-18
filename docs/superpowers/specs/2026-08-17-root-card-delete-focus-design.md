# Root Card Delete and Filter Polish Design

## Goal

Polish the root-page filters and repository cards by moving the search label into the input placeholder, suppressing pointer-only filter focus chrome while preserving keyboard focus, removing empty status spacing, and adding a safe top-right card delete action.

## Approved Requirements

- The search field displays `검색` as its placeholder instead of as a visible label. The accessible name remains `검색` through a visually hidden native label.
- Pointer selection of `input#q` and `select#tag` does not show the focus outline. Keyboard navigation with `Tab` retains the existing global focus-visible outline.
- An empty root `p[role="status"]` occupies no space. A nonempty status message remains visible with its current status semantics and spacing.
- Every repository card displays a visible `×` delete affordance at its top-right corner.
- Activating `×` opens a confirmation modal. Deletion occurs only after the user confirms in that modal.
- The card action reuses the existing authenticated, CSRF-protected `POST /repositories/:id/delete` route with `confirm=yes`.

## Search and Focus Treatment

The search label remains in the document as a native `<label for="q">`, with its text wrapped in the existing `.visually-hidden` utility. The search input receives `placeholder="검색"`. This keeps the form's accessible name and browser autofill semantics while removing the visible label row.

The existing global `:focus-visible` rule remains unchanged. `repo-filter` records pointer-origin focus only for the search input and tag select. A pointer interaction marks that control until blur or keyboard input; a narrowly scoped CSS rule suppresses the outline only while that marker is present. Keyboard focus therefore continues to use the global high-contrast outline, including after a user switches from pointer to keyboard.

No focus behavior changes apply to buttons, links, category chips, detail forms, or login controls.

## Empty Status Spacing

The server continues to render the root live-status paragraph so existing flash behavior and DOM expectations remain stable. A root-page CSS rule hides `main > p[role="status"]` only when it is empty. Nonempty flash messages are unaffected.

## Card Delete Trigger

Each card becomes the positioning context for a top-right delete link. The link displays `×`, has a minimum 44px interactive target, and exposes an accessible name containing the repository owner and name. Its fallback `href` points to `/repositories/:id#delete-heading`.

The fallback is intentional progressive enhancement: without JavaScript, activation navigates to the existing detail-page deletion section, where the user must check the permanent-deletion confirmation before submitting. The card action never performs an immediate no-JavaScript delete.

## Confirmation Modal

The repository panel owns one shared native `<dialog>` for deletion, separate from the existing detail-preview dialog. When a valid card delete link is activated, `repo-panel`:

1. prevents fallback navigation;
2. validates that the link is same-origin and matches `/repositories/:id#delete-heading`;
3. fills the dialog with the escaped repository display name;
4. assigns the matching `/repositories/:id/delete` action to the modal form;
5. enables the destructive submit button and opens the modal;
6. restores focus to the originating `×` after cancellation.

The modal form is server-rendered with the current CSRF token and a hidden `confirm=yes` field. Its destructive submit button starts disabled and is enabled only after the client validates and assigns the delete action. Confirming uses native form submission and the existing server redirect to `/?flash=repository_deleted`; no new API route or optimistic client state is added.

The modal provides a non-destructive cancel button and a danger-styled confirm button. Closing with Cancel or Escape does not mutate data. Server-side authentication, CSRF, confirmation, missing-record, and storage error handling remain authoritative.

## Layout and Visual Treatment

- Repository cards use relative positioning so `×` stays in the top-right without changing the card grid or content flow.
- The title row reserves enough inline space to avoid colliding with the delete target.
- The `×` uses existing text, border, danger, radius, and focus tokens; no new color token or image asset is introduced.
- The modal reuses the existing dialog surface and button patterns.
- The search placeholder and hidden label reduce the visible search control to the same control height as the select while retaining the approved responsive grid.

## Testing

- HTML unit tests verify the search placeholder, visually hidden label, per-card fallback delete link and accessible name, shared delete dialog, CSRF token, hidden `confirm=yes`, and initially disabled submit button.
- CSS policy tests verify empty root-status removal, card positioning, title collision clearance, 44px delete target, and pointer-only outline suppression without changing the global keyboard focus rule.
- Component/browser tests verify pointer focus chrome is absent, `Tab` focus remains visible, the modal names the selected repository, Cancel and Escape preserve data and restore focus, and Confirm submits to the correct repository delete route.
- No-JavaScript browser coverage verifies the `×` fallback reaches the existing detail deletion section rather than deleting immediately.
- Existing integration, accessibility, responsive, static-policy, and release verification gates run before deployment.

## Non-Goals

- Do not add bulk deletion, undo, optimistic removal, toast actions, or an additional deletion endpoint.
- Do not remove keyboard focus indicators.
- Do not change deletion semantics on the repository detail page.
- Do not change category chips, repository metadata, pagination, authentication, or GitHub capture behavior.
