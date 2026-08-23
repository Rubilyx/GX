import assert from "node:assert/strict";
import test from "node:test";
import {
  THREADS_SCOPES, debugThreadsAccessToken, exchangeLongLivedThreadsToken, exchangeThreadsCode,
  fetchThreadsConversationPage, fetchThreadsMedia, fetchThreadsProfile,
  fetchThreadsProfilePostsPage, refreshThreadsAccessToken, resolveThreadsPostUrl,
} from "../../src/threads-api.js";
import { AppError } from "../../src/domain.js";
import { normalizeThreadsUrl } from "../../src/threads-domain.js";
import { providerFixture } from "../support/harness.js";

const fields = [
  "id", "media_product_type", "media_type", "media_url", "permalink", "owner",
  "username", "text", "timestamp", "shortcode", "thumbnail_url", "children",
  "is_quote_post", "quoted_post", "link_attachment_url", "alt_text", "root_post", "replied_to",
].join(",");

const media = {
  id: "root-1", media_product_type: "THREADS", media_type: "CAROUSEL_ALBUM",
  permalink: "https://www.threads.com/@meta/post/root1", owner: { id: "author-1" },
  username: "meta", text: "", timestamp: "2026-08-24T00:00:00+0000", shortcode: "root1",
  children: { data: [{ id: "child-image" }, { id: "child-video" }] }, is_quote_post: true,
  quoted_post: { id: "quote-1" }, link_attachment_url: "https://example.test/read",
  alt_text: "Root image", root_post: { id: "root-1" }, replied_to: { id: "parent-1" },
};

const officialDebugData = {
  app_id: "client", type: "USER", application: "Repo Atlas", user_id: "user-1",
  data_access_expires_at: 5_100_000, expires_at: 5_184_100, issued_at: 100,
  is_valid: true, scopes: THREADS_SCOPES,
  granular_scopes: [
    { scope: "threads_basic" },
    { scope: "threads_profile_discovery", target_ids: ["author-1", "author-2"] },
  ],
};

/** @param {string} code @param {number} status */
const isAppError = (code, status) => (/** @type {unknown} */ error) =>
  error instanceof AppError && error.code === code && error.status === status;

test("uses the fixed scopes, Graph requests, bearer header, field projections, and mapped responses", async () => {
  /** @type {Request[]} */
  const requests = [];
  /** @type {(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>} */
  const fetcher = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    const url = new URL(request.url);
    if (url.pathname.endsWith("/oauth/access_token")) return Response.json({ access_token: "short", user_id: "user-1" });
    if (url.pathname.endsWith("/access_token")) return Response.json({ access_token: "long", token_type: "bearer", expires_in: 5_184_000 });
    if (url.pathname.endsWith("/refresh_access_token")) return Response.json({ access_token: "refreshed", token_type: "bearer", expires_in: 5_184_000 });
    if (url.pathname.endsWith("/debug_token")) return Response.json({ data: officialDebugData });
    if (url.pathname.endsWith("/profile_lookup")) return Response.json({ id: "author-1", username: "meta", name: "Meta", threads_profile_picture_url: "https://scontent.cdninstagram.com/avatar" });
    if (url.pathname.endsWith("/profile_posts")) return Response.json({ data: [media], paging: { next: "https://graph.threads.net/v1.0/profile_posts?after=next-1" } });
    if (url.pathname.endsWith("/conversation")) return Response.json({ data: [{ ...media, id: "reply-1", media_type: "TEXT_POST", children: undefined, is_quote_post: false, quoted_post: undefined, root_post: { id: "root-1" }, replied_to: { id: "root-1" }, text: "reply" }] });
    return Response.json(media);
  };

  assert.deepEqual(THREADS_SCOPES, ["threads_basic", "threads_profile_discovery", "threads_read_replies"]);
  assert.deepEqual(await exchangeThreadsCode(fetcher, { clientId: "client", clientSecret: "secret", redirectUri: "https://app.test/callback", code: "code", signal: AbortSignal.timeout(1_000) }), { accessToken: "short", userId: "user-1" });
  assert.deepEqual(await exchangeLongLivedThreadsToken(fetcher, { clientSecret: "secret", accessToken: "short", signal: AbortSignal.timeout(1_000) }), { accessToken: "long", tokenType: "bearer", expiresIn: 5_184_000 });
  assert.deepEqual(await refreshThreadsAccessToken(fetcher, { accessToken: "long", signal: AbortSignal.timeout(1_000) }), { accessToken: "refreshed", tokenType: "bearer", expiresIn: 5_184_000 });
  assert.deepEqual(await debugThreadsAccessToken(fetcher, { accessToken: "long", signal: AbortSignal.timeout(1_000) }), { appId: "client", userId: "user-1", isValid: true, expiresAt: 5_184_100, scopes: THREADS_SCOPES });
  assert.deepEqual(await fetchThreadsProfile(fetcher, { accessToken: "secret", username: "meta", signal: AbortSignal.timeout(1_000) }), { id: "author-1", username: "meta", name: "Meta", profilePictureUrl: "https://scontent.cdninstagram.com/avatar" });
  assert.deepEqual(await fetchThreadsProfilePostsPage(fetcher, { accessToken: "secret", username: "meta", after: "before-1", signal: AbortSignal.timeout(1_000) }), {
    data: [{ id: "root-1", ownerId: "author-1", username: "meta", text: "", permalink: "https://www.threads.com/@meta/post/root1", timestamp: "2026-08-24T00:00:00+0000", mediaType: "CAROUSEL_ALBUM", mediaUrl: null, thumbnailUrl: null, children: ["child-image", "child-video"], quotedPostId: "quote-1", linkAttachmentUrl: "https://example.test/read", altText: "Root image", rootPostId: "root-1", repliedToId: "parent-1" }],
    nextCursor: "next-1",
  });
  assert.deepEqual(await fetchThreadsMedia(fetcher, { accessToken: "secret", mediaId: "root-1", signal: AbortSignal.timeout(1_000) }), {
    id: "root-1", ownerId: "author-1", username: "meta", text: "", permalink: "https://www.threads.com/@meta/post/root1", timestamp: "2026-08-24T00:00:00+0000", mediaType: "CAROUSEL_ALBUM", mediaUrl: null, thumbnailUrl: null, children: ["child-image", "child-video"], quotedPostId: "quote-1", linkAttachmentUrl: "https://example.test/read", altText: "Root image", rootPostId: "root-1", repliedToId: "parent-1",
  });
  assert.deepEqual(await fetchThreadsConversationPage(fetcher, { accessToken: "secret", mediaId: "root-1", after: "cursor-1", signal: AbortSignal.timeout(1_000) }), {
    data: [{ id: "reply-1", ownerId: "author-1", username: "meta", text: "reply", permalink: "https://www.threads.com/@meta/post/root1", timestamp: "2026-08-24T00:00:00+0000", mediaType: "TEXT_POST", mediaUrl: null, thumbnailUrl: null, children: [], quotedPostId: null, linkAttachmentUrl: "https://example.test/read", altText: "Root image", rootPostId: "root-1", repliedToId: "root-1" }],
    nextCursor: null,
  });

  assert.equal(requests[0].url, "https://graph.threads.net/v1.0/oauth/access_token");
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].headers.get("authorization"), null);
  assert.equal(requests[0].headers.get("content-type"), "application/x-www-form-urlencoded;charset=UTF-8");
  assert.deepEqual(Object.fromEntries(new URLSearchParams(await requests[0].text())), { client_id: "client", client_secret: "secret", grant_type: "authorization_code", redirect_uri: "https://app.test/callback", code: "code" });
  assert.equal(requests[1].url, "https://graph.threads.net/v1.0/access_token?grant_type=th_exchange_token&client_secret=secret&access_token=short");
  assert.equal(requests[2].url, "https://graph.threads.net/v1.0/refresh_access_token?grant_type=th_refresh_token&access_token=long");
  assert.equal(requests[3].url, "https://graph.threads.net/v1.0/debug_token?input_token=long");
  assert.equal(requests[3].headers.get("authorization"), "Bearer long");
  assert.equal(requests[4].url, "https://graph.threads.net/v1.0/profile_lookup?fields=id%2Cusername%2Cname%2Cthreads_profile_picture_url&username=meta");
  assert.equal(requests[5].url, `https://graph.threads.net/v1.0/profile_posts?fields=${encodeURIComponent(fields)}&username=meta&after=before-1`);
  assert.equal(requests[6].url, `https://graph.threads.net/v1.0/root-1?fields=${encodeURIComponent(fields)}`);
  assert.equal(requests[7].url, `https://graph.threads.net/v1.0/root-1/conversation?fields=${encodeURIComponent(fields)}&after=cursor-1`);
  for (const request of requests.slice(4)) assert.equal(request.headers.get("authorization"), "Bearer secret");
  for (const request of requests) assert.equal(request.redirect, "manual");
});

test("rejects malformed success data and maps provider failures without leaking bearer secrets", async () => {
  for (const body of [
    { ...media, unexpected: true }, { ...media, id: "" }, { ...media, media_type: "AUDIO" },
    { ...media, timestamp: "not-a-time" }, { ...media, permalink: "https://evil.test/post/root1" }, { ...media, owner: {} },
    { ...media, children: { data: [{ id: "" }] } }, { ...media, is_quote_post: true, quoted_post: undefined },
  ]) await assert.rejects(
    fetchThreadsMedia(async () => Response.json(body), { accessToken: "secret-bearer", mediaId: "root-1", signal: AbortSignal.timeout(1_000) }),
    isAppError("threads_provider_protocol_error", 502),
  );
  /** @type {Array<[Response, string, number]>} */
  const failures = [
    [new Response(null, { status: 429, headers: { "Retry-After": "42" } }), "threads_rate_limited", 429],
    [new Response("secret provider body", { status: 401 }), "threads_reconnect_required", 401],
    [new Response(null, { status: 404 }), "threads_post_unavailable", 404],
    [new Response(null, { status: 500 }), "threads_provider_unavailable", 503],
  ];
  for (const [response, code, status] of failures) await assert.rejects(
    fetchThreadsMedia(async () => response, { accessToken: "secret-bearer", mediaId: "root-1", signal: AbortSignal.timeout(1_000) }),
    (error) => isAppError(code, status)(error) && error instanceof Error && !error.message.includes("secret-bearer") && !error.message.includes("body"),
  );
  await assert.rejects(
    fetchThreadsMedia(async () => { throw new DOMException("secret abort", "AbortError"); }, { accessToken: "secret-bearer", mediaId: "root-1", signal: AbortSignal.timeout(1_000) }),
    isAppError("threads_provider_unavailable", 503),
  );
});

test("caps JSON success bodies and accepts omitted media optionals as null or empty collections", async () => {
  let cancelInitiated = false;
  const result = fetchThreadsMedia(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(1_048_577).fill(97)); },
    cancel() { cancelInitiated = true; return new Promise(() => {}); },
  })), { accessToken: "secret", mediaId: "root-1", signal: AbortSignal.timeout(1_000) });
  await assert.rejects(result, isAppError("threads_provider_protocol_error", 502));
  assert.equal(cancelInitiated, true);
  const mapped = await fetchThreadsMedia(async () => Response.json({
    id: "minimal-1", media_product_type: "THREADS", media_type: "IMAGE",
    permalink: "https://www.threads.com/@meta/post/minimal1", owner: { id: "author-1" },
    username: "meta", text: "", timestamp: "2026-08-24T00:00:00+0000", shortcode: "minimal1",
  }), { accessToken: "secret", mediaId: "minimal-1", signal: AbortSignal.timeout(1_000) });
  assert.deepEqual({ mediaUrl: mapped.mediaUrl, thumbnailUrl: mapped.thumbnailUrl, children: mapped.children, quotedPostId: mapped.quotedPostId, linkAttachmentUrl: mapped.linkAttachmentUrl, altText: mapped.altText, rootPostId: mapped.rootPostId, repliedToId: mapped.repliedToId }, { mediaUrl: null, thumbnailUrl: null, children: [], quotedPostId: null, linkAttachmentUrl: null, altText: null, rootPostId: null, repliedToId: null });
});

test("resolves only bounded Threads short redirects and returns canonical inputs unchanged", async () => {
  const canonical = normalizeThreadsUrl("https://www.threads.com/@meta/post/root1");
  assert.equal(await resolveThreadsPostUrl(async () => assert.fail("canonical should not fetch"), canonical, AbortSignal.timeout(1_000)), canonical);
  const short = normalizeThreadsUrl("https://www.threads.com/t/RootShort");
  const resolved = await resolveThreadsPostUrl(async (input) => {
    assert.equal(new Request(input).url, "https://www.threads.com/t/RootShort");
    return new Response(null, { status: 302, headers: { Location: "https://www.threads.com/@meta/post/root1" } });
  }, short, AbortSignal.timeout(1_000));
  assert.deepEqual(resolved, normalizeThreadsUrl("https://www.threads.com/@meta/post/root1"));
  await assert.rejects(resolveThreadsPostUrl(async () => new Response(null, { status: 302, headers: { Location: "https://evil.test/t/no" } }), short, AbortSignal.timeout(1_000)), isAppError("threads_post_unavailable", 404));
});

test("contains injected fetch failures behind a fresh fixed unavailable error", async () => {
  const injected = new AppError("attacker_controlled", 418, { retryAfter: 999 });
  await assert.rejects(
    fetchThreadsMedia(async () => { throw injected; }, { accessToken: "secret", mediaId: "root-1", signal: AbortSignal.timeout(1_000) }),
    (error) => isAppError("threads_provider_unavailable", 503)(error) && error instanceof AppError && error !== injected && Object.keys(error.details).length === 0,
  );
});

test("uses conservative media-ID path segments and rejects unsafe values before fetching", async () => {
  /** @type {string[]} */ const paths = [];
  /** @type {(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>} */
  const fetcher = async (input) => {
    paths.push(new URL(new Request(input).url).pathname);
    return Response.json({ ...media, media_type: "VIDEO", id: "video_1", children: { data: [] } });
  };
  assert.equal((await fetchThreadsMedia(fetcher, { accessToken: "secret", mediaId: "video_1", signal: AbortSignal.timeout(1_000) })).mediaType, "VIDEO");
  assert.equal(paths[0], "/v1.0/video_1");
  for (const mediaId of [".", "..", "root/1", "root\\1", "root%2f1", "root?x=1", "root#x", " space "]) await assert.rejects(
    fetchThreadsConversationPage(async () => { assert.fail("unsafe media ID must not fetch"); }, { accessToken: "secret", mediaId, signal: AbortSignal.timeout(1_000) }),
    isAppError("threads_provider_protocol_error", 502),
  );
});

test("classifies Graph error envelopes without exposing their body and preserves an integer retry-after", async () => {
  /** @type {Array<[number, number, string, number]>} */
  const cases = [
    [400, 190, "threads_reconnect_required", 401], [403, 10, "threads_reconnect_required", 401],
    [400, 100, "threads_post_unavailable", 404], [403, 803, "threads_post_unavailable", 404],
    [403, 4, "threads_post_unavailable", 404],
  ];
  for (const [status, code, expectedCode, expectedStatus] of cases) await assert.rejects(
    fetchThreadsMedia(async () => Response.json({ error: { code, error_subcode: 7, message: "secret provider text", type: "OAuthException" } }, { status }), { accessToken: "secret", mediaId: "root-1", signal: AbortSignal.timeout(1_000) }),
    (error) => isAppError(expectedCode, expectedStatus)(error) && error instanceof Error && !error.message.includes("secret provider text"),
  );
  await assert.rejects(
    fetchThreadsMedia(async () => new Response(null, { status: 429, headers: { "Retry-After": "42" } }), { accessToken: "secret", mediaId: "root-1", signal: AbortSignal.timeout(1_000) }),
    (error) => isAppError("threads_rate_limited", 429)(error) && error instanceof AppError && error.details.retryAfter === 42,
  );
});

test("rejects malformed token, profile, page, and paging-next response shapes", async () => {
  await assert.rejects(exchangeThreadsCode(async () => Response.json({ access_token: "token", user_id: "user", extra: true }), { clientId: "client", clientSecret: "secret", redirectUri: "https://app.test/callback", code: "code", signal: AbortSignal.timeout(1_000) }), isAppError("threads_provider_protocol_error", 502));
  await assert.rejects(fetchThreadsProfile(async () => Response.json({ id: "author", username: "meta", name: 1, threads_profile_picture_url: null }), { accessToken: "secret", username: "meta", signal: AbortSignal.timeout(1_000) }), isAppError("threads_provider_protocol_error", 502));
  for (const next of [
    "https://user:pass@graph.threads.net/v1.0/profile_posts?after=cursor",
    "https://graph.threads.net/v1.0/profile_posts?after=cursor#secret",
  ]) await assert.rejects(
    fetchThreadsProfilePostsPage(async () => Response.json({ data: [], paging: { next } }), { accessToken: "secret", username: "meta", signal: AbortSignal.timeout(1_000) }),
    isAppError("threads_provider_protocol_error", 502),
  );
  await assert.rejects(fetchThreadsProfilePostsPage(async () => Response.json({ data: {}, paging: null }), { accessToken: "secret", username: "meta", signal: AbortSignal.timeout(1_000) }), isAppError("threads_provider_protocol_error", 502));
});

test("rejects malformed access-token debugger shapes without exposing token data", async () => {
  const valid = { ...officialDebugData, app_id: "app-1" };
  for (const data of [
    { ...valid, extra: true }, { ...valid, app_id: "" }, { ...valid, user_id: 1 },
    { ...valid, is_valid: "true" }, { ...valid, expires_at: 1.5 },
    { ...valid, scopes: "threads_basic" }, { ...valid, scopes: ["threads_basic", 1] },
    { ...valid, type: "" }, { ...valid, application: "a".repeat(257) },
    { ...valid, data_access_expires_at: -1 }, { ...valid, issued_at: 1.5 },
    { ...valid, granular_scopes: {} },
    { ...valid, granular_scopes: [{ scope: "threads_basic", extra: true }] },
    { ...valid, granular_scopes: [{}] },
    { ...valid, granular_scopes: [{ scope: "" }] },
    { ...valid, granular_scopes: [{ scope: "threads_basic", target_ids: "author-1" }] },
    { ...valid, granular_scopes: [{ scope: "threads_basic", target_ids: [""] }] },
  ]) await assert.rejects(
    debugThreadsAccessToken(async () => Response.json({ data }), { accessToken: "secret-debug-token", signal: AbortSignal.timeout(1_000) }),
    (error) => isAppError("threads_provider_protocol_error", 502)(error) && error instanceof Error && !error.message.includes("secret-debug-token"),
  );
  await assert.rejects(
    debugThreadsAccessToken(async () => Response.json({ data: valid, extra: true }), { accessToken: "secret-debug-token", signal: AbortSignal.timeout(1_000) }),
    isAppError("threads_provider_protocol_error", 502),
  );
});

test("maps the full official debugger fixture while returning only trusted critical fields", async () => {
  assert.deepEqual(await debugThreadsAccessToken(providerFixture({ threadsDebug: officialDebugData }), {
    accessToken: "long-token", signal: AbortSignal.timeout(1_000),
  }), {
    appId: "client", userId: "user-1", isValid: true,
    expiresAt: 5_184_100, scopes: THREADS_SCOPES,
  });
});

test("accepts three short redirects, cancels their bodies, and rejects a fourth", async () => {
  const short = normalizeThreadsUrl("https://www.threads.com/t/RootShort");
  let cancelled = 0;
  const locations = ["https://www.threads.com/t/one", "https://www.threads.com/t/two", "https://www.threads.com/@meta/post/root1"];
  const resolved = await resolveThreadsPostUrl(async () => new Response(new ReadableStream({
    cancel() { cancelled += 1; },
  }), { status: 302, headers: { Location: locations.shift() ?? "" } }), short, AbortSignal.timeout(1_000));
  assert.equal(resolved.kind, "canonical");
  assert.equal(cancelled, 3);
  await assert.rejects(resolveThreadsPostUrl(async () => new Response(null, { status: 302, headers: { Location: "https://www.threads.com/t/again" } }), short, AbortSignal.timeout(1_000)), isAppError("threads_post_unavailable", 404));
});

test("harness fixture rejects unknown cursors instead of replaying its first page", async () => {
  const fixture = providerFixture({
    threadsProfilePages: [{ data: [media], nextCursor: "cursor-1" }, { data: [] }],
  });
  const base = `https://graph.threads.net/v1.0/profile_posts?fields=${encodeURIComponent(fields)}&username=meta`;
  assert.equal((await fixture(`${base}&after=cursor-1`, { headers: { Authorization: "Bearer secret" } })).status, 200);
  await assert.rejects(fixture(`${base}&after=unknown`, { headers: { Authorization: "Bearer secret" } }), /Unexpected provider request/);
});
