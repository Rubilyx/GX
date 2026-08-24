import { expect, test } from "./fixtures.js";
import { login as loginWorker, seedThreadsArchive } from "../support/harness.js";

/** @param {any} harness */
async function connectThreadsFixture(harness) {
  const session = await loginWorker(harness.worker);
  const started = await harness.worker.fetch(`${session.origin}/threads/connect`, {
    headers: { Cookie: session.cookie },
  });
  const location = started.headers.get("location");
  const cookie = started.headers.get("set-cookie");
  if (!location || !cookie) throw new Error("native_threads_oauth_setup_missing");
  const state = new URL(location).searchParams.get("state");
  expect((await harness.worker.fetch(
    `${session.origin}/threads/oauth/callback?code=code-1&state=${state}`,
    { headers: { Cookie: cookie } },
  )).status).toBe(303);
}

test("core form flow survives disabled JavaScript", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("6자리 PIN").fill("123456");
  await page.getByRole("button", { name: "접속" }).click();
  await page.getByLabel("GitHub 저장소 URL").fill("https://github.com/OpenAI/example");
  await page.getByRole("button", { name: "저장" }).click();
  await expect(page.getByRole("heading", { name: "OpenAI/example" })).toBeVisible();
  await page.getByLabel("주 분류", { exact: true }).selectOption("Backend");
  await page.getByLabel("태그 (쉼표로 구분)").fill("example, node-js");
  await page.getByRole("button", { name: "변경 저장" }).click();
  await page.getByLabel(/AI 요약, 주 분류와 태그가 새 분석 결과로 교체됨/).check();
  await page.getByRole("button", { name: "GitHub 정보와 분석 새로고침" }).click();
  await page.getByRole("link", { name: "저장소 목록" }).click();
  await page.getByLabel("검색").fill("example");
  await page.getByRole("link", { name: "Backend 1", exact: true }).click();
  await page.getByLabel("태그").selectOption("example");
  await page.getByRole("button", { name: "찾기" }).click();
  await expect(page.locator("[data-repository-link]")).toHaveCount(1);
  await page.getByRole("link", { name: "OpenAI/example 삭제", exact: true }).click();
  await expect(page).toHaveURL(/\/repositories\/[0-9a-f-]+#delete-heading$/);
  await expect(page.getByRole("heading", { name: "저장소 삭제", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "저장소 목록" }).click();
  await page.getByRole("button", { name: "로그아웃" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel("6자리 PIN").fill("123456");
  await page.getByRole("button", { name: "접속" }).click();
  await page.getByRole("link", { name: "자세히 보기", exact: true }).first().click();
  await page.getByLabel(/이 저장소와 모든 Note를 영구 삭제함/).check();
  await page.getByRole("button", { name: "저장소 삭제" }).click();
  await expect(page).toHaveURL(/\/\?flash=repository_deleted$/);
});

test("native Note forms create, page, edit, and delete without JavaScript", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("6자리 PIN").fill("123456");
  await page.getByRole("button", { name: "접속" }).click();
  await page.getByLabel("GitHub 저장소 URL").fill("https://github.com/OpenAI/example");
  await page.getByRole("button", { name: "저장" }).click();
  await page.getByRole("link", { name: "Note 관리", exact: true }).click();
  await expect(page).toHaveURL(/\/repositories\/[0-9a-f-]+\/notes$/);

  for (let number = 1; number <= 6; number += 1) {
    const createForm = page.locator("[data-repository-note-create-form]");
    await createForm.getByRole("textbox", { name: "새 Note", exact: true }).fill(`Note ${number}`);
    await createForm.getByRole("button", { name: "저장", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Note를 저장했습니다.");
  }

  await expect(page.locator("[data-repository-note-item]")).toHaveCount(5);
  const pagination = page.locator(".repository-note-pagination");
  const pageTwo = pagination.getByRole("link", { name: "2", exact: true });
  await expect(pageTwo).toHaveAttribute("href", /\/repositories\/[0-9a-f-]+\/notes\?page=2$/);
  expect((await pageTwo.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  const metadata = page.locator(".repository-note-meta").first();
  await expect(metadata).toHaveCSS("font-size", "12px");
  await expect(metadata).toHaveCSS("color", "rgb(107, 105, 99)");
  await pageTwo.click();
  await expect(page).toHaveURL(/\/notes\?page=2$/);
  let noteOne = page.locator("[data-repository-note-item]").filter({ hasText: "Note 1" });
  await expect(noteOne).toHaveCount(1);

  await noteOne.getByRole("textbox", { name: "Note 수정", exact: true }).fill("Note 1 수정");
  await noteOne.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Note를 수정했습니다.");
  await page.getByRole("link", { name: "2", exact: true }).click();
  noteOne = page.locator("[data-repository-note-item]").filter({ hasText: "Note 1 수정" });
  await expect(noteOne.locator(".repository-note-body")).toHaveText("Note 1 수정");

  const beforeConfirmation = page.url();
  const deleteDisclosure = noteOne.locator("[data-repository-note-native-delete]");
  await deleteDisclosure.locator("summary").click();
  await expect(page).toHaveURL(beforeConfirmation);
  await expect(noteOne.locator(".repository-note-body").first()).toHaveText("Note 1 수정");
  await expect(deleteDisclosure).toHaveAttribute("open", "");
  const confirmation = deleteDisclosure.locator("[data-repository-note-native-confirmation]");
  await expect(confirmation).toContainText("OpenAI/example Note");
  await expect(confirmation.locator("time")).toHaveText(/^\d{4}\.\d{2}\.\d{2}$/);
  await expect(confirmation.locator("[data-repository-note-native-delete-excerpt]"))
    .toHaveText("Note 1 수정");
  const deletion = page.waitForRequest((request) => request.method() === "POST" &&
    /\/repositories\/[0-9a-f-]+\/notes\/[0-9a-f-]+\/delete$/.test(new URL(request.url()).pathname));
  await confirmation.getByRole("button", { name: "Note 영구 삭제", exact: true }).click();
  expect((await deletion).postData()).toContain("confirm=yes");
  await expect(page).toHaveURL(/\/notes\?flash=repository_note_deleted$/);
  await expect(page.getByRole("status")).toContainText("Note를 삭제했습니다.");
  await expect(page.locator("[data-repository-note-item]")).toHaveCount(5);
  await expect(page.locator(".repository-note-body").filter({ hasText: "Note 1 수정" }))
    .toHaveCount(0);
});

test("native Threads capture, pagination, sync, retry, delete, and logout remain usable", async ({
  page, harness,
}) => {
  await page.goto("/login");
  await page.getByLabel("6자리 PIN").fill("123456");
  await page.getByRole("button", { name: "접속" }).click();
  await page.goto("/threads");
  await expect(page.locator("[data-thread-connection]")).toContainText(
    /Threads를 (?:다시 )?연결/,
  );
  await connectThreadsFixture(harness);
  await page.reload();
  await expect(page.getByRole("button", { name: "Threads 연결 해제" })).toBeVisible();

  await page.getByLabel("Threads 게시물 URL").fill(
    "https://www.threads.com/@meta/post/RootShort",
  );
  await page.getByRole("button", { name: "보관하기" }).click();
  await expect(page).toHaveURL(/\/threads\/[0-9a-f-]{36}\?flash=threads_capture_queued$/);
  const postId = new URL(page.url()).pathname.split("/").pop();
  if (!postId) throw new Error("native_threads_post_missing");
  await harness.waitForThreadsArchive(postId, "ready");
  await page.goto(`/threads/${postId}`);
  await expect(page.locator("[data-thread-author-reply]")).toHaveCount(12);
  await page.getByRole("button", { name: "동기화" }).click();
  await expect(page).toHaveURL(new RegExp(
    `/threads/${postId}\\?flash=threads_sync_queued$`,
  ));
  const env = await harness.remoteWorker.getEnv();
  await expect.poll(() => env.PROD_DB.prepare(
    `SELECT status FROM threads_sync_jobs
     WHERE threads_post_id = ? AND generation = 2`,
  ).bind(postId).first("status"), { timeout: 10_000 }).toBe("ready");

  const pagedId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  await seedThreadsArchive(env.PROD_DB, {
    id: pagedId, rootEntryId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    shortcode: "PagedReplies", threadsMediaId: "paged-root", authorId: "99999",
    username: "paged", displayName: "Paged Author",
    submittedUrl: "https://www.threads.com/@paged/post/PagedReplies",
    canonicalUrl: "https://www.threads.com/@paged/post/PagedReplies",
    rootPermalink: "https://www.threads.com/@paged/post/PagedReplies",
  });
  for (let number = 1; number <= 21; number += 1) {
    await env.PROD_DB.prepare(
      `INSERT INTO threads_entries
         (id, threads_post_id, source_media_id, kind, author_id, text, permalink,
          published_at, media_type, first_seen_at, last_seen_at, created_at)
       VALUES (?, ?, ?, 'author_reply', '99999', ?, ?, ?, 'TEXT_POST', 1, 1, 1)`,
    ).bind(
      `eeeeeeee-eeee-4eee-8eee-${String(number).padStart(12, "0")}`,
      pagedId, `paged-reply-${number}`, `페이지 답글 ${number}`,
      `https://www.threads.com/@paged/post/Page${number}`,
      `2026-08-24T00:${String(number).padStart(2, "0")}:00.000Z`,
    ).run();
  }
  await page.goto(`/threads/${pagedId}`);
  await expect(page.locator("[data-thread-author-reply]")).toHaveCount(20);
  await page.getByRole("link", { name: "2", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/threads/${pagedId}\\?repliesPage=2$`));
  await expect(page.locator("[data-thread-author-reply]")).toHaveCount(1);

  await page.goto("/threads");
  await page.getByLabel("Threads 게시물 URL").fill(
    "https://www.threads.com/@meta/post/CorruptImage",
  );
  await page.getByRole("button", { name: "보관하기" }).click();
  const corruptId = new URL(page.url()).pathname.split("/").pop();
  if (!corruptId) throw new Error("native_corrupt_post_missing");
  await harness.waitForThreadsArchive(corruptId, "partial");
  await page.goto(`/threads/${corruptId}`);
  await page.getByRole("button", { name: "미디어 재시도" }).click();
  await expect(page).toHaveURL(new RegExp(
    `/threads/${corruptId}\\?flash=threads_retry_queued$`,
  ));
  await harness.waitForThreadsArchive(corruptId, "ready");
  await page.goto(`/threads/${corruptId}`);
  const deletion = page.locator("[data-thread-delete]");
  await deletion.locator("summary").click();
  await deletion.getByRole("button", { name: "보관 삭제", exact: true }).click();
  await expect(page).toHaveURL(/\/threads\?flash=threads_delete_queued$/);
  await expect.poll(() => env.PROD_DB.prepare(
    "SELECT COUNT(*) AS count FROM threads_posts WHERE id = ?",
  ).bind(corruptId).first("count")).toBe(0);
  await page.getByRole("button", { name: "로그아웃" }).click();
  await expect(page).toHaveURL(/\/login$/);
});
