import { formJson, setText } from "./dom.js";

const NOTE_MESSAGE = Object.freeze({
  invalid_repository_note: "Note는 1자 이상 4000자 이내로 입력하세요.",
  repository_note_not_found: "Note를 찾을 수 없습니다. 목록을 새로고치세요.",
  session_expired: "세션이 만료되었습니다. 다시 로그인하세요.",
  storage_unavailable: "저장 공간을 사용할 수 없습니다. 다시 시도하세요.",
});
const NOTE_ERROR = "Note 요청을 처리하지 못했습니다. 다시 시도하세요.";
const NOTE_LOAD_ERROR = "Note를 불러오지 못했습니다. 다시 시도하세요.";
const ACTIVITY_ERROR = "활동을 새로고치지 못했습니다.";

/** @param {unknown} value @param {number} [now] */
function activityText(value, now = Date.now()) {
  const pushedAt = Date.parse(String(value ?? ""));
  if (!Number.isFinite(pushedAt)) return null;
  const elapsed = Math.max(0, now - pushedAt);
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

/** @param {unknown} value */
function validId(value) {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value);
}

/** @param {unknown} value @param {string[]} keys */
function hasExactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** @param {unknown} value */
function validNoteBody(value) {
  return typeof value === "string" && value.length >= 1 && value.length <= 4_000 &&
    value.trim() === value && value.normalize("NFC") === value;
}

/** @param {unknown} value @param {string} repositoryId */
function validatedNote(value, repositoryId) {
  if (!hasExactKeys(value, ["id", "repositoryId", "body", "createdAt", "updatedAt"]))
    throw new Error("invalid_note");
  const note = /** @type {Record<string, unknown>} */ (value);
  if (!validId(note.id) || note.repositoryId !== repositoryId || !validNoteBody(note.body) ||
    !Number.isSafeInteger(note.createdAt) || Number(note.createdAt) < 0 ||
    !Number.isSafeInteger(note.updatedAt) || Number(note.updatedAt) < Number(note.createdAt))
    throw new Error("invalid_note");
  return {
    id: /** @type {string} */ (note.id), repositoryId,
    body: /** @type {string} */ (note.body),
    createdAt: /** @type {number} */ (note.createdAt),
    updatedAt: /** @type {number} */ (note.updatedAt),
  };
}

/** @param {unknown} value */
function validatedNoteSummary(value) {
  if (!hasExactKeys(value, ["noteCount", "latestNote"])) throw new Error("invalid_summary");
  const summary = /** @type {Record<string, unknown>} */ (value);
  if (!Number.isSafeInteger(summary.noteCount) || Number(summary.noteCount) < 0 ||
    !((summary.noteCount === 0 && summary.latestNote === null) ||
      (Number(summary.noteCount) > 0 && validNoteBody(summary.latestNote))))
    throw new Error("invalid_summary");
  return {
    noteCount: /** @type {number} */ (summary.noteCount),
    latestNote: /** @type {string | null} */ (summary.latestNote),
  };
}

/** @param {unknown} value @param {string} repositoryId */
function validatedNoteList(value, repositoryId) {
  if (!hasExactKeys(value, ["repository", "notes", "page", "totalPages", "total"]))
    throw new Error("invalid_list");
  const result = /** @type {Record<string, unknown>} */ (value);
  const repository = result.repository;
  if (!hasExactKeys(repository, ["id", "owner", "name", "summary"]))
    throw new Error("invalid_repository");
  const projected = /** @type {Record<string, unknown>} */ (repository);
  if (projected.id !== repositoryId || !validId(projected.id) ||
    typeof projected.owner !== "string" || typeof projected.name !== "string" ||
    !(projected.summary === null || typeof projected.summary === "string") ||
    !Array.isArray(result.notes) || !Number.isSafeInteger(result.page) || Number(result.page) < 1 ||
    !Number.isSafeInteger(result.totalPages) || Number(result.totalPages) < 1 ||
    !Number.isSafeInteger(result.total) || Number(result.total) < 0)
    throw new Error("invalid_list");
  const page = /** @type {number} */ (result.page);
  const totalPages = /** @type {number} */ (result.totalPages);
  const total = /** @type {number} */ (result.total);
  const notes = result.notes.map((note) => validatedNote(note, repositoryId));
  const expectedRows = Math.min(5, Math.max(0, total - (page - 1) * 5));
  if (page > totalPages || totalPages !== Math.max(1, Math.ceil(total / 5)) ||
    notes.length !== expectedRows || new Set(notes.map((note) => note.id)).size !== notes.length)
    throw new Error("invalid_list");
  return {
    repository: {
      id: repositoryId, owner: /** @type {string} */ (projected.owner),
      name: /** @type {string} */ (projected.name),
      summary: /** @type {string | null} */ (projected.summary),
    },
    notes, page, totalPages, total,
  };
}

/** @param {number} unixSeconds */
function noteDate(unixSeconds) {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(unixSeconds * 1_000));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}.${values.month}.${values.day}`;
}

/** @param {unknown} result @param {string} fallback */
function noteMessage(result, fallback) {
  const code = result && typeof result === "object" && !Array.isArray(result) &&
    "errorCode" in result ? result.errorCode : "";
  return typeof code === "string" && Object.hasOwn(NOTE_MESSAGE, code)
    ? NOTE_MESSAGE[/** @type {keyof typeof NOTE_MESSAGE} */ (code)] : fallback;
}

/** @param {Response} response */
async function responseJson(response) {
  try { return await response.json(); }
  catch { throw new Error("invalid_json"); }
}

/** @param {MouseEvent} event */
function plainPrimaryClick(event) {
  return event.button === 0 && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
}

class RepoPanel extends HTMLElement {
  connectedCallback() {
    if (this.dataset.ready) return;
    this.dataset.ready = "true";
    /** @type {{ opener: HTMLElement | null, repositoryId: string, listUrl: string, page: number, controller: AbortController | null, deleteOpener: HTMLElement | null }} */
    this.noteState = {
      opener: null,
      repositoryId: "",
      listUrl: "",
      page: 1,
      controller: null,
      deleteOpener: null,
    };
    /** @type {HTMLElement | null} */
    this.deleteOpener = null;

    const dialog = this.querySelector("[data-repository-dialog]");
    const createForm = dialog?.querySelector("[data-repository-note-create-form]");
    const createSave = dialog?.querySelector("[data-repository-note-create-save]");
    const createField = dialog?.querySelector("[data-repository-note-create]");
    const dialogClose = dialog?.querySelector("[data-repository-dialog-close]");
    const noteList = dialog?.querySelector("[data-repository-note-list]");
    const pagination = dialog?.querySelector("[data-repository-note-pagination]");
    const detailLink = dialog?.querySelector("[data-repository-detail-link]");
    const noteDeleteDialog = this.querySelector("[data-repository-note-delete-dialog]");
    const noteDeleteForm = noteDeleteDialog?.querySelector("[data-repository-note-delete-form]");
    const noteDeleteConfirm = noteDeleteDialog?.querySelector("[data-repository-note-delete-confirm]");
    const noteDeleteCancel = noteDeleteDialog?.querySelector("[data-repository-note-delete-cancel]");
    const noteDeleteStatus = noteDeleteDialog?.querySelector("[data-repository-note-delete-status]");
    const noteSupported = typeof HTMLDialogElement !== "undefined" &&
      dialog instanceof HTMLDialogElement && typeof dialog.showModal === "function" &&
      createForm instanceof HTMLFormElement && createSave instanceof HTMLButtonElement &&
      createField instanceof HTMLTextAreaElement && dialogClose instanceof HTMLButtonElement &&
      noteList instanceof HTMLElement && pagination instanceof HTMLElement &&
      detailLink instanceof HTMLAnchorElement && noteDeleteDialog instanceof HTMLDialogElement &&
      typeof noteDeleteDialog.showModal === "function" && noteDeleteForm instanceof HTMLFormElement &&
      noteDeleteConfirm instanceof HTMLButtonElement && noteDeleteCancel instanceof HTMLButtonElement &&
      noteDeleteStatus instanceof HTMLElement;
    if (noteSupported) {
      noteDeleteConfirm.disabled = true;
      dialog.addEventListener("close", () => this.closeNotes(dialog));
      dialogClose.addEventListener("click", () => this.closeNotes(dialog));
      noteDeleteDialog.addEventListener("close", () => {
        const opener = this.noteState.deleteOpener;
        noteDeleteForm.removeAttribute("action");
        noteDeleteConfirm.disabled = true;
        setText(noteDeleteDialog, "[data-repository-note-delete-date]", "");
        setText(noteDeleteDialog, "[data-repository-note-delete-excerpt]", "");
        this.setNoteStatus(noteDeleteDialog, "");
        this.noteState.deleteOpener = null;
        opener?.focus();
      });
    }

    const deleteDialog = this.querySelector("[data-repository-delete-dialog]");
    const deleteForm = deleteDialog?.querySelector("[data-repository-delete-form]");
    const deleteConfirm = deleteDialog?.querySelector("[data-repository-delete-confirm]");
    const deleteCancel = deleteDialog?.querySelector("[data-repository-delete-cancel]");
    const deleteSupported = typeof HTMLDialogElement !== "undefined" &&
      deleteDialog instanceof HTMLDialogElement && typeof deleteDialog.showModal === "function" &&
      deleteForm instanceof HTMLFormElement && deleteConfirm instanceof HTMLButtonElement &&
      deleteCancel instanceof HTMLButtonElement;
    if (deleteSupported) {
      deleteDialog.addEventListener("close", () => {
        deleteForm.removeAttribute("action");
        deleteConfirm.disabled = true;
        this.deleteOpener?.focus();
        this.deleteOpener = null;
      });
    }

    this.addEventListener("click", (event) => {
      if (!(event instanceof MouseEvent)) return;
      if (deleteSupported && this.openDelete(event, deleteDialog)) return;
      if (!noteSupported) return;
      if (this.pageNotes(event, dialog)) return;
      if (this.beginEdit(event, dialog)) return;
      if (this.openNoteDelete(event, dialog)) return;
      void this.openNotes(event, dialog);
    });
    this.addEventListener("submit", (event) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement)) return;
      if (form.hasAttribute("data-repository-activity-form")) {
        void this.refreshActivity(event, form);
        return;
      }
      if (!noteSupported) return;
      if (form === createForm) void this.createNote(event, dialog, form);
      else if (form.hasAttribute("data-repository-note-update-form"))
        void this.updateNote(event, dialog, form);
      else if (form === noteDeleteForm) void this.deleteNote(event, dialog, form);
    });
  }

  /** @param {MouseEvent} event @param {HTMLDialogElement} dialog */
  openDelete(event, dialog) {
    const target = event.target;
    const link = target instanceof Element ? target.closest("[data-repository-delete]") : null;
    if (!(link instanceof HTMLAnchorElement) || !plainPrimaryClick(event)) return false;
    event.preventDefault();
    const original = link.href;
    try {
      const source = new URL(original);
      const match = /^\/repositories\/([0-9a-f-]+)$/.exec(source.pathname);
      if (source.origin !== location.origin || !match || source.hash !== "#delete-heading")
        throw new Error("invalid_delete_link");
      const article = link.closest("article");
      const owner = article?.querySelector(".repository-owner");
      const name = article?.querySelector(".repository-name");
      const form = dialog.querySelector("[data-repository-delete-form]");
      const confirm = dialog.querySelector("[data-repository-delete-confirm]");
      const cancel = dialog.querySelector("[data-repository-delete-cancel]");
      if (!(owner instanceof HTMLElement) || !(name instanceof HTMLElement) ||
        !(form instanceof HTMLFormElement) || !(confirm instanceof HTMLButtonElement) ||
        !(cancel instanceof HTMLButtonElement))
        throw new Error("missing_delete_nodes");
      setText(dialog, "[data-repository-delete-name]", `${owner.textContent}${name.textContent}`);
      form.setAttribute("action", `${source.pathname}/delete`);
      confirm.disabled = false;
      this.deleteOpener = link;
      dialog.showModal();
      cancel.focus();
    } catch {
      location.href = original;
    }
    return true;
  }

  /** @param {MouseEvent} event @param {HTMLDialogElement} dialog */
  async openNotes(event, dialog) {
    const target = event.target;
    const link = target instanceof Element ? target.closest("[data-repository-link]") : null;
    if (!(link instanceof HTMLAnchorElement) || !plainPrimaryClick(event) ||
      !matchMedia("(min-width: 840px)").matches) return;
    event.preventDefault();
    const original = link.href;
    try {
      const source = new URL(original);
      const match = /^\/repositories\/([0-9a-f-]+)\/notes$/.exec(source.pathname);
      if (source.origin !== location.origin || source.username || source.password || !match ||
        source.search || source.hash) throw new Error("invalid_note_link");
      this.noteState.opener = link;
      this.noteState.repositoryId = match[1];
      this.noteState.listUrl = source.pathname;
      this.noteState.page = 1;
      const result = await this.loadNotes(dialog, source.href);
      if (!result) {
        if (this.noteState.opener === link) location.href = original;
        return;
      }
      if (this.noteState.opener !== link || this.noteState.repositoryId !== match[1]) return;
      dialog.showModal();
      const field = dialog.querySelector("[data-repository-note-create]");
      if (!(field instanceof HTMLTextAreaElement)) throw new Error("missing_note_field");
      field.focus();
    } catch {
      if (this.noteState.opener === link) location.href = original;
    }
  }

  /** @param {HTMLDialogElement} dialog @param {string} url */
  async loadNotes(dialog, url) {
    this.noteState.controller?.abort();
    const controller = new AbortController();
    this.noteState.controller = controller;
    this.setNoteStatus(dialog, "Note를 불러오는 중입니다.");
    try {
      const source = new URL(url, location.href);
      const pageValues = source.searchParams.getAll("page");
      if (source.origin !== location.origin || source.username || source.password || source.hash ||
        source.pathname !== this.noteState.listUrl ||
        [...source.searchParams.keys()].some((key) => key !== "page") || pageValues.length > 1 ||
        (pageValues.length === 1 && !/^[1-9][0-9]*$/.test(pageValues[0])))
        throw new Error("invalid_note_page");
      const repositoryId = this.noteState.repositoryId;
      const response = await fetch(source.href, {
        headers: { Accept: "application/json" }, credentials: "same-origin", signal: controller.signal,
      });
      const raw = await responseJson(response);
      if (!response.ok) throw new Error("note_list_failed");
      const result = validatedNoteList(raw, repositoryId);
      if (controller.signal.aborted || this.noteState.controller !== controller ||
        this.noteState.repositoryId !== repositoryId) return null;
      this.noteState.page = result.page;
      setText(dialog, "[data-repository-notes-heading]",
        `${result.repository.owner}/${result.repository.name} Note`);
      setText(dialog, "[data-repository-notes-summary]",
        result.repository.summary ?? "요약이 아직 없습니다.");
      const detail = dialog.querySelector("[data-repository-detail-link]");
      const form = dialog.querySelector("[data-repository-note-create-form]");
      if (!(detail instanceof HTMLAnchorElement) || !(form instanceof HTMLFormElement))
        throw new Error("missing_note_nodes");
      detail.setAttribute("href", `/repositories/${encodeURIComponent(repositoryId)}`);
      detail.hidden = false;
      form.setAttribute("action", this.noteState.listUrl);
      this.renderNotes(dialog, result);
      this.setNoteStatus(dialog, "");
      return result;
    } catch {
      if (!controller.signal.aborted && this.noteState.controller === controller)
        this.setNoteStatus(dialog, NOTE_LOAD_ERROR, "error");
      return null;
    } finally {
      if (this.noteState.controller === controller) this.noteState.controller = null;
    }
  }

  /** @param {HTMLDialogElement} dialog @param {ReturnType<typeof validatedNoteList>} result */
  renderNotes(dialog, result) {
    const section = dialog.querySelector("[data-repository-note-list]");
    const pagination = dialog.querySelector("[data-repository-note-pagination]");
    if (!(section instanceof HTMLElement) || !(pagination instanceof HTMLElement))
      throw new Error("missing_note_list");
    const heading = document.createElement("h3");
    heading.id = "repository-dialog-note-list-heading";
    heading.dataset.repositoryNoteListHeading = "";
    heading.tabIndex = -1;
    heading.textContent = result.notes.length ? `Note ${result.total}` : "저장한 Note가 없습니다";
    section.setAttribute("aria-labelledby", heading.id);
    section.setAttribute("data-page", String(result.page));
    if (!result.notes.length) {
      section.dataset.empty = "true";
      const empty = document.createElement("p");
      empty.className = "repository-note-empty";
      empty.textContent = "첫 Note를 작성하세요.";
      section.replaceChildren(heading, empty);
    } else {
      delete section.dataset.empty;
      const list = document.createElement("ol");
      list.className = "repository-note-list";
      for (const note of result.notes) {
        const item = document.createElement("li");
        item.dataset.repositoryNoteItem = "";
        item.setAttribute("data-note-id", note.id);
        const body = document.createElement("p");
        body.className = "repository-note-body";
        body.textContent = note.body;
        const meta = document.createElement("p");
        meta.className = "repository-note-meta";
        const createdLabel = document.createElement("span");
        createdLabel.textContent = "작성 ";
        const created = document.createElement("time");
        const createdText = noteDate(note.createdAt);
        created.className = "repository-note-created";
        created.setAttribute("datetime", createdText.replaceAll(".", "-"));
        created.textContent = createdText;
        meta.appendChild(createdLabel);
        meta.appendChild(created);
        if (note.updatedAt > note.createdAt) {
          const updatedLabel = document.createElement("span");
          updatedLabel.textContent = " · 수정 ";
          const updated = document.createElement("time");
          const updatedText = noteDate(note.updatedAt);
          updated.setAttribute("datetime", updatedText.replaceAll(".", "-"));
          updated.textContent = updatedText;
          meta.appendChild(updatedLabel);
          meta.appendChild(updated);
        }
        const actions = document.createElement("div");
        actions.className = "repository-note-actions";
        const edit = document.createElement("button");
        edit.type = "button";
        edit.dataset.repositoryNoteEdit = "";
        edit.textContent = "수정";
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "button-danger";
        remove.dataset.repositoryNoteDelete = "";
        remove.textContent = "삭제";
        actions.appendChild(edit);
        actions.appendChild(remove);
        item.appendChild(body);
        item.appendChild(meta);
        item.appendChild(actions);
        list.appendChild(item);
      }
      section.replaceChildren(heading, list);
    }

    pagination.className = "repository-note-pagination";
    const links = [];
    if (result.totalPages > 1 && result.page > 1) {
      const previous = document.createElement("a");
      previous.setAttribute("href", `${this.noteState.listUrl}?page=${result.page - 1}`);
      previous.setAttribute("rel", "prev");
      previous.textContent = "이전";
      links.push(previous);
    }
    for (let page = 1; page <= result.totalPages; page += 1) {
      const link = document.createElement("a");
      link.setAttribute("href", `${this.noteState.listUrl}?page=${page}`);
      link.textContent = String(page);
      if (page === result.page) link.setAttribute("aria-current", "page");
      links.push(link);
    }
    if (result.totalPages > 1 && result.page < result.totalPages) {
      const next = document.createElement("a");
      next.setAttribute("href", `${this.noteState.listUrl}?page=${result.page + 1}`);
      next.setAttribute("rel", "next");
      next.textContent = "다음";
      links.push(next);
    }
    pagination.hidden = result.totalPages <= 1;
    pagination.replaceChildren(...links);
  }

  /** @param {MouseEvent} event @param {HTMLDialogElement} dialog */
  pageNotes(event, dialog) {
    const target = event.target;
    const link = target instanceof Element
      ? target.closest("[data-repository-note-pagination] a") : null;
    if (!(link instanceof HTMLAnchorElement) || !dialog.open || !plainPrimaryClick(event)) return false;
    try {
      const source = new URL(link.href);
      if (source.origin !== location.origin || source.pathname !== this.noteState.listUrl ||
        !/^\?page=[1-9][0-9]*$/.test(source.search) || source.hash)
        throw new Error("invalid_note_page_link");
      event.preventDefault();
      void this.loadNotes(dialog, source.href);
    } catch {
      return false;
    }
    return true;
  }

  /** @param {SubmitEvent} event @param {HTMLDialogElement} dialog @param {HTMLFormElement} form */
  async createNote(event, dialog, form) {
    event.preventDefault();
    this.noteState.controller?.abort();
    const controller = new AbortController();
    this.noteState.controller = controller;
    const save = form.querySelector("[data-repository-note-create-save]");
    const draft = form.querySelector("[data-repository-note-create]");
    if (!(save instanceof HTMLButtonElement) || !(draft instanceof HTMLTextAreaElement)) return;
    save.disabled = true;
    this.setNoteStatus(dialog, "Note를 저장하는 중입니다.");
    try {
      const source = new URL(form.action);
      if (source.origin !== location.origin || source.pathname !== this.noteState.listUrl || source.search)
        throw new Error("invalid_create_action");
      const response = await formJson(form, controller.signal);
      const result = await responseJson(response);
      if (!response.ok) {
        this.setNoteStatus(dialog, noteMessage(result, NOTE_ERROR), "error");
        return;
      }
      if (!hasExactKeys(result, ["note", "noteSummary"])) throw new Error("invalid_create_result");
      validatedNote(result?.note, this.noteState.repositoryId);
      const summary = validatedNoteSummary(result?.noteSummary);
      const article = this.noteState.opener?.closest("article");
      if (article instanceof HTMLElement) this.syncCardNotes(article, summary);
      draft.value = "";
      this.setNoteStatus(dialog, "Note를 저장했습니다.", "success");
      if (this.noteState.controller === controller) this.noteState.controller = null;
      await this.loadNotes(dialog, `${this.noteState.listUrl}?page=1`);
    } catch {
      if (!controller.signal.aborted) this.setNoteStatus(dialog, NOTE_ERROR, "error");
    } finally {
      if (this.noteState.controller === controller) this.noteState.controller = null;
      save.disabled = false;
    }
  }

  /** @param {MouseEvent} event @param {HTMLDialogElement} dialog */
  beginEdit(event, dialog) {
    const target = event.target;
    const button = target instanceof Element ? target.closest("[data-repository-note-edit]") : null;
    if (!(button instanceof HTMLButtonElement)) return false;
    event.preventDefault();
    const item = button.closest("[data-repository-note-item]");
    const body = item?.querySelector(".repository-note-body");
    const remove = item?.querySelector("[data-repository-note-delete]");
    const noteId = item?.getAttribute("data-note-id") ?? "";
    const token = dialog.querySelector('[data-repository-note-create-form] input[name="csrf"]');
    if (!(item instanceof HTMLElement) || !(body instanceof HTMLParagraphElement) ||
      !(remove instanceof HTMLButtonElement) || !(token instanceof HTMLInputElement) ||
      !validId(noteId)) return true;
    const form = document.createElement("form");
    form.dataset.repositoryNoteUpdateForm = "";
    form.setAttribute("method", "post");
    form.setAttribute("action", `${this.noteState.listUrl}/${encodeURIComponent(noteId)}`);
    const csrf = document.createElement("input");
    csrf.type = "hidden";
    csrf.name = "csrf";
    csrf.value = token.value;
    const label = document.createElement("label");
    const textareaId = `dialog-note-body-${noteId}`;
    label.className = "visually-hidden";
    label.setAttribute("for", textareaId);
    label.textContent = "Note 수정";
    const textarea = document.createElement("textarea");
    textarea.id = textareaId;
    textarea.name = "body";
    textarea.maxLength = 4_000;
    textarea.required = true;
    textarea.textContent = body.textContent ?? "";
    const actions = document.createElement("div");
    actions.className = "repository-note-edit-actions";
    const save = document.createElement("button");
    save.type = "submit";
    save.textContent = "저장";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.dataset.repositoryNoteEditCancel = "";
    cancel.textContent = "취소";
    actions.appendChild(save);
    actions.appendChild(cancel);
    form.appendChild(csrf);
    form.appendChild(label);
    form.appendChild(textarea);
    form.appendChild(actions);
    button.disabled = true;
    remove.disabled = true;
    body.replaceWith(form);
    cancel.addEventListener("click", () => {
      form.replaceWith(body);
      button.disabled = false;
      remove.disabled = false;
      button.focus();
    });
    textarea.focus();
    return true;
  }

  /** @param {SubmitEvent} event @param {HTMLDialogElement} dialog @param {HTMLFormElement} form */
  async updateNote(event, dialog, form) {
    event.preventDefault();
    this.noteState.controller?.abort();
    const controller = new AbortController();
    this.noteState.controller = controller;
    const save = form.querySelector('button[type="submit"]');
    if (save instanceof HTMLButtonElement) save.disabled = true;
    this.setNoteStatus(dialog, "Note를 수정하는 중입니다.");
    try {
      const source = new URL(form.action);
      const match = new RegExp(`^${this.noteState.listUrl}/([0-9a-f-]+)$`).exec(source.pathname);
      if (source.origin !== location.origin || !match || source.search || source.hash)
        throw new Error("invalid_update_action");
      const response = await formJson(form, controller.signal);
      const result = await responseJson(response);
      if (!response.ok) {
        this.setNoteStatus(dialog, noteMessage(result, NOTE_ERROR), "error");
        return;
      }
      if (!hasExactKeys(result, ["note", "noteSummary"])) throw new Error("invalid_update_result");
      const note = validatedNote(result?.note, this.noteState.repositoryId);
      if (note.id !== match[1]) throw new Error("mismatched_note");
      const summary = validatedNoteSummary(result?.noteSummary);
      const article = this.noteState.opener?.closest("article");
      if (article instanceof HTMLElement) this.syncCardNotes(article, summary);
      this.setNoteStatus(dialog, "Note를 수정했습니다.", "success");
      if (this.noteState.controller === controller) this.noteState.controller = null;
      await this.loadNotes(dialog, `${this.noteState.listUrl}?page=${this.noteState.page}`);
    } catch {
      if (!controller.signal.aborted) this.setNoteStatus(dialog, NOTE_ERROR, "error");
    } finally {
      if (this.noteState.controller === controller) this.noteState.controller = null;
      if (save instanceof HTMLButtonElement) save.disabled = false;
    }
  }

  /** @param {MouseEvent} event @param {HTMLDialogElement} dialog */
  openNoteDelete(event, dialog) {
    const target = event.target;
    const button = target instanceof Element ? target.closest("[data-repository-note-delete]") : null;
    if (!(button instanceof HTMLButtonElement)) return false;
    event.preventDefault();
    const item = button.closest("[data-repository-note-item]");
    const noteId = item?.getAttribute("data-note-id") ?? "";
    const body = item?.querySelector(".repository-note-body");
    const created = item?.querySelector(".repository-note-created");
    const confirmation = this.querySelector("[data-repository-note-delete-dialog]");
    const form = confirmation?.querySelector("[data-repository-note-delete-form]");
    const confirm = confirmation?.querySelector("[data-repository-note-delete-confirm]");
    const cancel = confirmation?.querySelector("[data-repository-note-delete-cancel]");
    const date = confirmation?.querySelector("[data-repository-note-delete-date]");
    const excerpt = confirmation?.querySelector("[data-repository-note-delete-excerpt]");
    if (!(item instanceof HTMLElement) || !validId(noteId) ||
      !(body instanceof HTMLParagraphElement) || !(created instanceof HTMLTimeElement) ||
      !(confirmation instanceof HTMLDialogElement) || !(form instanceof HTMLFormElement) ||
      !(confirm instanceof HTMLButtonElement) || !(cancel instanceof HTMLButtonElement) ||
      !(date instanceof HTMLTimeElement) || !(excerpt instanceof HTMLElement)) return true;
    date.textContent = created.textContent;
    date.setAttribute("datetime", created.getAttribute("datetime") ?? "");
    excerpt.textContent = (body.textContent ?? "").slice(0, 80);
    form.setAttribute("action", `${this.noteState.listUrl}/${encodeURIComponent(noteId)}/delete`);
    confirm.disabled = false;
    this.setNoteStatus(confirmation, "");
    this.noteState.deleteOpener = button;
    confirmation.showModal();
    cancel.focus();
    return true;
  }

  /** @param {SubmitEvent} event @param {HTMLDialogElement} dialog @param {HTMLFormElement} form */
  async deleteNote(event, dialog, form) {
    event.preventDefault();
    this.noteState.controller?.abort();
    const controller = new AbortController();
    this.noteState.controller = controller;
    const confirmation = form.closest("[data-repository-note-delete-dialog]");
    const confirm = form.querySelector("[data-repository-note-delete-confirm]");
    if (confirm instanceof HTMLButtonElement) confirm.disabled = true;
    if (confirmation instanceof HTMLElement)
      this.setNoteStatus(confirmation, "Note를 삭제하는 중입니다.");
    try {
      const source = new URL(form.action);
      const match = new RegExp(`^${this.noteState.listUrl}/([0-9a-f-]+)/delete$`).exec(source.pathname);
      if (source.origin !== location.origin || !match || source.search || source.hash)
        throw new Error("invalid_delete_action");
      const response = await formJson(form, controller.signal);
      const result = await responseJson(response);
      if (!response.ok) {
        if (confirmation instanceof HTMLElement)
          this.setNoteStatus(confirmation, noteMessage(result, NOTE_ERROR), "error");
        return;
      }
      if (!hasExactKeys(result, ["repositoryId", "noteId", "noteSummary"]) ||
        result.repositoryId !== this.noteState.repositoryId || result.noteId !== match[1])
        throw new Error("invalid_delete_result");
      const summary = validatedNoteSummary(result.noteSummary);
      const article = this.noteState.opener?.closest("article");
      if (article instanceof HTMLElement) this.syncCardNotes(article, summary);
      this.noteState.deleteOpener = null;
      if (confirmation instanceof HTMLElement) this.setNoteStatus(confirmation, "");
      if (confirmation instanceof HTMLDialogElement && confirmation.open) confirmation.close();
      this.setNoteStatus(dialog, "Note를 삭제했습니다.", "success");
      if (this.noteState.controller === controller) this.noteState.controller = null;
      const resultPage = await this.loadNotes(
        dialog, `${this.noteState.listUrl}?page=${this.noteState.page}`,
      );
      if (resultPage) {
        const heading = dialog.querySelector("[data-repository-note-list-heading]");
        if (heading instanceof HTMLElement) heading.focus();
      }
    } catch {
      if (!controller.signal.aborted && confirmation instanceof HTMLElement)
        this.setNoteStatus(confirmation, NOTE_ERROR, "error");
    } finally {
      if (this.noteState.controller === controller) this.noteState.controller = null;
      if (confirm instanceof HTMLButtonElement &&
        confirmation instanceof HTMLDialogElement && confirmation.open) confirm.disabled = false;
    }
  }

  /** @param {HTMLElement} article @param {{ noteCount: number, latestNote: string | null }} noteSummary */
  syncCardNotes(article, noteSummary) {
    setText(article, "[data-repository-link]",
      noteSummary.noteCount > 0 ? `Note ${noteSummary.noteCount}` : "Note");
    const current = article.querySelector(".repository-memo");
    if (noteSummary.latestNote === null) {
      current?.remove();
      return;
    }
    if (current instanceof HTMLElement) {
      setText(current, "[data-repository-memo]", noteSummary.latestNote);
      return;
    }
    const metadata = article.querySelector(".repository-metadata");
    if (!(metadata instanceof HTMLElement) || !metadata.parentNode) return;
    const memo = document.createElement("div");
    memo.className = "repository-memo";
    const heading = document.createElement("h3");
    heading.textContent = "Note";
    const content = document.createElement("p");
    content.dataset.repositoryMemo = "";
    content.textContent = noteSummary.latestNote;
    memo.appendChild(heading);
    memo.appendChild(content);
    metadata.parentNode.insertBefore(memo, metadata);
  }

  /** @param {HTMLElement} root @param {string} message @param {string} [state] */
  setNoteStatus(root, message, state = "") {
    setText(root, "[data-repository-note-status]", message);
    const status = root.querySelector("[data-repository-note-status]");
    if (!(status instanceof HTMLElement)) return;
    if (state) status.dataset.state = state;
    else delete status.dataset.state;
  }

  /** @param {HTMLDialogElement} dialog */
  closeNotes(dialog) {
    const opener = this.noteState.opener;
    this.noteState.controller?.abort();
    const form = dialog.querySelector("[data-repository-note-create-form]");
    const list = dialog.querySelector("[data-repository-note-list]");
    const pagination = dialog.querySelector("[data-repository-note-pagination]");
    const detail = dialog.querySelector("[data-repository-detail-link]");
    if (form instanceof HTMLFormElement) {
      form.reset();
      form.removeAttribute("action");
    }
    if (list instanceof HTMLElement) {
      list.replaceChildren();
      list.removeAttribute("data-empty");
      list.removeAttribute("data-page");
    }
    pagination?.replaceChildren();
    if (detail instanceof HTMLAnchorElement) {
      detail.hidden = true;
      detail.removeAttribute("href");
    }
    this.setNoteStatus(dialog, "");
    this.noteState = {
      opener: null, repositoryId: "", listUrl: "", page: 1, controller: null,
      deleteOpener: null,
    };
    if (dialog.open) dialog.close();
    opener?.focus();
  }

  /** @param {SubmitEvent} event @param {HTMLFormElement} form */
  async refreshActivity(event, form) {
    event.preventDefault();
    const button = form.querySelector("[data-repository-activity-refresh]");
    const field = form.closest('[data-repository-field="activity"]');
    const value = field?.querySelector("[data-repository-activity-value]");
    const status = field?.querySelector("[data-repository-activity-status]");
    if (!(button instanceof HTMLButtonElement) || !(value instanceof HTMLElement) ||
      !(status instanceof HTMLElement)) return;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    status.textContent = "";
    try {
      const response = await formJson(form);
      let result;
      try { result = await response.json(); }
      catch { throw new Error("invalid_json"); }
      const repository = result?.repository;
      const source = new URL(form.action);
      if (!response.ok || !repository || typeof repository !== "object" ||
        typeof repository.id !== "string" || !/^[0-9a-f-]+$/.test(repository.id) ||
        !(repository.githubPushedAt === null || typeof repository.githubPushedAt === "string") ||
        typeof repository.activityRefreshedAt !== "number" ||
        source.origin !== location.origin ||
        source.pathname !== `/repositories/${encodeURIComponent(repository.id)}/activity`)
        throw new Error("invalid_result");
      if (repository.githubPushedAt === null) {
        value.textContent = "활동 내역 없음";
      } else {
        const label = activityText(repository.githubPushedAt);
        if (!label) throw new Error("invalid_activity");
        const time = document.createElement("time");
        time.dateTime = repository.githubPushedAt;
        time.textContent = label;
        value.replaceChildren(time);
      }
    } catch {
      status.textContent = ACTIVITY_ERROR;
    } finally {
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
  }
}

if (!customElements.get("repo-panel")) customElements.define("repo-panel", RepoPanel);
