import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  fetchRepositoryMetadata, fetchRepositoryReadme, truncateUtf8,
} from "../../src/github.js";
import { AppError } from "../../src/domain.js";

const metadata = {
  id: 123456789012,
  owner: { login: "OpenAI" },
  name: "openai-node",
  html_url: "https://evil.test/not-trusted",
  description: "Official JavaScript library for the OpenAI API",
  homepage: "https://www.npmjs.com/package/openai",
  default_branch: "master",
  language: "TypeScript",
  stargazers_count: 999,
  forks_count: 88,
  license: { spdx_id: "Apache-2.0" },
  topics: ["openai", "api"],
  updated_at: "2026-08-01T00:00:00Z",
};

/** @param {string} code @param {number} status */
const isAppError = (code, status) => (/** @type {unknown} */ error) =>
  error instanceof AppError && error.code === code && error.status === status;

test("requests only the fixed GitHub API origin with encoded path components", async () => {
  /** @type {{ request: Request, init: RequestInit | undefined }[]} */
  const seen = [];
  const fetcher = async (
    /** @type {RequestInfo | URL} */ input,
    /** @type {RequestInit | undefined} */ init,
  ) => {
    seen.push({ request: new Request(input, init), init });
    return Response.json(metadata);
  };
  const result = await fetchRepositoryMetadata(fetcher, { owner: "Open AI", name: "node#sdk" });
  assert.equal(result.githubId, "123456789012");
  assert.equal(result.owner, "OpenAI");
  assert.equal(result.htmlUrl, "https://github.com/OpenAI/openai-node");
  assert.ok(seen[0]);
  assert.equal(seen[0].request.url, "https://api.github.com/repos/Open%20AI/node%23sdk");
  assert.equal(seen[0].init?.redirect, "manual");
  assert.equal(seen[0].request.headers.get("x-github-api-version"), "2022-11-28");
});

test("allows one same-origin redirect and rejects unsafe redirect behavior", async () => {
  /** @type {string[]} */
  const urls = [];
  const result = await fetchRepositoryMetadata(async (input) => {
    const url = new URL(new Request(input).url);
    urls.push(url.href);
    return urls.length === 1
      ? new Response(null, { status: 301, headers: { Location: "/repositories/123" } })
      : Response.json(metadata);
  }, { owner: "a", name: "b" });
  assert.equal(result.githubId, "123456789012");
  assert.deepEqual(urls, [
    "https://api.github.com/repos/a/b",
    "https://api.github.com/repositories/123",
  ]);

  for (const response of [
    new Response(null, { status: 301, headers: { Location: "https://evil.test/repos/a/b" } }),
    new Response(null, { status: 302 }),
  ]) {
    await assert.rejects(
      fetchRepositoryMetadata(async () => response, { owner: "a", name: "b" }),
      isAppError("github_unavailable", 503),
    );
  }

  await assert.rejects(
    fetchRepositoryMetadata(async () => new Response(null, {
      status: 307, headers: { Location: "/still-redirecting" },
    }), { owner: "a", name: "b" }),
    isAppError("github_unavailable", 503),
  );
});

test("maps GitHub metadata failures without leaking native or response errors", async () => {
  await assert.rejects(
    fetchRepositoryMetadata(async () => new Response(null, { status: 404 }), { owner: "a", name: "b" }),
    isAppError("github_not_found", 404),
  );
  await assert.rejects(
    fetchRepositoryMetadata(async () => new Response(null, {
      status: 429, headers: { "Retry-After": "30" },
    }), { owner: "a", name: "b" }),
    (error) => isAppError("github_rate_limited", 429)(error) &&
      error instanceof AppError && error.details.retryAfter === 30,
  );
  await assert.rejects(
    fetchRepositoryMetadata(async () => { throw new DOMException("secret", "AbortError"); }, { owner: "a", name: "b" }),
    isAppError("github_timeout", 504),
  );
  await assert.rejects(
    fetchRepositoryMetadata(async () => { throw new TypeError("secret transport body"); }, { owner: "a", name: "b" }),
    (error) => isAppError("github_unavailable", 503)(error) &&
      error instanceof Error && !error.message.includes("secret"),
  );
});

test("rejects malformed metadata and accepts nullable documented fields", async () => {
  const result = await fetchRepositoryMetadata(async () => Response.json({
    ...metadata, id: "99999999999999999999", description: null, homepage: null,
    language: null, license: null,
  }), { owner: "a", name: "b" });
  assert.deepEqual(
    { githubId: result.githubId, description: result.description, homepageUrl: result.homepageUrl,
      primaryLanguage: result.primaryLanguage, licenseSpdx: result.licenseSpdx },
    { githubId: "99999999999999999999", description: null, homepageUrl: null,
      primaryLanguage: null, licenseSpdx: null },
  );

  for (const bad of [
    { ...metadata, id: 0 },
    { ...metadata, id: Number.MAX_SAFE_INTEGER + 1 },
    { ...metadata, id: "12x" },
    { ...metadata, owner: { login: "" } },
    { ...metadata, topics: ["ok", 1] },
    { ...metadata, updated_at: "not-a-date" },
    { ...metadata, updated_at: "2026-02-30T00:00:00Z" },
    { ...metadata, updated_at: "2026-08-01T24:00:00Z" },
  ]) {
    await assert.rejects(
      fetchRepositoryMetadata(async () => Response.json(bad), { owner: "a", name: "b" }),
      isAppError("github_unavailable", 503),
    );
  }
});

test("cuts README bytes on a UTF-8 boundary", () => {
  const input = new TextEncoder().encode(`a${"한".repeat(50_000)}`);
  const result = truncateUtf8(input, 131_072);
  assert.equal(result.truncated, true);
  assert.ok(result.bytes.byteLength <= 131_072);
  assert.doesNotThrow(() => new TextDecoder("utf-8", { fatal: true }).decode(result.bytes));
});

test("streams a bounded README, hashes final bytes, and never follows response URLs", async () => {
  const chunk = new Uint8Array(70_000).fill(97);
  let pulls = 0;
  /** @type {{ request?: Request }} */
  const capture = {};
  const readme = await fetchRepositoryReadme(async (input, init) => {
    capture.request = new Request(input, init);
    return new Response(new ReadableStream({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
        if (pulls === 100) controller.close();
      },
    }), { headers: { "Content-Type": "application/octet-stream" } });
  }, { owner: "Open AI", name: "node#sdk", defaultBranch: "feature/x" });

  const request = capture.request;
  assert.ok(request);
  assert.equal(request.url, "https://api.github.com/repos/Open%20AI/node%23sdk/readme?ref=feature%2Fx");
  assert.equal(request.headers.get("accept"), "application/vnd.github.raw+json");
  assert.equal(readme.status, "truncated");
  assert.equal(readme.bytes.byteLength, 131_072);
  assert.equal(readme.text.length, 131_072);
  assert.equal(readme.sha, createHash("sha256").update(readme.bytes).digest("hex"));
  assert.ok(pulls < 100);
});

test("initiates README cancellation without awaiting a never-settling cancel", async () => {
  let cancelInitiated = false;
  const operation = fetchRepositoryReadme(async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(131_077).fill(97));
    },
    cancel() {
      cancelInitiated = true;
      return new Promise(() => {});
    },
  })), { owner: "OpenAI", name: "openai-node", defaultBranch: "main" });
  const timeout = Symbol("timeout");
  let timer;
  const outcome = await Promise.race([
    operation,
    new Promise((resolve) => { timer = setTimeout(() => resolve(timeout), 1_000); }),
  ]);
  clearTimeout(timer);
  if (outcome === timeout) assert.fail("README adapter awaited stream cancellation");
  assert.equal(cancelInitiated, true);
  assert.equal(outcome.status, "truncated");
});

test("classifies missing, nontext, and unavailable README states without throwing", async () => {
  const repository = { owner: "OpenAI", name: "openai-node", defaultBranch: "master" };
  const missing = await fetchRepositoryReadme(
    async () => new Response(null, { status: 404 }), repository,
  );
  assert.deepEqual(missing, {
    text: "", bytes: new Uint8Array(), sha: null, status: "missing", errorCode: null,
  });

  for (const bytes of [new Uint8Array([0x61, 0, 0x62]), new Uint8Array([0xc3, 0x28])]) {
    const nontext = await fetchRepositoryReadme(async () => new Response(bytes), repository);
    assert.deepEqual(nontext, {
      text: "", bytes: new Uint8Array(), sha: null, status: "nontext", errorCode: null,
    });
  }

  /** @type {[((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>), string][]} */
  const failures = [
    [async () => new Response(null, { status: 403 }), "github_rate_limited"],
    [async () => { throw new DOMException("secret", "AbortError"); }, "github_timeout"],
    [async () => { throw new TypeError("secret transport body"); }, "github_unavailable"],
  ];
  for (const [fetcher, errorCode] of failures) {
    const unavailable = await fetchRepositoryReadme(fetcher, repository);
    assert.deepEqual(unavailable, {
      text: "", bytes: new Uint8Array(), sha: null, status: "unavailable", errorCode,
    });
  }
});
