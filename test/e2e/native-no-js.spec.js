import { expect, test } from "./fixtures.js";

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
  const pageTwo = page.getByRole("link", { name: "2", exact: true });
  await expect(pageTwo).toHaveAttribute("href", /\/repositories\/[0-9a-f-]+\/notes\?page=2$/);
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

  await noteOne.getByRole("button", { name: "삭제", exact: true }).click();
  await expect(page).toHaveURL(/\/notes\?flash=repository_note_deleted$/);
  await expect(page.getByRole("status")).toContainText("Note를 삭제했습니다.");
  await expect(page.locator("[data-repository-note-item]")).toHaveCount(5);
  await expect(page.locator(".repository-note-body").filter({ hasText: "Note 1 수정" }))
    .toHaveCount(0);
});
