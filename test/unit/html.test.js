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
    repositoryCounts: { all: 1, byCategory: { [repository.primaryCategory]: 1 } },
    page: 1, totalPages: 1, flash: "repository_created",
  });
  assert.match(html, /<link rel="icon" href="\/assets\/abc123\/favicon\.svg">/);
  assert.match(html, /<repo-capture>[\s\S]*<form[^>]*method="post"[^>]*action="\/repositories"/);
  const header = html.match(/<header class="index-header">[\s\S]*?<\/header>/)?.[0] ?? "";
  assert.match(header,
    /^<header class="index-header"><h1><a href="\/">Repo Atlas<\/a><\/h1><repo-filter>/);
  assert.match(header,
    /<repo-filter><form[^>]*method="get"[^>]*action="\/"[\s\S]*?<\/form><\/repo-filter>/);
  assert.match(header,
    /<\/repo-filter><form[^>]*method="post"[^>]*action="\/session\/logout"[\s\S]*?<\/form><\/header>$/);
  assert.match(html, /<button type="submit">저장<\/button>/);
  assert.doesNotMatch(html, /저장하고 요약하기/);
  assert.match(html, /<repo-filter>[\s\S]*<form[^>]*method="get"[^>]*action="\/"/);
  assert.match(html,
    /<label for="q"><span class="visually-hidden">검색<\/span><input id="q" name="q" type="search" maxlength="100" placeholder="검색" value=/);
  assert.match(html,
    /<label for="tag"><span class="visually-hidden">태그<\/span><select id="tag" name="tag">/);
  assert.doesNotMatch(html, /<label for="q">검색<input/);
  const filterIndex = html.indexOf("<repo-filter>");
  const captureIndex = html.indexOf("<repo-capture>");
  const categoriesIndex = html.indexOf('<nav class="category-filter" aria-label="Primary category">');
  const resultsIndex = html.indexOf('<h2 id="results">Repository</h2>');
  assert.ok(filterIndex < captureIndex);
  assert.ok(captureIndex < categoriesIndex);
  assert.ok(categoriesIndex < resultsIndex);
  assert.doesNotMatch(html, /id="category"|name="category"|>주 분류<select/);
  assert.match(html, /<h2 id="results">Repository<\/h2>/);
  assert.match(html, /name="csrf" value="csrf&quot;x"/);
  assert.match(html, /<form[^>]*method="post"[^>]*action="\/session\/logout"/);
  assert.match(html,
    /<img class="repository-avatar" src="https:\/\/github\.com\/a%2Fb%3Cscript%3E\.png\?size=80" alt="" width="45" height="45" loading="lazy" decoding="async" referrerpolicy="no-referrer">/);
  assert.match(html,
    /<span class="repository-title"><span class="repository-owner">a\/b&lt;script&gt;\/<\/span><span class="repository-name">x\?y&quot;&gt;&lt;img src=x&gt;<\/span><\/span>/);
  assert.doesNotMatch(html, /data-repository-source-link|target="_blank"/);
  assert.match(html,
    /<dl><dt>Primary category<\/dt><dd>[\s\S]*?<dt>Tags<\/dt>[\s\S]*?<dt>Stars<\/dt>[\s\S]*?<dt>Forks<\/dt>[\s\S]*?<dt>Language<\/dt>[\s\S]*?<dt>Analysis status<\/dt>/);
  const card = html.match(/<article[^>]*>[\s\S]*?<\/article>/)?.[0] ?? "";
  assert.match(card, /^<article data-analysis-card-status="error">/);
  assert.doesNotMatch(card, /data-repository-link/);
  assert.match(card, /<p data-analysis-summary-status="error">&lt;b&gt;summary&lt;\/b&gt;<\/p>/);
  assert.match(card,
    /<a data-repository-delete href="\/repositories\/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa#delete-heading" aria-label="[^"]+ 삭제"><span aria-hidden="true">×<\/span><\/a>/);
  for (const korean of ["주 분류", "태그", "별", "포크", "언어", "분석 상태"])
    assert.doesNotMatch(card, new RegExp(`<dt>${korean}<\\/dt>`));
  assert.match(html, /data-analysis-status="error"[^>]*><span class="status-marker" aria-hidden="true"><\/span>분석 오류<\/span>/);
  assert.match(html, /<dialog data-repository-dialog aria-labelledby="repository-dialog-heading">[\s\S]*<h2 id="repository-dialog-heading">저장소 상세<\/h2>/);
  const deleteDialog = html.match(
    /<dialog data-repository-delete-dialog[\s\S]*?<\/dialog>/,
  )?.[0] ?? "";
  assert.match(deleteDialog, /aria-labelledby="repository-delete-dialog-heading"/);
  assert.match(deleteDialog, /<strong data-repository-delete-name><\/strong>/);
  assert.match(deleteDialog, /<form method="post" data-repository-delete-form>/);
  assert.match(deleteDialog, /name="csrf" value="csrf&quot;x"/);
  assert.match(deleteDialog, /<input type="hidden" name="confirm" value="yes">/);
  assert.match(deleteDialog,
    /<button type="submit" class="button-danger" data-repository-delete-confirm disabled>삭제<\/button>/);
  assert.match(deleteDialog, /<form method="dialog"><button type="submit">취소<\/button><\/form>/);
  assert.doesNotMatch(deleteDialog, /<form[^>]+action=/);
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
  assert.match(html, />Backend&quot;&gt;&lt;script&gt; 1<\/a>/);
  assert.match(html, /category=Backend%22%3E%3Cscript%3E/);
  assert.match(html, /tag&quot;&gt;&lt;script&gt;/);

  const empty = renderIndexPage({
    releaseId: "abc123", modulePreloads: [], csrfToken: "csrf", repositories: [],
    filters: { q: "", category: "", tag: "", page: 1 }, categories: ["Backend"],
    availableTags: [], repositoryCounts: { all: 0, byCategory: {} },
    page: 1, totalPages: 1, flash: "",
  });
  assert.doesNotMatch(empty, /data-repository-link/);
  assert.doesNotMatch(empty, /data-repository-delete href=/);
  assert.match(empty, /<a data-repository-detail-link hidden>상세 페이지 열기<\/a>/);
  assert.match(empty, /<dialog data-repository-delete-dialog/);
  assert.match(empty, /class="status-marker" aria-hidden="true"/);
  assert.match(empty,
    /<nav class="category-filter" aria-label="Primary category"><a href="\/\?page=1" aria-current="page">All 0<\/a>/);
});

test("index category chips preserve filters and expose one active category", () => {
  const html = renderIndexPage({
    releaseId: "abc123", modulePreloads: [], csrfToken: "csrf", repositories: [repository],
    filters: { q: "llm tools", category: "Backend", tag: "python", page: 4 },
    categories: ["Backend", "Data & AI", "Empty"], availableTags: ["python"],
    repositoryCounts: { all: 4, byCategory: { Backend: 3, "Data & AI": 1 } },
    page: 4, totalPages: 4, flash: "",
  });
  const categoryNav = html.match(/<nav class="category-filter"[\s\S]*?<\/nav>/)?.[0] ?? "";
  assert.match(categoryNav,
    /<a href="\/\?q=llm\+tools&amp;tag=python&amp;page=1">All 4<\/a>/);
  assert.match(categoryNav,
    /<a href="\/\?q=llm\+tools&amp;category=Backend&amp;tag=python&amp;page=1" aria-current="page">Backend 3<\/a>/);
  assert.match(categoryNav,
    /<a href="\/\?q=llm\+tools&amp;category=Data\+%26\+AI&amp;tag=python&amp;page=1">Data &amp; AI 1<\/a>/);
  assert.match(categoryNav,
    /<a href="\/\?q=llm\+tools&amp;category=Empty&amp;tag=python&amp;page=1">Empty 0<\/a>/);
  assert.equal((categoryNav.match(/aria-current="page"/g) ?? []).length, 1);
});

test("index uses the terse analysis failure fallback", () => {
  const html = renderIndexPage({
    releaseId: "abc123", modulePreloads: [], csrfToken: "csrf",
    repositories: [{ ...repository, summary: null }],
    filters: { q: "", category: "", tag: "", page: 1 }, categories: ["Backend"],
    availableTags: [], page: 1, totalPages: 1, flash: "",
  });
  assert.match(html, /<p data-analysis-summary-status="error">AI 분석 실패<\/p>/);
  assert.doesNotMatch(html, /AI 분석을 완료하지 못했습니다/);
});

test("index omits detail links only from analysis error cards", () => {
  const html = renderIndexPage({
    releaseId: "abc123", modulePreloads: [], csrfToken: "csrf",
    repositories: [
      { ...repository, summary: null },
      {
        ...repository, id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        owner: "Ready", name: "repository", summary: "분석 완료 요약", analysisStatus: "ready",
      },
    ],
    filters: { q: "", category: "", tag: "", page: 1 }, categories: [],
    availableTags: [], page: 1, totalPages: 1, flash: "",
  });
  const cards = html.match(/<article[^>]*>[\s\S]*?<\/article>/g) ?? [];

  assert.equal(cards.length, 2);
  assert.match(cards[0], /^<article data-analysis-card-status="error">/);
  assert.doesNotMatch(cards[0], /data-repository-link/);
  assert.match(cards[1], /^<article>/);
  assert.match(cards[1],
    /<a data-repository-link href="\/repositories\/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb">자세히 보기<\/a>/);
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
  assert.match(html, /<p data-analysis-summary-status="error">AI 분석 실패<\/p>/);
  assert.match(html, /<nav aria-label="페이지">[\s\S]*<a rel="next"/);

  const detailHtml = renderRepositoryPage({
    releaseId: "abc123", modulePreloads: [], csrfToken: "csrf",
    repository: { ...repository, analysisStatus: "toString" }, categories: [], flash: "",
  });
  assert.doesNotMatch(detailHtml, /data-analysis-status=|function toString|native code/);
  assert.match(detailHtml, /<dt>분석 상태<\/dt><dd><span class="analysis-badge"><span class="status-marker" aria-hidden="true"><\/span>상태 확인 필요<\/span><\/dd>/);
});
