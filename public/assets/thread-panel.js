import { formJson } from "./dom.js";

const POLL_DELAYS = Object.freeze([1_000, 2_000, 5_000, 10_000]);
const POST_ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const LOCAL_ID = /^[0-9A-Za-z_-]+$/;
const STATUS = Object.freeze({
  pending: "수집 대기", collecting: "수집 중", ready: "보관 완료",
  partial: "일부 보관됨", error: "보관 실패",
});
const SESSION = "세션이 만료되었습니다. 다시 로그인하세요.";
const REQUEST_ERROR = "Threads 요청을 처리하지 못했습니다. 다시 시도하세요.";
const REPLIES_ERROR = "작성자 답글을 불러오지 못했습니다. 다시 시도하세요.";

/** @param {unknown} value @param {string[]} keys */
function exact(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** @param {unknown} value */
function nonnegative(value) {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

/** @param {unknown} value */
function nullableString(value) {
  return value === null || typeof value === "string";
}

/** @param {unknown} value */
function validDate(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/** @param {unknown} value @param {RegExp} pattern */
function localUrl(value, pattern) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value, location.origin);
    return url.origin === location.origin && !url.search && !url.hash && pattern.test(url.pathname)
      ? url : null;
  } catch { return null; }
}

/** @param {unknown} value */
function externalUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username && !url.password ? url : null;
  } catch { return null; }
}

/** @param {unknown} value @param {string} postId */
function validateProfile(value, postId) {
  const base = ["status", "contentType", "etag", "bytes", "errorCode"];
  if (!exact(value, base) && !exact(value, [...base, "url"]))
    throw new Error("invalid_profile");
  const profile = /** @type {Record<string, unknown>} */ (value);
  if (!["pending", "ready", "error"].includes(String(profile.status)) ||
    !nullableString(profile.contentType) || !nullableString(profile.etag) ||
    !(profile.bytes === null || nonnegative(profile.bytes)) || !nullableString(profile.errorCode))
    throw new Error("invalid_profile");
  if (profile.status === "ready") {
    if (!localUrl(profile.url,
      new RegExp(`^/threads/${postId}/media/[0-9A-Za-z_-]+$`))) throw new Error("invalid_profile");
  } else if (Object.hasOwn(profile, "url")) throw new Error("invalid_profile");
  return profile;
}

/** @param {unknown} value @param {string} postId */
function validateAuthor(value, postId) {
  if (value === null) return null;
  if (!exact(value, ["id", "username", "displayName", "profileMedia"]))
    throw new Error("invalid_author");
  const author = /** @type {Record<string, unknown>} */ (value);
  if (typeof author.id !== "string" || !LOCAL_ID.test(author.id) ||
    typeof author.username !== "string" || typeof author.displayName !== "string")
    throw new Error("invalid_author");
  validateProfile(author.profileMedia, postId);
  return author;
}

/** @param {unknown} value */
function validateLink(value) {
  if (!exact(value, ["url", "source", "ordinal"])) throw new Error("invalid_link");
  const link = /** @type {Record<string, unknown>} */ (value);
  if (!externalUrl(link.url) || !["body", "attachment"].includes(String(link.source)) ||
    !nonnegative(link.ordinal)) throw new Error("invalid_link");
  return link;
}

/** @param {unknown} value @param {string} postId */
function validateMedia(value, postId) {
  const keys = ["id", "sourceMediaId", "kind", "ordinal", "altText", "status",
    "contentType", "bytes", "etag", "errorCode", "url", "retryUrl"];
  if (!exact(value, keys)) throw new Error("invalid_media");
  const item = /** @type {Record<string, unknown>} */ (value);
  if (typeof item.id !== "string" || !LOCAL_ID.test(item.id) ||
    typeof item.sourceMediaId !== "string" || !item.sourceMediaId ||
    !["image", "video", "video_thumbnail"].includes(String(item.kind)) ||
    !nonnegative(item.ordinal) || !nullableString(item.altText) ||
    !["pending", "ready", "error"].includes(String(item.status)) ||
    !nullableString(item.contentType) || !(item.bytes === null || nonnegative(item.bytes)) ||
    !nullableString(item.etag) || !nullableString(item.errorCode)) throw new Error("invalid_media");
  const ready = localUrl(item.url, new RegExp(`^/threads/${postId}/media/[0-9A-Za-z_-]+$`));
  const retry = localUrl(item.retryUrl,
    new RegExp(`^/threads/${postId}/media/[0-9A-Za-z_-]+/retry$`));
  if (item.status === "ready" ? !ready || item.retryUrl !== null
    : item.status === "error" ? item.url !== null || !retry
      : item.url !== null || item.retryUrl !== null) throw new Error("invalid_media");
  return item;
}

/** @param {unknown} value @param {string} postId @param {Set<string>} trail */
function validateEntry(value, postId, trail = new Set()) {
  const keys = ["id", "sourceMediaId", "kind", "parentEntryId", "author", "text",
    "permalink", "publishedAt", "mediaType", "altText", "nestedQuotePermalink",
    "links", "media", "quote"];
  if (!exact(value, keys)) throw new Error("invalid_entry");
  const entry = /** @type {Record<string, unknown>} */ (value);
  if (typeof entry.id !== "string" || !LOCAL_ID.test(entry.id) || trail.has(entry.id) ||
    typeof entry.sourceMediaId !== "string" || !entry.sourceMediaId ||
    !["root", "author_reply", "quote"].includes(String(entry.kind)) ||
    !(entry.parentEntryId === null || typeof entry.parentEntryId === "string") ||
    typeof entry.text !== "string" || !nullableString(entry.permalink) ||
    !validDate(entry.publishedAt) || typeof entry.mediaType !== "string" || !entry.mediaType ||
    !nullableString(entry.altText) || !nullableString(entry.nestedQuotePermalink) ||
    !Array.isArray(entry.links) || !Array.isArray(entry.media)) throw new Error("invalid_entry");
  validateAuthor(entry.author, postId);
  if (entry.permalink !== null && !externalUrl(entry.permalink)) throw new Error("invalid_entry");
  if (entry.nestedQuotePermalink !== null && !externalUrl(entry.nestedQuotePermalink))
    throw new Error("invalid_entry");
  entry.links.map(validateLink);
  entry.media.map((item) => validateMedia(item, postId));
  const nextTrail = new Set(trail).add(/** @type {string} */ (entry.id));
  if (entry.quote !== null) validateEntry(entry.quote, postId, nextTrail);
  return entry;
}

/** @param {unknown} value @param {string} postId */
function validateArchive(value, postId) {
  const keys = ["id", "canonicalUrl", "status", "errorCode", "author", "root", "quote",
    "firstReplies", "replyCount", "mediaProgress", "syncGeneration", "createdAt", "updatedAt"];
  if (!exact(value, keys)) throw new Error("invalid_archive");
  const archive = /** @type {Record<string, unknown>} */ (value);
  if (archive.id !== postId || !["pending", "collecting", "ready", "partial", "error"]
    .includes(String(archive.status)) || !nullableString(archive.canonicalUrl) ||
    !nullableString(archive.errorCode) || !Array.isArray(archive.firstReplies) ||
    !nonnegative(archive.replyCount) || !nonnegative(archive.syncGeneration) ||
    Number(archive.syncGeneration) < 1 || !nonnegative(archive.createdAt) ||
    !nonnegative(archive.updatedAt) ||
    !exact(archive.mediaProgress, ["expected", "ready", "failed", "pending"]))
    throw new Error("invalid_archive");
  if (archive.canonicalUrl !== null && !externalUrl(archive.canonicalUrl))
    throw new Error("invalid_archive");
  validateAuthor(archive.author, postId);
  if (archive.root !== null) validateEntry(archive.root, postId);
  if (archive.quote !== null) validateEntry(archive.quote, postId);
  const replies = archive.firstReplies.map((entry) => validateEntry(entry, postId));
  if (replies.some((entry) => entry.kind !== "author_reply") ||
    new Set(replies.map((entry) => entry.id)).size !== replies.length ||
    replies.length > Number(archive.replyCount)) throw new Error("invalid_archive");
  const progress = /** @type {Record<string, unknown>} */ (archive.mediaProgress);
  for (const key of ["expected", "ready", "failed", "pending"])
    if (!nonnegative(progress[key])) throw new Error("invalid_archive");
  if (Number(progress.expected) !== Number(progress.ready) + Number(progress.failed) +
    Number(progress.pending)) throw new Error("invalid_archive");
  return archive;
}

/** @param {unknown} value @param {string} postId @param {number | null} expectedPage */
function validateDetail(value, postId, expectedPage = null) {
  if (!exact(value, ["archive", "replies", "repliesPage", "totalReplyPages",
    "totalReplies", "actions"])) throw new Error("invalid_detail");
  const detail = /** @type {Record<string, unknown>} */ (value);
  const archive = validateArchive(detail.archive, postId);
  if (!Array.isArray(detail.replies) || !nonnegative(detail.totalReplies) ||
    !Number.isSafeInteger(detail.repliesPage) || Number(detail.repliesPage) < 1 ||
    !Number.isSafeInteger(detail.totalReplyPages) || Number(detail.totalReplyPages) < 1 ||
    Number(detail.totalReplyPages) !== Math.max(1, Math.ceil(Number(detail.totalReplies) / 20)) ||
    Number(detail.repliesPage) > Number(detail.totalReplyPages) ||
    expectedPage !== null && Number(detail.repliesPage) !== expectedPage ||
    !exact(detail.actions, ["detail", "sync", "delete"])) throw new Error("invalid_detail");
  const actions = /** @type {Record<string, unknown>} */ (detail.actions);
  if (!localUrl(actions.detail, new RegExp(`^/threads/${postId}$`)) ||
    !localUrl(actions.sync, new RegExp(`^/threads/${postId}/sync$`)) ||
    !localUrl(actions.delete, new RegExp(`^/threads/${postId}/delete$`)))
    throw new Error("invalid_detail");
  const replies = detail.replies.map((entry) => validateEntry(entry, postId));
  const expectedRows = Math.min(20,
    Math.max(0, Number(detail.totalReplies) - (Number(detail.repliesPage) - 1) * 20));
  if (replies.length !== expectedRows || replies.some((entry) => entry.kind !== "author_reply") ||
    new Set(replies.map((entry) => entry.id)).size !== replies.length)
    throw new Error("invalid_detail");
  for (let index = 1; index < replies.length; index += 1) {
    const previous = replies[index - 1];
    const current = replies[index];
    if (String(previous.publishedAt).localeCompare(String(current.publishedAt)) > 0 ||
      previous.publishedAt === current.publishedAt &&
      String(previous.sourceMediaId).localeCompare(String(current.sourceMediaId)) > 0)
      throw new Error("invalid_detail");
  }
  return { detail, archive, replies };
}

/** @param {MouseEvent} event */
function plainPrimaryClick(event) {
  return event.button === 0 && !event.altKey && !event.ctrlKey &&
    !event.metaKey && !event.shiftKey;
}

/** @param {unknown} value */
function errorCode(value) {
  return exact(value, ["errorCode"]) &&
    typeof /** @type {Record<string, unknown>} */ (value).errorCode === "string"
    ? /** @type {Record<string, string>} */ (value).errorCode : null;
}

/** @param {Response} response */
async function responseJson(response) {
  try { return await response.json(); }
  catch { throw new Error("invalid_json"); }
}

/** @param {HTMLElement} root @param {string} message */
function panelMessage(root, message) {
  const node = root.querySelector("[data-thread-panel-message]");
  if (node instanceof HTMLElement) node.textContent = message;
}

/** @param {string} value */
function seoulDate(value) {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(value));
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}.${map.month}.${map.day}`;
}

/** @param {Record<string, unknown>} entry @param {string} postId */
function replyNode(entry, postId) {
  const article = document.createElement("article");
  article.dataset.threadAuthorReply = "";
  article.dataset.threadEntryId = /** @type {string} */ (entry.id);
  article.dataset.threadExpandedReply = "";
  const author = /** @type {Record<string, unknown>} */ (entry.author);
  const header = document.createElement("header");
  header.className = "thread-author";
  const profile = /** @type {Record<string, unknown>} */ (author.profileMedia);
  if (profile.status === "ready") {
    const image = document.createElement("img");
    image.dataset.threadAuthorImage = "";
    image.src = /** @type {string} */ (profile.url);
    image.alt = "";
    image.width = 44;
    image.height = 44;
    image.loading = "lazy";
    image.decoding = "async";
    header.appendChild(image);
  }
  const name = document.createElement("strong");
  name.dataset.threadAuthorName = "";
  name.textContent = /** @type {string} */ (author.displayName);
  const username = document.createElement("span");
  username.dataset.threadAuthorUsername = "";
  username.textContent = `@${author.username}`;
  header.appendChild(name);
  header.appendChild(username);
  const time = document.createElement("time");
  time.dataset.threadPublishedAt = "";
  time.dateTime = /** @type {string} */ (entry.publishedAt);
  time.textContent = seoulDate(/** @type {string} */ (entry.publishedAt));
  const root = document.createElement("div");
  root.dataset.threadRoot = "";
  const text = document.createElement("p");
  text.dataset.threadText = "";
  appendLinkedText(text, /** @type {string} */ (entry.text),
    /** @type {Record<string, unknown>[]} */ (entry.links));
  root.appendChild(text);
  root.appendChild(mediaNode(entry, postId));
  article.appendChild(header);
  article.appendChild(time);
  article.appendChild(root);
  return article;
}

/** @param {HTMLElement} node @param {string} text @param {Record<string, unknown>[]} links */
function appendLinkedText(node, text, links) {
  const matches = links.map((link) => {
    const label = /** @type {string} */ (link.url);
    return { start: text.indexOf(label), label };
  }).filter((match) => match.start >= 0)
    .sort((left, right) => left.start - right.start || right.label.length - left.label.length);
  let offset = 0;
  for (const match of matches) {
    if (match.start < offset) continue;
    node.appendChild(document.createTextNode(text.slice(offset, match.start)));
    const anchor = document.createElement("a");
    anchor.href = match.label;
    anchor.rel = "noreferrer";
    anchor.textContent = match.label;
    node.appendChild(anchor);
    offset = match.start + match.label.length;
  }
  node.appendChild(document.createTextNode(text.slice(offset)));
}

/** @param {Record<string, unknown>} entry @param {string} postId */
function mediaNode(entry, postId) {
  const container = document.createElement("div");
  container.dataset.threadMedia = "";
  const media = /** @type {Record<string, unknown>[]} */ (entry.media);
  const ready = media.filter((item) => item.status === "ready");
  const visual = ready.filter((item) => item.kind === "image" || item.kind === "video");
  if (visual.length) {
    const gallery = document.createElement("div");
    gallery.className = "thread-media";
    for (const item of visual) {
      if (item.kind === "image") {
        const image = document.createElement("img");
        image.src = /** @type {string} */ (item.url);
        image.alt = typeof item.altText === "string" && item.altText
          ? item.altText : "보관된 Threads 이미지";
        image.loading = "lazy";
        image.decoding = "async";
        gallery.appendChild(image);
      } else {
        const video = document.createElement("video");
        video.controls = true;
        video.preload = "metadata";
        const label = typeof item.altText === "string" && item.altText
          ? item.altText : "보관된 Threads 동영상";
        video.setAttribute("aria-label", label);
        const thumbnail = ready.find((candidate) => candidate.kind === "video_thumbnail" &&
          candidate.sourceMediaId === item.sourceMediaId);
        if (thumbnail) video.poster = /** @type {string} */ (thumbnail.url);
        const source = document.createElement("source");
        source.src = /** @type {string} */ (item.url);
        video.appendChild(source);
        video.appendChild(document.createTextNode(label));
        gallery.appendChild(video);
      }
    }
    container.appendChild(gallery);
  }
  const token = document.querySelector('[data-thread-sync-form] input[name="csrf"]');
  for (const item of media.filter((candidate) => candidate.status === "error")) {
    const form = document.createElement("form");
    form.method = "post";
    form.action = /** @type {string} */ (item.retryUrl);
    form.dataset.threadRetryForm = "";
    if (token instanceof HTMLInputElement) {
      const csrf = document.createElement("input");
      csrf.type = "hidden";
      csrf.name = "csrf";
      csrf.value = token.value;
      form.appendChild(csrf);
    }
    const button = document.createElement("button");
    button.type = "submit";
    button.textContent = "미디어 재시도";
    form.appendChild(button);
    container.appendChild(form);
  }
  void postId;
  return container;
}

class ThreadPanel extends HTMLElement {
  connectedCallback() {
    if (this.dataset.ready) return;
    this.dataset.ready = "true";
    /** @type {Map<HTMLElement, any>} */
    this.states = new Map();
    /** @type {HTMLElement | null} */
    this.deleteOpener = null;
    for (const card of this.querySelectorAll("[data-thread-archive]")) {
      if (!(card instanceof HTMLElement) || !POST_ID.test(card.dataset.threadId ?? "")) continue;
      const id = /** @type {string} */ (card.dataset.threadId);
      const generation = Number(card.dataset.threadGeneration);
      if (!Number.isSafeInteger(generation) || generation < 1) continue;
      const state = {
        card, id, detailUrl: `/threads/${id}`, timer: null, controller: null,
        etag: "", delayIndex: 0, expansionController: null, expanded: false,
        loading: false, expansionEpoch: 0, pollEpoch: 0, generation,
      };
      this.states.set(card, state);
      if (card.dataset.threadStatus === "pending" || card.dataset.threadStatus === "collecting")
        this.schedule(state);
    }
    this.visibilityHandler = () => this.visibilityChanged();
    document.addEventListener("visibilitychange", this.visibilityHandler);
    this.addEventListener("click", (event) => {
      if (!(event instanceof MouseEvent)) return;
      if (this.openDelete(event)) return;
      void this.toggleReplies(event);
    });
    this.addEventListener("submit", (event) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement)) return;
      if (form.hasAttribute("data-thread-sync-form")) void this.mutate(event, form, "sync");
      else if (form.hasAttribute("data-thread-retry-form")) void this.mutate(event, form, "retry");
      else if (form.hasAttribute("data-thread-delete-form")) void this.deleteArchive(event, form);
    });
    const dialog = this.querySelector("[data-thread-delete-dialog]");
    const cancel = dialog?.querySelector("[data-thread-delete-cancel]");
    if (dialog instanceof HTMLDialogElement && cancel instanceof HTMLButtonElement) {
      cancel.addEventListener("click", () => dialog.close());
      dialog.addEventListener("close", () => this.closedDelete(dialog));
    }
  }

  disconnectedCallback() {
    if (this.visibilityHandler)
      document.removeEventListener("visibilitychange", this.visibilityHandler);
    for (const state of this.states?.values() ?? []) {
      if (state.timer !== null) clearTimeout(state.timer);
      state.controller?.abort();
      state.expansionController?.abort();
    }
    this.states?.clear();
  }

  visibilityChanged() {
    for (const state of this.states.values()) {
      if (document.visibilityState !== "visible") {
        if (state.timer !== null) clearTimeout(state.timer);
        state.timer = null;
        state.controller?.abort();
        state.controller = null;
      } else if ((state.card.dataset.threadStatus === "pending" ||
        state.card.dataset.threadStatus === "collecting") && state.timer === null &&
        state.controller === null) this.schedule(state);
    }
  }

  /** @param {any} state */
  schedule(state) {
    if (document.visibilityState !== "visible" || state.timer !== null ||
      state.controller !== null || state.stopped || !this.isConnected) return;
    const delay = POLL_DELAYS[Math.min(state.delayIndex, POLL_DELAYS.length - 1)];
    state.timer = setTimeout(() => {
      state.timer = null;
      void this.poll(state);
    }, delay);
  }

  /** @param {any} state */
  async poll(state) {
    if (!this.isConnected || document.visibilityState !== "visible") return;
    const controller = new AbortController();
    state.controller = controller;
    const epoch = state.pollEpoch;
    /** @type {Record<string, string>} */
    const headers = { Accept: "application/json" };
    if (state.etag) headers["If-None-Match"] = state.etag;
    try {
      const response = await fetch(state.detailUrl, {
        headers, credentials: "same-origin", signal: controller.signal,
      });
      if (state.pollEpoch !== epoch) return;
      if (response.status === 304) {
        state.delayIndex = Math.min(state.delayIndex + 1, POLL_DELAYS.length - 1);
        return;
      }
      const body = await responseJson(response);
      if (state.pollEpoch !== epoch) return;
      if (!response.ok) {
        if (response.status === 401 && errorCode(body) === "session_expired") {
          panelMessage(this, SESSION);
          state.stopped = true;
        } else panelMessage(this, REQUEST_ERROR);
        state.delayIndex = POLL_DELAYS.length - 1;
        return;
      }
      const result = validateDetail(body, state.id);
      if (state.pollEpoch !== epoch || Number(result.archive.syncGeneration) < state.generation)
        return;
      state.generation = Number(result.archive.syncGeneration);
      state.card.dataset.threadGeneration = String(state.generation);
      const etag = response.headers.get("ETag");
      state.etag = typeof etag === "string" ? etag : "";
      this.applyPolling(state.card, result.archive);
      state.delayIndex = Math.min(state.delayIndex + 1, POLL_DELAYS.length - 1);
      if (!["pending", "collecting"].includes(String(result.archive.status)) && state.expanded)
        await this.loadReplies(state, true);
    } catch {
      if (!controller.signal.aborted && state.pollEpoch === epoch)
        panelMessage(this, REQUEST_ERROR);
    } finally {
      if (state.controller === controller) state.controller = null;
      if (!state.stopped && ["pending", "collecting"].includes(state.card.dataset.threadStatus ?? ""))
        this.schedule(state);
    }
  }

  /** @param {HTMLElement} card @param {Record<string, unknown>} archive */
  applyPolling(card, archive) {
    const status = /** @type {keyof typeof STATUS} */ (archive.status);
    card.dataset.threadStatus = status;
    const label = card.querySelector("[data-thread-status-label]");
    if (label instanceof HTMLElement) label.textContent = STATUS[status];
    const progress = /** @type {Record<string, number>} */ (archive.mediaProgress);
    const progressNode = card.querySelector("[data-thread-progress]");
    if (progressNode instanceof HTMLElement) progressNode.textContent =
      `미디어 ${progress.ready}/${progress.expected} 준비${progress.failed ? ` · 실패 ${progress.failed}` : ""}`;
    const author = archive.author;
    if (author && typeof author === "object") {
      const record = /** @type {Record<string, unknown>} */ (author);
      const name = card.querySelector("[data-thread-author-name]");
      const username = card.querySelector("[data-thread-author-username]");
      if (name instanceof HTMLElement) name.textContent = /** @type {string} */ (record.displayName);
      if (username instanceof HTMLElement) username.textContent = `@${record.username}`;
    }
  }

  /** @param {MouseEvent} event */
  async toggleReplies(event) {
    const target = event.target;
    const link = target instanceof Element ? target.closest("[data-thread-all-replies]") : null;
    if (!(link instanceof HTMLAnchorElement) || !plainPrimaryClick(event)) return;
    const card = link.closest("[data-thread-archive]");
    const state = card instanceof HTMLElement ? this.states.get(card) : null;
    if (!state) return;
    event.preventDefault();
    if (state.loading) {
      state.expansionEpoch += 1;
      state.expansionController?.abort();
      state.expansionController = null;
      state.loading = false;
      link.removeAttribute("aria-busy");
      link.textContent = `작성자 답글 ${link.dataset.threadTotal ?? ""}개 모두 보기`;
      return;
    }
    if (state.expanded) {
      state.expansionController?.abort();
      state.expansionController = null;
      for (const node of state.card.querySelectorAll("[data-thread-expanded-reply]")) node.remove();
      state.expanded = false;
      link.textContent = `작성자 답글 ${link.dataset.threadTotal ?? ""}개 모두 보기`;
      return;
    }
    await this.loadReplies(state, false);
  }

  /** @param {any} state @param {boolean} refresh */
  async loadReplies(state, refresh) {
    state.expansionController?.abort();
    const controller = new AbortController();
    state.expansionController = controller;
    state.expansionEpoch += 1;
    const epoch = state.expansionEpoch;
    state.loading = true;
    const link = state.card.querySelector("[data-thread-all-replies]");
    const container = state.card.querySelector("[data-thread-replies]");
    if (!(link instanceof HTMLAnchorElement) || !(container instanceof HTMLElement)) {
      state.loading = false;
      return;
    }
    if (!refresh) {
      const total = link.dataset.threadTotal || (link.textContent.match(/[0-9]+/)?.[0] ?? "");
      link.dataset.threadTotal = total;
      link.setAttribute("aria-busy", "true");
      link.textContent = `작성자 답글 ${total}개 불러오는 중`;
    }
    const known = new Set([...container.querySelectorAll("[data-thread-entry-id]")]
      .map((node) => node instanceof HTMLElement ? node.dataset.threadEntryId : ""));
    const staged = [];
    const seen = new Set();
    let totalPages = 1;
    let totalReplies = 0;
    let last = null;
    try {
      for (let page = 1; page <= totalPages; page += 1) {
        const url = new URL(state.detailUrl, location.origin);
        url.searchParams.set("repliesPage", String(page));
        const response = await fetch(url, {
          headers: { Accept: "application/json" }, credentials: "same-origin",
          signal: controller.signal,
        });
        const body = await responseJson(response);
        if (!response.ok) {
          if (response.status === 401 && errorCode(body) === "session_expired")
            panelMessage(this, SESSION);
          throw new Error("reply_response");
        }
        const result = validateDetail(body, state.id, page);
        totalPages = Number(result.detail.totalReplyPages);
        totalReplies = Number(result.detail.totalReplies);
        for (const reply of result.replies) {
          if (last && (String(last.publishedAt).localeCompare(String(reply.publishedAt)) > 0 ||
            last.publishedAt === reply.publishedAt &&
            String(last.sourceMediaId).localeCompare(String(reply.sourceMediaId)) > 0))
            throw new Error("reply_order");
          last = reply;
          const id = /** @type {string} */ (reply.id);
          if (seen.has(id)) throw new Error("reply_duplicate");
          seen.add(id);
          if (!known.has(id)) staged.push(reply);
        }
      }
      if (seen.size !== totalReplies || [...known].some((id) => !seen.has(id)) ||
        state.expansionEpoch !== epoch || controller.signal.aborted) throw new Error("reply_count");
      const fragment = document.createDocumentFragment();
      for (const reply of staged) fragment.appendChild(replyNode(reply, state.id));
      container.appendChild(fragment);
      state.expanded = true;
      link.dataset.threadTotal = String(totalReplies);
      link.textContent = `작성자 답글 ${totalReplies}개 접기`;
      link.removeAttribute("aria-busy");
      if (!refresh) panelMessage(this, "");
    } catch {
      if (!controller.signal.aborted && state.expansionEpoch === epoch)
        panelMessage(this, REPLIES_ERROR);
      if (!refresh && !state.expanded && state.expansionEpoch === epoch) {
        link.removeAttribute("aria-busy");
        link.textContent = `작성자 답글 ${link.dataset.threadTotal ?? ""}개 모두 보기`;
      }
    } finally {
      if (state.expansionController === controller) {
        state.expansionController = null;
        state.loading = false;
      }
    }
  }

  /** @param {Event} event @param {HTMLFormElement} form @param {"sync" | "retry"} kind */
  async mutate(event, form, kind) {
    if (event.defaultPrevented || !form.checkValidity()) return;
    event.preventDefault();
    const card = form.closest("[data-thread-archive]");
    const state = card instanceof HTMLElement ? this.states.get(card) : null;
    if (!state) return;
    const button = form.querySelector('button[type="submit"]');
    if (button instanceof HTMLButtonElement) button.disabled = true;
    const controller = new AbortController();
    let retryQueued = false;
    try {
      const response = await formJson(form, controller.signal);
      const body = await responseJson(response);
      if (!response.ok) {
        panelMessage(this, response.status === 401 && errorCode(body) === "session_expired"
          ? SESSION : REQUEST_ERROR);
        return;
      }
      if (kind === "sync") {
        if (!exact(body, ["threadsPostId", "generation", "status", "duplicate"]))
          throw new Error("invalid_sync");
        const result = /** @type {Record<string, unknown>} */ (body);
        if (result.threadsPostId !== state.id || !nonnegative(result.generation) ||
          Number(result.generation) < 1 || result.status !== "pending" ||
          typeof result.duplicate !== "boolean") throw new Error("invalid_sync");
        if (state.timer !== null) clearTimeout(state.timer);
        state.timer = null;
        state.pollEpoch += 1;
        const previousController = state.controller;
        state.controller = null;
        previousController?.abort();
        state.etag = "";
        state.stopped = false;
        state.delayIndex = 0;
        state.generation = Number(result.generation);
        state.card.dataset.threadGeneration = String(state.generation);
        state.card.dataset.threadStatus = "pending";
        this.applyPolling(state.card, {
          status: "pending", mediaProgress: { expected: 0, ready: 0, failed: 0, pending: 0 },
        });
        this.schedule(state);
      } else {
        if (!exact(body, ["threadsPostId", "mediaId", "status"]))
          throw new Error("invalid_retry");
        const result = /** @type {Record<string, unknown>} */ (body);
        if (result.threadsPostId !== state.id || typeof result.mediaId !== "string" ||
          !LOCAL_ID.test(result.mediaId) || result.status !== "queued")
          throw new Error("invalid_retry");
        form.dataset.threadRetryStatus = "queued";
        if (button instanceof HTMLButtonElement) button.textContent = "미디어 재시도 대기 중";
        retryQueued = true;
      }
      panelMessage(this, "");
    } catch {
      panelMessage(this, REQUEST_ERROR);
    } finally {
      if (button instanceof HTMLButtonElement && !retryQueued) button.disabled = false;
    }
  }

  /** @param {MouseEvent} event */
  openDelete(event) {
    const target = event.target;
    const summary = target instanceof Element ? target.closest("[data-thread-delete] > summary") : null;
    if (!(summary instanceof HTMLElement) || !plainPrimaryClick(event)) return false;
    const card = summary.closest("[data-thread-archive]");
    const nativeForm = card?.querySelector("[data-thread-delete] > form");
    const dialog = this.querySelector("[data-thread-delete-dialog]");
    const dialogForm = dialog?.querySelector("[data-thread-delete-form]");
    const confirm = dialog?.querySelector("[data-thread-delete-confirm]");
    const cancel = dialog?.querySelector("[data-thread-delete-cancel]");
    if (!(card instanceof HTMLElement) || !(nativeForm instanceof HTMLFormElement) ||
      !(dialog instanceof HTMLDialogElement) || typeof dialog.showModal !== "function" ||
      !(dialogForm instanceof HTMLFormElement) || !(confirm instanceof HTMLButtonElement) ||
      !(cancel instanceof HTMLButtonElement)) return false;
    const id = card.dataset.threadId ?? "";
    const action = localUrl(nativeForm.action, new RegExp(`^/threads/${id}/delete$`));
    const authorTarget = dialog.querySelector("[data-thread-delete-author]");
    const dateTarget = dialog.querySelector("[data-thread-delete-date]");
    if (!POST_ID.test(id) || !action || !(authorTarget instanceof HTMLElement) ||
      !(dateTarget instanceof HTMLElement)) return false;
    event.preventDefault();
    const name = card.querySelector("[data-thread-author-name]")?.textContent ?? "";
    const username = card.querySelector("[data-thread-author-username]")?.textContent ?? "";
    const date = card.querySelector(":scope > [data-thread-published-at]")?.textContent ?? "";
    authorTarget.textContent = `${name} ${username}`.trim();
    dateTarget.textContent = date;
    dialogForm.action = action.href;
    confirm.disabled = false;
    this.deleteOpener = summary;
    dialog.showModal();
    cancel.focus();
    return true;
  }

  /** @param {HTMLDialogElement} dialog */
  closedDelete(dialog) {
    const form = dialog.querySelector("[data-thread-delete-form]");
    const confirm = dialog.querySelector("[data-thread-delete-confirm]");
    if (form instanceof HTMLFormElement) form.removeAttribute("action");
    if (confirm instanceof HTMLButtonElement) confirm.disabled = true;
    const author = dialog.querySelector("[data-thread-delete-author]");
    const date = dialog.querySelector("[data-thread-delete-date]");
    const status = dialog.querySelector("[data-thread-delete-status]");
    if (author instanceof HTMLElement) author.textContent = "";
    if (date instanceof HTMLElement) date.textContent = "";
    if (status instanceof HTMLElement) status.textContent = "";
    const opener = this.deleteOpener;
    this.deleteOpener = null;
    opener?.focus();
  }

  /** @param {Event} event @param {HTMLFormElement} form */
  async deleteArchive(event, form) {
    if (event.defaultPrevented || !form.checkValidity() || !form.hasAttribute("action")) return;
    event.preventDefault();
    const dialog = form.closest("dialog");
    const confirm = form.querySelector("[data-thread-delete-confirm]");
    if (!(dialog instanceof HTMLDialogElement) || !(confirm instanceof HTMLButtonElement) ||
      confirm.disabled || !(this.deleteOpener instanceof HTMLElement)) return;
    const card = this.deleteOpener.closest("[data-thread-archive]");
    const state = card instanceof HTMLElement ? this.states.get(card) : null;
    if (!state) return;
    confirm.disabled = true;
    try {
      const response = await formJson(form);
      const body = await responseJson(response);
      if (!response.ok) {
        const status = dialog.querySelector("[data-thread-delete-status]");
        if (status instanceof HTMLElement) status.textContent =
          response.status === 401 && errorCode(body) === "session_expired" ? SESSION : REQUEST_ERROR;
        return;
      }
      if (!exact(body, ["threadsPostId", "status", "duplicate"]))
        throw new Error("invalid_delete");
      const result = /** @type {Record<string, unknown>} */ (body);
      if (result.threadsPostId !== state.id || result.status !== "deleting" ||
        typeof result.duplicate !== "boolean") throw new Error("invalid_delete");
      state.controller?.abort();
      state.expansionController?.abort();
      if (state.timer !== null) clearTimeout(state.timer);
      this.states.delete(state.card);
      this.deleteOpener = null;
      dialog.close();
      const list = this.querySelector("[data-thread-archive-list]");
      if (!(list instanceof HTMLElement)) {
        location.href = "/threads";
        return;
      }
      state.card.remove();
      let focusTarget = this.querySelector("[data-thread-list-heading]");
      if (!list.querySelector("[data-thread-archive]")) {
        const empty = document.createElement("section");
        empty.dataset.threadEmpty = "";
        const heading = document.createElement("h2");
        heading.dataset.threadEmptyHeading = "";
        heading.tabIndex = -1;
        heading.textContent = "보관한 Threads가 없습니다";
        const copy = document.createElement("p");
        copy.textContent = "Threads URL을 추가하세요.";
        empty.appendChild(heading);
        empty.appendChild(copy);
        list.appendChild(empty);
        focusTarget = heading;
      }
      if (focusTarget instanceof HTMLElement) focusTarget.focus();
    } catch {
      const status = dialog.querySelector("[data-thread-delete-status]");
      if (status instanceof HTMLElement) status.textContent = REQUEST_ERROR;
    } finally {
      if (dialog.open && form.hasAttribute("action")) confirm.disabled = false;
    }
  }
}

if (!customElements.get("thread-panel"))
  customElements.define("thread-panel", ThreadPanel);
