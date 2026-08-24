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
  repository_updated: "분류를 저장했습니다.",
  repository_note_created: "Note를 저장했습니다.",
  repository_note_updated: "Note를 수정했습니다.",
  repository_note_deleted: "Note를 삭제했습니다.",
  repository_activity_refreshed: "저장소 활동을 새로고쳤습니다.",
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
  threads_connected: "Threads를 연결했습니다.",
  threads_disconnected: "Threads 연결을 해제했습니다.",
  threads_capture_queued: "Threads 가져오기를 대기열에 추가했습니다.",
  threads_sync_queued: "Threads 동기화를 대기열에 추가했습니다.",
  threads_retry_queued: "Threads 미디어 재시도를 대기열에 추가했습니다.",
  threads_delete_queued: "Threads 삭제를 대기열에 추가했습니다.",
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

/** @param {"repository" | "threads"} active */
function appNavigation(active) {
  return `<nav class="app-navigation" aria-label="주요 메뉴"><a href="/"${active === "repository" ? ' aria-current="page"' : ""}>Repository</a><a href="/threads"${active === "threads" ? ' aria-current="page"' : ""}>Threads</a></nav>`;
}

/** @param {{ releaseId: string, errorCode?: string }} view */
export function renderLoginPage({ releaseId, errorCode = "" }) {
  return document({
    releaseId, page: "login.css", title: "Repo Atlas 로그인",
    body: `<main id="main"><h1>Repo Atlas 로그인</h1>${errorStatus(errorCode)}<form method="post" action="/session"><label for="pin">6자리 PIN</label><input id="pin" name="pin" type="password" inputmode="numeric" pattern="[0-9]{6}" minlength="6" maxlength="6" autocomplete="current-password" required><button type="submit">접속</button></form></main>`,
  });
}

/** @param {number} value */
function compactMetric(value) {
  if (value < 1_000) return String(value);
  const divisor = value < 1_000_000 ? 1_000 : 1_000_000;
  const suffix = value < 1_000_000 ? "K" : "M";
  const scaled = Math.round((value / divisor) * 10) / 10;
  return `${scaled}${suffix}`;
}

/** @param {unknown} value @param {number} now */
export function repositoryActivity(value, now) {
  const updatedAt = Date.parse(String(value ?? ""));
  if (!Number.isFinite(updatedAt)) return null;
  const elapsed = Math.max(0, now - updatedAt);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (elapsed < minute) return "방금 활동";
  if (elapsed < hour) return `${Math.floor(elapsed / minute)}분 전 활동`;
  if (elapsed < day) return `${Math.floor(elapsed / hour)}시간 전 활동`;
  if (elapsed < 30 * day) return `${Math.floor(elapsed / day)}일 전 활동`;
  if (elapsed < 365 * day) return `${Math.floor(elapsed / (30 * day))}개월 전 활동`;
  return `${Math.floor(elapsed / (365 * day))}년 전 활동`;
}

/** @param {any} repository @param {number} now @param {string} csrfToken */
function repositoryCard(repository, now, csrfToken) {
  const analysisStatus = statusKey(repository.analysisStatus);
  const summary = repository.summary || (analysisStatus === "error"
    ? "AI 분석 실패"
    : statusText(repository.analysisStatus));
  const owner = encodeURIComponent(repository.owner);
  const avatar = `https://avatars.githubusercontent.com/${owner}`;
  const detail = `/repositories/${encodeURIComponent(repository.id)}`;
  const label = `${repository.owner}/${repository.name} 삭제`;
  const remove = `<a data-repository-delete href="${htmlAttr(`${detail}#delete-heading`)}" aria-label="${htmlAttr(label)}"><span aria-hidden="true">×</span></a>`;
  const cardStatus = analysisStatus === "error" ? ' data-analysis-card-status="error"' : "";
  const category = repository.primaryCategory || "미분류";
  /** @type {string[]} */
  const tags = repository.tags?.length ? repository.tags : ["없음"];
  const tagBadges = tags.map((tag) =>
    `<span class="repository-badge">${htmlText(tag)}</span>`).join("");
  const activity = repositoryActivity(repository.githubPushedAt, now);
  const activityValue = repository.activityRefreshedAt === null ||
    repository.activityRefreshedAt === undefined
    ? "활동 동기화 필요"
    : activity
      ? `<time datetime="${htmlAttr(repository.githubPushedAt)}">${htmlText(activity)}</time>`
      : "활동 내역 없음";
  const activityLabel = `${repository.owner}/${repository.name} 활동 새로고침`;
  const activityIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>';
  const activityForm = `<form method="post" action="${htmlAttr(`${detail}/activity`)}" data-repository-activity-form>${csrf(csrfToken)}<button type="submit" data-repository-activity-refresh aria-label="${htmlAttr(activityLabel)}">${activityIcon}</button></form>`;
  const activityStatus = '<span class="visually-hidden" data-repository-activity-status role="status" aria-live="polite"></span>';
  const metadata = `<dl class="repository-metadata"><div data-repository-field="category"><dt>Primary category</dt><dd><span class="repository-badge repository-badge--primary">${htmlText(category)}</span></dd></div><div data-repository-field="tags"><dt>Tags</dt><dd><span class="repository-badge-list">${tagBadges}</span></dd></div><div data-repository-field="stars"><dt>Stars</dt><dd>${htmlText(compactMetric(repository.stars))}</dd></div><div data-repository-field="forks"><dt>Forks</dt><dd>${htmlText(compactMetric(repository.forks))}</dd></div><div data-repository-field="language"><dt>Language</dt><dd>${htmlText(repository.primaryLanguage || "알 수 없음")}</dd></div><div data-repository-field="activity"><dt class="visually-hidden">Repository Activity</dt><dd><span data-repository-activity-value>${activityValue}</span>${activityForm}${activityStatus}</dd></div></dl>`;
  const notePreview = repository.latestNote
    ? `<div class="repository-note-preview"><h3>Note</h3><p data-repository-note-preview>${htmlText(repository.latestNote)}</p></div>`
    : "";
  const noteAction = repository.noteCount > 0 ? `Note ${repository.noteCount}` : "Note";
  const actions = `<div class="repository-actions"><a href="${htmlAttr(detail)}">자세히 보기</a><a data-repository-link href="${htmlAttr(`${detail}/notes`)}">${htmlText(noteAction)}</a></div>`;
  return `<article${cardStatus}>${remove}<h2><img class="repository-avatar" src="${htmlAttr(avatar)}" alt="" width="48" height="48" loading="lazy" decoding="async" referrerpolicy="no-referrer"><span class="repository-title"><span class="repository-owner">${htmlText(repository.owner)}/</span><span class="repository-name">${htmlText(repository.name)}</span></span></h2><p data-analysis-summary-status="${analysisStatus}">${htmlText(summary)}</p>${notePreview}${metadata}${actions}</article>`;
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
  const now = Number.isFinite(view.now) ? view.now : Date.now();
  const filter = view.filters ?? { q: "", category: "", tag: "" };
  const list = repositories.length
    ? `<section aria-labelledby="results"><h2 id="results">Repository</h2>${repositories.map((/** @type {any} */ repository) => repositoryCard(repository, now, view.csrfToken)).join("")}</section>`
    : `<section class="repository-empty"><h2>저장한 저장소가 없습니다</h2><p role="status">GitHub 저장소 URL 추가 필요</p></section>`;
  const deleteDialog = `<dialog data-repository-delete-dialog aria-labelledby="repository-delete-dialog-heading" aria-describedby="repository-delete-dialog-warning"><h2 id="repository-delete-dialog-heading">저장소를 삭제할까요?</h2><p class="repository-delete-target"><span>삭제 대상</span><strong data-repository-delete-name></strong></p><p id="repository-delete-dialog-warning" class="repository-delete-warning">저장소와 모든 Note가 영구 삭제되며 복구할 수 없습니다.</p><div class="repository-delete-actions"><form method="dialog"><button type="submit" data-repository-delete-cancel autofocus>취소</button></form><form method="post" data-repository-delete-form>${csrf(view.csrfToken)}<input type="hidden" name="confirm" value="yes"><button type="submit" class="button-danger" data-repository-delete-confirm disabled>저장소 삭제</button></form></div></dialog>`;
  const pagination = view.totalPages > 1 ? `<nav aria-label="페이지">${view.page > 1 ? `<a rel="prev" href="${pageHref(filter, view.page - 1)}">이전</a>` : ""}<span>${htmlText(view.page)} / ${htmlText(view.totalPages)}</span>${view.page < view.totalPages ? `<a rel="next" href="${pageHref(filter, view.page + 1)}">다음</a>` : ""}</nav>` : "";
  const filterForm = `<repo-filter><form method="get" action="/"><label for="q"><span class="visually-hidden">검색</span><input id="q" name="q" type="search" maxlength="100" placeholder="검색" value="${htmlAttr(filter.q)}"></label><label for="tag"><span class="visually-hidden">태그</span><select id="tag" name="tag">${options(view.availableTags ?? [], filter.tag, "전체 태그")}</select></label><input type="hidden" name="page" value="${htmlAttr(view.page)}"><button type="submit">찾기</button></form></repo-filter>`;
  const repositoryDialog = `<dialog data-repository-dialog aria-labelledby="repository-dialog-heading"><h2 id="repository-dialog-heading" data-repository-notes-heading>Note</h2><p data-repository-notes-summary></p><form method="post" data-repository-note-create-form>${csrf(view.csrfToken)}<div class="repository-dialog-field"><label for="dialog-note">새 Note</label><textarea id="dialog-note" name="body" data-repository-note-create maxlength="4000" required></textarea></div><button type="submit" data-repository-note-create-save>저장</button></form><p data-repository-note-status role="status" aria-live="polite"></p><section data-repository-note-list></section><nav data-repository-note-pagination aria-label="Note 페이지"></nav><div class="repository-dialog-footer"><a data-repository-detail-link hidden>상세 페이지 열기</a><button type="button" data-repository-dialog-close>닫기</button></div></dialog>`;
  const noteDeleteDialog = `<dialog data-repository-note-delete-dialog aria-labelledby="repository-note-delete-heading"><h2 id="repository-note-delete-heading">Note를 삭제할까요?</h2><p>삭제할 Note: <time data-repository-note-delete-date></time> <span data-repository-note-delete-excerpt></span></p><p data-repository-note-status data-repository-note-delete-status role="status" aria-live="polite"></p><div class="repository-delete-actions"><form method="dialog"><button type="submit" data-repository-note-delete-cancel>취소</button></form><form method="post" data-repository-note-delete-form>${csrf(view.csrfToken)}<input type="hidden" name="confirm" value="yes"><button type="submit" class="button-danger" data-repository-note-delete-confirm>Note 삭제</button></form></div></dialog>`;
  return document({
    releaseId: view.releaseId, page: "repositories.css", title: "Repo Atlas",
    app: true, modulePreloads: view.modulePreloads,
    body: `<main id="main"><header class="index-header"><h1><a href="/">Repo Atlas</a></h1>${filterForm}${logoutForm(view.csrfToken)}</header>${appNavigation("repository")}${errorStatus(view.flash)}<repo-capture><form method="post" action="/repositories">${csrf(view.csrfToken)}<label for="repository-url">GitHub 저장소 URL</label><input id="repository-url" name="url" type="url" inputmode="url" required autocomplete="off" placeholder="https://github.com/owner/repository"><button type="submit">저장</button><p data-capture-status role="status" aria-live="polite"><span data-capture-message></span></p></form></repo-capture><repo-panel>${categoryFilter(view.categories ?? CATEGORIES, filter, view.repositoryCounts)}${list}${pagination}${repositoryDialog}${noteDeleteDialog}${deleteDialog}</repo-panel></main>`,
  });
}

/** @param {number} unixSeconds */
function noteDate(unixSeconds) {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(unixSeconds * 1_000));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}.${values.month}.${values.day}`;
}

/** @param {string} repositoryId @param {number} page */
function notePageHref(repositoryId, page) {
  return htmlAttr(`/repositories/${encodeURIComponent(repositoryId)}/notes?page=${page}`);
}

/** @param {string} formatted */
function noteDateTime(formatted) {
  return formatted.replaceAll(".", "-");
}

/** @param {string} body */
function noteExcerpt(body) {
  return body.slice(0, 80);
}

/** @param {any} view */
function noteListMarkup(view) {
  if (!view.notes.length) return `<section data-repository-note-list data-empty="true"><h2 id="repository-note-list-heading" data-repository-note-list-heading>저장한 Note가 없습니다</h2><p>첫 Note를 작성하세요.</p></section>`;
  const repositoryPath = `/repositories/${encodeURIComponent(view.repository.id)}/notes`;
  const items = view.notes.map((/** @type {any} */ note) => {
    const itemPath = `${repositoryPath}/${encodeURIComponent(note.id)}`;
    const created = noteDate(note.createdAt);
    const updated = noteDate(note.updatedAt);
    const modified = note.updatedAt > note.createdAt
      ? ` · 수정 <time datetime="${htmlAttr(noteDateTime(updated))}">${htmlText(updated)}</time>` : "";
    const textareaId = `note-body-${note.id}`;
    const deleteHeadingId = `note-delete-heading-${note.id}`;
    return `<li data-repository-note-item data-note-id="${htmlAttr(note.id)}"><p class="repository-note-body">${htmlText(note.body)}</p><p class="repository-note-meta">작성 <time datetime="${htmlAttr(noteDateTime(created))}">${htmlText(created)}</time>${modified}</p><form method="post" action="${htmlAttr(itemPath)}" data-repository-note-update-form>${csrf(view.csrfToken)}<label class="visually-hidden" for="${htmlAttr(textareaId)}">Note 수정</label><textarea id="${htmlAttr(textareaId)}" name="body" maxlength="4000" required>${htmlText(note.body)}</textarea><button type="submit">저장</button></form><details data-repository-note-native-delete><summary data-repository-note-delete>삭제</summary><div data-repository-note-native-confirmation role="group" aria-labelledby="${htmlAttr(deleteHeadingId)}"><h3 id="${htmlAttr(deleteHeadingId)}">${htmlText(view.repository.owner)}/${htmlText(view.repository.name)} Note를 삭제할까요?</h3><p>작성 <time datetime="${htmlAttr(noteDateTime(created))}">${htmlText(created)}</time></p><p data-repository-note-delete-excerpt data-repository-note-native-delete-excerpt>${htmlText(noteExcerpt(note.body))}</p><p>이 Note가 영구 삭제되며 복구할 수 없습니다.</p><form method="post" action="${htmlAttr(`${itemPath}/delete`)}" data-repository-note-delete-form>${csrf(view.csrfToken)}<input type="hidden" name="confirm" value="yes"><button type="submit" class="button-danger">Note 영구 삭제</button></form></div></details></li>`;
  }).join("");
  const pagination = view.totalPages > 1
    ? `<nav class="repository-note-pagination" data-repository-note-pagination aria-label="Note 페이지">${view.page > 1 ? `<a rel="prev" href="${notePageHref(view.repository.id, view.page - 1)}">이전</a>` : ""}${Array.from({ length: view.totalPages }, (_, index) => index + 1).map((page) => `<a href="${notePageHref(view.repository.id, page)}"${page === view.page ? ' aria-current="page"' : ""}>${htmlText(page)}</a>`).join("")}${view.page < view.totalPages ? `<a rel="next" href="${notePageHref(view.repository.id, view.page + 1)}">다음</a>` : ""}</nav>` : "";
  return `<section data-repository-note-list><h2 id="repository-note-list-heading" data-repository-note-list-heading>Note ${htmlText(view.total)}</h2><ol class="repository-note-list">${items}</ol>${pagination}</section>`;
}

/** @param {any} view */
export function renderRepositoryNotesPage(view) {
  const repository = view.repository;
  const repositoryPath = `/repositories/${encodeURIComponent(repository.id)}`;
  return document({
    releaseId: view.releaseId, page: "repositories.css",
    title: `${repository.owner}/${repository.name} Note - Repo Atlas`, app: true,
    modulePreloads: view.modulePreloads,
    body: `<main id="main">${appNavigation("repository")}<p><a href="${htmlAttr(repositoryPath)}">저장소 상세</a></p><h1 data-repository-notes-heading>${htmlText(repository.owner)}/${htmlText(repository.name)} Note</h1><p data-repository-notes-summary>${htmlText(repository.summary ?? "요약이 아직 없습니다.")}</p><form method="post" action="${htmlAttr(`${repositoryPath}/notes`)}" data-repository-note-create-form>${csrf(view.csrfToken)}<label for="new-note">새 Note</label><textarea id="new-note" name="body" data-repository-note-create maxlength="4000" required></textarea><button type="submit" data-repository-note-create-save>저장</button></form><p data-repository-note-status role="status" aria-live="polite">${view.flash ? `${statusMarker}${messageFor(view.flash)}` : ""}</p>${noteListMarkup(view)}${logoutForm(view.csrfToken)}</main>`,
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
  body: `<main id="main">${appNavigation("repository")}<p><a href="/">저장소 목록</a></p><h1>${htmlText(repository.owner)}/${htmlText(repository.name)}</h1>${errorStatus(view.flash)}<p><a href="${htmlAttr(github)}" rel="noreferrer">GitHub에서 열기</a></p><p><a href="${htmlAttr(`${path}/notes`)}">Note 관리</a></p>${detail(repository)}<section aria-labelledby="edit-heading"><h2 id="edit-heading">분류 편집</h2><form method="post" action="${path}">${csrf(view.csrfToken)}<label for="primary-category">주 분류</label><select id="primary-category" name="primaryCategory" required>${options(view.categories ?? CATEGORIES, repository.primaryCategory, "분류 선택")}</select><label for="tags">태그 (쉼표로 구분)</label><input id="tags" name="tags" type="text" value="${htmlAttr(repository.tags?.join(", ") ?? "")}"><button type="submit">변경 저장</button></form></section><section aria-labelledby="refresh-heading"><h2 id="refresh-heading">다시 분석</h2><form method="post" action="${path}/refresh">${csrf(view.csrfToken)}<label><input type="checkbox" name="confirm" value="yes" required> AI 요약, 주 분류와 태그가 새 분석 결과로 교체됨을 확인합니다.</label><button type="submit">GitHub 정보와 분석 새로고침</button></form></section><section aria-labelledby="delete-heading"><h2 id="delete-heading">저장소 삭제</h2><form method="post" action="${path}/delete">${csrf(view.csrfToken)}<label><input type="checkbox" name="confirm" value="yes" required> 이 저장소와 모든 Note를 영구 삭제함을 확인합니다.</label><button type="submit" class="button-danger">저장소 삭제</button></form></section>${logoutForm(view.csrfToken)}</main>`,
  });
}

const THREAD_STATUS = Object.freeze({
  pending: "대기 중", collecting: "수집 중", ready: "보관 완료", partial: "일부 보관됨",
  error: "보관 오류", deleting: "삭제 중",
});

/** @param {unknown} value */
function threadsStatusKey(value) {
  return typeof value === "string" && Object.hasOwn(THREAD_STATUS, value)
    ? /** @type {keyof typeof THREAD_STATUS} */ (value) : null;
}

/** @param {unknown} value */
function threadsStatusText(value) {
  const key = threadsStatusKey(value);
  return key ? THREAD_STATUS[key] : "상태 확인 필요";
}

/** @param {unknown} value */
function seoulDate(value) {
  const date = new Date(String(value ?? ""));
  if (Number.isNaN(date.getTime())) return "날짜 확인 필요";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  /** @param {Intl.DateTimeFormatPartTypes} type */
  const part = (type) => parts.find((item) => item.type === type)?.value ?? "00";
  return `${part("year")}.${part("month")}.${part("day")}`;
}

/** @param {unknown} value */
function safeStoredHref(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch { return null; }
}

/** @param {unknown} text @param {any[]} links */
function threadText(text, links = []) {
  const source = String(text ?? "");
  const matches = [];
  for (const link of links) {
    const href = safeStoredHref(link?.url);
    if (!href) continue;
    let start = source.indexOf(link.url);
    while (start >= 0) {
      matches.push({ start, end: start + link.url.length, href, label: link.url });
      start = source.indexOf(link.url, start + link.url.length);
    }
  }
  matches.sort((left, right) => left.start - right.start || right.end - left.end);
  let offset = 0;
  let output = "";
  for (const match of matches) {
    if (match.start < offset) continue;
    output += htmlText(source.slice(offset, match.start));
    output += `<a href="${htmlAttr(match.href)}" rel="noreferrer">${htmlText(match.label)}</a>`;
    offset = match.end;
  }
  return `${output}${htmlText(source.slice(offset))}`;
}

/** @param {string} postId @param {any} author */
function threadAuthor(postId, author) {
  const profile = author?.profileMedia;
  const image = profile?.status === "ready" && author?.id
    ? `<img data-thread-author-image src="/threads/${encodeURIComponent(postId)}/media/${encodeURIComponent(author.id)}" alt="" width="44" height="44" loading="lazy" decoding="async">` : "";
  return `<header class="thread-author">${image}<strong data-thread-author-name>${htmlText(author?.displayName ?? "알 수 없는 작성자")}</strong><span data-thread-author-username>@${htmlText(author?.username ?? "unknown")}</span></header>`;
}

/** @param {string} postId @param {any[]} media */
function threadMedia(postId, media = []) {
  const ready = media.filter((item) => item?.status === "ready");
  const items = ready.filter((item) => item.kind === "image" || item.kind === "video").map((item) => {
    const href = `/threads/${encodeURIComponent(postId)}/media/${encodeURIComponent(item.id)}`;
    if (item.kind === "image")
      return `<img src="${htmlAttr(href)}" alt="${htmlAttr(item.altText || "보관된 Threads 이미지")}" loading="lazy" decoding="async">`;
    const thumbnail = ready.find((candidate) => candidate.kind === "video_thumbnail" &&
      candidate.sourceMediaId === item.sourceMediaId);
    const poster = thumbnail ? ` poster="/threads/${encodeURIComponent(postId)}/media/${encodeURIComponent(thumbnail.id)}"` : "";
    const label = typeof item.altText === "string" && item.altText.trim()
      ? item.altText : "보관된 Threads 동영상";
    return `<video controls preload="metadata"${poster} aria-label="${htmlAttr(label)}"><source src="${htmlAttr(href)}">${htmlText(label)}</video>`;
  }).join("");
  const retries = media.filter((item) => item?.status === "error").map((item) =>
    `<form method="post" action="/threads/${encodeURIComponent(postId)}/media/${encodeURIComponent(item.id)}/retry" data-thread-retry-form><button type="submit">미디어 재시도</button></form>`).join("");
  return `<div data-thread-media>${items ? `<div class="thread-media">${items}</div>` : ""}${retries}</div>`;
}

/** @param {string} postId @param {any} entry @param {boolean} reply */
function threadEntry(postId, entry, reply = false) {
  if (!entry) return "";
  const replyAttribute = reply
    ? ` data-thread-author-reply data-thread-entry-id="${htmlAttr(entry.id ?? "")}"` : "";
  return `<article${replyAttribute}>${threadAuthor(postId, entry.author)}<time data-thread-published-at datetime="${htmlAttr(entry.publishedAt)}">${htmlText(seoulDate(entry.publishedAt))}</time><div data-thread-root><p data-thread-text>${threadText(entry.text, entry.links)}</p>${threadMedia(postId, entry.media)}</div></article>`;
}

/** @param {string} postId @param {any} entry */
function threadRoot(postId, entry) {
  if (!entry) return '<div data-thread-root><p data-thread-text>보관할 본문이 없습니다.</p></div>';
  return `<time data-thread-published-at datetime="${htmlAttr(entry.publishedAt)}">${htmlText(seoulDate(entry.publishedAt))}</time><div data-thread-root><p data-thread-text>${threadText(entry.text, entry.links)}</p>${threadMedia(postId, entry.media)}</div>`;
}

/** @param {any} archive */
function threadProgress(archive) {
  const progress = archive.mediaProgress ?? {};
  const expected = Number.isSafeInteger(progress.expected) ? progress.expected : 0;
  const ready = Number.isSafeInteger(progress.ready) ? progress.ready : 0;
  const failed = Number.isSafeInteger(progress.failed) ? progress.failed : 0;
  return `<p data-thread-progress>미디어 ${htmlText(ready)}/${htmlText(expected)} 준비${failed ? ` · 실패 ${htmlText(failed)}` : ""}</p>`;
}

/** @param {any} archive @param {any[]} replies @param {boolean} detail @param {string} csrfToken */
function threadArchive(archive, replies, detail, csrfToken) {
  const postId = String(archive.id ?? "");
  const postPath = `/threads/${encodeURIComponent(postId)}`;
  const status = threadsStatusKey(archive.status) ?? "error";
  const repliesId = detail ? ' id="author-replies"' : "";
  const quote = archive.quote
    ? `<section data-thread-quote><p data-thread-text>${threadText(archive.quote.text, archive.quote.links)}</p></section>`
    : '<section data-thread-quote hidden></section>';
  const replyMarkup = replies.map((reply) => threadEntry(postId, reply, true)).join("");
  const allReplies = archive.replyCount > replies.length && !detail
    ? `<a data-thread-all-replies href="${htmlAttr(`${postPath}#author-replies`)}">작성자 답글 ${htmlText(archive.replyCount)}개 모두 보기</a>` : "";
  return `<article data-thread-archive data-thread-id="${htmlAttr(postId)}" data-thread-status="${status}">${threadAuthor(postId, archive.author)}<p data-thread-status-label>${threadsStatusText(archive.status)}</p>${threadProgress(archive)}${threadRoot(postId, archive.root)}${quote}<section${repliesId} data-thread-replies>${replyMarkup}</section><div class="thread-actions"><form method="post" action="${htmlAttr(`${postPath}/sync`)}" data-thread-sync-form>${csrf(csrfToken)}<button type="submit">동기화</button></form>${allReplies}</div><details data-thread-delete><summary>보관 삭제</summary><form method="post" action="${htmlAttr(`${postPath}/delete`)}">${csrf(csrfToken)}<input type="hidden" name="confirm" value="yes"><button type="submit" class="button-danger">보관 삭제</button></form></details></article>`;
}

/** @param {string} csrfToken */
function threadDeleteDialog(csrfToken) {
  return `<dialog data-thread-delete-dialog><h2>Threads 보관을 삭제할까요?</h2><p>삭제 대상 <strong data-thread-delete-author></strong></p><p>게시일 <span data-thread-delete-date></span></p><p>보관한 본문과 미디어를 삭제하며 복구할 수 없습니다.</p><form method="post" data-thread-delete-form>${csrf(csrfToken)}<input type="hidden" name="confirm" value="yes"><div class="thread-dialog-actions"><button type="button" data-thread-delete-cancel>취소</button><button type="submit" class="button-danger" data-thread-delete-confirm disabled>보관 삭제</button></div><p role="status" aria-live="polite" data-thread-delete-status></p></form></dialog>`;
}

/** @param {boolean} connected @param {boolean} reconnectRequired @param {string} csrfToken */
function threadsConnection(connected, reconnectRequired, csrfToken) {
  if (connected) return `<form method="post" action="/threads/disconnect">${csrf(csrfToken)}<button type="submit">Threads 연결 해제</button></form>`;
  return `<p data-thread-connection>${reconnectRequired ? "Threads를 다시 연결하세요." : "Threads를 연결해 보관을 시작하세요."} <a class="thread-connection-action" href="/threads/connect">${reconnectRequired ? "Threads 다시 연결하기" : "Threads 연결하기"}</a></p>`;
}

/** @param {number} page @param {number} totalPages */
function threadsIndexPagination(page, totalPages) {
  if (totalPages <= 1) return "";
  /** @param {number} value */
  const href = (value) => `/threads?page=${value}`;
  return `<nav class="thread-reply-pagination" aria-label="Threads 페이지">${page > 1 ? `<a rel="prev" href="${href(page - 1)}">이전</a>` : ""}<span>${htmlText(page)} / ${htmlText(totalPages)}</span>${page < totalPages ? `<a rel="next" href="${href(page + 1)}">다음</a>` : ""}</nav>`;
}

/** @param {any} view */
export function renderThreadsIndexPage(view) {
  const archives = (view.archives ?? []).slice(0, 10);
  const connection = threadsConnection(Boolean(view.connected), Boolean(view.reconnectRequired), view.csrfToken);
  const list = archives.length ? archives.map(/** @param {any} archive */ (archive) =>
    threadArchive(archive, (archive.firstReplies ?? []).slice(0, 3), false, view.csrfToken)).join("")
    : '<section data-thread-empty><h2 data-thread-empty-heading tabindex="-1">보관한 Threads가 없습니다</h2><p>Threads URL을 추가하세요.</p></section>';
  return document({
    releaseId: view.releaseId, page: "threads.css", title: "Threads - Repo Atlas",
    app: true, modulePreloads: view.modulePreloads,
    body: `<main id="main" class="thread-page">${appNavigation("threads")}<header><h1>Threads</h1>${connection}</header>${errorStatus(view.flash)}<thread-capture class="thread-capture"><form method="post" action="/threads">${csrf(view.csrfToken)}<label for="threads-url">Threads 게시물 URL</label><input id="threads-url" name="url" type="url" inputmode="url" required><button type="submit">보관하기</button><p role="status" aria-live="polite" data-thread-capture-message></p></form></thread-capture><thread-panel><h2 data-thread-list-heading tabindex="-1">보관 목록</h2><section data-thread-archive-list>${list}</section>${threadsIndexPagination(view.page ?? 1, view.totalPages ?? 1)}${threadDeleteDialog(view.csrfToken)}<p role="status" aria-live="polite" data-thread-panel-message></p></thread-panel>${logoutForm(view.csrfToken)}</main>`,
  });
}

/** @param {any} view */
export function renderThreadsDetailPage(view) {
  const archive = view.archive;
  const replies = (view.replies ?? []).slice(0, 20);
  const page = view.repliesPage ?? 1;
  const totalPages = view.totalReplyPages ?? 1;
  const postPath = `/threads/${encodeURIComponent(archive.id)}`;
  const numbers = totalPages > 1 ? Array.from({ length: totalPages }, (_, index) => index + 1).map((number) =>
    `<a href="${htmlAttr(`${postPath}?repliesPage=${number}`)}"${number === page ? ' aria-current="page"' : ""}>${number}</a>`).join("") : "";
  const pagination = numbers ? `<nav class="thread-reply-pagination" aria-label="작성자 답글 페이지">${page > 1 ? `<a rel="prev" href="${htmlAttr(`${postPath}?repliesPage=${page - 1}`)}">이전</a>` : ""}${numbers}${page < totalPages ? `<a rel="next" href="${htmlAttr(`${postPath}?repliesPage=${page + 1}`)}">다음</a>` : ""}</nav>` : "";
  return document({
    releaseId: view.releaseId, page: "threads.css", title: "Threads 보관 - Repo Atlas",
    app: true, modulePreloads: view.modulePreloads,
    body: `<main id="main" class="thread-page">${appNavigation("threads")}<p><a href="/threads">Threads 목록</a></p>${threadsConnection(Boolean(view.connected), Boolean(view.reconnectRequired), view.csrfToken)}${errorStatus(view.flash)}<thread-panel>${threadArchive(archive, replies, true, view.csrfToken)}${pagination}${threadDeleteDialog(view.csrfToken)}<p role="status" aria-live="polite" data-thread-panel-message></p></thread-panel>${logoutForm(view.csrfToken)}</main>`,
  });
}
