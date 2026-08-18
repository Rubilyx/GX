import AxeBuilder from "@axe-core/playwright";
import { expect, loginAndSeed, test } from "./fixtures.js";

test.beforeEach(async ({ page }) => {
  test.skip(test.info().project.name === "chromium-no-js");
  await loginAndSeed(page);
});

/** @param {import("@playwright/test").Page} page */
async function expectNoBlockingAxe(page) {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.filter(({ impact }) => impact === "serious" || impact === "critical")).toEqual([]);
}

test("index and detail have no serious or critical axe violations", async ({ page }) => {
  await expectNoBlockingAxe(page);
  await page.locator("[data-repository-link]").first().click();
  if (["mobile-chrome", "mobile-safari"].includes(test.info().project.name)) {
    await expect(page).toHaveURL(/\/repositories\/[0-9a-f-]+/);
  } else {
    await expect(page.getByRole("dialog")).toBeVisible();
  }
  await expectNoBlockingAxe(page);
  await page.goto("/");
  await page.getByRole("link", { name: "OpenAI/example 삭제", exact: true }).click();
  await expect(page.locator("[data-repository-delete-dialog]")).toBeVisible();
  await expectNoBlockingAxe(page);
  await page.keyboard.press("Escape");
});

test("keyboard focus is visible and native dialog stays focused then returns it", async ({ page }) => {
  test.skip(!["chromium", "firefox", "chrome", "edge"].includes(test.info().project.name));
  await page.keyboard.press("Tab");
  const focused = page.locator(":focus");
  await expect(focused).toHaveCSS("outline-style", "solid");
  const opener = page.locator("[data-repository-link]").first();
  const focusableCount = await page.locator("a[href], button, input, select, textarea").count();
  for (let count = 0; count < focusableCount * 2 && !await opener.evaluate((element) => document.activeElement === element); count += 1)
    await page.keyboard.press("Tab");
  await expect(opener).toBeFocused();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  for (let count = 0; count < 6; count += 1) await page.keyboard.press("Tab");
  expect(await page.evaluate(() => {
    const active = document.activeElement;
    return active instanceof Element && Boolean(active.closest("[data-repository-dialog]"));
  })).toBe(true);
  await page.keyboard.press("Escape");
  await expect(opener).toBeFocused();
});

test("WebKit keeps dialog focus trapped and returns it after a pointer open", async ({ page }) => {
  test.skip(test.info().project.name !== "webkit");
  const opener = page.locator("[data-repository-link]").first();
  await opener.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  for (let count = 0; count < 6; count += 1) await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.activeElement instanceof Element &&
    Boolean(document.activeElement.closest("[data-repository-dialog]")))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(opener).toBeFocused();
});

test("capture announces only changed live status text and status has non-color text", async ({ page }) => {
  await page.goto("/");
  const status = page.locator("[data-capture-status]");
  await expect(status).toHaveText("");
  let release = () => {};
  const complete = new Promise((resolve) => { release = () => resolve(undefined); });
  await page.route("**/repositories", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await complete;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      repositoryId: "dddddddd-dddd-dddd-dddd-dddddddddddd", analysisStatus: "ready", errorCode: null,
    }) });
  });
  await page.getByLabel("GitHub 저장소 URL").fill("https://github.com/OpenAI/example");
  try {
    await page.getByRole("button", { name: "저장" }).click();
    await expect(status).toHaveText("저장 중입니다.");
    await expect(page.getByRole("button", { name: "저장" })).toBeDisabled();
    await expect(page.locator("[data-analysis-status='ready']")).toHaveText("분석 완료");
  } finally {
    release();
  }
});

test("reduced motion leaves no nontrivial animation or transition", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const durations = await page.locator("*").evaluateAll((elements) => elements.map((element) => {
    const style = getComputedStyle(element);
    return [style.animationDuration, style.transitionDuration];
  }));
  for (const [animation, transition] of durations) {
    expect(Number.parseFloat(animation)).toBeLessThanOrEqual(0.01);
    expect(Number.parseFloat(transition)).toBeLessThanOrEqual(0.01);
  }
});
