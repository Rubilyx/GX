# Repository Card Compaction Design

## Goal

Improve the repository gallery card's comparison density without changing its data model or progressive-enhancement contracts. Analysis-error cards regain their existing detail and Memo actions, while category, tags, and repository metrics become easier to scan in less vertical space.

## Scope

- Preserve the current `article`, repository `h2`, analysis-summary paragraph, semantic description list, avatar behavior, delete dialog, detail dialog, and no-JavaScript navigation.
- Restore the existing `자세히 보기` and `Memo` action group on analysis-error cards.
- Reorganize Primary category, Tags, Stars, Forks, and Language into compact visual groups while retaining explicit `dt` and `dd` relationships.
- Remove the separate Analysis status field from the card. Ready cards communicate success through their summary, and non-ready cards communicate state once through the existing summary fallback and status data attributes.
- Add deterministic compact formatting for Stars and Forks in the card only.

## Explicit Exclusions

- Do not substitute the GitHub repository description when AI analysis fails. The existing `AI 분석 실패` fallback remains authoritative for an error with no AI summary.
- Do not change the visible `Memo` label, its detail-page `href`, or add a `#personal-note` fragment.
- Do not change the visible `×` delete glyph, delete link, confirmation dialog, or detail-page deletion fallback.
- Do not add recent-activity data, split tag provenance, filter duplicate-looking tags, add database columns or migrations, or change GitHub/OpenAI requests.
- Do not modify repository detail-page fields or forms.

## Rendering Structure

`repositoryCard` continues to render one `article` containing the delete link, repository heading, one summary/status paragraph, metadata description list, and action group.

The metadata `dl` groups each `dt`/`dd` pair in a direct child `div` with a stable field class or data attribute. This keeps the HTML description-list semantics while giving CSS explicit layout hooks:

- Primary category occupies a full-width classification row and presents its value as the primary badge.
- Tags occupy a full-width row beneath the category. Each tag is rendered as an individual badge; an empty collection renders one textual `없음` value.
- Stars, Forks, and Language form a three-column metric row. Each metric retains a visible short label and its value.
- Analysis status is not rendered as a second visible field. Existing `data-analysis-card-status`, `data-analysis-summary-status`, and fixed Korean summary/status text continue to expose state without duplicating the error message.

User-controlled owner, name, category, tags, language, summary, and values continue through the existing HTML text and attribute escaping helpers. The renderer does not emit user strings as raw markup.

## Metric Formatting

A small renderer helper formats non-negative integer card counts deterministically:

- `0` through `999` remain decimal integers.
- `1,000` through `999,999` use at most one decimal and a `K` suffix.
- `1,000,000` and above use at most one decimal and an `M` suffix.
- A trailing `.0` is omitted.

This presentation affects only card text. Detail pages retain exact numeric values.

## Error and Action Behavior

An analysis-error card with no AI summary continues to display `AI 분석 실패`; it does not display `repository.description`. Category and tags retain their existing `미분류` and `없음` fallbacks, and GitHub metrics remain visible.

The action group renders for every repository regardless of analysis status. `자세히 보기` remains a normal detail-page link. `Memo` remains the same enhanced link and continues to open the current read-only summary/Memo dialog for supported desktop primary clicks, with the existing detail-page navigation fallback in every other case.

No new retry action is added. Refresh remains an authenticated, confirmed operation on the detail page.

## CSS and Responsive Layout

The repository card keeps its current 20px padding, avatar/title geometry, 44px interaction targets, three-column desktop gallery, and one-column mobile gallery.

The metadata list replaces the current two-column table-like layout with explicit field groups. Category and tags use wrapping badge rows. Metrics use three equal columns inside the card at all supported viewport widths. Labels remain visible, values wrap safely inside their column, and no horizontal page overflow is introduced at 390px.

Card actions remain after metadata and preserve their current spacing and alignment. Error-card colors remain unchanged.

## Testing

Implementation follows red-green-refactor:

- HTML unit tests first require error cards to retain `AI 분석 실패` without the GitHub description, render the action group, omit a visible Analysis status field, preserve the exact Memo and delete contracts, and escape badge content.
- HTML renderer coverage checks integer, `K`, `M`, decimal-trimming, and boundary cases through rendered card output; the formatting helper does not become a new public API.
- CSS policy tests first require the grouped metadata layout, wrapping category/tag badges, three-column metrics, safe overflow behavior, and all preserved card/action/delete dimensions.
- Type checking, CSS linting, source-policy checks, focused unit tests, and browser checks run after implementation.
- Browser verification covers the supplied 389px card width and a 390px mobile viewport, checking no clipping, no horizontal page overflow, working error-card detail/Memo actions, keyboard focus, and axe accessibility results.

The full release test suite requires the repository-pinned Node `24.18.0`. If the local runtime remains `24.15.0`, targeted change coverage and all runtime-independent checks must pass, and the version mismatch is reported separately rather than weakening release guards.

## Delivery Constraints

Preserve the untracked `repo-atlas-card-evaluation.html` report and all unrelated working-tree state. Do not alter release Node requirements, install dependencies, create migrations, publish, deploy, or perform GitHub operations as part of this change.
