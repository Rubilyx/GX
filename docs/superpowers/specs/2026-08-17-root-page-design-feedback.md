# Root Page Design Feedback

## Goal

Apply the four requested root-page refinements at the reported 1389x1379 desktop viewport without changing unrelated login or repository-detail typography:

- reduce the `Repo Atlas` page title;
- preserve clear space before the native select indicator;
- translate repository-card fact labels to English;
- present the repository title without navigation.
- show the GitHub owner's avatar beside each repository title.
- shorten the analysis-error fallback to `AI 분석 실패`.

## Header typography

Keep the global responsive `h1` scale unchanged for login and detail pages. Add a root-page rule for `.index-header > h1` that caps the existing responsive `--text-xl` size at `2.25rem` (36px). The existing 26px lower bound remains effective on compact screens, while the reported desktop viewport drops from 46px to 36px.

## Select indicator clearance

Keep the platform-native select and its keyboard and accessibility behavior. Preserve the current working-tree change from 24px to `var(--space-8)` (32px) of inline-end padding and verify it in source-policy and Chromium geometry tests.

## Repository facts

Translate only the six left-column `dt` labels on repository cards:

- `주 분류` to `Primary category`;
- `태그` to `Tags`;
- `별` to `Stars`;
- `포크` to `Forks`;
- `언어` to `Language`;
- `분석 상태` to `Analysis status`.

Values, empty-state copy, filter labels, detail-page labels, and status-badge text remain unchanged. The content-sized label column and 12px column gap already present in the working tree remain in place.

## Repository navigation

Render the two-line owner/name heading as non-interactive text. Use a semantic span rather than an anchor without an `href`, and retain the existing owner/name visual hierarchy.

Keep `View details` as the card's only navigation. It retains the existing internal `/repositories/:id` URL and `data-repository-link` enhancement: desktop browsers may open the current native dialog, while compact or no-JavaScript clients reach the detail page normally. No dialog or detail-page behavior is removed.

The title and detail link remain server-rendered and fully usable without JavaScript.

## Analysis-error copy

When an error-state repository has no stored summary, render the exact fallback `AI 분석 실패`. Stored summaries and pending/ready status copy remain unchanged.

## GitHub avatar

Render a decorative 40x40 owner avatar before the two-line repository title. Build the image URL as `https://github.com/:encoded-owner.png?size=80`, using the same encoded owner component as repository navigation. Give the image explicit intrinsic dimensions, a circular crop, lazy loading, asynchronous decoding, an empty `alt` value, and `referrerpolicy="no-referrer"`. The adjacent textual link remains the card's accessible repository name, so the avatar does not repeat it to assistive technology.

Use a two-column title grid so the avatar and owner/name stack stay aligned while long names can wrap within the remaining card width. The 40px avatar fits inside the existing approximately 45px heading block at the reported viewport and must not enlarge or overflow the card.

The application CSP currently permits only same-origin images. Extend only the app-page `img-src` directive to allow `https://github.com` and `https://avatars.githubusercontent.com`, covering GitHub's owner-image endpoint and its final avatar host. Keep login-page CSP unchanged. No database column, API contract, migration, image proxy, or new dependency is introduced.

## Testing

- Unit-test the exact English fact labels, escaped GitHub URL, new-tab attributes, and retained internal detail link.
- Update CSS policy tests for the page-scoped 36px cap while retaining the existing 32px select-padding assertion.
- Unit-test the encoded avatar URL and its loading, privacy, sizing, and decorative-image attributes.
- Update security-header tests for the two narrowly allowed GitHub image origins and unchanged login CSP.
- Add the reported 1389x1379 viewport to the Chromium responsive test and assert that the root title computes to at most 36px.
- Assert in Chromium that each avatar is 40x40, circular, and contained by its card without horizontal overflow.
- Update enhanced-browser tests so the title is not an anchor and `View details` continues to open the existing dialog/detail route.
- Run source checks, unit tests, integration tests, and focused Chromium end-to-end tests before completion.

## Non-goals

- Changing global heading typography or repository-detail page typography.
- Replacing the native select indicator with a custom icon.
- Translating card values, filter controls, dialogs, or detail pages.
- Removing repository analysis, notes, editing, or the progressive-enhancement dialog.
- Making the repository title clickable or adding a second title-adjacent navigation target.
- Persisting avatar URLs or proxying avatar bytes through the Worker.
- Refactoring unrelated working-tree changes.
