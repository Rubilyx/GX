import { expect, test } from "./fixtures.js";
import { login as loginWorker, seedThreadsArchive } from "../support/harness.js";

const POST_ID = "11111111-1111-1111-1111-111111111111";
const ROOT_ID = "22222222-2222-2222-2222-222222222222";
const MEDIA_ID = "33333333-3333-3333-3333-333333333333";

/** @param {import("@playwright/test").Page} page */
async function login(page) {
  await page.goto("/login");
  await page.getByLabel("6자리 PIN").fill("123456");
  await page.getByRole("button", { name: "접속" }).click();
  await expect(page).toHaveURL(/\/$/);
}

/** @param {any} harness */
async function connectConfiguredThreads(harness) {
  const session = await loginWorker(harness.worker);
  const started = await harness.worker.fetch(`${session.origin}/threads/connect`, {
    headers: { Cookie: session.cookie },
  });
  const location = started.headers.get("location");
  const cookie = started.headers.get("set-cookie");
  if (!location || !cookie)
    throw new Error(`configured_oauth_setup_missing:${started.status}`);
  const state = new URL(location).searchParams.get("state");
  const callback = await harness.worker.fetch(
    `${session.origin}/threads/oauth/callback?code=code-1&state=${state}`,
    { headers: { Cookie: cookie } },
  );
  expect(callback.status).toBe(303);
}

/** @param {any} harness
 * @param {{ status?: string, replies?: number, failedMedia?: boolean,
 * quotedReply?: boolean }} [options] */
async function seedArchive(harness, {
  status = "ready", replies = 12, failedMedia = false, quotedReply = false,
} = {}) {
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
  if (quotedReply && replies >= 12) {
    const parentId = "44444444-4444-4444-4444-000000000012";
    const quoteId = "55555555-5555-4555-8555-555555555555";
    await env.PROD_DB.prepare(
      `INSERT INTO threads_entries
         (id, threads_post_id, source_media_id, kind, parent_entry_id, author_id,
          text, permalink, published_at, media_type, nested_quote_permalink,
          first_seen_at, last_seen_at, created_at)
       VALUES (?, ?, 'expanded-quote-source', 'quote', ?, 'author-1',
         '확장 답글 인용 본문', 'https://www.threads.com/@meta/post/ExpandedQuote',
         '2026-08-24T00:12:30.000Z', 'IMAGE',
         'https://www.threads.com/@nested/post/NestedExpanded', 1, 1, 1)`,
    ).bind(quoteId, POST_ID, parentId).run();
    await env.PROD_DB.prepare(
      `INSERT INTO threads_links (id, entry_id, url, source, ordinal)
       VALUES ('expanded-quote-link', ?, 'https://attachment.example/expanded',
         'attachment', 0)`,
    ).bind(quoteId).run();
    await env.PROD_DB.prepare(
      `INSERT INTO threads_media
         (id, entry_id, source_media_id, kind, ordinal, status, error_code,
          created_at, updated_at)
       VALUES ('expanded-quote-media', ?, 'expanded-quote-source', 'image', 0,
         'error', 'threads_media_unavailable', 1, 1)`,
    ).bind(quoteId).run();
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

/** @param {any} harness */
async function mediaAttempts(harness) {
  const env = await harness.worker.getEnv();
  const row = await env.PROD_DB.prepare(
    "SELECT attempt_count FROM threads_media WHERE id = ?",
  ).bind(MEDIA_ID).first();
  return row?.attempt_count ?? 0;
}

function author() {
  return {
    id: "author-1", username: "meta", displayName: "Meta",
    profileMedia: {
      status: "pending", contentType: null, etag: null, bytes: null, errorCode: null,
      available: false, url: null, retryUrl: null,
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

test("configured scheduled event refreshes the stored Threads credential", async ({ harness }) => {
  await connectConfiguredThreads(harness);
  const env = await harness.remoteWorker.getEnv();
  await env.PROD_DB.prepare(
    "UPDATE threads_oauth_credentials SET expires_at = ? WHERE singleton_id = 1",
  ).bind(1_900_500_000).run();

  await harness.remoteWorker.scheduled({
    cron: "0 3 * * *", scheduledTime: new Date(1_900_000_000_000),
  });

  await expect.poll(() => env.PROD_DB.prepare(
    "SELECT refreshed_at FROM threads_oauth_credentials WHERE singleton_id = 1",
  ).first("refreshed_at")).toBe(1_900_000_000);
});

test("archive waiter polls authenticated configured JSON until the requested status", async ({ harness }) => {
  const env = await harness.remoteWorker.getEnv();
  await seedThreadsArchive(env.PROD_DB, {
    id: POST_ID, rootEntryId: ROOT_ID, status: "ready", updatedAt: 1_787_500_000,
  });

  const result = await harness.waitForThreadsArchive(POST_ID, "ready", 1_000);

  expect(result.archive.id).toBe(POST_ID);
  expect(result.archive.status).toBe("ready");
});

test("archive waiter is bounded and dumps configured event diagnostics on timeout", async ({ harness }) => {
  let debugCalls = 0;
  const originalDebug = harness.server.debug;
  harness.server.debug = () => { debugCalls += 1; };
  const startedAt = Date.now();
  try {
    await expect(harness.waitForThreadsArchive(POST_ID, "partial", 50)).rejects
      .toThrow("test_threads_archive_timeout:partial");
  } finally {
    harness.server.debug = originalDebug;
  }
  expect(Date.now() - startedAt).toBeLessThan(1_000);
  expect(debugCalls).toBe(1);
});

test("configured fixture captures the canonical archive through real Queues and private R2", async ({
  page, harness,
}) => {
  await connectConfiguredThreads(harness);
  /** @type {string[]} */
  const browserProviderRequests = [];
  /** @type {Array<{ path: string, range: string }>} */
  const browserMediaRanges = [];
  page.on("request", (request) => {
    const requested = new URL(request.url());
    const host = requested.hostname;
    if (host === "graph.threads.net" || host.endsWith(".cdninstagram.com") ||
      host.endsWith(".fbcdn.net") || /(^|\.)threads\.(com|net)$/.test(host))
      browserProviderRequests.push(request.url());
    if (/^\/threads\/[0-9a-f-]{36}\/media\/[0-9a-f-]{36}$/.test(requested.pathname) &&
      request.headers().range) browserMediaRanges.push({
        path: requested.pathname, range: request.headers().range,
      });
  });
  await login(page);
  await page.goto("/threads");
  const acceptedResponse = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === "/threads");
  await page.getByLabel("Threads 게시물 URL").fill(
    "https://www.threads.com/@meta/post/RootShort",
  );
  await page.getByRole("button", { name: "보관하기" }).click();
  expect((await acceptedResponse).status()).toBe(200);
  await expect(page).toHaveURL(/\/threads\/[0-9a-f-]{36}$/);
  const postId = new URL(page.url()).pathname.split("/").pop();
  if (!postId) throw new Error("canonical_post_id_missing");
  await expect(page.locator("[data-thread-archive]")).toHaveAttribute(
    "data-thread-status", /^(pending|collecting)$/,
  );

  const ready = await harness.waitForThreadsArchive(postId, "ready");
  expect(ready.archive.mediaProgress).toEqual({
    expected: 6, ready: 6, failed: 0, pending: 0,
  });
  const env = await harness.remoteWorker.getEnv();
  const entries = await env.PROD_DB.prepare(
    `SELECT kind, source_media_id, text, nested_quote_permalink
     FROM threads_entries WHERE threads_post_id = ?
     ORDER BY kind, source_media_id`,
  ).bind(postId).all();
  expect(entries.results.filter((entry) => entry.kind === "root")).toHaveLength(1);
  expect(entries.results.filter((entry) => entry.kind === "author_reply")).toHaveLength(12);
  expect(entries.results.some((entry) => String(entry.source_media_id).startsWith("other-reply")))
    .toBe(false);
  expect(entries.results.filter((entry) => entry.kind === "quote")).toEqual([
    expect.objectContaining({
      source_media_id: "shared-quote",
      nested_quote_permalink: "https://www.threads.com/@meta/post/NestedQuote",
    }),
    expect.objectContaining({
      source_media_id: "shared-quote",
      nested_quote_permalink: "https://www.threads.com/@meta/post/NestedQuote",
    }),
  ]);
  expect(await env.PROD_DB.prepare(
    `SELECT url FROM threads_links link JOIN threads_entries entry ON entry.id = link.entry_id
     WHERE entry.threads_post_id = ? ORDER BY url`,
  ).bind(postId).all().then((result) => result.results.map((row) => row.url)))
    .toEqual(["https://example.com/archive"]);

  const media = await env.PROD_DB.prepare(
    `SELECT item.id, item.source_media_id, item.kind, item.etag FROM threads_media item
     JOIN threads_entries entry ON entry.id = item.entry_id
     WHERE entry.threads_post_id = ? ORDER BY item.kind, item.id`,
  ).bind(postId).all();
  expect(media.results).toHaveLength(5);
  expect(media.results.every((item) => item.etag)).toBe(true);
  const objects = await env.THREADS_MEDIA.list({ prefix: "threads/" });
  expect(objects.objects).toHaveLength(6);

  await page.goto(`/threads/${postId}`);
  await expect(page.locator("[data-thread-media] img")).toHaveCount(3);
  await expect(page.locator(
    "[data-thread-archive] > [data-thread-root] [data-thread-media] img",
  )).toHaveCount(1);
  await expect(page.locator("[data-thread-quote] [data-thread-media] img")).toHaveCount(2);
  const video = page.locator("[data-thread-media] video");
  await expect(video).toHaveCount(1);
  const videoId = media.results.find((item) => item.kind === "video")?.id;
  const imageId = media.results.find((item) => item.source_media_id === "root-image")?.id;
  if (!videoId) throw new Error("canonical_video_missing");
  if (!imageId) throw new Error("canonical_image_missing");
  const image = await page.request.get(`/threads/${postId}/media/${imageId}`);
  expect(image.status()).toBe(200);
  expect(await image.text()).toBe("fixture-image-bytes");
  const profile = await page.request.get(`/threads/${postId}/media/12345`);
  expect(profile.status()).toBe(200);
  expect(await profile.text()).toBe("fixture-avatar-bytes");
  await video.evaluate((element) => {
    if (!(element instanceof HTMLVideoElement)) throw new Error("canonical_video_invalid");
    element.load();
  });
  await expect.poll(() => browserMediaRanges.filter((request) =>
    request.path.endsWith(`/media/${videoId}`)).length).toBeGreaterThan(0);
  expect(browserMediaRanges.filter((request) => request.path.endsWith(`/media/${videoId}`))
    .every((request) => /^bytes=\d+-\d*$/.test(request.range))).toBe(true);
  const range = await page.request.get(`/threads/${postId}/media/${videoId}`, {
    headers: { Range: "bytes=0-3" },
  });
  expect(range.status()).toBe(206);
  expect(range.headers()["content-range"]).toMatch(/^bytes 0-3\/\d+$/);
  expect((await range.body()).byteLength).toBe(4);

  await page.goto("/threads");
  const card = page.locator(`[data-thread-id="${postId}"]`);
  await expect(card.locator("[data-thread-author-reply]")).toHaveCount(3);
  await card.locator("[data-thread-all-replies]").click();
  await expect(card.locator("[data-thread-author-reply]")).toHaveCount(12);
  expect(new Set(await card.locator("[data-thread-author-reply]").evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-thread-entry-id")))).size).toBe(12);
  const initialMediaEtags = media.results.map((item) => ({
    id: item.id, etag: item.etag,
  }));
  const syncResponse = page.waitForResponse((response) =>
    response.request().method() === "POST" &&
    new URL(response.url()).pathname === `/threads/${postId}/sync`);
  await card.getByRole("button", { name: "동기화" }).click();
  expect((await syncResponse).status()).toBe(200);
  await expect.poll(async () => env.PROD_DB.prepare(
    `SELECT status FROM threads_sync_jobs
     WHERE threads_post_id = ? AND generation = 2`,
  ).bind(postId).first("status"), { timeout: 10_000 }).toBe("ready");
  expect(await env.PROD_DB.prepare(
    `SELECT COUNT(*) AS count FROM threads_entries
     WHERE threads_post_id = ? AND kind = 'author_reply'`,
  ).bind(postId).first("count")).toBe(13);
  expect(await env.PROD_DB.prepare(
    `SELECT text FROM threads_entries
     WHERE threads_post_id = ? AND kind = 'root'`,
  ).bind(postId).first("text")).toBe("Fixture root https://example.com/archive");
  expect(await env.PROD_DB.prepare(
    `SELECT item.id, item.etag FROM threads_media item
     JOIN threads_entries entry ON entry.id = item.entry_id
     WHERE entry.threads_post_id = ? ORDER BY item.kind, item.id`,
  ).bind(postId).all().then((result) => result.results.map((item) => ({
    id: item.id, etag: item.etag,
  })))).toEqual(initialMediaEtags);
  await page.goto("/threads");
  const syncedCard = page.locator(`[data-thread-id="${postId}"]`);
  await syncedCard.locator("[data-thread-all-replies]").click();
  await expect(syncedCard.locator("[data-thread-author-reply]")).toHaveCount(13);

  const anonymous = await harness.configuredWorker.fetch(
    `${harness.url.origin}/threads/${postId}/media/${imageId}`,
    { headers: { Accept: "application/json" } },
  );
  expect(anonymous.status).toBe(401);
  const otherPostId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  await seedThreadsArchive(env.PROD_DB, {
    id: otherPostId, rootEntryId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    shortcode: "OtherScoped", threadsMediaId: "other-scoped-root",
    submittedUrl: "https://www.threads.com/@meta/post/OtherScoped",
    canonicalUrl: "https://www.threads.com/@meta/post/OtherScoped",
    rootPermalink: "https://www.threads.com/@meta/post/OtherScoped",
  });
  expect((await page.request.get(
    `/threads/${otherPostId}/media/${imageId}`,
  )).status()).toBe(404);
  expect(browserProviderRequests).toEqual([]);
});

test("configured corrupt media becomes partial, retries to ready, and deletes asynchronously", async ({
  page, harness,
}) => {
  await connectConfiguredThreads(harness);
  await login(page);
  await page.goto("/threads");
  await page.getByLabel("Threads 게시물 URL").fill(
    "https://www.threads.com/@meta/post/CorruptImage",
  );
  await page.getByRole("button", { name: "보관하기" }).click();
  await expect(page).toHaveURL(/\/threads\/[0-9a-f-]{36}$/);
  const postId = new URL(page.url()).pathname.split("/").pop();
  if (!postId) throw new Error("corrupt_post_id_missing");

  const partial = await harness.waitForThreadsArchive(postId, "partial");
  expect(partial.archive.root.text).toBe("Corrupt image with readable video");
  expect(partial.archive.mediaProgress).toEqual({
    expected: 4, ready: 3, failed: 1, pending: 0,
  });
  const failed = partial.archive.root.media.find(
    (/** @type {any} */ item) => item.status === "error");
  const video = partial.archive.root.media.find(
    (/** @type {any} */ item) => item.kind === "video");
  if (!failed || !video) throw new Error("corrupt_fixture_media_missing");
  expect((await page.request.get(
    `/threads/${postId}/media/${video.id}`,
  )).status()).toBe(200);

  await page.goto(`/threads/${postId}`);
  await page.locator(`[data-thread-retry-form]`).getByRole(
    "button", { name: "미디어 재시도" },
  ).click();
  const ready = await harness.waitForThreadsArchive(postId, "ready");
  expect(ready.archive.mediaProgress).toEqual({
    expected: 4, ready: 4, failed: 0, pending: 0,
  });
  expect((await page.request.get(
    `/threads/${postId}/media/${failed.id}`,
  )).status()).toBe(200);
  const env = await harness.remoteWorker.getEnv();
  const profileKey = await env.PROD_DB.prepare(
    `SELECT profile_r2_key FROM threads_authors
     WHERE threads_user_id = '12345' AND profile_media_status = 'ready'`,
  ).first("profile_r2_key");
  if (typeof profileKey !== "string") throw new Error("configured_profile_key_missing");
  expect(await env.THREADS_MEDIA.head(profileKey)).not.toBeNull();

  await page.goto("/threads");
  const card = page.locator(`[data-thread-id="${postId}"]`);
  const opener = card.locator("[data-thread-delete] > summary");
  await opener.click();
  const dialog = page.locator("[data-thread-delete-dialog]");
  await dialog.getByRole("button", { name: "취소" }).click();
  await expect(opener).toBeFocused();
  await opener.click();
  await dialog.getByRole("button", { name: "보관 삭제", exact: true }).click();
  await expect.poll(() => env.PROD_DB.prepare(
    "SELECT COUNT(*) AS count FROM threads_posts WHERE id = ?",
  ).bind(postId).first("count")).toBe(0);
  await expect.poll(() => env.PROD_DB.prepare(
    "SELECT COUNT(*) AS count FROM threads_authors WHERE threads_user_id = '12345'",
  ).first("count")).toBe(0);
  const remaining = await env.THREADS_MEDIA.list({ prefix: `threads/posts/${postId}/` });
  expect(remaining.objects).toHaveLength(0);
  expect(await env.THREADS_MEDIA.head(profileKey)).toBeNull();
  const profileObjects = await env.THREADS_MEDIA.list({ prefix: "threads/authors/12345/" });
  expect(profileObjects.objects).toHaveLength(0);
});

test("capture renders pending state, progresses through polling, and stops at ready", async ({ page }) => {
  await login(page);
  let polls = 0;
  await page.route(/\/threads\/[0-9a-f-]{36}$/, async (route, request) => {
    if (!request.headers().accept?.includes("application/json")) return route.fallback();
    polls += 1;
    const id = new URL(request.url()).pathname.split("/").pop();
    if (!id) throw new Error("missing_post_id");
    const body = detail(id, polls === 1 ? "collecting" : "ready", 0);
    if (polls > 1) {
      body.archive.root.text = "폴링으로 완성된 루트 본문";
      body.archive.firstReplies = [entry(1)];
      body.archive.replyCount = 1;
      body.replies = [entry(1)];
      body.totalReplies = 1;
    }
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
  await expect(card.locator(":scope > [data-thread-root] [data-thread-text]")).toHaveText(
    "폴링으로 완성된 루트 본문",
  );
  await expect(card.locator("[data-thread-author-reply]")).toHaveCount(1);
  const stoppedAt = polls;
  await page.waitForTimeout(1_500);
  expect(polls).toBe(stoppedAt);
});

test("plain reply expansion loads complete quoted provenance while modified click stays native", async ({ page, context, harness }) => {
  await seedArchive(harness, { quotedReply: true });
  await login(page);
  await page.goto("/threads");
  const link = page.locator("[data-thread-all-replies]");
  await expect(link).toHaveText("작성자 답글 12개 모두 보기");
  const popupPromise = context.waitForEvent("page");
  await link.click({ button: "middle" });
  const popup = await popupPromise;
  await popup.waitForLoadState();
  await expect(popup).toHaveURL(new RegExp(`/threads/${POST_ID}#author-replies$`));
  await popup.close();

  await link.click();
  const card = page.locator("[data-thread-archive]");
  await expect(card.locator("[data-thread-author-reply]")).toHaveCount(12);
  await expect(link).toHaveText("작성자 답글 12개 접기");
  await expect(card.locator("[data-thread-author-reply]").last()).toContainText("작성자 답글 12");
  const quote = card.locator("[data-thread-author-reply]").last().locator("[data-thread-quote]");
  await expect(quote).toContainText("확장 답글 인용 본문");
  await expect(quote.locator("[data-thread-original-link]")).toHaveAttribute(
    "href", "https://www.threads.com/@meta/post/ExpandedQuote",
  );
  await expect(quote.locator("[data-thread-nested-quote-link]")).toHaveAttribute(
    "href", "https://www.threads.com/@nested/post/NestedExpanded",
  );
  await expect(quote.getByRole("link", { name: "https://attachment.example/expanded" }))
    .toBeVisible();
  await expect(quote.getByRole("button", { name: "미디어 재시도" })).toBeVisible();
});

test("retry preserves content, sync adds reply thirteen, and shared delete restores focus", async ({ page, harness }) => {
  await seedArchive(harness, { status: "partial", failedMedia: true });
  await login(page);
  await page.goto("/threads");
  const card = page.locator("[data-thread-archive]");
  const rootText = card.locator(":scope > [data-thread-root] > [data-thread-text]");
  await expect(rootText).toHaveText("보관된 루트 본문");
  const attemptsBefore = await mediaAttempts(harness);
  const retryResponse = page.waitForResponse((response) =>
    response.request().method() === "POST" && response.url().endsWith(`/media/${MEDIA_ID}/retry`));
  const retryRequest = page.waitForRequest((request) =>
    request.method() === "POST" && request.url().endsWith(`/media/${MEDIA_ID}/retry`));
  await card.getByRole("button", { name: "미디어 재시도" }).click();
  expect(await (await retryResponse).json()).toEqual({
    threadsPostId: POST_ID, mediaId: MEDIA_ID, status: "queued",
  });
  expect((await retryRequest).postData()).toContain('name="csrf"');
  await expect(card).toHaveAttribute("data-thread-status", "collecting");
  await expect.poll(() => mediaAttempts(harness)).toBeGreaterThan(attemptsBefore);
  await expect(card.locator("[data-thread-retry-form]")).toHaveAttribute(
    "data-thread-retry-status", "queued",
  );
  await expect(card.getByRole("button", { name: "미디어 재시도 대기 중" })).toBeDisabled();
  await expect(rootText).toHaveText("보관된 루트 본문");

  await card.getByRole("link", { name: "작성자 답글 12개 모두 보기" }).click();
  let detailPolls = 0;
  const syncedDetail = new RegExp(`/threads/${POST_ID}(?:\\?.*)?$`);
  await page.route(syncedDetail, async (route, request) => {
    if (request.method() !== "GET" || !request.headers().accept?.includes("application/json"))
      return route.fallback();
    detailPolls += 1;
    const synced = detail(POST_ID, "ready", 13);
    synced.archive.syncGeneration = 2;
    await route.fulfill({ status: 200, contentType: "application/json", headers: { ETag: '"sync-ready"' }, body: JSON.stringify(synced) });
  });
  await page.route(`**/threads/${POST_ID}/sync`, (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ threadsPostId: POST_ID, generation: 2,
      status: "collecting", duplicate: true }),
  }));
  await card.getByRole("button", { name: "동기화" }).click();
  await expect(card).toHaveAttribute("data-thread-status", "ready", { timeout: 6_000 });
  expect(detailPolls).toBe(2);
  await expect(card.locator("[data-thread-author-reply]")).toHaveCount(13, { timeout: 6_000 });
  await page.unroute(syncedDetail);

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
  const deleteResponse = page.waitForResponse((response) =>
    response.request().method() === "POST" && response.url().endsWith(`/${POST_ID}/delete`));
  await dialog.getByRole("button", { name: "보관 삭제", exact: true }).click();
  await deleteResponse;
  await expect(card).toHaveAttribute("data-thread-status", "deleting");
  await expect(card).toHaveCount(0);
  await expect(page.locator("[data-thread-empty-heading]")).toBeFocused();
});

test("JavaScript-disabled media retry preserves the native CSRF redirect and queue effect", async ({ browser, baseURL, harness }) => {
  await seedArchive(harness, { status: "partial", failedMedia: true });
  const native = await browser.newContext({
    baseURL, javaScriptEnabled: false, ignoreHTTPSErrors: true,
    extraHTTPHeaders: { "CF-Connecting-IP": "192.0.2.102" },
  });
  const page = await native.newPage();
  await login(page);
  await page.goto("/threads");
  const before = await mediaAttempts(harness);
  const requestPromise = page.waitForRequest((request) =>
    request.method() === "POST" && request.url().endsWith(`/media/${MEDIA_ID}/retry`));
  await page.getByRole("button", { name: "미디어 재시도" }).click();
  const request = await requestPromise;
  expect(request.postData()).toContain("csrf=");
  await expect(page).toHaveURL(new RegExp(
    `/threads/${POST_ID}\\?flash=threads_retry_queued$`,
  ));
  await expect.poll(() => mediaAttempts(harness)).toBeGreaterThan(before);
  await native.close();
});

test("a corrupt delete action remains native and never opens or navigates the enhanced dialog", async ({ page, harness }) => {
  await seedArchive(harness, { replies: 0 });
  await login(page);
  await page.goto("/threads");
  const originalUrl = page.url();
  const details = page.locator("[data-thread-delete]");
  await details.locator("form").evaluate((form) => form.setAttribute(
    "action", "https://invalid.example/threads/delete",
  ));
  await details.locator("summary").click();
  await expect(details).toHaveAttribute("open", "");
  await expect(page.locator("[data-thread-delete-dialog]")).toBeHidden();
  expect(page.url()).toBe(originalUrl);
});

test("malformed later reply page commits no staged replies", async ({ page, harness }) => {
  await seedArchive(harness, { replies: 21 });
  await login(page);
  await page.route(new RegExp(`/threads/${POST_ID}\\?repliesPage=2$`), async (route) => {
    const malformed = /** @type {any} */ (detail(POST_ID, "ready", 21));
    malformed.unexpected = true;
    await route.fulfill({
      status: 200, contentType: "application/json", body: JSON.stringify(malformed),
    });
  });
  await page.goto("/threads");
  const card = page.locator("[data-thread-archive]");
  const link = card.locator("[data-thread-all-replies]");
  await link.click();
  await expect(page.locator("[data-thread-panel-message]")).toHaveText(
    "작성자 답글을 불러오지 못했습니다. 다시 시도하세요.",
  );
  await expect(card.locator("[data-thread-author-reply]")).toHaveCount(3);
  await expect(link).toHaveText("작성자 답글 21개 모두 보기");
});

test("second activation cancels a loading reply expansion without restarting it", async ({ page, harness }) => {
  await seedArchive(harness);
  await login(page);
  let requests = 0;
  /** @type {() => void} */
  let startedResolve = () => {};
  /** @type {Promise<void>} */
  const started = new Promise((resolve) => { startedResolve = resolve; });
  /** @type {() => void} */
  let releaseResolve = () => {};
  /** @type {Promise<void>} */
  const release = new Promise((resolve) => { releaseResolve = resolve; });
  await page.route(new RegExp(`/threads/${POST_ID}\\?repliesPage=1$`), async (route) => {
    requests += 1;
    startedResolve();
    await release;
    await route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify(detail(POST_ID, "ready", 12)),
    });
  });
  await page.goto("/threads");
  const card = page.locator("[data-thread-archive]");
  const link = card.locator("[data-thread-all-replies]");
  await link.click();
  await started;
  await link.click();
  releaseResolve();
  await page.waitForTimeout(300);
  expect(requests).toBe(1);
  await expect(card.locator("[data-thread-author-reply]")).toHaveCount(3);
  await expect(link).toHaveText("작성자 답글 12개 모두 보기");
  await expect(link).toBeFocused();
});

test("cancelling an expanded reply refresh preserves its nodes and collapse label", async ({ page, harness }) => {
  await seedArchive(harness, { status: "collecting" });
  await login(page);
  let pageRequests = 0;
  /** @type {() => void} */
  let refreshStartedResolve = () => {};
  /** @type {Promise<void>} */
  const refreshStarted = new Promise((resolve) => { refreshStartedResolve = resolve; });
  /** @type {() => void} */
  let releaseRefreshResolve = () => {};
  /** @type {Promise<void>} */
  const releaseRefresh = new Promise((resolve) => { releaseRefreshResolve = resolve; });
  await page.route(new RegExp(`/threads/${POST_ID}\\?repliesPage=1$`), async (route) => {
    pageRequests += 1;
    if (pageRequests === 1) return route.fallback();
    refreshStartedResolve();
    await releaseRefresh;
    await route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify(detail(POST_ID, "ready", 12)),
    });
  });
  await page.route(new RegExp(`/threads/${POST_ID}$`), async (route, request) => {
    if (!request.headers().accept?.includes("application/json")) return route.fallback();
    await route.fulfill({
      status: 200, contentType: "application/json", headers: { ETag: '"terminal"' },
      body: JSON.stringify(detail(POST_ID, "ready", 12)),
    });
  });
  await page.goto("/threads");
  const card = page.locator("[data-thread-archive]");
  const link = card.locator("[data-thread-all-replies]");
  await link.click();
  await expect(card.locator("[data-thread-author-reply]")).toHaveCount(12);
  await expect(link).toHaveText("작성자 답글 12개 접기");
  await refreshStarted;
  await link.click();
  releaseRefreshResolve();
  await page.waitForTimeout(300);
  expect(pageRequests).toBe(2);
  await expect(card.locator("[data-thread-author-reply]")).toHaveCount(12);
  await expect(link).toHaveText("작성자 답글 12개 접기");
  await expect(link).toBeFocused();
  await link.click();
  await expect(card.locator("[data-thread-author-reply]")).toHaveCount(3);
  await expect(link).toHaveText("작성자 답글 12개 모두 보기");
});

test("sync invalidates a delayed old-generation poll before scheduling the new generation", async ({ page, harness }) => {
  await seedArchive(harness, { status: "pending", replies: 0 });
  await login(page);
  let calls = 0;
  /** @type {() => void} */
  let oldStartedResolve = () => {};
  /** @type {Promise<void>} */
  const oldStarted = new Promise((resolve) => { oldStartedResolve = resolve; });
  /** @type {() => void} */
  let releaseOldResolve = () => {};
  /** @type {Promise<void>} */
  const releaseOld = new Promise((resolve) => { releaseOldResolve = resolve; });
  await page.route(new RegExp(`/threads/${POST_ID}$`), async (route, request) => {
    if (!request.headers().accept?.includes("application/json")) return route.fallback();
    calls += 1;
    if (calls === 1) {
      oldStartedResolve();
      await releaseOld;
      const stale = detail(POST_ID, "error", 0);
      stale.archive.mediaProgress = { expected: 1, ready: 0, failed: 1, pending: 0 };
      await route.fulfill({
        status: 200, contentType: "application/json", headers: { ETag: '"old"' },
        body: JSON.stringify(stale),
      });
      return;
    }
    const current = detail(POST_ID, "ready", 0);
    current.archive.syncGeneration = 2;
    current.archive.mediaProgress = { expected: 2, ready: 2, failed: 0, pending: 0 };
    await route.fulfill({
      status: 200, contentType: "application/json", headers: { ETag: '"new"' },
      body: JSON.stringify(current),
    });
  });
  await page.route(`**/threads/${POST_ID}/sync`, (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({
      threadsPostId: POST_ID, generation: 2, status: "pending", duplicate: false,
    }),
  }));
  await page.goto("/threads");
  await oldStarted;
  await page.getByRole("button", { name: "동기화" }).click();
  releaseOldResolve();
  const card = page.locator("[data-thread-archive]");
  await expect(card).toHaveAttribute("data-thread-status", "ready", { timeout: 6_000 });
  await expect(card).toHaveAttribute("data-thread-generation", "2");
  await expect(card.locator("[data-thread-progress]")).toHaveText("미디어 2/2 준비");
  expect(calls).toBeGreaterThanOrEqual(2);
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
