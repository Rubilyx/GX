import assert from "node:assert/strict";
import test from "node:test";
import fixture from "../support/provider-fixture-worker.js";

test("provider fixture accepts only exact GitHub and OpenAI boundaries", async () => {
  for (const request of [
    new Request("https://evil.test/repos/OpenAI/example"),
    new Request("https://api.github.com/repos/OpenAI/example?x=1"),
    new Request("https://evil.test/v1/responses", { method: "POST" }),
  ]) assert.equal((await fixture.fetch(request)).status, 502);
  assert.equal((await fixture.fetch(new Request("https://api.github.com/repos/OpenAI/example"))).status, 200);
  assert.equal((await fixture.fetch(new Request("https://api.openai.com/v1/responses", { method: "POST" }))).status, 200);
});
