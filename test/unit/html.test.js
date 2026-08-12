import assert from "node:assert/strict";
import test from "node:test";
import {
  assetHref, htmlAttr, htmlText, renderIndexPage, renderLoginPage, renderRepositoryPage,
} from "../../src/html.js";

const repository = {
  id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", githubId: `42<script>`, owner: `a/b<script>`,
  name: `x?y"><img src=x>`, description: `<script>alert("description")</script>`,
  homepageUrl: `https://example.test/?x=" onclick="alert(1)`, defaultBranch: `main<&`,
  primaryLanguage: `JS<script>`, stars: 1, forks: 2, licenseSpdx: `MIT<&`,
  topics: [`topic<script>`], githubUpdatedAt: `today<&`, readmeSha: `sha<script>`,
  readmeStatus: "ready", sourceRefreshedAt: 1, summary: `<b>summary</b>`, problem: `<i>problem</i>`,
  values: [`<em>value</em>`], audience: `<u>audience</u>`, cautions: `<strong>cautions</strong>`,
  primaryCategory: `Backend"><script>`, analysisStatus: "error", analysisErrorCode: `native secret <x>`,
  analysisModel: `model<script>`, promptVersion: `v1<&`, analysisStartedAt: null,
  analyzedAt: 2, personalNote: `</textarea><script>alert("note")</script>`,
  analysisGeneration: 1, createdAt: 1, updatedAt: 2, tags: [`tag"><script>`],
};

test("escapes text and attribute contexts", () => {
  assert.equal(htmlText(`<script>alert("x")</script>`), "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  assert.equal(htmlAttr(`x" autofocus onfocus="alert(1)`), "x&quot; autofocus onfocus=&quot;alert(1)");
  assert.equal(assetHref("abc123", "app.js"), "/assets/abc123/app.js");
  assert.throws(() => assetHref("../escape", "app.js"), /invalid_asset_path/);
});

test("login is a complete labeled PIN document without application script", () => {
  const html = renderLoginPage({ releaseId: "abc123", errorCode: "" });
  assert.match(html, /^<!doctype html><html lang="ko">/);
  assert.equal((html.match(/<main\b/g) ?? []).length, 1);
  assert.match(html, /<a href="#main">본문으로 건너뛰기<\/a>/);
  assert.match(html, /<label[^>]*for="pin"[^>]*>6자리 PIN<\/label>/);
  assert.match(html, /inputmode="numeric"/);
  assert.match(html, /pattern="\[0-9\]\{6\}"/);
  assert.match(html, /<link rel="icon" href="\/assets\/abc123\/favicon\.svg">/);
  assert.match(html, /layers\.css[\s\S]*tokens\.css[\s\S]*core\.css[\s\S]*login\.css/);
  assert.doesNotMatch(html, /<script/);
});

test("status messages are fixed Korean copy and never echo codes", () => {
  const invalidPin = renderLoginPage({ releaseId: "abc123", errorCode: "invalid_pin" });
  assert.match(invalidPin, /PIN이 올바르지 않습니다/);
  assert.match(invalidPin, /class="status-marker" aria-hidden="true"/);
  assert.doesNotMatch(invalidPin, /invalid_pin|요청을 처리하지 못했습니다/);
  const unknown = renderLoginPage({ releaseId: "abc123", errorCode: "native secret <x>" });
  assert.match(unknown, /요청을 처리하지 못했습니다/);
  assert.doesNotMatch(unknown, /native secret|&lt;x&gt;/);
  for (const prototypeName of ["constructor", "toString", "__proto__"]) {
    const prototype = renderLoginPage({ releaseId: "abc123", errorCode: prototypeName });
    assert.match(prototype, /요청을 처리하지 못했습니다\. 다시 시도하세요\./);
    assert.doesNotMatch(prototype, new RegExp(prototypeName));
  }
  for (const [code, message] of [
    ["analysis_refused", "AI가 안전상의 이유로 분석을 거부했습니다."],
    ["analysis_invalid_output", "AI 분석 결과를 확인할 수 없습니다. 다시 시도하세요."],
  ]) {
    const known = renderRepositoryPage({
      releaseId: "abc123", modulePreloads: [], csrfToken: "csrf",
      repository: { ...repository, analysisErrorCode: code },
      categories: [repository.primaryCategory], flash: "",
    });
    assert.match(known, new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(known, /class="status-marker" aria-hidden="true"/);
    assert.doesNotMatch(known, new RegExp(code));
  }
});

test("index exposes complete native forms and safe enhancement controls", () => {
  const html = renderIndexPage({
    releaseId: "abc123", modulePreloads: ["repo-capture.js"], csrfToken: `csrf"x`,
    repositories: [repository], filters: {
      q: `"><script>alert("q")</script>`, category: repository.primaryCategory,
      tag: repository.tags[0], page: 1,
    }, categories: [repository.primaryCategory], availableTags: repository.tags,
    page: 1, totalPages: 1, flash: "repository_created",
  });
  assert.match(html, /<link rel="icon" href="\/assets\/abc123\/favicon\.svg">/);
  assert.match(html, /<repo-capture>[\s\S]*<form[^>]*method="post"[^>]*action="\/repositories"/);
  assert.match(html, /<button type="submit">저장<\/button>/);
  assert.doesNotMatch(html, /저장하고 요약하기/);
  assert.match(html, /<repo-filter>[\s\S]*<form[^>]*method="get"[^>]*action="\/"/);
  assert.match(html, /name="csrf" value="csrf&quot;x"/);
  assert.match(html, /<form[^>]*method="post"[^>]*action="\/session\/logout"/);
  assert.match(html, /<repo-panel>[\s\S]*data-repository-link[^>]*href="\/repositories\/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"/);
  assert.match(html, /data-analysis-status="error"[^>]*><span class="status-marker" aria-hidden="true"><\/span>분석 오류<\/span>/);
  assert.match(html, /<dialog data-repository-dialog aria-labelledby="repository-dialog-heading">[\s\S]*<h2 id="repository-dialog-heading">저장소 상세<\/h2>/);
  assert.match(html, /<a data-repository-detail-link hidden>상세 페이지 열기<\/a>/);
  assert.doesNotMatch(html, /data-repository-detail-link[^>]*href=|data-repository-link href="\/"/);
  assert.match(html, /저장소를 저장했습니다/);
  assert.match(html, /class="status-marker" aria-hidden="true"/);
  assert.doesNotMatch(html, /repository_created|요청을 처리하지 못했습니다/);
  assert.match(html, /rel="modulepreload" href="\/assets\/abc123\/repo-capture\.js"/);
  assert.match(html, /<script type="module" src="\/assets\/abc123\/app\.js"><\/script>/);
  const captureStatus = html.match(/<p data-capture-status[^>]*>[\s\S]*?<\/p>/)?.[0] ?? "";
  assert.doesNotMatch(captureStatus, /status-marker/);
  assert.doesNotMatch(html, /<[^>]+\son(?:click|submit|change)=/);
  assert.doesNotMatch(html, /<script>alert|<img src|<b>summary|onclick=/);
  assert.match(html, /value="&quot;&gt;&lt;script&gt;alert\(&quot;q&quot;\)&lt;\/script&gt;"/);
  assert.match(html, /value="Backend&quot;&gt;&lt;script&gt;" selected/);
  assert.match(html, /tag&quot;&gt;&lt;script&gt;/);

  const empty = renderIndexPage({
    releaseId: "abc123", modulePreloads: [], csrfToken: "csrf", repositories: [],
    filters: { q: "", category: "", tag: "", page: 1 }, categories: ["Backend"],
    availableTags: [], page: 1, totalPages: 1, flash: "",
  });
  assert.doesNotMatch(empty, /data-repository-link/);
  assert.match(empty, /<a data-repository-detail-link hidden>상세 페이지 열기<\/a>/);
  assert.match(empty, /class="status-marker" aria-hidden="true"/);
});

test("repository document renders canonical GitHub URL and all native mutation forms", () => {
  const html = renderRepositoryPage({
    releaseId: "abc123", modulePreloads: [], csrfToken: "csrf",
    repository, categories: [repository.primaryCategory], flash: "repository_analysis_error",
  });
  assert.match(html, /href="https:\/\/github\.com\/a%2Fb%3Cscript%3E\/x%3Fy%22%3E%3Cimg%20src%3Dx%3E"/);
  assert.match(html, /action="\/repositories\/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"/);
  assert.match(html, /<dt>GitHub ID<\/dt><dd>42&lt;script&gt;<\/dd>/);
  assert.match(html, /<dt>README SHA<\/dt><dd>sha&lt;script&gt;<\/dd>/);
  assert.match(html, /<dt>분석 상태<\/dt><dd><span class="analysis-badge" data-analysis-status="error"><span class="status-marker" aria-hidden="true"><\/span>분석 오류<\/span><\/dd>/);
  assert.match(html, /<dt>분석 오류<\/dt><dd>요청을 처리하지 못했습니다\. 다시 시도하세요\.<\/dd>/);
  assert.match(html, /<section class="repository-facts" aria-labelledby="github-facts-heading">[\s\S]*?<h2 id="github-facts-heading">GitHub 정보<\/h2>[\s\S]*?<dt>GitHub ID<\/dt>/);
  assert.match(html, /<section class="repository-facts" aria-labelledby="analysis-facts-heading">[\s\S]*?<h2 id="analysis-facts-heading">AI 분석<\/h2>[\s\S]*?<dt>분석 상태<\/dt>/);
  assert.match(html, /<section class="repository-facts" aria-labelledby="record-facts-heading">[\s\S]*?<h2 id="record-facts-heading">내부 기록<\/h2>[\s\S]*?<dt>생성<\/dt>/);
  assert.match(html, /분석을 완료하지 못했지만 GitHub 정보는 저장했습니다/);
  assert.doesNotMatch(html, /repository_analysis_error|native secret|&lt;x&gt;/);
  const refresh = html.match(/<form method="post" action="[^"]+\/refresh">[\s\S]*?<\/form>/)?.[0] ?? "";
  const remove = html.match(/<form method="post" action="[^"]+\/delete">[\s\S]*?<\/form>/)?.[0] ?? "";
  assert.match(refresh, /name="confirm" value="yes" required/);
  assert.match(remove, /name="confirm" value="yes" required/);
  assert.match(remove, /<button type="submit" class="button-danger">저장소 삭제<\/button>/);
  assert.doesNotMatch(refresh, /영구 삭제/);
  assert.doesNotMatch(remove, /새 분석 결과/);
  assert.doesNotMatch(html, /<[^>]+\son(?:click|submit|change)=/);
  assert.doesNotMatch(html, /<script>alert|<img src|<b>summary|<\/textarea><script/);
});

test("analysis status hooks admit only fixed own values", () => {
  const repositories = ["ready", "pending", "error", "constructor"].map((analysisStatus, index) => ({
    ...repository, id: `repo-${index}`, githubId: String(index), name: `repo-${index}`,
    summary: null, analysisStatus,
  }));
  const html = renderIndexPage({
    releaseId: "abc123", modulePreloads: [], csrfToken: "csrf", repositories,
    filters: { q: "", category: "", tag: "", page: 1 }, categories: [],
    availableTags: [], page: 1, totalPages: 2, flash: "",
  });
  for (const status of ["ready", "pending", "error"])
    assert.equal((html.match(new RegExp(`data-analysis-status="${status}"`, "g")) ?? []).length, 1);
  assert.doesNotMatch(html, /data-analysis-status="constructor"|function Object|native code/);
  assert.match(html, /상태 확인 필요/);
  assert.match(html, /AI 분석을 완료하지 못했습니다\. 상세에서 다시 분석할 수 있습니다\./);
  assert.match(html, /<nav aria-label="페이지">[\s\S]*<a rel="next"/);

  const detailHtml = renderRepositoryPage({
    releaseId: "abc123", modulePreloads: [], csrfToken: "csrf",
    repository: { ...repository, analysisStatus: "toString" }, categories: [], flash: "",
  });
  assert.doesNotMatch(detailHtml, /data-analysis-status=|function toString|native code/);
  assert.match(detailHtml, /<dt>분석 상태<\/dt><dd><span class="analysis-badge"><span class="status-marker" aria-hidden="true"><\/span>상태 확인 필요<\/span><\/dd>/);
});
