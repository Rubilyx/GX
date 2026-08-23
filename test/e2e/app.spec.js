import { expect, loginAndSeed, test } from "./fixtures.js";
import { seedNamedRepositories, seedRepository, seedRepositoryNote } from "../support/harness.js";

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
  await expect(memo).toHaveText("Note");
  await expect(memo).toHaveAttribute(
    "href", "/repositories/eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee/notes",
  );
});

test("repository card exposes separate detail and note actions", async ({ page }) => {
  await page.setViewportSize({ width: 1389, height: 1379 });
  await loginAndSeed(page);
  const card = page.locator("repo-panel article").first();
  const detail = card.getByRole("link", { name: "자세히 보기", exact: true });
  const memo = card.locator("[data-repository-link]");
  const actions = card.locator(".repository-actions");
  const summary = card.locator("[data-analysis-summary-status]");

  await expect(detail).toHaveAttribute("href", /\/repositories\/[0-9a-f-]+$/);
  await expect(detail).toHaveCSS("text-decoration-line", "none");
  await expect(memo).toHaveText("Note");
  await expect(memo).toHaveCSS("text-decoration-line", "none");
  await expect(summary).toHaveCSS("font-weight", "500");
  await expect(card.locator("[data-repository-memo]")).toHaveCount(0);
  await expect(card.locator('[data-repository-field="activity"]')).toContainText("활동");
  await expect(card.getByRole("button", { name: "OpenAI/example 활동 새로고침" }))
    .toHaveText("");
  const [actionsBox, memoBox] = await Promise.all([actions.boundingBox(), memo.boundingBox()]);
  expect(actionsBox).not.toBeNull();
  expect(memoBox).not.toBeNull();
  if (!actionsBox || !memoBox) throw new Error("repository_action_bounds_missing");
  expect(Math.abs((actionsBox.x + actionsBox.width) - (memoBox.x + memoBox.width))).toBeLessThanOrEqual(1);
  await detail.hover();
  await expect(detail).toHaveCSS("color", "rgb(159, 47, 45)");
  await memo.hover();
  await expect(memo).toHaveCSS("color", "rgb(159, 47, 45)");
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
    const categoryValue = category?.querySelector("dd");
    const tagsValue = tags?.querySelector("dd");
    const metrics = [...element.querySelectorAll(
      '[data-repository-field="stars"], [data-repository-field="forks"], [data-repository-field="language"]',
    )];
    if (!(category instanceof HTMLElement) || !(tags instanceof HTMLElement) ||
        !(badgeList instanceof HTMLElement) || !(primaryBadge instanceof HTMLElement) ||
        !(categoryValue instanceof HTMLElement) || !(tagsValue instanceof HTMLElement) ||
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
      badgeValuePadding: [categoryValue, tagsValue].map((value) => {
        const valueStyle = getComputedStyle(value);
        return [valueStyle.paddingBlockStart, valueStyle.paddingBlockEnd];
      }),
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
    badgeValuePadding: [["8px", "8px"], ["8px", "8px"]],
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
  await expect(dialog.getByText("저장소와 모든 Note가 영구 삭제되며 복구할 수 없습니다.", {
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

test.describe("desktop Note manager", () => {
  test.describe.configure({ mode: "serial" });

  test("renders native previous, numbered, and next links at pagination boundaries", async ({
    page, harness,
  }) => {
    test.skip(["mobile-chrome", "mobile-safari", "chromium-no-js"].includes(test.info().project.name));
    await loginAndSeed(page);
    const opener = page.locator("[data-repository-link]").first();
    const href = await opener.getAttribute("href");
    const match = /^\/repositories\/([0-9a-f-]+)\/notes$/.exec(href ?? "");
    expect(match).not.toBeNull();
    const repositoryId = match?.[1] ?? "";
    const env = await harness.worker.getEnv();
    for (let number = 1; number <= 11; number += 1) {
      await seedRepositoryNote(env.PROD_DB, {
        id: crypto.randomUUID(), repositoryId, body: `페이지 Note ${number}`,
        createdAt: number, updatedAt: number,
      });
    }

    await opener.click();
    const dialog = page.locator("[data-repository-dialog]");
    const pagination = dialog.locator("[data-repository-note-pagination]");
    await expect(pagination.getByRole("link", { name: "이전", exact: true })).toHaveCount(0);
    await expect(pagination.getByRole("link", { name: "1", exact: true }))
      .toHaveAttribute("aria-current", "page");
    const firstNext = pagination.getByRole("link", { name: "다음", exact: true });
    await expect(firstNext).toHaveAttribute("rel", "next");
    await expect(firstNext).toHaveAttribute("href", `${href}?page=2`);

    await firstNext.click();
    const middlePrevious = pagination.getByRole("link", { name: "이전", exact: true });
    const middleNext = pagination.getByRole("link", { name: "다음", exact: true });
    await expect(middlePrevious).toHaveAttribute("rel", "prev");
    await expect(middlePrevious).toHaveAttribute("href", `${href}?page=1`);
    await expect(pagination.getByRole("link", { name: "2", exact: true }))
      .toHaveAttribute("aria-current", "page");
    await expect(middleNext).toHaveAttribute("href", `${href}?page=3`);

    await middleNext.click();
    await expect(pagination.getByRole("link", { name: "3", exact: true }))
      .toHaveAttribute("aria-current", "page");
    await expect(pagination.getByRole("link", { name: "이전", exact: true }))
      .toHaveAttribute("href", `${href}?page=2`);
    await expect(pagination.getByRole("link", { name: "다음", exact: true })).toHaveCount(0);
  });

  test("rejects a Note list response with a non-UUID Note id", async ({ page }) => {
    test.skip(["mobile-chrome", "mobile-safari", "chromium-no-js"].includes(test.info().project.name));
    await loginAndSeed(page);
    const opener = page.locator("[data-repository-link]").first();
    const href = await opener.getAttribute("href");
    await page.route("**/repositories/*/notes", async (route) => {
      if (route.request().method() !== "GET" ||
        route.request().headers().accept !== "application/json") return route.continue();
      const response = await route.fetch();
      const result = await response.json();
      result.notes = [{
        id: "abc-def", repositoryId: result.repository.id, body: "잘못된 ID Note",
        createdAt: 1, updatedAt: 1,
      }];
      result.page = 1;
      result.totalPages = 1;
      result.total = 1;
      await route.fulfill({ response, json: result });
    });

    await opener.click();

    await expect(page).toHaveURL(new RegExp(`${href}$`));
    await expect(page.locator("[data-repository-dialog]:visible")).toHaveCount(0);
  });

  test("rejects a Note list response with unexpected keys", async ({ page }) => {
    test.skip(["mobile-chrome", "mobile-safari", "chromium-no-js"].includes(test.info().project.name));
    await loginAndSeed(page);
    const opener = page.locator("[data-repository-link]").first();
    const href = await opener.getAttribute("href");
    await page.route("**/repositories/*/notes", async (route) => {
      if (route.request().method() !== "GET" ||
        route.request().headers().accept !== "application/json") return route.continue();
      const response = await route.fetch();
      const result = await response.json();
      result.unexpected = true;
      await route.fulfill({ response, json: result });
    });

    await opener.click();

    await expect(page).toHaveURL(new RegExp(`${href}$`));
    await expect(page.locator("[data-repository-dialog]:visible")).toHaveCount(0);
  });

  test("creates, pages, edits, deletes, synchronizes the card, and restores focus", async ({ page }) => {
    test.skip(["mobile-chrome", "mobile-safari", "chromium-no-js"].includes(test.info().project.name));
    await page.setViewportSize({ width: 1200, height: 900 });
    await loginAndSeed(page);
    const opener = page.locator("[data-repository-link]").first();
    const card = opener.locator("xpath=ancestor::article");
    const dialog = page.locator("[data-repository-dialog]");

    await opener.focus();
    await opener.click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "OpenAI/example Note" })).toBeVisible();
    await expect(dialog.locator("[data-repository-notes-summary]"))
      .toHaveText("예제 저장소의 핵심 사용법을 보여준다.");
    const draft = dialog.getByRole("textbox", { name: "새 Note", exact: true });
    await expect(draft).toBeFocused();

    for (let number = 1; number <= 6; number += 1) {
      await draft.fill(`Note ${number}`);
      await dialog.getByRole("button", { name: "저장", exact: true }).click();
      await expect(draft).toHaveValue("");
      await expect(dialog.locator(".repository-note-body").first()).toHaveText(`Note ${number}`);
    }

    await expect(opener).toHaveText("Note 6");
    await expect(card.locator("[data-repository-memo]")).toHaveText("Note 6");
    await expect(dialog.locator("[data-repository-note-item]")).toHaveCount(5);
    const pagination = dialog.locator("[data-repository-note-pagination]");
    await expect(pagination.getByRole("link", { name: "1", exact: true }))
      .toHaveAttribute("aria-current", "page");
    await expect(pagination.getByRole("link", { name: "2", exact: true })).toBeVisible();

    await pagination.getByRole("link", { name: "2", exact: true }).click();
    await expect(pagination.getByRole("link", { name: "2", exact: true }))
      .toHaveAttribute("aria-current", "page");
    await expect(dialog.locator("[data-repository-note-item]")).toHaveCount(1);
    let noteOne = dialog.locator("[data-repository-note-item]").filter({ hasText: "Note 1" });
    await noteOne.getByRole("button", { name: "수정", exact: true }).click();
    const edit = noteOne.getByRole("textbox", { name: "Note 수정", exact: true });
    await expect(edit).toBeFocused();
    await edit.fill("Note 1 수정");
    await noteOne.getByRole("button", { name: "저장", exact: true }).click();

    noteOne = dialog.locator("[data-repository-note-item]").filter({ hasText: "Note 1 수정" });
    await expect(noteOne.locator(".repository-note-meta")).toContainText("작성");
    await expect(noteOne.locator(".repository-note-meta")).toContainText("수정");
    await expect(pagination.getByRole("link", { name: "2", exact: true }))
      .toHaveAttribute("aria-current", "page");

    let deleteButton = noteOne.getByRole("button", { name: "삭제", exact: true });
    await deleteButton.click();
    const confirmation = page.locator("[data-repository-note-delete-dialog]");
    await expect(confirmation).toBeVisible();
    await expect(confirmation.locator("[data-repository-note-delete-date]"))
      .toHaveText(/^\d{4}\.\d{2}\.\d{2}$/);
    await expect(confirmation.locator("[data-repository-note-delete-excerpt]"))
      .toHaveText("Note 1 수정");
    await confirmation.getByRole("button", { name: "취소", exact: true }).click();
    await expect(confirmation).toBeHidden();
    await expect(deleteButton).toBeFocused();

    await deleteButton.click();
    await confirmation.getByRole("button", { name: "Note 삭제", exact: true }).click();
    await expect(confirmation).toBeHidden();
    await expect(dialog.locator("[data-repository-note-item]")).toHaveCount(5);
    await expect(pagination.getByRole("link", { name: "1", exact: true }))
      .toHaveAttribute("aria-current", "page");
    await expect(dialog.locator("[data-repository-note-list-heading]")).toBeFocused();

    const newest = dialog.locator("[data-repository-note-item]").filter({ hasText: "Note 6" });
    await newest.getByRole("button", { name: "삭제", exact: true }).click();
    await confirmation.getByRole("button", { name: "Note 삭제", exact: true }).click();
    await expect(opener).toHaveText("Note 4");
    await expect(card.locator("[data-repository-memo]")).toHaveText("Note 5");

    await dialog.getByRole("button", { name: "닫기", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
  });

  test("failed create preserves the draft and re-enables retry", async ({ page }) => {
    test.skip(["mobile-chrome", "mobile-safari", "chromium-no-js"].includes(test.info().project.name));
    await loginAndSeed(page);
    await page.locator("[data-repository-link]").first().click();
    const dialog = page.locator("[data-repository-dialog]");
    const draft = dialog.getByRole("textbox", { name: "새 Note", exact: true });
    const save = dialog.getByRole("button", { name: "저장", exact: true });
    await draft.fill("재시도할 Note");
    await page.route("**/repositories/*/notes", (route) => route.request().method() === "POST"
      ? route.fulfill({
        status: 503, contentType: "application/json",
        body: JSON.stringify({ errorCode: "storage_unavailable" }),
      }) : route.continue());

    await save.click();
    await expect(dialog.getByRole("status")).toHaveText("저장 공간을 사용할 수 없습니다. 다시 시도하세요.");
    await expect(draft).toHaveValue("재시도할 Note");
    await expect(save).toBeEnabled();
    await page.unroute("**/repositories/*/notes");
    await save.click();
    await expect(dialog.locator(".repository-note-body").first()).toHaveText("재시도할 Note");
  });

  test("failed update preserves the edit and re-enables retry", async ({ page }) => {
    test.skip(["mobile-chrome", "mobile-safari", "chromium-no-js"].includes(test.info().project.name));
    await loginAndSeed(page);
    await page.locator("[data-repository-link]").first().click();
    const dialog = page.locator("[data-repository-dialog]");
    await dialog.getByRole("textbox", { name: "새 Note", exact: true }).fill("수정 전 Note");
    await dialog.getByRole("button", { name: "저장", exact: true }).click();
    const item = dialog.locator("[data-repository-note-item]").first();
    await item.getByRole("button", { name: "수정", exact: true }).click();
    const edit = item.getByRole("textbox", { name: "Note 수정", exact: true });
    const save = item.getByRole("button", { name: "저장", exact: true });
    await edit.fill("재시도한 수정 Note");
    await page.route("**/repositories/*/notes/*", (route) => route.request().method() === "POST"
      ? route.fulfill({
        status: 503, contentType: "application/json",
        body: JSON.stringify({ errorCode: "storage_unavailable" }),
      }) : route.continue());

    await save.click();
    await expect(dialog.getByRole("status"))
      .toHaveText("저장 공간을 사용할 수 없습니다. 다시 시도하세요.");
    await expect(edit).toHaveValue("재시도한 수정 Note");
    await expect(save).toBeEnabled();
    await page.unroute("**/repositories/*/notes/*");
    await save.click();
    await expect(item.locator(".repository-note-body")).toHaveText("재시도한 수정 Note");
  });

  test("inline editing disables Delete until cancel or successful replacement", async ({ page }) => {
    test.skip(["mobile-chrome", "mobile-safari", "chromium-no-js"].includes(test.info().project.name));
    await loginAndSeed(page);
    await page.locator("[data-repository-link]").first().click();
    const dialog = page.locator("[data-repository-dialog]");
    await dialog.getByRole("textbox", { name: "새 Note", exact: true }).fill("편집 상태 Note");
    await dialog.getByRole("button", { name: "저장", exact: true }).click();
    let item = dialog.locator("[data-repository-note-item]").first();
    const edit = item.getByRole("button", { name: "수정", exact: true });
    const remove = item.getByRole("button", { name: "삭제", exact: true });

    await edit.click();
    await expect(remove).toBeDisabled();
    await item.getByRole("button", { name: "취소", exact: true }).click();
    await expect(remove).toBeEnabled();

    await edit.click();
    await item.getByRole("textbox", { name: "Note 수정", exact: true }).fill("편집 완료 Note");
    await item.getByRole("button", { name: "저장", exact: true }).click();
    item = dialog.locator("[data-repository-note-item]").filter({ hasText: "편집 완료 Note" });
    await expect(item.getByRole("button", { name: "삭제", exact: true })).toBeEnabled();
  });

  test("failed delete announces inside confirmation and re-enables retry", async ({ page }) => {
    test.skip(["mobile-chrome", "mobile-safari", "chromium-no-js"].includes(test.info().project.name));
    await loginAndSeed(page);
    await page.locator("[data-repository-link]").first().click();
    const dialog = page.locator("[data-repository-dialog]");
    await dialog.getByRole("textbox", { name: "새 Note", exact: true }).fill("삭제 재시도 Note");
    await dialog.getByRole("button", { name: "저장", exact: true }).click();
    const item = dialog.locator("[data-repository-note-item]").first();
    await item.getByRole("button", { name: "삭제", exact: true }).click();
    const confirmation = page.locator("[data-repository-note-delete-dialog]");
    const confirm = confirmation.getByRole("button", { name: "Note 삭제", exact: true });
    await page.route("**/repositories/*/notes/*/delete", (route) => route.fulfill({
      status: 503, contentType: "application/json",
      body: JSON.stringify({ errorCode: "storage_unavailable" }),
    }));

    await confirm.click();
    await expect(confirmation).toBeVisible();
    await expect(confirmation.getByRole("status"))
      .toHaveText("저장 공간을 사용할 수 없습니다. 다시 시도하세요.");
    await expect(dialog.getByRole("status")).toHaveText("");
    await expect(confirm).toBeEnabled();
    await page.unroute("**/repositories/*/notes/*/delete");
    await confirm.click();
    await expect(confirmation).toBeHidden();
    await expect(dialog.locator("[data-repository-note-item]")).toHaveCount(0);
  });
});

test("mobile Note action uses the native page and confirms deletion before POST", async ({ page }) => {
  test.skip(!["mobile-chrome", "mobile-safari"].includes(test.info().project.name));
  await loginAndSeed(page);

  await page.locator("[data-repository-link]").first().click();

  await expect(page).toHaveURL(/\/repositories\/[0-9a-f-]+\/notes$/);
  await expect(page.getByRole("heading", { name: "OpenAI/example Note" })).toBeVisible();
  await expect(page.locator("[data-repository-dialog]:visible")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  const body = `모바일 삭제 확인 ${"가".repeat(90)}`;
  const create = page.locator("[data-repository-note-create-form]");
  await create.getByRole("textbox", { name: "새 Note", exact: true }).fill(body);
  await create.getByRole("button", { name: "저장", exact: true }).click();
  const item = page.locator("[data-repository-note-item]").first();
  const disclosure = item.locator("[data-repository-note-native-delete]");
  const trigger = disclosure.locator("summary");
  expect((await trigger.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  const beforeConfirmation = page.url();
  await trigger.click();

  await expect(page).toHaveURL(beforeConfirmation);
  await expect(item.locator(".repository-note-body").first()).toHaveText(body);
  const confirmation = disclosure.locator("[data-repository-note-native-confirmation]");
  await expect(confirmation).toContainText("OpenAI/example Note");
  await expect(confirmation.locator("time")).toHaveText(/^\d{4}\.\d{2}\.\d{2}$/);
  const excerpt = confirmation.locator("[data-repository-note-native-delete-excerpt]");
  await expect(excerpt).toHaveText(body.slice(0, 80));
  expect((await excerpt.textContent())?.length).toBeLessThanOrEqual(80);

  await confirmation.getByRole("button", { name: "Note 영구 삭제", exact: true }).click();
  await expect(page).toHaveURL(/\/notes\?flash=repository_note_deleted$/);
  const empty = page.locator('[data-repository-note-list][data-empty="true"]');
  await expect(empty).toBeVisible();
  await expect(empty).toHaveCSS("background-color", "rgb(241, 240, 237)");
});

test("activity button refreshes only pushed activity in place", async ({ page, harness }) => {
  test.skip(test.info().project.name === "chromium-no-js");
  await loginAndSeed(page);
  const env = await harness.worker.getEnv();
  await env.PROD_DB.prepare(
    "UPDATE repositories SET github_pushed_at = NULL, activity_refreshed_at = NULL",
  ).run();
  await page.reload();
  const card = page.locator("repo-panel article").first();
  const button = card.getByRole("button", { name: "OpenAI/example 활동 새로고침" });
  const activity = card.locator("[data-repository-activity-value]");
  await expect(activity).toHaveText("활동 동기화 필요");
  await expect(button).toHaveText("");
  const icon = button.locator("svg");
  await expect(icon).toHaveAttribute("viewBox", "0 0 24 24");
  await expect(icon).toHaveAttribute("aria-hidden", "true");
  await expect(icon.locator("path")).toHaveCount(4);
  const buttonBox = await button.boundingBox();
  const iconBox = await icon.boundingBox();
  expect(buttonBox).not.toBeNull();
  expect(iconBox).not.toBeNull();
  expect(buttonBox?.width).toBe(28);
  expect(buttonBox?.height).toBe(28);
  expect(iconBox?.width).toBe(18);
  expect(iconBox?.height).toBe(18);
  await expect(button).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(button).toHaveCSS("border-top-width", "0px");
  await expect(button).toHaveCSS("color", "rgb(37, 37, 34)");
  await button.hover();
  await expect(button).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(button).toHaveCSS("color", "rgb(159, 47, 45)");

  const refreshed = page.waitForResponse((response) =>
    /\/repositories\/[0-9a-f-]+\/activity$/.test(new URL(response.url()).pathname));
  await button.click();

  expect((await refreshed).status()).toBe(200);
  await expect(activity.locator("time")).toHaveAttribute("datetime", "2026-08-08T00:00:00Z");
  await expect(activity.locator("time")).toHaveCSS("font-size", "12px");
  await expect(activity.locator("time")).toHaveCSS("font-weight", "400");
  await expect(activity).toContainText("활동");
  await expect(card.locator('[data-repository-field="stars"] dd')).toHaveText("10");
  expect(harness.providerCalls()).toEqual([
    "provider_fixture:github_metadata",
    "provider_fixture:github_readme",
    "provider_fixture:openai_response",
    "provider_fixture:github_metadata",
  ]);
});

test("failed activity enhancement preserves the last accurate value", async ({ page }) => {
  test.skip(test.info().project.name === "chromium-no-js");
  await loginAndSeed(page);
  const card = page.locator("repo-panel article").first();
  const value = card.locator("[data-repository-activity-value]");
  const previous = await value.textContent();
  await page.route("**/repositories/*/activity", (route) => route.fulfill({
    status: 503, contentType: "application/json", body: JSON.stringify({ errorCode: "github_unavailable" }),
  }));

  await card.getByRole("button", { name: "OpenAI/example 활동 새로고침" }).click();

  await expect(value).toHaveText(previous ?? "");
  await expect(card.locator("[data-repository-activity-status]"))
    .toHaveText("활동을 새로고치지 못했습니다.");
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
  const href = await page.getByRole("link", { name: "자세히 보기", exact: true })
    .first().getAttribute("href");
  if (!href) throw new Error("detail_href_missing");
  await page.goto(href);
  await page.getByLabel("주 분류", { exact: true }).selectOption("Backend");
  await page.getByLabel("태그 (쉼표로 구분)").fill("example, node-js");
  await page.getByRole("button", { name: "변경 저장" }).click();
  await expect(page.getByRole("status")).toHaveText("분류를 저장했습니다.");
  await page.getByLabel(/AI 요약, 주 분류와 태그가 새 분석 결과로 교체됨/).check();
  await page.getByRole("button", { name: "GitHub 정보와 분석 새로고침" }).click();
  await expect(page.getByRole("status")).toHaveText("GitHub 정보와 분석을 새로고쳤습니다.");
  await page.getByLabel(/이 저장소와 모든 Note를 영구 삭제함/).check();
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
