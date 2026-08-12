import assert from "node:assert/strict";
import test from "node:test";
import { setText } from "../../public/assets/dom.js";

test("setText avoids duplicate DOM writes", () => {
  let writes = 0;
  let text = "";
  const node = { get textContent() { return text; }, set textContent(value) { writes += 1; text = value; } };
  const root = { querySelector() { return node; } };
  setText(root, "[data-status]", "저장 중입니다.");
  setText(root, "[data-status]", "저장 중입니다.");
  assert.equal(writes, 1);
});
