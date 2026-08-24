import { expect, test } from "./fixtures.js";
import { seedThreadsArchive } from "../support/harness.js";

const POST_ID = "11111111-1111-1111-1111-111111111111";
const ROOT_ID = "22222222-2222-2222-2222-222222222222";
const MEDIA_ID = "33333333-3333-3333-3333-333333333333";

/** @param {import("@playwright/test").Page} page */
async function login(page) {
  await page.goto("/login");
  await page.getByLabel("6자리 PIN").fill("123456");
  await page.getByRole("button", { name: "접속" }).click();
}

/** @param {any} harness
 * @param {{ status?: string, replies?: number, failedMedia?: boolean }} [options] */
async function seedArchive(harness, { status = "ready", replies = 12, failedMedia = false } = {}) {
  const env = await harness.worker.getEnv();
  await seedThreadsArchive(env.PROD_DB, {
    id: POST_ID, rootEntryId: ROOT_ID, status,
    rootText: "보관된 루트 본문", rootPublishedAt: "2026-08-24T00:00:00.000Z",
    updatedAt: 1_787_500_000,
  });
  for (let index = 1; index <= replies; index += 1) {
    const suffix = String(index).padStart(12, "0");
    await env.PROD_DB.prepare(
      `INSERT INTO threads_entries
         (id, threads_post_id, source_media_id, kind, parent_entry_id, author_id,
          text, permalink, published_at, media_type, first_seen_at, last_seen_at, created_at)
       VALUES (?, ?, ?, 'author_reply', NULL, 'author-1', ?, ?, ?, 'TEXT_POST', 1, 1, 1)`,
    ).bind(
      `44444444-4444-4444-4444-${suffix}`, POST_ID, `reply-${index}`,
      `작성자 답글 ${index}`, `https://www.threads.com/@meta/post/Reply${index}`,
      `2026-08-24T00:${String(index).padStart(2, "0")}:00.000Z`,
    ).run();
  }
  if (failedMedia) {
    await env.PROD_DB.prepare(
      `INSERT INTO threads_media
         (id, entry_id, source_media_id, kind, ordinal, status, error_code,
          created_at, updated_at, attempt_count)
       VALUES (?, ?, 'root-1', 'image', 0, 'error', 'threads_media_unavailable', 1, 1, 1)`,
    ).bind(MEDIA_ID, ROOT_ID).run();
    await env.PROD_DB.prepare(
      `UPDATE threads_sync_jobs SET expected_media_count = 1, failed_media_count = 1
       WHERE threads_post_id = ?`,
    ).bind(POST_ID).run();
  }
}

function author() {
  return {
    id: "author-1", username: "meta", displayName: "Meta",
    profileMedia: {
      status: "pending", contentType: null, etag: null, bytes: null, errorCode: null,
    },
  };
}

/** @param {number} index @param {string} [kind] */
function entry(index, kind = "author_reply") {
  return {
    id: index === 0 ? ROOT_ID : `44444444-4444-4444-4444-${String(index).padStart(12, "0")}`,
    sourceMediaId: index === 0 ? "root-1" : `reply-${index}`,
    kind, parentEntryId: null, author: author(),
    text: index === 0 ? "보관된 루트 본문" : `작성자 답글 ${index}`,
    permalink: `https://www.threads.com/@meta/post/${index === 0 ? "RootShort" : `Reply${index}`}`,
    publishedAt: index === 0 ? "2026-08-24T00:00:00.000Z"
      : `2026-08-24T00:${String(index).padStart(2, "0")}:00.000Z`,
    mediaType: "TEXT_POST", altText: null, nestedQuotePermalink: null,
    links: [], media: [], quote: null,
  };
}

/** @param {string} id @param {string} status @param {number} [replyTotal] */
function detail(id, status, replyTotal = 12) {
  const replies = Array.from({ length: replyTotal }, (_, index) => entry(index + 1));
  return {
    archive: {
      id, canonicalUrl: "https://www.threads.com/@meta/post/RootShort", status,
      errorCode: null, author: author(), root: entry(0, "root"), quote: null,
      firstReplies: replies.slice(0, 3), replyCount: replyTotal,
      mediaProgress: { expected: 0, ready: 0, failed: 0, pending: 0 },
      syncGeneration: 1, createdAt: 1, updatedAt: 2,
    },
    replies, repliesPage: 1, totalReplyPages: 1, totalReplies: replyTotal,
    actions: {
      detail: `/threads/${id}`, sync: `/threads/${id}/sync`, delete: `/threads/${id}/delete`,
    },
  };
}

test("capture renders pending state, progresses through polling, and stops at ready", async ({ page }) => {
  await login(page);
  let polls = 0;
  await page.route(/\/threads\/[0-9a-f-]{36}$/, async (route, request) => {
    if (!request.headers().accept?.includes("application/json")) return route.fallback();
    polls += 1;
    const id = new URL(request.url()).pathname.split("/").pop();
    if (!id) throw new Error("missing_post_id");
    const body = detail(id, polls === 1 ? "collecting" : "ready", 0);
    body.archive.mediaProgress = polls === 1
      ? { expected: 2, ready: 1, failed: 0, pending: 1 }
      : { expected: 2, ready: 2, failed: 0, pending: 0 };
    await route.fulfill({ status: 200, contentType: "application/json", headers: { ETag: `"poll-${polls}"` }, body: JSON.stringify(body) });
  });
  await page.goto("/threads");
  await page.getByLabel("Threads 게시물 URL").fill("https://www.threads.com/@meta/post/RootShort");
  await page.getByRole("button", { name: "보관하기" }).click();
  await expect(page).toHaveURL(/\/threads\/[0-9a-f-]{36}$/);
  const card = page.locator("[data-thread-archive]");
  await expect(card).toHaveAttribute("data-thread-status", "pending");
  await expect(card).toHaveAttribute("data-thread-status", "ready", { timeout: 8_000 });
  await expect(card.locator("[data-thread-progress]")).toHaveText("미디어 2/2 준비");
  const stoppedAt = polls;
  await page.waitForTimeout(1_500);
  expect(polls).toBe(stoppedAt);
});

test("plain reply expansion loads twelve in-card replies while modified click stays native", async ({ page, context, harness }) => {
  await seedArchive(harness);
  await login(page);
  await page.goto("/threads");
  const link = page.locator("[data-thread-all-replies]");
  await expect(link).toHaveText("작성자 답글 12개 모두 보기");
  const popupPromise = context.waitForEvent("page");
  await link.click({ modifiers: ["Control"] });
  const popup = await popupPromise;
  await popup.waitForLoadState();
  await expect(popup).toHaveURL(new RegExp(`/threads/${POST_ID}#author-replies$`));
  await popup.close();

  await link.click();
  const card = page.locator("[data-thread-archive]");
  await expect(card.locator("[data-thread-author-reply]")).toHaveCount(12);
  await expect(link).toHaveText("작성자 답글 12개 접기");
  await expect(card.locator("[data-thread-author-reply]").last()).toContainText("작성자 답글 12");
});

test("retry preserves content, sync adds reply thirteen, and shared delete restores focus", async ({ page, harness }) => {
  await seedArchive(harness, { status: "partial", failedMedia: true });
  await login(page);
  await page.goto("/threads");
  const card = page.locator("[data-thread-archive]");
  const rootText = card.locator(":scope > [data-thread-root] > [data-thread-text]");
  await expect(rootText).toHaveText("보관된 루트 본문");
  await card.getByRole("button", { name: "미디어 재시도" }).click();
  await expect(rootText).toHaveText("보관된 루트 본문");

  await card.getByRole("link", { name: "작성자 답글 12개 모두 보기" }).click();
  let detailPolls = 0;
  await page.route(new RegExp(`/threads/${POST_ID}(?:\\?.*)?$`), async (route, request) => {
    if (request.method() !== "GET" || !request.headers().accept?.includes("application/json"))
      return route.fallback();
    detailPolls += 1;
    await route.fulfill({ status: 200, contentType: "application/json", headers: { ETag: '"sync-ready"' }, body: JSON.stringify(detail(POST_ID, "ready", 13)) });
  });
  await page.route(`**/threads/${POST_ID}/sync`, (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ threadsPostId: POST_ID, generation: 2, status: "pending", duplicate: false }),
  }));
  await card.getByRole("button", { name: "동기화" }).click();
  await expect(card).toHaveAttribute("data-thread-status", "ready", { timeout: 6_000 });
  expect(detailPolls).toBe(2);
  await expect(card.locator("[data-thread-author-reply]")).toHaveCount(13, { timeout: 6_000 });

  const opener = card.locator("[data-thread-delete] > summary");
  const dialog = page.locator("[data-thread-delete-dialog]");
  await opener.click();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("[data-thread-delete-author]")).toHaveText("Meta @meta");
  await dialog.getByRole("button", { name: "취소" }).click();
  await expect(opener).toBeFocused();
  await opener.click();
  await page.keyboard.press("Escape");
  await expect(opener).toBeFocused();
  await opener.click();
  await dialog.getByRole("button", { name: "보관 삭제", exact: true }).click();
  await expect(card).toHaveCount(0);
  await expect(page.locator("[data-thread-empty-heading]")).toBeFocused();
});

test("session expiry is fixed copy and mobile and no-JavaScript paths remain usable", async ({ page, browser, baseURL }) => {
  await login(page);
  let expiredPolls = 0;
  await page.route(/\/threads\/[0-9a-f-]{36}$/, async (route, request) => {
    if (!request.headers().accept?.includes("application/json")) return route.fallback();
    expiredPolls += 1;
    await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ errorCode: "session_expired" }) });
  });
  await page.goto("/threads");
  await page.getByLabel("Threads 게시물 URL").fill("https://www.threads.com/@meta/post/RootShort");
  await page.getByRole("button", { name: "보관하기" }).click();
  await expect(page.getByRole("status").last()).toHaveText("세션이 만료되었습니다. 다시 로그인하세요.", { timeout: 5_000 });
  const stoppedAt = expiredPolls;
  await page.waitForTimeout(1_500);
  expect(expiredPolls).toBe(stoppedAt);
  await page.setViewportSize({ width: 360, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  const native = await browser.newContext({
    baseURL, javaScriptEnabled: false, ignoreHTTPSErrors: true,
    extraHTTPHeaders: { "CF-Connecting-IP": "192.0.2.101" },
  });
  const nativePage = await native.newPage();
  await login(nativePage);
  await nativePage.goto("/threads");
  await nativePage.getByLabel("Threads 게시물 URL").fill("https://www.threads.com/@meta/post/NativePost");
  await nativePage.getByRole("button", { name: "보관하기" }).click();
  await expect(nativePage).toHaveURL(/\/threads\/[0-9a-f-]{36}\?flash=threads_capture_queued$/);
  await expect(nativePage.locator("[data-thread-archive]")).toBeVisible();
  await native.close();
});
