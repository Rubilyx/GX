import assert from "node:assert/strict";
import test from "node:test";
import {
  assetHref, htmlAttr, htmlText, renderIndexPage, renderLoginPage, renderRepositoryNotesPage,
  renderRepositoryPage, renderThreadsDetailPage, renderThreadsIndexPage, repositoryActivity,
} from "../../src/html.js";

const repository = {
  id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", githubId: `42<script>`, owner: `a/b<script>`,
  name: `x?y"><img src=x>`, description: `<script>alert("description")</script>`,
  homepageUrl: `https://example.test/?x=" onclick="alert(1)`, defaultBranch: `main<&`,
  primaryLanguage: `JS<script>`, stars: 1, forks: 2, licenseSpdx: `MIT<&`,
  topics: [`topic<script>`], githubUpdatedAt: `today<&`, githubPushedAt: null,
  activityRefreshedAt: null,
  readmeSha: `sha<script>`,
  readmeStatus: "ready", sourceRefreshedAt: 1, summary: `<b>summary</b>`, problem: `<i>problem</i>`,
  values: [`<em>value</em>`], audience: `<u>audience</u>`, cautions: `<strong>cautions</strong>`,
  primaryCategory: `Backend"><script>`, analysisStatus: "error", analysisErrorCode: `native secret <x>`,
  analysisModel: `model<script>`, promptVersion: `v1<&`, analysisStartedAt: null,
  analyzedAt: 2, noteCount: 3, latestNote: `</textarea><script>alert("note")</script>`,
  analysisGeneration: 1, createdAt: 1, updatedAt: 2, tags: [`tag"><script>`],
};

const threadEntry = {
  id: "entry-1", sourceMediaId: "source-1", kind: "root", parentEntryId: null,
  author: {
    id: "author-1", username: "author<script>", displayName: "작성자 <script>",
    profileMedia: { status: "ready", contentType: "image/jpeg", etag: "etag", bytes: 12, errorCode: null },
  },
  text: "본문 <script> https://safe.example/path", permalink: "https://www.threads.net/@author/post/post-1",
  publishedAt: "2026-08-23T15:30:00.000Z", mediaType: "CAROUSEL_ALBUM", altText: null,
  nestedQuotePermalink: null,
  links: [{ url: "https://safe.example/path", source: "body", ordinal: 0 }],
  media: [
    { id: "image-1", sourceMediaId: "image-source", kind: "image", ordinal: 0, altText: "저장된 이미지", status: "ready" },
    { id: "video-1", sourceMediaId: "video-source", kind: "video", ordinal: 1, altText: "동영상 <script>", status: "ready" },
    { id: "thumbnail-1", sourceMediaId: "video-source", kind: "video_thumbnail", ordinal: 2, altText: null, status: "ready" },
    { id: "failed-1", sourceMediaId: "failed-source", kind: "image", ordinal: 3, altText: null, status: "error" },
    { id: "video-fallback", sourceMediaId: "fallback-source", kind: "video", ordinal: 4, altText: null, status: "ready" },
  ],
  quote: null,
};

const threadArchive = {
  id: "post-1", canonicalUrl: "https://www.threads.net/@author/post/post-1", status: "partial",
  errorCode: "threads_provider_unavailable", author: threadEntry.author, root: threadEntry,
  quote: {
    ...threadEntry, id: "quote-1", sourceMediaId: "quote-source", kind: "quote",
    parentEntryId: "entry-1", text: "인용 <b>본문</b>", media: [], links: [],
    author: { ...threadEntry.author, id: "quote-author", username: "quoted", displayName: "인용 작성자" },
  },
  firstReplies: Array.from({ length: 3 }, (_, index) => ({
    ...threadEntry, id: `reply-${index + 1}`, sourceMediaId: `reply-source-${index + 1}`,
    kind: "author_reply", parentEntryId: null, text: `답글 ${index + 1}`,
    publishedAt: `2026-08-23T15:3${index + 1}:00.000Z`, media: [], links: [], quote: null,
  })),
  replyCount: 12, mediaProgress: { expected: 5, ready: 4, failed: 1, pending: 0 },
  syncGeneration: 2, createdAt: 1, updatedAt: 2,
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
    /<img class="repository-avatar" src="https:\/\/avatars\.githubusercontent\.com\/a%2Fb%3Cscript%3E" alt="" width="48" height="48" loading="lazy" decoding="async" referrerpolicy="no-referrer">/);
  assert.match(html,
    /<span class="repository-title"><span class="repository-owner">a\/b&lt;script&gt;\/<\/span><span class="repository-name">x\?y&quot;&gt;&lt;img src=x&gt;<\/span><\/span>/);
  assert.doesNotMatch(html, /data-repository-source-link|target="_blank"/);
  assert.match(html,
    /<dl class="repository-metadata"><div data-repository-field="category"><dt>Primary category<\/dt><dd><span class="repository-badge repository-badge--primary">Backend&quot;&gt;&lt;script&gt;<\/span><\/dd><\/div>/);
  assert.match(html,
    /<div data-repository-field="tags"><dt>Tags<\/dt><dd><span class="repository-badge-list"><span class="repository-badge">tag&quot;&gt;&lt;script&gt;<\/span><\/span><\/dd><\/div>/);
  const card = html.match(/<article[^>]*>[\s\S]*?<\/article>/)?.[0] ?? "";
  assert.match(card, /^<article data-analysis-card-status="error">/);
  assert.match(card,
    /<div class="repository-actions"><a href="\/repositories\/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa">자세히 보기<\/a><a data-repository-link href="\/repositories\/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa\/notes">Note 3<\/a><\/div>/);
  assert.match(card,
    /<div class="repository-note-preview"><h3>Note<\/h3><p data-repository-note-preview>&lt;\/textarea&gt;&lt;script&gt;alert\(&quot;note&quot;\)&lt;\/script&gt;<\/p><\/div>/);
  assert.match(card, /<p data-analysis-summary-status="error">&lt;b&gt;summary&lt;\/b&gt;<\/p>/);
  assert.doesNotMatch(card, /<dt>Analysis status<\/dt>/);
  assert.match(card,
    /<a data-repository-delete href="\/repositories\/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa#delete-heading" aria-label="[^"]+ 삭제"><span aria-hidden="true">×<\/span><\/a>/);
  for (const korean of ["주 분류", "태그", "별", "포크", "언어", "분석 상태"])
    assert.doesNotMatch(card, new RegExp(`<dt>${korean}<\\/dt>`));
  const repositoryDialog = html.match(
    /<dialog data-repository-dialog[\s\S]*?<\/dialog>/,
  )?.[0] ?? "";
  assert.match(repositoryDialog, /aria-labelledby="repository-dialog-heading"/);
  assert.match(repositoryDialog, /<h2 id="repository-dialog-heading" data-repository-notes-heading>Note<\/h2>/);
  assert.match(repositoryDialog, /<p data-repository-notes-summary><\/p>/);
  assert.match(repositoryDialog,
    /<form method="post" data-repository-note-create-form>[\s\S]*name="csrf" value="csrf&quot;x"/);
  assert.match(repositoryDialog,
    /<textarea id="dialog-note" name="body" data-repository-note-create maxlength="4000" required><\/textarea>/);
  assert.match(repositoryDialog,
    /<p data-repository-note-status role="status" aria-live="polite"><\/p>/);
  assert.match(repositoryDialog, /<section data-repository-note-list><\/section>/);
  assert.match(repositoryDialog, /<nav data-repository-note-pagination aria-label="Note 페이지"><\/nav>/);
  assert.match(repositoryDialog, /<button type="submit" data-repository-note-create-save>저장<\/button>/);
  assert.match(repositoryDialog, /<button type="button" data-repository-dialog-close>닫기<\/button>/);
  assert.doesNotMatch(repositoryDialog, /personalNote|data-repository-summary|data-repository-note-form/);
  assert.match(html,
    /<dialog data-repository-note-delete-dialog[\s\S]*data-repository-note-delete-date[\s\S]*data-repository-note-delete-excerpt[\s\S]*data-repository-note-delete-form/);
  const deleteDialog = html.match(
    /<dialog data-repository-delete-dialog[\s\S]*?<\/dialog>/,
  )?.[0] ?? "";
  assert.match(deleteDialog,
    /aria-labelledby="repository-delete-dialog-heading" aria-describedby="repository-delete-dialog-warning"/);
  assert.match(deleteDialog,
    /<h2 id="repository-delete-dialog-heading">저장소를 삭제할까요\?<\/h2>/);
  assert.match(deleteDialog,
    /<p class="repository-delete-target"><span>삭제 대상<\/span><strong data-repository-delete-name><\/strong><\/p>/);
  assert.match(deleteDialog,
    /<p id="repository-delete-dialog-warning" class="repository-delete-warning">저장소와 모든 Note가 영구 삭제되며 복구할 수 없습니다\.<\/p>/);
  assert.match(deleteDialog, /<form method="post" data-repository-delete-form>/);
  assert.match(deleteDialog, /name="csrf" value="csrf&quot;x"/);
  assert.match(deleteDialog, /<input type="hidden" name="confirm" value="yes">/);
  assert.match(deleteDialog,
    /<button type="submit" class="button-danger" data-repository-delete-confirm disabled>저장소 삭제<\/button>/);
  assert.match(deleteDialog,
    /<div class="repository-delete-actions"><form method="dialog"><button type="submit" data-repository-delete-cancel autofocus>취소<\/button><\/form>[\s\S]*<form method="post" data-repository-delete-form>/);
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
  assert.doesNotMatch(empty, /class="status-marker" aria-hidden="true"/);
  assert.match(empty,
    /<section class="repository-empty"><h2>저장한 저장소가 없습니다<\/h2><p role="status">GitHub 저장소 URL 추가 필요<\/p><\/section>/);
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

test("index compacts card metadata without replacing AI failure content", () => {
  const html = renderIndexPage({
    releaseId: "abc123", modulePreloads: [], csrfToken: "csrf",
    repositories: [
      {
        ...repository, summary: null, description: "GitHub fallback must stay hidden",
        primaryCategory: null, tags: [], primaryLanguage: null,
        stars: 999, forks: 1_000,
      },
      {
        ...repository, id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        owner: "Ready", name: "repository", summary: "분석 완료 요약", analysisStatus: "ready",
        primaryCategory: "Design", tags: ["safe", `tag<script>`],
        primaryLanguage: "JavaScript", stars: 10_500, forks: 1_000_000,
      },
    ],
    filters: { q: "", category: "", tag: "", page: 1 }, categories: [],
    availableTags: [], page: 1, totalPages: 1, flash: "",
  });
  const cards = html.match(/<article[^>]*>[\s\S]*?<\/article>/g) ?? [];

  assert.equal(cards.length, 2);
  assert.match(cards[0], /^<article data-analysis-card-status="error">/);
  assert.match(cards[0], /<p data-analysis-summary-status="error">AI 분석 실패<\/p>/);
  assert.doesNotMatch(cards[0], /GitHub fallback must stay hidden|<dt>Analysis status<\/dt>/);
  assert.match(cards[0], /data-repository-field="stars"[\s\S]*?<dd>999<\/dd>/);
  assert.match(cards[0], /data-repository-field="forks"[\s\S]*?<dd>1K<\/dd>/);
  assert.match(cards[1], /^<article>/);
  assert.match(cards[1], /data-repository-field="stars"[\s\S]*?<dd>10\.5K<\/dd>/);
  assert.match(cards[1], /data-repository-field="forks"[\s\S]*?<dd>1M<\/dd>/);
  assert.match(cards[1], /<span class="repository-badge">tag&lt;script&gt;<\/span>/);
  assert.doesNotMatch(cards[1], /tag<script>/);
  assert.match(cards[0],
    /<div class="repository-actions"><a href="\/repositories\/[^"]+">자세히 보기<\/a><a data-repository-link href="\/repositories\/[^"]+\/notes">Note 3<\/a><\/div>/);
  assert.match(cards[1],
    /<div class="repository-actions"><a href="\/repositories\/[^"]+">자세히 보기<\/a><a data-repository-link href="\/repositories\/[^"]+\/notes">Note 3<\/a><\/div>/);
});

test("index cards show only the newest Note directly after the description", () => {
  const html = renderIndexPage({
    releaseId: "abc123", modulePreloads: [], csrfToken: "csrf",
    repositories: [
      { ...repository, noteCount: 2, latestNote: "첫 줄\n둘째 줄" },
      {
        ...repository, id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        githubId: "43", owner: "Empty", name: "note", noteCount: 0, latestNote: null,
      },
    ],
    filters: { q: "", category: "", tag: "", page: 1 }, categories: [],
    availableTags: [], page: 1, totalPages: 1, flash: "",
  });
  const [savedCard = "", emptyCard = ""] =
    html.match(/<article[^>]*>[\s\S]*?<\/article>/g) ?? [];

  assert.match(savedCard,
    /<p data-analysis-summary-status="error">[\s\S]*?<\/p><div class="repository-note-preview"><h3>Note<\/h3><p data-repository-note-preview>첫 줄\n둘째 줄<\/p><\/div>/);
  assert.match(savedCard, /<a data-repository-link href="[^"]+\/notes">Note 2<\/a>/);
  assert.doesNotMatch(emptyCard, /repository-note-preview|data-repository-note-preview|>None</);
  assert.match(emptyCard, /<a data-repository-link href="[^"]+\/notes">Note<\/a>/);
});

test("index cards show pushed activity with an accessible metadata-only refresh form", () => {
  const html = renderIndexPage({
    releaseId: "abc123", modulePreloads: [], csrfToken: "csrf",
    repositories: [{
      ...repository, githubPushedAt: "2026-08-20T00:00:00Z", activityRefreshedAt: 1,
    }],
    filters: { q: "", category: "", tag: "", page: 1 }, categories: [],
    availableTags: [], page: 1, totalPages: 1, flash: "",
    now: Date.parse("2026-08-23T00:00:00Z"),
  });

  assert.match(html,
    /<div data-repository-field="activity"><dt class="visually-hidden">Repository Activity<\/dt><dd><span data-repository-activity-value><time datetime="2026-08-20T00:00:00Z">3일 전 활동<\/time><\/span><form method="post" action="\/repositories\/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa\/activity" data-repository-activity-form><input type="hidden" name="csrf" value="csrf"><button type="submit" data-repository-activity-refresh aria-label="a\/b&lt;script&gt;\/x\?y&quot;&gt;&lt;img src=x&gt; 활동 새로고침"><svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M21 12a9 9 0 0 0-9-9 9\.75 9\.75 0 0 0-6\.74 2\.74L3 8"\/><path d="M3 3v5h5"\/><path d="M3 12a9 9 0 0 0 9 9 9\.75 9\.75 0 0 0 6\.74-2\.74L21 16"\/><path d="M16 16h5v5"\/><\/svg><\/button><\/form><span class="visually-hidden" data-repository-activity-status role="status" aria-live="polite"><\/span><\/dd><\/div>/);
});

test("index cards mark pre-migration activity as requiring synchronization", () => {
  const html = renderIndexPage({
    releaseId: "abc123", modulePreloads: [], csrfToken: "csrf",
    repositories: [{ ...repository, githubPushedAt: null, activityRefreshedAt: null }],
    filters: { q: "", category: "", tag: "", page: 1 }, categories: [],
    availableTags: [], page: 1, totalPages: 1, flash: "",
  });

  assert.match(html,
    /<span data-repository-activity-value>활동 동기화 필요<\/span>/);
});

test("index cards distinguish a synchronized repository with no pushes", () => {
  const html = renderIndexPage({
    releaseId: "abc123", modulePreloads: [], csrfToken: "csrf",
    repositories: [{ ...repository, githubPushedAt: null, activityRefreshedAt: 1 }],
    filters: { q: "", category: "", tag: "", page: 1 }, categories: [],
    availableTags: [], page: 1, totalPages: 1, flash: "",
  });

  assert.match(html,
    /<span data-repository-activity-value>활동 내역 없음<\/span>/);
});

test("repository activity formats invalid, future, and exact unit boundaries", () => {
  const now = Date.parse("2026-08-23T00:00:00Z");
  assert.equal(repositoryActivity("invalid", now), null);
  assert.equal(repositoryActivity("2026-08-24T00:00:00Z", now), "방금 활동");
  /** @type {Array<[number, string]>} */
  const boundaries = [
    [60_000, "1분 전 활동"],
    [60 * 60_000, "1시간 전 활동"],
    [30 * 24 * 60 * 60_000, "1개월 전 활동"],
    [365 * 24 * 60 * 60_000, "1년 전 활동"],
  ];
  for (const [elapsed, expected] of boundaries)
    assert.equal(repositoryActivity(new Date(now - elapsed).toISOString(), now), expected);
});

test("repository document renders canonical GitHub URL and all native mutation forms", () => {
  const html = renderRepositoryPage({
    releaseId: "abc123", modulePreloads: [], csrfToken: "csrf",
    repository, categories: [repository.primaryCategory], flash: "repository_analysis_error",
  });
  assert.match(html, /href="https:\/\/github\.com\/a%2Fb%3Cscript%3E\/x%3Fy%22%3E%3Cimg%20src%3Dx%3E"/);
  assert.match(html, /action="\/repositories\/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"/);
  assert.match(html, /<h2 id="edit-heading">분류 편집<\/h2>/);
  assert.match(html,
    /<a href="\/repositories\/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa\/notes">Note 관리<\/a>/);
  assert.match(html, /<nav class="app-navigation" aria-label="주요 메뉴"><a href="\/" aria-current="page">Repository<\/a><a href="\/threads">Threads<\/a><\/nav>/);
  assert.doesNotMatch(html, /personalNote|personal-note|개인 메모/);
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
  assert.match(remove, /이 저장소와 모든 Note를 영구 삭제/);
});

test("repository Note page renders escaped CRUD forms, Seoul dates, and numbered pagination", () => {
  const notes = Array.from({ length: 5 }, (_, index) => ({
    id: `${index + 1}`.repeat(8) + "-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    repositoryId: repository.id,
    body: index === 0 ? `<script>alert("note")</script>`
      : index === 1 ? "가".repeat(90) : `Note ${index + 1}`,
    createdAt: 1_787_410_800 - index,
    updatedAt: index === 0 ? 1_787_410_801 : 1_787_410_800 - index,
  }));
  const html = renderRepositoryNotesPage({
    releaseId: "abc123", modulePreloads: [], csrfToken: `csrf"x`,
    repository, notes, page: 2, totalPages: 3, total: 12,
    flash: "repository_note_updated",
  });

  assert.match(html,
    /<h1 data-repository-notes-heading>a\/b&lt;script&gt;\/x\?y&quot;&gt;&lt;img src=x&gt; Note<\/h1>/);
  assert.match(html, /<nav class="app-navigation" aria-label="주요 메뉴"><a href="\/" aria-current="page">Repository<\/a><a href="\/threads">Threads<\/a><\/nav>/);
  assert.match(html, /<p data-repository-notes-summary>&lt;b&gt;summary&lt;\/b&gt;<\/p>/);
  assert.match(html,
    /<form method="post" action="\/repositories\/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa\/notes" data-repository-note-create-form>/);
  assert.match(html,
    /<textarea id="new-note" name="body" data-repository-note-create maxlength="4000" required><\/textarea>/);
  assert.match(html, /name="csrf" value="csrf&quot;x"/);
  assert.match(html, /<p data-repository-note-status role="status" aria-live="polite">/);
  assert.equal((html.match(/<li data-repository-note-item/g) ?? []).length, 5);
  assert.match(html, /<p class="repository-note-body">&lt;script&gt;alert\(&quot;note&quot;\)&lt;\/script&gt;<\/p>/);
  assert.match(html, /<time datetime="2026-08-23">2026\.08\.23<\/time>/);
  assert.match(html, /수정 <time datetime="2026-08-23">2026\.08\.23<\/time>/);
  assert.equal((html.match(/<p class="repository-note-meta">/g) ?? []).length, 5);
  assert.match(html,
    /action="\/repositories\/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa\/notes\/11111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa"/);
  assert.match(html,
    /<textarea id="note-body-11111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa" name="body" maxlength="4000" required>&lt;script&gt;alert\(&quot;note&quot;\)&lt;\/script&gt;<\/textarea>/);
  const nativeDelete = html.match(
    /<details data-repository-note-native-delete[\s\S]*?<\/details>/,
  )?.[0] ?? "";
  assert.match(nativeDelete, /<summary data-repository-note-delete>삭제<\/summary>/);
  assert.match(nativeDelete,
    /role="group" aria-labelledby="note-delete-heading-11111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa"/);
  assert.match(nativeDelete, /Note를 삭제할까요\?/);
  assert.match(nativeDelete, /작성 <time datetime="2026-08-23">2026\.08\.23<\/time>/);
  assert.match(nativeDelete, /data-repository-note-native-delete-excerpt/);
  assert.match(nativeDelete,
    /action="\/repositories\/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa\/notes\/11111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa\/delete"/);
  assert.match(nativeDelete, /<input type="hidden" name="confirm" value="yes">/);
  assert.match(nativeDelete, /<button type="submit" class="button-danger">Note 영구 삭제<\/button>/);
  assert.match(html, new RegExp(
    `<p data-repository-note-delete-excerpt data-repository-note-native-delete-excerpt>${"가".repeat(80)}<\\/p>`,
  ));
  assert.doesNotMatch(html, new RegExp(`${"가".repeat(80)}…`));
  const pagination = html.match(
    /<nav class="repository-note-pagination" data-repository-note-pagination[\s\S]*?<\/nav>/,
  )?.[0] ?? "";
  assert.match(pagination, /<a rel="prev" href="[^\"]+\?page=1">이전<\/a>/);
  assert.match(pagination, /href="[^\"]+\?page=1">1<\/a>/);
  assert.match(pagination, /href="[^\"]+\?page=2" aria-current="page">2<\/a>/);
  assert.match(pagination, /href="[^\"]+\?page=3">3<\/a>/);
  assert.match(pagination, /<a rel="next" href="[^\"]+\?page=3">다음<\/a>/);
  assert.match(html, /Note를 수정했습니다/);
  assert.doesNotMatch(html, /<script>alert|onclick=/);
});

test("repository Note page renders an actionable empty state", () => {
  const html = renderRepositoryNotesPage({
    releaseId: "abc123", modulePreloads: [], csrfToken: "csrf",
    repository: { ...repository, summary: null }, notes: [], page: 1, totalPages: 1, total: 0,
    flash: "",
  });
  assert.match(html,
    /<section data-repository-note-list data-empty="true"><h2 id="repository-note-list-heading" data-repository-note-list-heading>저장한 Note가 없습니다<\/h2>/);
  assert.match(html, /첫 Note를 작성하세요/);
  assert.doesNotMatch(html, /<li data-repository-note-item|data-repository-note-pagination/);
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
    assert.equal((html.match(new RegExp(`data-analysis-summary-status="${status}"`, "g")) ?? []).length, 1);
  assert.equal((html.match(/data-analysis-card-status="error"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /data-analysis-(?:summary-)?status="constructor"|function Object|native code/);
  assert.doesNotMatch(html, /<dt>Analysis status<\/dt>|data-analysis-status=/);
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

test("Threads index renders semantic archived cards, native controls, and safe media", () => {
  const html = renderThreadsIndexPage({
    releaseId: "abc123", csrfToken: `csrf"x`, connected: true,
    archives: [threadArchive], page: 1, totalPages: 2, flash: "threads_capture_queued",
  });
  assert.match(html, /<nav class="app-navigation" aria-label="주요 메뉴">[\s\S]*Repository[\s\S]*Threads[\s\S]*<\/nav>/);
  assert.match(html, /<a href="\/threads" aria-current="page">Threads<\/a>/);
  assert.match(html, /<form method="post" action="\/threads\/disconnect">[\s\S]*Threads 연결 해제/);
  assert.match(html, /<form method="post" action="\/threads">[\s\S]*name="url" type="url"/);
  assert.match(html, /<thread-capture class="thread-capture">[\s\S]*data-thread-capture-message/);
  assert.match(html, /<thread-panel>[\s\S]*data-thread-archive-list/);
  assert.match(html, /<article data-thread-archive data-thread-id="post-1" data-thread-status="partial">/);
  assert.match(html, /data-thread-progress>미디어 4\/5 준비 · 실패 1/);
  assert.match(html, /<img data-thread-author-image src="\/threads\/post-1\/media\/author-1" alt=""/);
  assert.match(html, /data-thread-author-name>작성자 &lt;script&gt;<\/strong>/);
  assert.match(html, /data-thread-author-username>@author&lt;script&gt;<\/span>/);
  assert.match(html, /<time data-thread-published-at datetime="2026-08-23T15:30:00\.000Z">2026\.08\.24<\/time>/);
  assert.match(html, /<p data-thread-text>본문 &lt;script&gt; <a href="https:\/\/safe\.example\/path" rel="noreferrer">https:\/\/safe\.example\/path<\/a><\/p>/);
  assert.match(html, /<img src="\/threads\/post-1\/media\/image-1" alt="저장된 이미지"/);
  assert.match(html, /<video controls preload="metadata" poster="\/threads\/post-1\/media\/thumbnail-1" aria-label="동영상 &lt;script&gt;"><source src="\/threads\/post-1\/media\/video-1">동영상 &lt;script&gt;<\/video>/);
  assert.match(html, /<video controls preload="metadata" aria-label="보관된 Threads 동영상"><source src="\/threads\/post-1\/media\/video-fallback">보관된 Threads 동영상<\/video>/);
  assert.match(html, /<section data-thread-quote><p data-thread-text>인용 &lt;b&gt;본문&lt;\/b&gt;<\/p><\/section>/);
  assert.equal((html.match(/data-thread-author-reply/g) ?? []).length, 3);
  assert.match(html, /href="\/threads\/post-1#author-replies">작성자 답글 12개 모두 보기<\/a>/);
  assert.match(html, /<form method="post" action="\/threads\/post-1\/sync" data-thread-sync-form>/);
  assert.match(html, /<form method="post" action="\/threads\/post-1\/media\/failed-1\/retry" data-thread-retry-form>/);
  assert.match(html, /<details data-thread-delete>[\s\S]*action="\/threads\/post-1\/delete"[\s\S]*name="confirm" value="yes"/);
  assert.equal((html.match(/data-thread-delete-dialog/g) ?? []).length, 1);
  assert.match(html, /<dialog data-thread-delete-dialog>[\s\S]*data-thread-delete-author[\s\S]*data-thread-delete-date/);
  assert.match(html, /data-thread-delete-confirm[^>]*disabled/);
  assert.match(html, /data-thread-list-heading[^>]*tabindex="-1"/);
  assert.match(html, /Threads 가져오기를 대기열에 추가했습니다/);
  assert.doesNotMatch(html, /threads\.net\/embed|cdninstagram\.com|<script[^>]+src="https:|profile_r2_key|https:\/\/www\.threads\.net\/@author/);
});

test("Threads detail paginates twenty chronological replies and retains shared Repository navigation", () => {
  const replies = Array.from({ length: 20 }, (_, index) => ({
    ...threadEntry, id: `detail-reply-${index + 1}`, sourceMediaId: `detail-source-${index + 1}`,
    kind: "author_reply", parentEntryId: null, text: `상세 답글 ${index + 1}`,
    publishedAt: `2026-08-23T15:${String(index).padStart(2, "0")}:00.000Z`, media: [], links: [], quote: null,
  }));
  const html = renderThreadsDetailPage({
    releaseId: "abc123", csrfToken: "csrf", connected: false, archive: threadArchive,
    replies, repliesPage: 2, totalReplyPages: 3, totalReplies: 45, flash: "threads_disconnected",
  });
  assert.match(html, /<a href="\/">Repository<\/a>/);
  assert.match(html, /<a href="\/threads" aria-current="page">Threads<\/a>/);
  assert.match(html, /<a class="thread-connection-action" href="\/threads\/connect">Threads 연결하기<\/a>/);
  assert.equal((html.match(/data-thread-author-reply/g) ?? []).length, 20);
  assert.match(html, /<nav class="thread-reply-pagination" aria-label="작성자 답글 페이지">[\s\S]*repliesPage=1[\s\S]*repliesPage=2" aria-current="page"[\s\S]*repliesPage=3/);
  assert.match(html, /Threads 연결을 해제했습니다/);
  assert.doesNotMatch(html, /<script[^>]+src="https:|threads\.net\/embed|cdninstagram\.com/);
  assert.match(html, /<thread-panel>[\s\S]*<dialog data-thread-delete-dialog>/);
});

test("Threads empty state exposes the progressive capture and deletion focus targets", () => {
  const html = renderThreadsIndexPage({
    releaseId: "abc123", modulePreloads: [], csrfToken: "csrf", connected: false,
    archives: [], page: 1, totalPages: 1, flash: "",
  });
  assert.match(html, /<thread-capture class="thread-capture">/);
  assert.match(html, /data-thread-empty-heading tabindex="-1">보관한 Threads가 없습니다/);
  assert.equal((html.match(/<dialog data-thread-delete-dialog>/g) ?? []).length, 1);
});
