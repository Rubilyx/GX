const metadata = {
  id: 9007199254740000,
  owner: { login: "OpenAI" }, name: "example",
  html_url: "https://github.com/OpenAI/example", description: "Example repository",
  homepage: null, default_branch: "main", language: "JavaScript",
  stargazers_count: 10, forks_count: 2, license: { spdx_id: "MIT" }, topics: ["example"],
  updated_at: "2026-08-09T00:00:00Z",
};

const analysis = {
  summary: "예제 저장소의 핵심 사용법을 보여준다.", problem: "작동하는 최소 예제가 필요하다.",
  values: ["구조가 단순하다."], audience: "JavaScript 개발자", cautions: "예제 목적의 저장소다.",
  primaryCategory: "Backend", tags: ["example"],
};

export default {
  /** @param {Request} request */
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.origin === "https://api.github.com" &&
      url.pathname === "/repos/OpenAI/example" && !url.search) {
      console.log("provider_fixture:github_metadata");
      return Response.json(metadata);
    }
    if (request.method === "GET" && url.origin === "https://api.github.com" && url.pathname === "/repos/OpenAI/example/readme" &&
      url.search === "?ref=main") {
      console.log("provider_fixture:github_readme");
      return new Response("# Example", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    if (request.method === "POST" && url.origin === "https://api.openai.com" && url.pathname === "/v1/responses" && !url.search) {
      console.log("provider_fixture:openai_response");
      return Response.json({
        model: "gpt-5.6-terra-test-snapshot",
        output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(analysis) }] }],
      });
    }
    return new Response("provider_fixture_unexpected_request", { status: 502 });
  },
};
