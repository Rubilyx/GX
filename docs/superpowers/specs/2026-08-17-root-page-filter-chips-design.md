# Root Page Filter Chips Design

## Goal

Make the root page hierarchy more compact and browsing-oriented by reducing the title, moving repository search above capture, replacing the primary-category select with a YouTube-style category filter bar, and using an English repository section heading.

## Approved Requirements

- The root-page `Repo Atlas` heading computes to `32px` (`2rem`) at the reference desktop viewport. Other page-level `h1` styles remain unchanged.
- Root-page content order is: header, status message, search/tag filter form, GitHub repository capture form, category filter bar, repository results, pagination, and detail dialog.
- The existing `주 분류` select is removed from the filter form. Search, tag, page, and submit controls retain their native form behavior.
- The category filter bar contains `All` followed by every supplied primary category in its existing order.
- The results heading copy is exactly `Repository` when repositories exist.

## Category Navigation

The filter bar is server-rendered navigation, not a client-only control. Each chip is a same-origin anchor whose query contains the current nonempty `q` and `tag` values, the chip's nonempty `category` value, and `page=1`. The `All` chip omits `category`. This makes filtering bookmarkable, preserves progressive enhancement, and resets pagination after a category change.

The navigation uses `aria-label="Primary category"`. The active chip uses `aria-current="page"`; exactly one chip is active, including `All` when no category is selected. Category text and query values use the existing HTML text and attribute escaping boundaries.

## Layout and Visual Treatment

The root page renders the native search/tag filter before the capture form. Removing the category field leaves a compact search, tag, and submit layout at desktop widths and the existing single-column form at narrow widths.

The category navigation sits immediately before the repository results. Its chips remain on one row and scroll horizontally when they exceed the available inline size. Every chip has a minimum `44px` target height, rounded pill shape, compact horizontal padding, no text wrapping, and a visible keyboard focus state inherited from the global focus policy. The active chip uses the existing primary action color and contrasting white text; inactive chips use the existing surface, border, and primary text tokens.

No new JavaScript component, custom event, or client-side state is introduced. Existing filter enhancement may continue to operate on the remaining native form controls.

## Empty and Error States

The category bar is rendered whether or not the current filter returns repositories, so the user can recover from an empty category result. Existing empty-result, flash-status, capture-error, and repository-analysis-error behavior remains unchanged. The empty heading remains `저장한 저장소가 없습니다` because the requested English copy applies to `h2#results` only.

## Responsive and Accessibility Behavior

- Below `600px`, the search/tag form remains one column and the chip row scrolls horizontally without causing page-level overflow.
- At `600px` and above, search and tag occupy equal columns with the submit action aligned at the end of the row.
- The category bar is exposed as navigation, not as a toolbar or listbox.
- Keyboard users can focus and activate every chip as a normal link.
- The selected category is communicated by both visual styling and `aria-current="page"`.

## Testing

- HTML unit tests verify DOM order, absence of the category select, exact `Repository` copy, escaped chip URLs and labels, query preservation, `page=1`, and one active chip.
- CSS policy tests verify the root heading's `2rem` size, compact filter columns, horizontal chip overflow, minimum target size, and active/inactive token usage.
- Integration tests verify the rendered category links preserve search/tag filters and select the requested category.
- Chromium tests verify chip navigation, the resulting canonical query, active state, DOM order, 32px heading, and no horizontal page overflow at reference widths.
- Existing static checks, integration tests, and relevant browser suites run before deployment.

## Non-Goals

- Do not add multi-select categories.
- Do not load results without navigation.
- Do not add icons, counts, drag scrolling, sticky positioning, or hidden scrollbars.
- Do not change repository card data labels, card navigation, avatar behavior, detail pages, or authentication.
