import assert from "node:assert/strict";
import test from "node:test";
import {
  AppError, normalizeGitHubUrl, normalizeTags, parseListQuery, validateRepositoryEdit,
} from "../../src/domain.js";

test("normalizes the one accepted GitHub URL shape", () => {
  assert.deepEqual(
    normalizeGitHubUrl(" https://github.com/OpenAI/openai-node.git/?tab=readme#top "),
    { owner: "OpenAI", name: "openai-node", url: "https://github.com/OpenAI/openai-node" },
  );
  for (const raw of [
    "http://github.com/openai/openai-node",
    "https://github.com:444/openai/openai-node",
    "https://www.github.com/openai/openai-node",
    "https://github.com/openai",
    "https://github.com/openai/openai-node/issues",
    "https://user@github.com/openai/openai-node",
    "https://github.com/openai/%E0%A4%A",
    "https://github.com/openai%2Fevil/repo",
    "https://github.com/openai%5Cevil/repo",
  ]) assert.throws(() => normalizeGitHubUrl(raw), /invalid_repository_url/);
});

test("accepts only one q/category/tag/page value", () => {
  assert.deepEqual(
    parseListQuery(new URL("https://app.test/?q=%20API%20&category=Backend&tag=node-js&page=2")),
    { q: "API", category: "Backend", tag: "node-js", page: 2 },
  );
  for (const search of ["?sort=stars", "?q=a&q=b", `?q=${"x".repeat(101)}`, "?tag=Bad_Tag"])
    assert.throws(() => parseListQuery(new URL(`https://app.test/${search}`)), /invalid_list_query/);
  assert.equal(parseListQuery(new URL("https://app.test/?page=-9")).page, 1);
});

test("normalizes tag and editable fields", () => {
  assert.deepEqual(normalizeTags([" Node JS ", "node-js", "AI"]), ["node-js", "ai"]);
  assert.deepEqual(validateRepositoryEdit({
    personalNote: "  메모  ", primaryCategory: "Backend", tags: ["node-js"],
  }), { personalNote: "메모", primaryCategory: "Backend", tags: ["node-js"] });
  assert.throws(() => normalizeTags(["a", "b", "c", "d", "e", "f"]), /invalid_tags/);
  assert.throws(() => validateRepositoryEdit({ personalNote: "x".repeat(4001), primaryCategory: "Backend", tags: [] }), /invalid_repository_edit/);
});

test("rejects extra edit fields", () => {
  assert.throws(
    () => validateRepositoryEdit({ personalNote: "", primaryCategory: "Other", tags: [], stars: 99 }),
    /invalid_repository_edit/,
  );
});

test("rejects malformed repository edit shapes with safe errors", () => {
  for (const input of [{}, null, { personalNote: "", primaryCategory: "Other", tags: "x" }]) {
    assert.throws(
      () => validateRepositoryEdit(/** @type {any} */ (input)),
      (error) => error instanceof AppError && error.code === "invalid_repository_edit" && error.status === 400,
    );
  }
});
