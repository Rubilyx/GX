const metadata = { id: 9007199254740000, owner: { login: "OpenAI" }, name: "example", html_url: "https://github.com/OpenAI/example", description: "Example repository", homepage: null, default_branch: "main", language: "JavaScript", stargazers_count: 10, forks_count: 2, license: { spdx_id: "MIT" }, topics: ["example"], updated_at: "2026-08-09T00:00:00Z", pushed_at: "2026-08-08T00:00:00Z" };
const analysis = { summary: "예제 저장소의 핵심 사용법을 보여준다.", problem: "작동하는 최소 예제가 필요하다.", values: ["구조가 단순하다."], audience: "JavaScript 개발자", cautions: "예제 목적의 저장소다.", primaryCategory: "Backend", tags: ["example"] };
const fields = ["id", "media_product_type", "media_type", "media_url", "permalink", "owner", "username", "text", "timestamp", "shortcode", "thumbnail_url", "children", "is_quote_post", "quoted_post", "link_attachment_url", "alt_text", "root_post", "replied_to"].join(",");
const profileFields = "id,username,name,threads_profile_picture_url";
const root = { id: "root-1", media_product_type: "THREADS", media_type: "TEXT_POST", permalink: "https://www.threads.com/@meta/post/RootShort", owner: { id: "author-1" }, username: "meta", text: "Root", timestamp: "2026-08-24T00:00:00+0000", shortcode: "RootShort" };

/** @param {URL} url @param {string[]} keys */
function exactQuery(url, keys) { return [...url.searchParams.keys()].length === keys.length && keys.every((key) => url.searchParams.getAll(key).length === 1); }
/** @param {Request} request */
function bearer(request) { return /^Bearer\s+[^\s]+$/.test(request.headers.get("authorization") ?? ""); }
function unexpected() { console.log("provider_fixture:unexpected_request"); return new Response("provider_fixture_unexpected_request", { status: 502 }); }

export default {
  /** @param {Request} request */
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.origin === "https://api.github.com" && url.pathname === "/repos/OpenAI/example" && !url.search) { console.log("provider_fixture:github_metadata"); return Response.json(metadata); }
    if (request.method === "GET" && url.origin === "https://api.github.com" && url.pathname === "/repos/OpenAI/example/readme" && url.search === "?ref=main") { console.log("provider_fixture:github_readme"); return new Response("# Example", { headers: { "Content-Type": "text/plain; charset=utf-8" } }); }
    if (request.method === "POST" && url.origin === "https://api.openai.com" && url.pathname === "/v1/responses" && !url.search) { console.log("provider_fixture:openai_response"); return Response.json({ model: "gpt-5.6-terra-test-snapshot", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(analysis) }] }] }); }
    if (request.method === "GET" && url.origin === "https://www.threads.com" && url.pathname === "/t/RootShort" && !url.search && !request.headers.get("authorization")) { console.log("provider_fixture:threads_short_url"); return new Response(null, { status: 302, headers: { Location: "https://www.threads.com/@meta/post/RootShort" } }); }
    if (request.method === "POST" && url.origin === "https://graph.threads.net" && url.pathname === "/v1.0/oauth/access_token" && !url.search && !request.headers.get("authorization")) {
      const form = new URLSearchParams(await request.text());
      if ([...form.keys()].length !== 5 || !["client_id", "client_secret", "grant_type", "redirect_uri", "code"].every((key) => form.getAll(key).length === 1) || form.get("grant_type") !== "authorization_code") return unexpected();
      console.log("provider_fixture:threads_exchange_code"); return Response.json({ access_token: "short-token", user_id: "author-1" });
    }
    if (request.method === "GET" && url.origin === "https://graph.threads.net" && url.pathname === "/v1.0/access_token" && exactQuery(url, ["grant_type", "client_secret", "access_token"]) && url.searchParams.get("grant_type") === "th_exchange_token" && !request.headers.get("authorization")) { console.log("provider_fixture:threads_exchange_long_lived"); return Response.json({ access_token: "long-token", token_type: "bearer", expires_in: 5_184_000 }); }
    if (request.method === "GET" && url.origin === "https://graph.threads.net" && url.pathname === "/v1.0/refresh_access_token" && exactQuery(url, ["grant_type", "access_token"]) && url.searchParams.get("grant_type") === "th_refresh_token" && !request.headers.get("authorization")) { console.log("provider_fixture:threads_refresh_token"); return Response.json({ access_token: "refreshed-token", token_type: "bearer", expires_in: 5_184_000 }); }
    if (request.method === "GET" && url.origin === "https://graph.threads.net" && url.pathname === "/v1.0/profile_lookup" && exactQuery(url, ["fields", "username"]) && url.searchParams.get("fields") === profileFields && url.searchParams.get("username") === "meta" && bearer(request)) { console.log("provider_fixture:threads_profile"); return Response.json({ id: "author-1", username: "meta", name: "Meta", threads_profile_picture_url: "https://scontent.cdninstagram.com/fixture-avatar" }); }
    if (request.method === "GET" && url.origin === "https://graph.threads.net" && url.pathname === "/v1.0/profile_posts" && exactQuery(url, ["fields", "username"]) && url.searchParams.get("fields") === fields && url.searchParams.get("username") === "meta" && bearer(request)) { console.log("provider_fixture:threads_profile_posts"); return Response.json({ data: [root] }); }
    if (request.method === "GET" && url.origin === "https://graph.threads.net" && url.pathname === "/v1.0/root-1" && exactQuery(url, ["fields"]) && url.searchParams.get("fields") === fields && bearer(request)) { console.log("provider_fixture:threads_media"); return Response.json(root); }
    if (request.method === "GET" && url.origin === "https://graph.threads.net" && url.pathname === "/v1.0/root-1/conversation" && exactQuery(url, ["fields"]) && url.searchParams.get("fields") === fields && bearer(request)) { console.log("provider_fixture:threads_conversation"); return Response.json({ data: [] }); }
    if (request.method === "GET" && url.origin === "https://scontent.cdninstagram.com" && url.pathname === "/fixture-image" && !url.search && !request.headers.get("authorization")) { console.log("provider_fixture:threads_media_body"); return new Response("image"); }
    return unexpected();
  },
};
