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

test("filter change submits one canonical query", async ({ page }) => {
  await loginAndSeed(page);
  await page.getByLabel("검색").fill("example");
  await page.getByLabel("주 분류").selectOption("Backend");
  await expect(page).toHaveURL(/\?q=example&category=Backend&page=1$/);
  await expect(page.locator("repo-filter")).toHaveAttribute("data-ready", "true");
  await page.getByLabel("태그").selectOption("example");
  await expect(page).toHaveURL(/\?q=example&category=Backend&tag=example&page=1$/);
  expect(new URL(page.url()).search).toBe("?q=example&category=Backend&tag=example&page=1");
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

test("desktop repository link opens the native detail dialog and restores focus", async ({ page }) => {
  test.skip(["mobile-chrome", "mobile-safari", "chromium-no-js"].includes(test.info().project.name));
  await loginAndSeed(page);
  const opener = page.locator("[data-repository-link]").first();
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
