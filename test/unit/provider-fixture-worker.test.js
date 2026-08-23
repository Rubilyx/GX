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
