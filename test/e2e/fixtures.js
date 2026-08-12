import { test as base, expect } from "@playwright/test";
import { startHarness } from "../support/harness.js";

/** @typedef {Awaited<ReturnType<typeof startHarness>>} Harness */
/** @typedef {import("@playwright/test").PlaywrightTestArgs & import("@playwright/test").PlaywrightTestOptions} BaseTest */
/** @typedef {import("@playwright/test").PlaywrightWorkerArgs & import("@playwright/test").PlaywrightWorkerOptions} BaseWorker */
/** @type {import("@playwright/test").Fixtures<{ resetStorage: undefined }, { harness: Harness }, BaseTest, BaseWorker>} */
const fixtures = {
  harness: [async ({}, use) => {
    const harness = await startHarness();
    await use(harness);
    await harness.close();
  }, { scope: "worker" }],
  baseURL: async ({ harness, resetStorage }, use) => {
    void resetStorage;
    await use(harness.url.href);
  },
  resetStorage: [async ({ harness }, use) => {
    await harness.reset();
    await use(undefined);
  }, { auto: true }],
};

export const test = base.extend(fixtures);

/** @param {import("@playwright/test").Page} page */
export async function loginAndSeed(page) {
  await page.goto("/login");
  await page.getByLabel("6자리 PIN").fill("123456");
  await page.getByRole("button", { name: "접속" }).click();
  await page.getByLabel("GitHub 저장소 URL").fill("https://github.com/OpenAI/example");
  await page.getByRole("button", { name: "저장" }).click();
  await expect(page).toHaveURL(/\/repositories\/[0-9a-f-]+/);
  await page.goto("/");
}

export { expect };
