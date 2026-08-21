import { expect, loginAndSeed, test } from "./fixtures.js";
import { seedNamedRepositories, seedRepository } from "../support/harness.js";

test("invalid PIN reports the native authentication message", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("6자리 PIN").fill("000000");
  await page.getByRole("button", { name: "접속" }).click();
  await expect(page.getByRole("status")).toContainText("PIN");
});

test("capture enhancement reaches detail through the provider fixture", async ({ page, harness }) => {
  await page.goto("/login");
  const loopbackOrigin = new URL(page.url()).origin;
  await page.getByLabel("6자리 PIN").fill("123456");
  const [loginRequest] = await Promise.all([
    page.waitForRequest((request) => new URL(request.url()).pathname === "/session"),
    page.getByRole("button", { name: "접속" }).click(),
  ]);
  expect((await loginRequest.allHeaders()).origin).toBe(loopbackOrigin);
  await page.getByLabel("GitHub 저장소 URL").fill("https://github.com/OpenAI/example");
  const captureRequestPromise = page.waitForRequest(
    (request) => new URL(request.url()).pathname === "/repositories",
  );
  await page.getByRole("button", { name: "저장" }).click();
  const captureRequest = await captureRequestPromise;
  expect((await captureRequest.allHeaders()).origin).toBe(loopbackOrigin);
  await expect(page).toHaveURL(/\/repositories\/[0-9a-f-]+/);
  await expect(page.getByRole("heading", { name: "OpenAI/example" })).toBeVisible();
  expect(harness.providerCalls()).toEqual([
    "provider_fixture:github_metadata",
    "provider_fixture:github_readme",
    "provider_fixture:openai_response",
  ]);
});

test("category chips preserve search and tag in one canonical query", async ({ page }) => {
  await loginAndSeed(page);
  await page.getByLabel("검색").fill("example");
  await page.getByLabel("태그").selectOption("example");
  await expect(page).toHaveURL(/\?q=example&tag=example&page=1$/);
  await expect(page.locator("#category")).toHaveCount(0);
  await page.getByRole("link", { name: "Backend 1", exact: true }).click();
  await expect(page).toHaveURL(/\?q=example&category=Backend&tag=example&page=1$/);
  await expect(page.getByRole("link", { name: "Backend 1", exact: true }))
    .toHaveAttribute("aria-current", "page");
  expect(new URL(page.url()).search).toBe("?q=example&category=Backend&tag=example&page=1");
});

test("Repo Atlas title returns to the unfiltered first screen", async ({ page }) => {
  await loginAndSeed(page);
  await page.goto("/?q=example&tag=example&page=1");
  const home = page.getByRole("link", { name: "Repo Atlas", exact: true });

  await expect(home).toHaveAttribute("href", "/");
  await expect(home).toHaveCSS("text-decoration-line", "none");
  await expect(home).toHaveCSS("min-height", "44px");
  await home.click();
  await expect(page).toHaveURL((url) => url.pathname === "/" && url.search === "");
});

test("filter hides pointer focus chrome and preserves keyboard focus", async ({ page }) => {
  await loginAndSeed(page);
  const search = page.getByLabel("검색", { exact: true });
  const tag = page.getByLabel("태그");
  await expect(tag).toHaveAttribute("id", "tag");
  const tagControl = page.locator("#tag");

  await search.click();
  await expect(search).toHaveAttribute("data-pointer-focus", "");
  await expect(search).toHaveCSS("outline-style", "none");

  await page.keyboard.press("Tab");
  await expect(tagControl).toBeFocused();
  await expect(tagControl).not.toHaveAttribute("data-pointer-focus");
  await expect(tagControl).toHaveCSS("outline-style", "solid");

  await tagControl.click();
  await expect(tagControl).toHaveAttribute("data-pointer-focus", "");
  await expect(tagControl).toHaveCSS("outline-style", "none");
});

test("paging preserves a stable canonical page query", async ({ page, harness }) => {
  const env = await harness.worker.getEnv();
  await seedNamedRepositories(env.PROD_DB, 35);
  await page.goto("/login");
  await page.getByLabel("6자리 PIN").fill("123456");
  await page.getByRole("button", { name: "접속" }).click();
  const next = page.getByRole("link", { name: "다음" });
  await expect(next).toHaveAttribute("href", "/?page=2");
  await next.click();
  await expect(page).toHaveURL(/\?page=2$/);
  await expect(page.getByRole("link", { name: "이전" })).toHaveAttribute("href", "/?page=1");
});

test("repository title is non-interactive", async ({ page }) => {
  await loginAndSeed(page);
  const title = page.locator(".repository-title").first();
  await expect(title).toHaveText("OpenAI/example");
  expect(await title.evaluate((element) => ({
    tag: element.tagName, insideLink: element.closest("a") !== null,
  }))).toEqual({ tag: "SPAN", insideLink: false });
});

test("repository descriptions keep their bordered bubble spacing", async ({ page }) => {
  await page.setViewportSize({ width: 1389, height: 1379 });
  await loginAndSeed(page);
  const description = page.locator("repo-panel article > p").first();

  expect(await description.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      backgroundColor: style.backgroundColor,
      borderColor: style.borderTopColor,
      borderRadius: style.borderTopLeftRadius,
      borderStyle: style.borderTopStyle,
      borderWidth: style.borderTopWidth,
      marginBottom: style.marginBottom,
      marginTop: style.marginTop,
      paddingBottom: style.paddingBottom,
      paddingLeft: style.paddingLeft,
      paddingRight: style.paddingRight,
      paddingTop: style.paddingTop,
    };
  })).toEqual({
    backgroundColor: "rgb(241, 240, 237)",
    borderColor: "rgb(227, 225, 220)",
    borderRadius: "8px",
    borderStyle: "solid",
    borderWidth: "1px",
    marginBottom: "8px",
    marginTop: "8px",
    paddingBottom: "12px",
    paddingLeft: "16px",
    paddingRight: "16px",
    paddingTop: "12px",
  });
});

test("analysis failure cards keep one failure message and expose both actions", async ({ page, harness }) => {
  await loginAndSeed(page);
  const env = await harness.worker.getEnv();
  await seedRepository(env.PROD_DB, {
    id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", githubId: "404",
    owner: "Failure", name: "short", htmlUrl: "https://github.com/Failure/short",
    summary: null, primaryCategory: null, analysisStatus: "error",
    analysisErrorCode: "analysis_unavailable", createdAt: 999,
  });
  await page.reload();

  const card = page.locator('article[data-analysis-card-status="error"]');
  const description = card.locator('[data-analysis-summary-status="error"]');
  const detail = card.getByRole("link", { name: "자세히 보기", exact: true });
  const memo = card.locator("[data-repository-link]");
  await expect(card).toHaveCSS("background-color", "rgb(241, 240, 237)");
  await expect(card).toHaveCSS("color", "rgb(107, 105, 99)");
  await expect(description).toHaveText("AI 분석 실패");
  await expect(description).toHaveCSS("background-color", "rgb(253, 235, 236)");
  await expect(card.locator('[data-analysis-status="error"]')).toHaveCount(0);
  await expect(detail).toHaveAttribute("href", "/repositories/eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee");
  await expect(memo).toHaveText("Memo");
  await expect(memo).toHaveAttribute("href", "/repositories/eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee");
});

test("repository card exposes separate detail and memo actions", async ({ page }) => {
  await page.setViewportSize({ width: 1389, height: 1379 });
  await loginAndSeed(page);
  const card = page.locator("repo-panel article").first();
  const detail = card.getByRole("link", { name: "자세히 보기", exact: true });
  const memo = card.locator("[data-repository-link]");
  const actions = card.locator(".repository-actions");
  const summary = card.locator("[data-analysis-summary-status]");

  await expect(detail).toHaveAttribute("href", /\/repositories\/[0-9a-f-]+$/);
  await expect(detail).toHaveCSS("text-decoration-line", "none");
  await expect(memo).toHaveText("Memo");
  await expect(memo).toHaveCSS("text-decoration-line", "none");
  await expect(summary).toHaveCSS("font-weight", "500");
  const [actionsBox, memoBox] = await Promise.all([actions.boundingBox(), memo.boundingBox()]);
  expect(actionsBox).not.toBeNull();
  expect(memoBox).not.toBeNull();
  if (!actionsBox || !memoBox) throw new Error("repository_action_bounds_missing");
  expect(Math.abs((actionsBox.x + actionsBox.width) - (memoBox.x + memoBox.width))).toBeLessThanOrEqual(1);
  await detail.hover();
  await expect(detail).toHaveCSS("color", "rgb(159, 47, 45)");
});

test("repository actions stay 44px tall with uneven card content", async ({ page, harness }) => {
  await page.setViewportSize({ width: 1389, height: 1379 });
  await loginAndSeed(page);
  const env = await harness.worker.getEnv();
  await seedRepository(env.PROD_DB, {
    id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", githubId: "404",
    owner: "Failure", name: "short", htmlUrl: "https://github.com/Failure/short",
    summary: null, primaryCategory: null, analysisStatus: "error",
    analysisErrorCode: "analysis_unavailable", createdAt: 999,
  });
  await seedRepository(env.PROD_DB, {
    id: "dddddddd-dddd-dddd-dddd-dddddddddddd", githubId: "405",
    owner: "Extremely-long-owner-name", name: "content-heavy-repository",
    htmlUrl: "https://github.com/Extremely-long-owner-name/content-heavy-repository",
    summary: "긴 설명이 있는 저장소 카드가 같은 행의 높이를 크게 늘려도 자세히 보기 링크의 터치 영역은 늘어나지 않아야 합니다. ".repeat(4),
    tags: ["long-design-system", "responsive-layout", "accessibility", "javascript", "documentation"],
    createdAt: 998,
  });
  await page.reload();

  const heights = await page.locator(".repository-actions > a").evaluateAll((links) =>
    links.map((link) => link.getBoundingClientRect().height));
  expect(heights).toHaveLength(6);
  expect(heights.every((height) => height === 44)).toBe(true);
});

test("repository summary boxes keep their top edge fixed with uneven text", async ({ page, harness }) => {
  await page.setViewportSize({ width: 1389, height: 1379 });
  await loginAndSeed(page);
  const env = await harness.worker.getEnv();
  await seedRepository(env.PROD_DB, {
    id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", githubId: "404",
    owner: "Pair", name: "short", htmlUrl: "https://github.com/Pair/short",
    summary: "짧은 설명", createdAt: 999,
  });
  await seedRepository(env.PROD_DB, {
    id: "dddddddd-dddd-dddd-dddd-dddddddddddd", githubId: "405",
    owner: "Pair", name: "lengthy", htmlUrl: "https://github.com/Pair/lengthy",
    summary: "본문이 길어져도 요약 박스의 상단 위치는 움직이지 않아야 합니다. ".repeat(16),
    createdAt: 998,
  });
  await page.reload();

  const summaries = await page.locator("repo-panel article").evaluateAll((cards) =>
    Object.fromEntries(cards.map((card) => {
      const heading = card.querySelector("h2")?.textContent;
      const summary = card.querySelector(":scope > p");
      if (!heading || !(summary instanceof HTMLElement))
        throw new Error("repository_summary_nodes_missing");
      const cardBox = card.getBoundingClientRect();
      const summaryBox = summary.getBoundingClientRect();
      return [heading, {
        height: summaryBox.height,
        top: summaryBox.top - cardBox.top,
      }];
    })));

  expect(Math.abs(summaries["Pair/short"].top - summaries["Pair/lengthy"].top))
    .toBeLessThanOrEqual(1);
  expect(summaries["Pair/lengthy"].height).toBeGreaterThan(summaries["Pair/short"].height);
});

test("repository metadata presents taxonomy badges and compact metrics", async ({ page }) => {
  await page.setViewportSize({ width: 1389, height: 1379 });
  await loginAndSeed(page);
  const metadata = page.locator(".repository-metadata").first();

  expect(await metadata.evaluate((element) => {
    const category = element.querySelector('[data-repository-field="category"]');
    const tags = element.querySelector('[data-repository-field="tags"]');
    const badgeList = element.querySelector(".repository-badge-list");
    const primaryBadge = element.querySelector(".repository-badge--primary");
    const metrics = [...element.querySelectorAll(
      '[data-repository-field="stars"], [data-repository-field="forks"], [data-repository-field="language"]',
    )];
    if (!(category instanceof HTMLElement) || !(tags instanceof HTMLElement) ||
        !(badgeList instanceof HTMLElement) || !(primaryBadge instanceof HTMLElement) ||
        metrics.length !== 3 || metrics.some((metric) => !(metric instanceof HTMLElement)))
      throw new Error("repository_metadata_nodes_missing");
    const style = getComputedStyle(element);
    return {
      columns: style.gridTemplateColumns.split(" ").length,
      rowGap: style.rowGap,
      categoryColumn: getComputedStyle(category).gridColumn,
      tagsColumn: getComputedStyle(tags).gridColumn,
      badgeListDisplay: getComputedStyle(badgeList).display,
      badgeListWrap: getComputedStyle(badgeList).flexWrap,
      primaryBadgeColor: getComputedStyle(primaryBadge).color,
      metricBorders: metrics.map((metric) => getComputedStyle(metric).borderTopWidth),
      metricWeights: metrics.map((metric) => {
        const value = metric.querySelector("dd");
        return value instanceof HTMLElement ? getComputedStyle(value).fontWeight : "";
      }),
    };
  })).toEqual({
    columns: 3,
    rowGap: "12px",
    categoryColumn: "1 / -1",
    tagsColumn: "1 / -1",
    badgeListDisplay: "flex",
    badgeListWrap: "wrap",
    primaryBadgeColor: "rgb(255, 255, 255)",
    metricBorders: ["1px", "1px", "1px"],
    metricWeights: ["650", "650", "650"],
  });
});

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
});

test("card delete dialog fits its confirmation content at the desktop reference viewport", async ({ page }) => {
  await page.setViewportSize({ width: 1389, height: 1379 });
  await loginAndSeed(page);
  await page.getByRole("link", { name: "OpenAI/example 삭제", exact: true }).click();
  const dialog = page.locator("[data-repository-delete-dialog]");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "저장소를 삭제할까요?" })).toBeVisible();
  await expect(dialog.getByText("삭제 대상", { exact: true })).toBeVisible();
  await expect(dialog.getByText("저장소와 개인 메모가 영구 삭제되며 복구할 수 없습니다.", {
    exact: true,
  })).toBeVisible();
  const cancel = dialog.getByRole("button", { name: "취소", exact: true });
  const remove = dialog.getByRole("button", { name: "저장소 삭제", exact: true });
  await expect(cancel).toBeFocused();
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
  expect(geometry.width).toBeLessThanOrEqual(448);
  expect(geometry.height).toBeLessThanOrEqual(320);
  expect(Math.abs(geometry.centerX - 1389 / 2)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.centerY - 1379 / 2)).toBeLessThanOrEqual(1);
  expect(geometry.radius).toBe("12px");
  const [cancelBox, removeBox] = await Promise.all([cancel.boundingBox(), remove.boundingBox()]);
  expect(cancelBox).not.toBeNull();
  expect(removeBox).not.toBeNull();
  expect(Math.abs((cancelBox?.y ?? 0) - (removeBox?.y ?? 0))).toBeLessThanOrEqual(1);
  expect((removeBox?.x ?? 0)).toBeGreaterThan(cancelBox?.x ?? 0);
});

test("card delete confirms, restores focus, and submits the protected native form", async ({ page }) => {
  await loginAndSeed(page);
  const opener = page.getByRole("link", { name: "OpenAI/example 삭제", exact: true });
  const dialog = page.locator("[data-repository-delete-dialog]");

  await expect(opener).toHaveAttribute("href", /\/repositories\/[0-9a-f-]+#delete-heading$/);
  await opener.click();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("[data-repository-delete-name]")).toHaveText("OpenAI/example");
  await dialog.getByRole("button", { name: "취소", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();

  await opener.click();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();

  await opener.click();
  const deletion = page.waitForRequest((request) =>
    request.method() === "POST" && /\/repositories\/[0-9a-f-]+\/delete$/.test(new URL(request.url()).pathname));
  await dialog.getByRole("button", { name: "저장소 삭제", exact: true }).click();
  const request = await deletion;
  expect(request.postData()).toContain("confirm=yes");
  expect(request.postData()).toContain("csrf=");
  await expect(page).toHaveURL(/\/?flash=repository_deleted$/);
  await expect(page.getByText("저장소를 삭제했습니다.", { exact: true })).toBeVisible();
});

test("desktop repository link opens the native detail dialog and restores focus", async ({ page }) => {
  test.skip(["mobile-chrome", "mobile-safari", "chromium-no-js"].includes(test.info().project.name));
  await loginAndSeed(page);
  const opener = page.getByRole("link", { name: "Memo", exact: true }).first();
  await opener.focus();
  await opener.click();
  const dialog = page.locator("[data-repository-dialog]");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "OpenAI/example" })).toBeVisible();
  await expect(dialog.locator("[data-repository-summary]")).toHaveValue(
    "예제 저장소의 핵심 사용법을 보여준다.",
  );
  await expect(dialog.locator("[data-repository-detail-link]")).toHaveAttribute(
    "href", /\/repositories\/[0-9a-f-]+$/,
  );
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
});

test("desktop memo dialog saves an editable personal note and stays compact", async ({ page }) => {
  test.skip(["mobile-chrome", "mobile-safari", "chromium-no-js"].includes(test.info().project.name));
  await page.setViewportSize({ width: 1200, height: 900 });
  await loginAndSeed(page);

  await page.getByRole("link", { name: "Memo", exact: true }).first().click();
  const dialog = page.locator("[data-repository-dialog]");
  const note = dialog.getByRole("textbox", { name: "개인 메모", exact: true });
  await note.fill("다시 확인할 개인 메모");
  const saveResponse = page.waitForResponse((response) =>
    /\/repositories\/[0-9a-f-]+\/note$/.test(new URL(response.url()).pathname));
  await dialog.getByRole("button", { name: "저장", exact: true }).click();

  expect((await saveResponse).status()).toBe(200);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("status")).toHaveText("저장 완료");
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.height).toBeLessThan(868);

  await dialog.getByRole("button", { name: "닫기", exact: true }).click();
  await page.getByRole("link", { name: "Memo", exact: true }).first().click();
  await expect(dialog.getByRole("textbox", { name: "개인 메모", exact: true }))
    .toHaveValue("다시 확인할 개인 메모");
});

test("desktop detail action navigates to the repository page", async ({ page }) => {
  test.skip(["mobile-chrome", "mobile-safari", "chromium-no-js"].includes(test.info().project.name));
  await loginAndSeed(page);

  await page.getByRole("link", { name: "자세히 보기", exact: true }).first().click();

  await expect(page).toHaveURL(/\/repositories\/[0-9a-f-]+$/);
  await expect(page.getByRole("heading", { name: "OpenAI/example" })).toBeVisible();
});

test("panel failure follows the original detail link", async ({ page }) => {
  await loginAndSeed(page);
  await page.route("**/repositories/**", (route) => {
    if (route.request().headers().accept?.includes("application/json")) route.abort();
    else route.continue();
  });
  await page.locator("[data-repository-link]").first().click();
  await expect(page).toHaveURL(/\/repositories\/[0-9a-f-]+/);
  await expect(page.getByRole("heading", { name: "OpenAI/example" })).toBeVisible();
});

test("missing dialog support leaves the native detail link intact", async ({ page }) => {
  /** @type {string[]} */
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      value: undefined, configurable: true,
    });
  });
  await loginAndSeed(page);
  let jsonRequests = 0;
  await page.route("**/repositories/**", (route) => {
    if (route.request().headers().accept?.includes("application/json")) jsonRequests += 1;
    route.continue();
  });
  await page.locator("[data-repository-link]").first().click();
  await expect(page).toHaveURL(/\/repositories\/[0-9a-f-]+/);
  expect(jsonRequests).toBe(0);
  expect(errors).toEqual([]);
});

test("capture partial success still opens the saved detail", async ({ page, harness }) => {
  const id = "cccccccc-cccc-cccc-cccc-cccccccccccc";
  const env = await harness.worker.getEnv();
  await seedRepository(env.PROD_DB, {
    id, githubId: "303", owner: "OpenAI", name: "example",
    htmlUrl: "https://github.com/OpenAI/example", analysisStatus: "error",
    analysisErrorCode: "analysis_rate_limited",
  });
  await page.goto("/login");
  await page.getByLabel("6자리 PIN").fill("123456");
  await page.getByRole("button", { name: "접속" }).click();
  await page.getByLabel("GitHub 저장소 URL").fill("https://github.com/OpenAI/example");
  await page.route("**/repositories", (route) => route.request().method() === "POST"
    ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      repositoryId: id, analysisStatus: "error", errorCode: "analysis_rate_limited",
    }) }) : route.continue());
  await page.getByRole("button", { name: "저장" }).click();
  await expect(page).toHaveURL(/\/repositories\/[0-9a-f-]+/);
  await expect(page.locator("dt").filter({ hasText: /^분석 상태$/ })
    .locator("xpath=following-sibling::dd[1]")).toHaveText("분석 오류");
});

test("detail edits, refreshes replacement analysis, deletes, and logs out through native forms", async ({ page }) => {
  await loginAndSeed(page);
  const href = await page.locator("[data-repository-link]").first().getAttribute("href");
  if (!href) throw new Error("detail_href_missing");
  await page.goto(href);
  await page.getByRole("textbox", { name: "개인 메모", exact: true }).fill("보관할 메모");
  await page.getByLabel("주 분류", { exact: true }).selectOption("Backend");
  await page.getByLabel("태그 (쉼표로 구분)").fill("example, node-js");
  await page.getByRole("button", { name: "변경 저장" }).click();
  await expect(page.getByRole("status")).toHaveText("분류와 메모를 저장했습니다.");
  await page.getByLabel(/AI 요약, 주 분류와 태그가 새 분석 결과로 교체됨/).check();
  await page.getByRole("button", { name: "GitHub 정보와 분석 새로고침" }).click();
  await expect(page.getByRole("status")).toHaveText("GitHub 정보와 분석을 새로고쳤습니다.");
  await expect(page.getByRole("textbox", { name: "개인 메모", exact: true })).toHaveValue("보관할 메모");
  await page.getByLabel(/이 저장소와 개인 메모를 영구 삭제함/).check();
  await page.getByRole("button", { name: "저장소 삭제" }).click();
  await expect(page.getByText("저장소를 삭제했습니다.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "로그아웃" }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test("duplicate capture returns the explicit existing-record notice", async ({ page }) => {
  await loginAndSeed(page);
  await page.goto("/");
  await page.getByLabel("GitHub 저장소 URL").fill("https://github.com/OpenAI/example");
  await page.locator("repo-capture form").evaluate((form) => /** @type {HTMLFormElement} */ (form).submit());
  await expect(page.getByRole("status")).toHaveText("이미 저장된 저장소입니다.");
});

test("capture failure reports safe text and preserves the entered URL", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("6자리 PIN").fill("123456");
  await page.getByRole("button", { name: "접속" }).click();
  const input = page.getByLabel("GitHub 저장소 URL");
  const status = page.locator("[data-capture-status]");
  await expect(status).toBeHidden();
  await input.fill("https://github.com/OpenAI/example");
  await page.route("**/repositories", (route) => route.abort());
  await page.getByRole("button", { name: "저장" }).click();
  await expect(status).toHaveText(
    "저장소를 저장하지 못했습니다. 다시 시도하세요.",
  );
  await expect(input).toHaveValue("https://github.com/OpenAI/example");
  await expect(page.getByRole("button", { name: "저장" })).toBeEnabled();
  await expect(page).toHaveURL(/\/$/);
});

test("rapid enhanced capture aborts only the first request and the second result wins", async ({ page, harness }) => {
  test.setTimeout(15_000);
  const firstId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const secondId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  const env = await harness.worker.getEnv();
  await seedRepository(env.PROD_DB, {
    id: firstId, githubId: "101", owner: "First", name: "first",
    htmlUrl: "https://github.com/First/first",
  });
  await seedRepository(env.PROD_DB, {
    id: secondId, githubId: "102", owner: "Second", name: "second",
    htmlUrl: "https://github.com/Second/second",
  });
  await page.goto("/login");
  await page.getByLabel("6자리 PIN").fill("123456");
  await page.getByRole("button", { name: "접속" }).click();
  await page.getByLabel("GitHub 저장소 URL").fill("https://github.com/OpenAI/example");

  let calls = 0;
  /** @type {(() => void) | undefined} */
  let releaseFirst;
  /** @type {Promise<void>} */
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  /** @type {(() => void) | undefined} */
  let markFirstSeen;
  /** @type {Promise<void>} */
  const firstSeen = new Promise((resolve) => { markFirstSeen = resolve; });
  /** @type {(() => void) | undefined} */
  let releaseSecond;
  /** @type {Promise<void>} */
  const secondGate = new Promise((resolve) => { releaseSecond = resolve; });
  /** @type {(() => void) | undefined} */
  let markSecondSeen;
  /** @type {Promise<void>} */
  const secondSeen = new Promise((resolve) => { markSecondSeen = resolve; });
  await page.route("**/repositories", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    calls += 1;
    if (calls === 1) {
      markFirstSeen?.();
      await firstGate;
      await route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ repositoryId: firstId, analysisStatus: "ready", errorCode: null }),
      }).catch(() => {});
      return;
    }
    markSecondSeen?.();
    await secondGate;
    await route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ repositoryId: secondId, analysisStatus: "ready", errorCode: null }),
    });
  });
  await expect(page.locator("repo-capture")).toHaveAttribute("data-ready", "true");
  const firstFailed = page.waitForEvent("requestfailed", (request) =>
    request.method() === "POST" && new URL(request.url()).pathname === "/repositories");
  const form = page.locator("repo-capture form");
  try {
    await form.evaluate((element) => /** @type {HTMLFormElement} */ (element).requestSubmit());
    await firstSeen;
    await form.evaluate((element) => /** @type {HTMLFormElement} */ (element).requestSubmit());
    await secondSeen;
    const failedRequest = await firstFailed;
    expect(failedRequest.failure()?.errorText).toBeTruthy();
    releaseSecond?.();
    await expect(page).toHaveURL(`/repositories/${secondId}`);
    await expect(page.getByRole("heading", { name: "Second/second" })).toBeVisible();
    expect(calls).toBe(2);
  } finally {
    releaseFirst?.();
    releaseSecond?.();
  }
});

test("enhanced core flow emits no browser errors", async ({ page }) => {
  /** @type {string[]} */
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await loginAndSeed(page);
  await page.locator("[data-repository-link]").first().click();
  if (["mobile-chrome", "mobile-safari"].includes(test.info().project.name)) {
    await expect(page).toHaveURL(/\/repositories\/[0-9a-f-]+/);
  } else {
    await expect(page.locator("[data-repository-dialog]")).toBeVisible();
    await page.keyboard.press("Escape");
  }
  expect(errors).toEqual([]);
});
