import { CATEGORIES } from "./domain.js";

const ESCAPE = Object.freeze({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
});
const ASSET = /^[a-z0-9][a-z0-9._-]*$/i;
const MESSAGE = Object.freeze({
  invalid_pin: "PIN이 올바르지 않습니다.",
  auth_locked: "로그인 시도가 잠겼습니다. 잠시 후 다시 시도하세요.",
  auth_guard_unavailable: "로그인을 확인할 수 없습니다. 잠시 후 다시 시도하세요.",
  repository_created: "저장소를 저장했습니다.",
  repository_already_saved: "이미 저장된 저장소입니다.",
  repository_updated: "분류와 메모를 저장했습니다.",
  repository_refreshed: "GitHub 정보와 분석을 새로고쳤습니다.",
  repository_analysis_error: "분석을 완료하지 못했지만 GitHub 정보는 저장했습니다.",
  repository_deleted: "저장소를 삭제했습니다.",
  analysis_rate_limited: "AI 분석 요청이 제한되었습니다. 잠시 후 다시 시도하세요.",
  analysis_timeout: "AI 분석 시간이 초과되었습니다. 다시 시도하세요.",
  analysis_provider_error: "AI 분석을 완료하지 못했습니다. 다시 시도하세요.",
  analysis_refused: "AI가 안전상의 이유로 분석을 거부했습니다.",
  analysis_invalid_output: "AI 분석 결과를 확인할 수 없습니다. 다시 시도하세요.",
  github_rate_limited: "GitHub 요청이 제한되었습니다. 잠시 후 다시 시도하세요.",
  github_unavailable: "GitHub 정보를 불러오지 못했습니다. 다시 시도하세요.",
});
const GENERIC_MESSAGE = "요청을 처리하지 못했습니다. 다시 시도하세요.";

/** @param {unknown} value */
export function htmlText(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ESCAPE[/** @type {keyof typeof ESCAPE} */ (character)]);
}

export const htmlAttr = htmlText;

/** @param {string} releaseId @param {string} filename */
export function assetHref(releaseId, filename) {
  if (!ASSET.test(releaseId) || !ASSET.test(filename)) throw new Error("invalid_asset_path");
  return `/assets/${releaseId}/${filename}`;
}

const ANALYSIS_STATUS = Object.freeze({
  ready: "분석 완료", pending: "분석 중", error: "분석 오류",
});

/** @param {unknown} status */
const statusKey = (status) => typeof status === "string" && Object.hasOwn(ANALYSIS_STATUS, status)
  ? /** @type {keyof typeof ANALYSIS_STATUS} */ (status) : null;

/** @param {unknown} status */
const statusText = (status) => {
  const key = statusKey(status);
  return key ? ANALYSIS_STATUS[key] : "상태 확인 필요";
};

/** @param {unknown} status */
const statusBadge = (status) => {
  const key = statusKey(status);
  return `<span class="analysis-badge"${key ? ` data-analysis-status="${key}"` : ""}><span class="status-marker" aria-hidden="true"></span>${statusText(status)}</span>`;
};

const statusMarker = '<span class="status-marker" aria-hidden="true"></span>';

/** @param {string} releaseId @param {string} page */
function styles(releaseId, page) {
  return ["layers.css", "tokens.css", "core.css", page]
    .map((name) => `<link rel="stylesheet" href="${assetHref(releaseId, name)}">`).join("");
}

/** @param {string} releaseId @param {string[]} [preloads] */
function appAssets(releaseId, preloads = []) {
  const links = preloads.map((name) =>
    `<link rel="modulepreload" href="${assetHref(releaseId, name)}">`).join("");
  return `${links}<script type="module" src="${assetHref(releaseId, "app.js")}"></script>`;
}

/** @param {{ releaseId: string, page: string, title: string, body: string, app?: boolean, modulePreloads?: string[] }} view */
function document({ releaseId, page, title, body, app = false, modulePreloads = [] }) {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${htmlText(title)}</title><link rel="icon" href="${assetHref(releaseId, "favicon.svg")}">${styles(releaseId, page)}${app ? appAssets(releaseId, modulePreloads) : ""}</head><body><a href="#main">본문으로 건너뛰기</a>${body}</body></html>`;
}

/** @param {string} value */
function csrf(value) {
  return `<input type="hidden" name="csrf" value="${htmlAttr(value)}">`;
}

/** @param {string} errorCode */
function messageFor(errorCode) {
  return Object.hasOwn(MESSAGE, errorCode)
    ? MESSAGE[/** @type {keyof typeof MESSAGE} */ (errorCode)] : GENERIC_MESSAGE;
}

/** @param {string} errorCode */
function errorStatus(errorCode) {
  const message = errorCode ? messageFor(errorCode) : "";
  return `<p role="status" aria-live="polite">${message ? `${statusMarker}${message}` : ""}</p>`;
}

/** @param {string[]} values @param {string} selected @param {string} emptyLabel */
function options(values, selected, emptyLabel) {
  return `<option value="">${htmlText(emptyLabel)}</option>${values.map((value) =>
    `<option value="${htmlAttr(value)}"${value === selected ? " selected" : ""}>${htmlText(value)}</option>`).join("")}`;
}

/** @param {string} csrfToken */
function logoutForm(csrfToken) {
  return `<form method="post" action="/session/logout">${csrf(csrfToken)}<button type="submit">로그아웃</button></form>`;
}

/** @param {{ releaseId: string, errorCode?: string }} view */
export function renderLoginPage({ releaseId, errorCode = "" }) {
  return document({
    releaseId, page: "login.css", title: "Repo Atlas 로그인",
    body: `<main id="main"><h1>Repo Atlas 로그인</h1>${errorStatus(errorCode)}<form method="post" action="/session"><label for="pin">6자리 PIN</label><input id="pin" name="pin" type="password" inputmode="numeric" pattern="[0-9]{6}" minlength="6" maxlength="6" autocomplete="current-password" required><button type="submit">접속</button></form></main>`,
  });
}

/** @param {any} repository */
function repositoryCard(repository) {
  const analysisStatus = statusKey(repository.analysisStatus);
  const summary = repository.summary || (analysisStatus === "error"
    ? "AI 분석 실패"
    : statusText(repository.analysisStatus));
  const owner = encodeURIComponent(repository.owner);
  const avatar = `https://github.com/${owner}.png?size=80`;
  const detail = `/repositories/${encodeURIComponent(repository.id)}`;
  const label = `${repository.owner}/${repository.name} 삭제`;
  const remove = `<a data-repository-delete href="${htmlAttr(`${detail}#delete-heading`)}" aria-label="${htmlAttr(label)}"><span aria-hidden="true">×</span></a>`;
  return `<article>${remove}<h2><img class="repository-avatar" src="${htmlAttr(avatar)}" alt="" width="45" height="45" loading="lazy" decoding="async" referrerpolicy="no-referrer"><span class="repository-title"><span class="repository-owner">${htmlText(repository.owner)}/</span><span class="repository-name">${htmlText(repository.name)}</span></span></h2><p data-analysis-summary-status="${analysisStatus}">${htmlText(summary)}</p><dl><dt>Primary category</dt><dd>${htmlText(repository.primaryCategory || "미분류")}</dd><dt>Tags</dt><dd>${htmlText(repository.tags?.join(", ") || "없음")}</dd><dt>Stars</dt><dd>${htmlText(repository.stars)}</dd><dt>Forks</dt><dd>${htmlText(repository.forks)}</dd><dt>Language</dt><dd>${htmlText(repository.primaryLanguage || "알 수 없음")}</dd><dt>Analysis status</dt><dd>${statusBadge(repository.analysisStatus)}</dd></dl><a data-repository-link href="${htmlAttr(detail)}">자세히 보기</a></article>`;
}

/** @param {{ q?: string, category?: string, tag?: string }} filters @param {number} page */
function pageHref(filters, page) {
  const query = new URLSearchParams();
  if (filters.q) query.set("q", filters.q);
  if (filters.category) query.set("category", filters.category);
  if (filters.tag) query.set("tag", filters.tag);
  query.set("page", String(page));
  return `/?${htmlAttr(query.toString())}`;
}

/** @param {{ q?: string, tag?: string }} filters @param {string} category */
function categoryHref(filters, category) {
  const query = new URLSearchParams();
  if (filters.q) query.set("q", filters.q);
  if (category) query.set("category", category);
  if (filters.tag) query.set("tag", filters.tag);
  query.set("page", "1");
  return `/?${htmlAttr(query.toString())}`;
}

/** @param {string[]} categories @param {{ q?: string, category?: string, tag?: string }} filter @param {{ all?: number, byCategory?: Record<string, number> }} [counts] */
function categoryFilter(categories, filter, counts = {}) {
  /** @type {Array<[string, string, number]>} */
  const chips = [["", "All", counts.all ?? 0], ...categories.map((category) =>
    /** @type {[string, string, number]} */
    ([category, category, counts.byCategory?.[category] ?? 0]))];
  return `<nav class="category-filter" aria-label="Primary category">${chips.map(([value, label, count]) =>
    `<a href="${categoryHref(filter, value)}"${value === filter.category ? ' aria-current="page"' : ""}>${htmlText(label)} ${htmlText(count)}</a>`).join("")}</nav>`;
}

/** @param {any} view */
export function renderIndexPage(view) {
  const repositories = view.repositories ?? [];
  const filter = view.filters ?? { q: "", category: "", tag: "" };
  const list = repositories.length
    ? `<section aria-labelledby="results"><h2 id="results">Repository</h2>${repositories.map(repositoryCard).join("")}</section>`
    : `<section><h2>저장한 저장소가 없습니다</h2><p role="status">${statusMarker}위 입력란에 공개 GitHub 저장소 URL을 넣어 첫 저장소를 추가하세요.</p></section>`;
  const deleteDialog = `<dialog data-repository-delete-dialog aria-labelledby="repository-delete-dialog-heading"><h2 id="repository-delete-dialog-heading">저장소 삭제</h2><p><strong data-repository-delete-name></strong> 저장소를 삭제하시겠습니까?</p><p>저장소와 개인 메모가 영구 삭제됩니다.</p><form method="post" data-repository-delete-form>${csrf(view.csrfToken)}<input type="hidden" name="confirm" value="yes"><button type="submit" class="button-danger" data-repository-delete-confirm disabled>삭제</button></form><form method="dialog"><button type="submit">취소</button></form></dialog>`;
  const pagination = view.totalPages > 1 ? `<nav aria-label="페이지">${view.page > 1 ? `<a rel="prev" href="${pageHref(filter, view.page - 1)}">이전</a>` : ""}<span>${htmlText(view.page)} / ${htmlText(view.totalPages)}</span>${view.page < view.totalPages ? `<a rel="next" href="${pageHref(filter, view.page + 1)}">다음</a>` : ""}</nav>` : "";
  const filterForm = `<repo-filter><form method="get" action="/"><label for="q"><span class="visually-hidden">검색</span><input id="q" name="q" type="search" maxlength="100" placeholder="검색" value="${htmlAttr(filter.q)}"></label><label for="tag"><span class="visually-hidden">태그</span><select id="tag" name="tag">${options(view.availableTags ?? [], filter.tag, "전체 태그")}</select></label><input type="hidden" name="page" value="${htmlAttr(view.page)}"><button type="submit">찾기</button></form></repo-filter>`;
  return document({
    releaseId: view.releaseId, page: "repositories.css", title: "Repo Atlas",
    app: true, modulePreloads: view.modulePreloads,
    body: `<main id="main"><header class="index-header"><h1>Repo Atlas</h1>${filterForm}${logoutForm(view.csrfToken)}</header>${errorStatus(view.flash)}<repo-capture><form method="post" action="/repositories">${csrf(view.csrfToken)}<label for="repository-url">GitHub 저장소 URL</label><input id="repository-url" name="url" type="url" inputmode="url" required autocomplete="off" placeholder="https://github.com/owner/repository"><button type="submit">저장</button><p data-capture-status role="status" aria-live="polite"><span data-capture-message></span></p></form></repo-capture><repo-panel>${categoryFilter(view.categories ?? CATEGORIES, filter, view.repositoryCounts)}${list}${pagination}<dialog data-repository-dialog aria-labelledby="repository-dialog-heading"><h2 id="repository-dialog-heading">저장소 상세</h2><label for="dialog-summary">요약</label><textarea id="dialog-summary" data-repository-summary readonly></textarea><label for="dialog-note">개인 메모</label><textarea id="dialog-note" data-repository-note readonly></textarea><a data-repository-detail-link hidden>상세 페이지 열기</a><form method="dialog"><button type="submit">닫기</button></form></dialog>${deleteDialog}</repo-panel></main>`,
  });
}

/** @param {any} repository */
function detail(repository) {
  /** @type {Array<[string, string, Array<[string, unknown]>]>} */
  const groups = [
    ["github-facts-heading", "GitHub 정보", [
      ["GitHub ID", repository.githubId], ["설명", repository.description],
      ["홈페이지", repository.homepageUrl], ["기본 브랜치", repository.defaultBranch],
      ["주 언어", repository.primaryLanguage], ["별", repository.stars],
      ["포크", repository.forks], ["라이선스", repository.licenseSpdx],
      ["GitHub 주제", repository.topics?.join(", ")], ["GitHub 갱신", repository.githubUpdatedAt],
      ["README SHA", repository.readmeSha], ["README 상태", repository.readmeStatus],
      ["소스 갱신", repository.sourceRefreshedAt],
    ]],
    ["analysis-facts-heading", "AI 분석", [
      ["요약", repository.summary], ["해결 문제", repository.problem],
      ["핵심 가치", repository.values?.join(" ")], ["대상", repository.audience],
      ["주의점", repository.cautions], ["분석 상태", statusText(repository.analysisStatus)],
      ["분석 오류", repository.analysisErrorCode ? messageFor(repository.analysisErrorCode) : null],
      ["분석 모델", repository.analysisModel], ["프롬프트 버전", repository.promptVersion],
      ["분석 시작", repository.analysisStartedAt], ["분석 완료", repository.analyzedAt],
      ["분석 세대", repository.analysisGeneration],
    ]],
    ["record-facts-heading", "내부 기록", [
      ["생성", repository.createdAt], ["갱신", repository.updatedAt],
    ]],
  ];
  return groups.map(([id, heading, entries]) =>
    `<section class="repository-facts" aria-labelledby="${id}"><h2 id="${id}">${heading}</h2><dl>${entries.map(([name, value]) => name === "분석 상태"
      ? `<dt>분석 상태</dt><dd>${statusBadge(repository.analysisStatus)}</dd>`
      : `<dt>${htmlText(name)}</dt><dd>${htmlText(value ?? "없음")}</dd>`).join("")}</dl></section>`).join("");
}

/** @param {any} view */
export function renderRepositoryPage(view) {
  const repository = view.repository;
  const path = `/repositories/${encodeURIComponent(repository.id)}`;
  const github = `https://github.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
  return document({
    releaseId: view.releaseId, page: "repositories.css",
    title: `${repository.owner}/${repository.name} - Repo Atlas`, app: true,
    modulePreloads: view.modulePreloads,
  body: `<main id="main"><p><a href="/">저장소 목록</a></p><h1>${htmlText(repository.owner)}/${htmlText(repository.name)}</h1>${errorStatus(view.flash)}<p><a href="${htmlAttr(github)}" rel="noreferrer">GitHub에서 열기</a></p>${detail(repository)}<section aria-labelledby="edit-heading"><h2 id="edit-heading">분류와 메모 편집</h2><form method="post" action="${path}">${csrf(view.csrfToken)}<label for="personal-note">개인 메모</label><textarea id="personal-note" name="personalNote" maxlength="4000">${htmlText(repository.personalNote)}</textarea><label for="primary-category">주 분류</label><select id="primary-category" name="primaryCategory" required>${options(view.categories ?? CATEGORIES, repository.primaryCategory, "분류 선택")}</select><label for="tags">태그 (쉼표로 구분)</label><input id="tags" name="tags" type="text" value="${htmlAttr(repository.tags?.join(", ") ?? "")}"><button type="submit">변경 저장</button></form></section><section aria-labelledby="refresh-heading"><h2 id="refresh-heading">다시 분석</h2><form method="post" action="${path}/refresh">${csrf(view.csrfToken)}<label><input type="checkbox" name="confirm" value="yes" required> AI 요약, 주 분류와 태그가 새 분석 결과로 교체됨을 확인합니다.</label><button type="submit">GitHub 정보와 분석 새로고침</button></form></section><section aria-labelledby="delete-heading"><h2 id="delete-heading">저장소 삭제</h2><form method="post" action="${path}/delete">${csrf(view.csrfToken)}<label><input type="checkbox" name="confirm" value="yes" required> 이 저장소와 개인 메모를 영구 삭제함을 확인합니다.</label><button type="submit" class="button-danger">저장소 삭제</button></form></section>${logoutForm(view.csrfToken)}</main>`,
  });
}
