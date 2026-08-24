import AxeBuilder from "@axe-core/playwright";
import { expect, loginAndSeed, test } from "./fixtures.js";
import { seedThreadsArchive } from "../support/harness.js";

test.beforeEach(async ({ page }) => {
  test.skip(test.info().project.name === "chromium-no-js");
  await loginAndSeed(page);
});

/** @param {import("@playwright/test").Page} page */
async function expectNoBlockingAxe(page) {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.filter(({ impact }) => impact === "serious" || impact === "critical")).toEqual([]);
}

/** @param {import("@playwright/test").Page} page @param {import("@playwright/test").Locator} target */
async function tabTo(page, target) {
  const focusableCount = await page.locator("a[href], button, input, select, textarea").count();
  for (let count = 0; count < focusableCount * 2 && !await target.evaluate(
    (element) => document.activeElement === element,
  ); count += 1) await page.keyboard.press("Tab");
  await expect(target).toBeFocused();
}

test("index, Note manager, Note confirmation, and repository confirmation pass axe", async ({ page }) => {
  await expectNoBlockingAxe(page);
  await page.locator("[data-repository-link]").first().click();
  if (["mobile-chrome", "mobile-safari"].includes(test.info().project.name)) {
    await expect(page).toHaveURL(/\/repositories\/[0-9a-f-]+\/notes$/);
    await expectNoBlockingAxe(page);
    const create = page.locator("[data-repository-note-create-form]");
    await create.getByRole("textbox", { name: "새 Note", exact: true }).fill("native 삭제 확인용 Note");
    await create.getByRole("button", { name: "저장", exact: true }).click();
    const nativeDelete = page.locator("[data-repository-note-native-delete]").first();
    const summary = nativeDelete.locator("summary");
    await summary.focus();
    await expect(summary).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(nativeDelete.locator("[data-repository-note-native-confirmation]")).toBeVisible();
    await expectNoBlockingAxe(page);
  } else {
    const manager = page.locator("[data-repository-dialog]");
    await expect(manager).toBeVisible();
    await expectNoBlockingAxe(page);
    await manager.getByRole("textbox", { name: "새 Note", exact: true }).fill("삭제 확인용 Note");
    await manager.getByRole("button", { name: "저장", exact: true }).click();
    await manager.getByRole("button", { name: "삭제", exact: true }).click();
    const confirmation = page.locator("[data-repository-note-delete-dialog]");
    await expect(confirmation).toBeVisible();
    await expectNoBlockingAxe(page);
    await confirmation.getByRole("button", { name: "취소", exact: true }).click();
  }
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

test("keyboard-only Note create, edit, and cancel keeps content and focus", async ({ page }) => {
  test.skip(!["chromium", "firefox", "chrome", "edge"].includes(test.info().project.name));
  const opener = page.locator("[data-repository-link]").first();
  await page.keyboard.press("Tab");
  await tabTo(page, opener);
  await page.keyboard.press("Enter");
  const dialog = page.locator("[data-repository-dialog]");
  const draft = dialog.getByRole("textbox", { name: "새 Note", exact: true });
  await expect(draft).toBeFocused();
  await page.keyboard.type("키보드 Note");
  await page.keyboard.press("Tab");
  const create = dialog.getByRole("button", { name: "저장", exact: true });
  await expect(create).toBeFocused();
  await page.keyboard.press("Enter");
  const item = dialog.locator("[data-repository-note-item]").filter({ hasText: "키보드 Note" });
  await expect(item.locator(".repository-note-body")).toHaveText("키보드 Note");

  const edit = item.getByRole("button", { name: "수정", exact: true });
  await tabTo(page, edit);
  await page.keyboard.press("Enter");
  const textarea = item.getByRole("textbox", { name: "Note 수정", exact: true });
  await expect(textarea).toBeFocused();
  await page.keyboard.press("Control+A");
  await page.keyboard.type("취소할 수정");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  const cancel = item.getByRole("button", { name: "취소", exact: true });
  await expect(cancel).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(item.locator(".repository-note-body")).toHaveText("키보드 Note");
  await expect(edit).toBeFocused();
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

test("capture announces only changed live status text and ready cards retain summary text", async ({ page }) => {
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
    await expect(page.locator('[data-analysis-summary-status="ready"]'))
      .toHaveText("예제 저장소의 핵심 사용법을 보여준다.");
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

test("Threads empty, reconnect, collecting, ready, partial, detail, and delete dialog pass axe", async ({
  page, harness,
}) => {
  await page.goto("/threads");
  await expect(page.locator("[data-thread-empty]")).toBeVisible();
  await expect(page.locator("[data-thread-connection]")).toContainText(
    /Threads를 (?:다시 )?연결/,
  );
  await expectNoBlockingAxe(page);

  const env = await harness.worker.getEnv();
  const states = [
    { id: "11111111-1111-4111-8111-111111111111", root: "21111111-1111-4111-8111-111111111111", shortcode: "CollectingA11y", status: "collecting", job: "collecting" },
    { id: "12222222-2222-4222-8222-222222222222", root: "22222222-2222-4222-8222-222222222222", shortcode: "ReadyA11y", status: "ready", job: "ready" },
    { id: "13333333-3333-4333-8333-333333333333", root: "23333333-3333-4333-8333-333333333333", shortcode: "PartialA11y", status: "partial", job: "partial" },
  ];
  for (const [index, state] of states.entries()) await seedThreadsArchive(env.PROD_DB, {
    id: state.id, rootEntryId: state.root, shortcode: state.shortcode,
    threadsMediaId: `a11y-root-${index}`, authorId: String(81000 + index),
    username: `a11y${index}`, displayName: `A11y ${index}`,
    submittedUrl: `https://www.threads.com/@a11y${index}/post/${state.shortcode}`,
    canonicalUrl: `https://www.threads.com/@a11y${index}/post/${state.shortcode}`,
    rootPermalink: `https://www.threads.com/@a11y${index}/post/${state.shortcode}`,
    status: state.status, jobStatus: state.job,
  });
  await page.goto("/threads");
  for (const state of ["collecting", "ready", "partial"])
    await expect(page.locator(`[data-thread-status="${state}"]`)).toHaveCount(1);
  await expectNoBlockingAxe(page);

  await page.goto(`/threads/${states[1].id}`);
  await expectNoBlockingAxe(page);
  const opener = page.locator("[data-thread-delete] > summary");
  await opener.click();
  await expect(page.locator("[data-thread-delete-dialog]")).toBeVisible();
  await expectNoBlockingAxe(page);
  await page.keyboard.press("Escape");
  await expect(opener).toBeFocused();
});
