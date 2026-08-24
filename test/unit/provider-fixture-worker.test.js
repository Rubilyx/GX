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

test("provider fixture accepts only exact official Threads and media boundaries", async () => {
  const good = [
    new Request("https://www.threads.com/t/RootShort"),
    new Request("https://graph.threads.net/v1.0/oauth/access_token", { method: "POST", body: new URLSearchParams({ client_id: "client", client_secret: "secret", grant_type: "authorization_code", redirect_uri: "https://app.test/callback", code: "code" }) }),
    new Request("https://graph.threads.net/v1.0/access_token?grant_type=th_exchange_token&client_secret=secret&access_token=short"),
    new Request("https://graph.threads.net/v1.0/refresh_access_token?grant_type=th_refresh_token&access_token=long"),
    new Request("https://graph.threads.net/v1.0/debug_token?input_token=long-token", { headers: { Authorization: "Bearer long-token" } }),
    new Request("https://graph.threads.net/v1.0/profile_lookup?fields=id%2Cusername%2Cname%2Cthreads_profile_picture_url&username=meta", { headers: { Authorization: "Bearer secret" } }),
    new Request("https://graph.threads.net/v1.0/profile_posts?fields=id%2Cmedia_product_type%2Cmedia_type%2Cmedia_url%2Cpermalink%2Cowner%2Cusername%2Ctext%2Ctimestamp%2Cshortcode%2Cthumbnail_url%2Cchildren%2Cis_quote_post%2Cquoted_post%2Clink_attachment_url%2Calt_text%2Croot_post%2Creplied_to&username=meta&after=cursor-1", { headers: { Authorization: "Bearer secret" } }),
    new Request("https://scontent.cdninstagram.com/fixture-image"),
  ];
  for (const request of good) assert.notEqual((await fixture.fetch(request)).status, 502);
  for (const request of [
    new Request("https://graph.threads.net/v1.0/profile_lookup?fields=id&username=meta", { headers: { Authorization: "Bearer secret" } }),
    new Request("https://graph.threads.net/v1.0/profile_lookup?fields=id%2Cusername%2Cname%2Cthreads_profile_picture_url&username=meta", { method: "POST", headers: { Authorization: "Bearer secret" } }),
    new Request("https://graph.threads.net/v1.0/profile_lookup?fields=id%2Cusername%2Cname%2Cthreads_profile_picture_url&username=meta", { headers: { Authorization: "Basic secret" } }),
    new Request("https://graph.threads.net/v1.0/access_token?grant_type=th_exchange_token&client_secret=secret&access_token=short&extra=1"),
    new Request("https://graph.threads.net/v1.0/access_token?grant_type=th_exchange_token&client_secret=secret&access_token=short", { headers: { Authorization: "Bearer secret" } }),
    new Request("https://graph.threads.net/v1.0/debug_token?input_token=long-token&extra=1", { headers: { Authorization: "Bearer long-token" } }),
    new Request("https://graph.threads.net/v1.0/debug_token?input_token=long-token", { headers: { Authorization: "Bearer other-token" } }),
    new Request("https://graph.threads.net/v1.0/profile_posts?fields=id%2Cmedia_product_type%2Cmedia_type%2Cmedia_url%2Cpermalink%2Cowner%2Cusername%2Ctext%2Ctimestamp%2Cshortcode%2Cthumbnail_url%2Cchildren%2Cis_quote_post%2Cquoted_post%2Clink_attachment_url%2Calt_text%2Croot_post%2Creplied_to&username=meta&after=unknown", { headers: { Authorization: "Bearer secret" } }),
    new Request("https://graph.threads.net/v1.0/root-1", { method: "POST", headers: { Authorization: "Bearer secret" } }),
    new Request("https://scontent.cdninstagram.com/fixture-image?unexpected=1"),
  ]) assert.equal((await fixture.fetch(request)).status, 502);
});

test("provider fixture debugger returns the full official metadata shape", async () => {
  const response = await fixture.fetch(new Request(
    "https://graph.threads.net/v1.0/debug_token?input_token=long-token",
    { headers: { Authorization: "Bearer long-token" } },
  ));
  assert.deepEqual(await response.json(), { data: {
    app_id: "test-threads-app", type: "USER", application: "Repo Atlas",
    user_id: "author-1", data_access_expires_at: 1_999_000_000,
    expires_at: 2_000_000_000, issued_at: 1_900_000_000, is_valid: true,
    scopes: ["threads_basic", "threads_profile_discovery", "threads_read_replies"],
    granular_scopes: [
      { scope: "threads_basic" },
      { scope: "threads_profile_discovery", target_ids: ["author-1"] },
    ],
  } });
});

test("provider fixture exposes the canonical paginated Threads archive scenario", async () => {
  const projection = "id%2Cmedia_product_type%2Cmedia_type%2Cmedia_url%2Cpermalink%2Cowner%2Cusername%2Ctext%2Ctimestamp%2Cshortcode%2Cthumbnail_url%2Cchildren%2Cis_quote_post%2Cquoted_post%2Clink_attachment_url%2Calt_text%2Croot_post%2Creplied_to";
  const authorization = { Authorization: "Bearer fixture-token" };
  const profile = await fixture.fetch(new Request(
    `https://graph.threads.net/v1.0/profile_posts?fields=${projection}&username=meta`,
    { headers: authorization },
  ));
  const profileBody = /** @type {any} */ (await profile.json());
  assert.equal(profileBody.data[0].id, "root-1");
  assert.equal(profileBody.data[0].media_type, "CAROUSEL_ALBUM");
  assert.equal(profileBody.data[0].link_attachment_url, "https://example.com/archive");
  assert.deepEqual(profileBody.data[0].children.data.map(
    (/** @type {any} */ item) => item.id), [
    "root-image", "root-video",
  ]);

  const pages = [];
  for (const after of [null, "conversation-2", "conversation-3"]) {
    const suffix = after ? `&after=${after}` : "";
    const response = await fixture.fetch(new Request(
      `https://graph.threads.net/v1.0/root-1/conversation?fields=${projection}${suffix}`,
      { headers: authorization },
    ));
    assert.equal(response.status, 200);
    pages.push(/** @type {any} */ (await response.json()));
  }
  const replies = pages.flatMap((page) => page.data);
  assert.equal(replies.filter((reply) => reply.owner.id === "12345").length, 12);
  assert.deepEqual(replies.filter((reply) => reply.owner.id === "67890")
    .map((reply) => reply.id), ["other-reply-1", "other-reply-2"]);
  assert.deepEqual(pages.slice(0, 2).map((page) => page.paging.next), [
    "https://graph.threads.net/v1.0/root-1/conversation?after=conversation-2",
    "https://graph.threads.net/v1.0/root-1/conversation?after=conversation-3",
  ]);

  const quote = await fixture.fetch(new Request(
    `https://graph.threads.net/v1.0/shared-quote?fields=${projection}`,
    { headers: authorization },
  )).then((response) => response.json());
  assert.equal(quote.quoted_post.id, "nested-quote");
  const video = await fixture.fetch(new Request(
    `https://graph.threads.net/v1.0/root-video?fields=${projection}`,
    { headers: authorization },
  )).then((response) => response.json());
  assert.equal(video.media_url, "https://scontent.cdninstagram.com/fixture-video");
  assert.equal(video.thumbnail_url, "https://scontent.cdninstagram.com/fixture-thumbnail");

  for (const [path, contentType] of [
    ["fixture-avatar", "image/jpeg"], ["fixture-image", "image/jpeg"],
    ["fixture-video", "video/mp4"], ["fixture-thumbnail", "image/jpeg"],
  ]) {
    const response = await fixture.fetch(new Request(
      `https://scontent.cdninstagram.com/${path}`,
    ));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), contentType);
    assert.equal(Number(response.headers.get("content-length")),
      (await response.arrayBuffer()).byteLength);
  }
});

test("provider fixture exposes a deterministic corrupt image followed by a valid retry", async () => {
  const projection = "id%2Cmedia_product_type%2Cmedia_type%2Cmedia_url%2Cpermalink%2Cowner%2Cusername%2Ctext%2Ctimestamp%2Cshortcode%2Cthumbnail_url%2Cchildren%2Cis_quote_post%2Cquoted_post%2Clink_attachment_url%2Calt_text%2Croot_post%2Creplied_to";
  const headers = { Authorization: "Bearer fixture-token" };
  const profile = await fixture.fetch(new Request(
    `https://graph.threads.net/v1.0/profile_posts?fields=${projection}&username=meta`,
    { headers },
  )).then((response) => response.json());
  assert.equal(profile.data.some(
    (/** @type {any} */ item) => item.shortcode === "CorruptImage"), true);
  const conversation = await fixture.fetch(new Request(
    `https://graph.threads.net/v1.0/corrupt-root/conversation?fields=${projection}`,
    { headers },
  ));
  assert.deepEqual(await conversation.json(), { data: [] });

  const first = await fixture.fetch(new Request(
    "https://scontent.cdninstagram.com/fixture-corrupt",
  ));
  assert.equal(first.headers.get("content-length"), "4");
  assert.equal((await first.arrayBuffer()).byteLength, 3);
  const second = await fixture.fetch(new Request(
    "https://scontent.cdninstagram.com/fixture-corrupt",
  ));
  assert.equal(second.headers.get("content-length"), "4");
  assert.equal((await second.arrayBuffer()).byteLength, 4);
});
