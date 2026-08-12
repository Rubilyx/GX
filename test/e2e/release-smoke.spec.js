import { expect, test } from "@playwright/test";

test.use({ javaScriptEnabled: false, trace: "off", screenshot: "off", video: "off", extraHTTPHeaders: {}, ignoreHTTPSErrors: false });

function releaseConfig() {
  const {
    RELEASE_BASE_URL: rawBase,
    RELEASE_ID: releaseId,
    RELEASE_PIN: pin,
    RELEASE_MODE: mode,
    RELEASE_REQUIRE_DETAIL: rawRequireDetail,
  } = process.env;
  const values = [rawBase, releaseId, pin, mode, rawRequireDetail];
  if (values.every((value) => value === undefined)) return null;
  if (!rawBase || !releaseId || !pin || !mode || !rawRequireDetail)
    throw new Error("release_config_partial");
  if (mode !== "read-only" && mode !== "provider") throw new Error("release_mode_invalid");
  if (rawRequireDetail !== "true" && rawRequireDetail !== "false")
    throw new Error("release_require_detail_invalid");
  let base;
  try { base = new URL(rawBase); }
  catch { throw new Error("release_base_url_invalid"); }
  if (base.protocol !== "https:" || base.username || base.password ||
    (base.pathname !== "/" || base.search || base.hash)) throw new Error("release_base_url_unsafe");
  return { base, releaseId, pin, mode, requireDetail: rawRequireDetail === "true" };
}

const repositoryPath = /^\/repositories\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

test("release smoke", async ({ page }) => {
  const release = releaseConfig();
  test.skip(!release);
  if (!release) return;
  const health = await page.request.get(new URL("/health", release.base).href);
  expect(health.status()).toBe(200);
  expect(await health.json()).toEqual({ status: "ok", releaseId: release.releaseId });
  await page.goto(new URL("/login", release.base).href);
  await page.getByLabel("6자리 PIN").fill(release.pin);
  await page.getByRole("button", { name: "접속" }).click();
  await expect(page).toHaveURL(release.base.href);
  await expect(page.getByRole("heading", { name: "Repo Atlas", exact: true })).toBeVisible();

  if (release.mode === "read-only") {
    const details = page.locator("[data-repository-link]");
    const count = await details.count();
    if (release.requireDetail) expect(count).toBeGreaterThan(0);
    if (count) {
      const href = await details.first().getAttribute("href");
      if (!href || !repositoryPath.test(href)) throw new Error("release_detail_href_missing");
      await page.goto(new URL(href, release.base).href);
      await expect(page.locator("main h1")).toBeVisible();
    }
    return;
  }

  let createdId = "";
  try {
    await page.getByLabel("GitHub 저장소 URL").fill("https://github.com/github/docs");
    await page.getByRole("button", { name: "저장" }).click();
    const current = new URL(page.url());
    const match = current.origin === release.base.origin ? repositoryPath.exec(current.pathname) : null;
    if (match) createdId = match[1];
    if (!createdId || current.searchParams.get("flash") !== "repository_created")
      throw new Error("release_provider_not_created");
    await expect(page.getByText("분석 완료", { exact: true })).toBeVisible();
  } finally {
    if (!createdId) {
      const current = new URL(page.url());
      const match = current.origin === release.base.origin ? repositoryPath.exec(current.pathname) : null;
      if (match) createdId = match[1];
    }
    if (createdId) {
      const deletion = page.locator(`form[action="/repositories/${createdId}/delete"]`);
      await expect(deletion).toHaveCount(1);
      await deletion.getByLabel(/이 저장소와 개인 메모를 영구 삭제함/).check();
      await deletion.getByRole("button", { name: "저장소 삭제" }).click();
      await expect(page).toHaveURL(new URL("/?flash=repository_deleted", release.base).href);
    }
  }
});
