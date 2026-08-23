import { formJson, setText } from "./dom.js";

const NOTE_MESSAGE = Object.freeze({
  invalid_personal_note: "개인 메모는 4000자 이내로 입력하세요.",
  session_expired: "세션이 만료되었습니다. 다시 로그인하세요.",
});
const NOTE_ERROR = "메모를 저장하지 못했습니다. 다시 시도하세요.";
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

/** @param {HTMLElement} article @param {string} note */
function syncCardMemo(article, note) {
  setText(article, "[data-repository-link]", note ? "Note 1" : "Note");
  const current = article.querySelector(".repository-memo");
  if (!note) {
    current?.remove();
    return;
  }
  if (current instanceof HTMLElement) {
    setText(current, "[data-repository-memo]", note);
    return;
  }
  const metadata = article.querySelector(".repository-metadata");
  if (!(metadata instanceof HTMLElement)) return;
  const memo = document.createElement("div");
  memo.className = "repository-memo";
  const heading = document.createElement("h3");
  heading.textContent = "Note";
  const content = document.createElement("p");
  content.dataset.repositoryMemo = "";
  content.textContent = note;
  memo.insertAdjacentElement("beforeend", heading);
  memo.insertAdjacentElement("beforeend", content);
  metadata.insertAdjacentElement("beforebegin", memo);
}

/** @param {MouseEvent} event */
function plainPrimaryClick(event) {
  return event.button === 0 && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
}

class RepoPanel extends HTMLElement {
  connectedCallback() {
    if (this.dataset.ready) return;
    this.dataset.ready = "true";
    /** @type {HTMLElement | null} */
    this.opener = null;
    /** @type {HTMLElement | null} */
    this.deleteOpener = null;
    /** @type {AbortController | null} */
    this.noteController = null;

    const dialog = this.querySelector("[data-repository-dialog]");
    const noteForm = dialog?.querySelector("[data-repository-note-form]");
    const noteSave = dialog?.querySelector("[data-repository-note-save]");
    const dialogClose = dialog?.querySelector("[data-repository-dialog-close]");
    const detailSupported = typeof HTMLDialogElement !== "undefined" &&
      dialog instanceof HTMLDialogElement && typeof dialog.showModal === "function";
    const noteSupported = detailSupported && noteForm instanceof HTMLFormElement &&
      noteSave instanceof HTMLButtonElement && dialogClose instanceof HTMLButtonElement;
    if (detailSupported) {
      dialog.addEventListener("close", () => {
        this.noteController?.abort();
        this.noteController = null;
        noteForm?.removeAttribute("action");
        this.setNoteStatus(dialog, "");
        this.opener?.focus();
        this.opener = null;
      });
    }
    if (noteSupported) {
      noteForm.addEventListener("submit", (event) => this.saveNote(event, dialog, noteForm));
      dialogClose.addEventListener("click", () => dialog.close());
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
      if (deleteSupported && this.openDelete(event, deleteDialog)) return;
      if (detailSupported) this.open(event, dialog);
    });
    this.addEventListener("submit", (event) => {
      const form = event.target;
      if (form instanceof HTMLFormElement && form.hasAttribute("data-repository-activity-form"))
        this.refreshActivity(event, form);
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
  async open(event, dialog) {
    const target = event.target;
    const link = target instanceof Element ? target.closest("[data-repository-link]") : null;
    if (!(link instanceof HTMLAnchorElement) || !plainPrimaryClick(event) ||
      !matchMedia("(min-width: 840px)").matches) return;
    event.preventDefault();
    const original = link.href;
    try {
      const source = new URL(original);
      if (source.origin !== location.origin || !/^\/repositories\/[0-9a-f-]+$/.test(source.pathname))
        throw new Error("invalid_link");
      const response = await fetch(original, {
        headers: { Accept: "application/json" }, credentials: "same-origin",
      });
      const result = await response.json();
      const repository = result?.repository;
      if (!response.ok || !repository || typeof repository !== "object" ||
        typeof repository.id !== "string" || !/^[0-9a-f-]+$/.test(repository.id) ||
        typeof repository.owner !== "string" || typeof repository.name !== "string" ||
        !(repository.summary === null || typeof repository.summary === "string") ||
        typeof repository.personalNote !== "string") throw new Error("invalid_result");
      const detailHref = `/repositories/${encodeURIComponent(repository.id)}`;
      if (source.pathname !== detailHref) throw new Error("mismatched_result");
      setText(dialog, "#repository-dialog-heading", `${repository.owner}/${repository.name}`);
      const summary = dialog.querySelector("[data-repository-summary]");
      const note = dialog.querySelector("[data-repository-note]");
      const detail = dialog.querySelector("[data-repository-detail-link]");
      const form = dialog.querySelector("[data-repository-note-form]");
      const save = dialog.querySelector("[data-repository-note-save]");
      if (!(summary instanceof HTMLTextAreaElement) || !(note instanceof HTMLTextAreaElement) ||
        !(detail instanceof HTMLAnchorElement) || !(form instanceof HTMLFormElement) ||
        !(save instanceof HTMLButtonElement)) throw new Error("missing_dialog_nodes");
      summary.value = repository.summary ?? "요약이 아직 없습니다.";
      note.value = repository.personalNote;
      detail.href = detailHref;
      detail.hidden = false;
      form.setAttribute("action", `${detailHref}/note`);
      save.disabled = false;
      this.setNoteStatus(dialog, "");
      this.opener = link;
      dialog.showModal();
    } catch {
      location.href = original;
    }
  }

  /** @param {HTMLElement} root @param {string} message @param {string} [state] */
  setNoteStatus(root, message, state = "") {
    setText(root, "[data-repository-note-status]", message);
    const status = root.querySelector("[data-repository-note-status]");
    if (!(status instanceof HTMLElement)) return;
    if (state) status.dataset.state = state;
    else delete status.dataset.state;
  }

  /** @param {SubmitEvent} event @param {HTMLDialogElement} dialog @param {HTMLFormElement} form */
  async saveNote(event, dialog, form) {
    event.preventDefault();
    this.noteController?.abort();
    const controller = new AbortController();
    this.noteController = controller;
    const save = form.querySelector("[data-repository-note-save]");
    if (save instanceof HTMLButtonElement) save.disabled = true;
    this.setNoteStatus(dialog, "저장 중입니다.");
    try {
      const response = await formJson(form, controller.signal);
      let result;
      try { result = await response.json(); }
      catch { throw new Error("invalid_json"); }
      if (!response.ok) {
        const code = result && typeof result === "object" && "errorCode" in result
          ? result.errorCode : "";
        this.setNoteStatus(dialog,
          typeof code === "string" && Object.hasOwn(NOTE_MESSAGE, code)
            ? NOTE_MESSAGE[/** @type {keyof typeof NOTE_MESSAGE} */ (code)] : NOTE_ERROR,
          "error");
        return;
      }
      const repository = result?.repository;
      const source = new URL(form.action);
      if (!repository || typeof repository !== "object" ||
        typeof repository.id !== "string" || !/^[0-9a-f-]+$/.test(repository.id) ||
        typeof repository.personalNote !== "string" ||
        source.origin !== location.origin ||
        source.pathname !== `/repositories/${encodeURIComponent(repository.id)}/note`)
        throw new Error("invalid_result");
      const note = form.querySelector("[data-repository-note]");
      if (!(note instanceof HTMLTextAreaElement)) throw new Error("missing_note");
      note.value = repository.personalNote;
      const article = this.opener?.closest("article");
      if (article instanceof HTMLElement)
        syncCardMemo(article, repository.personalNote);
      this.setNoteStatus(dialog, "저장 완료", "success");
    } catch {
      if (!controller.signal.aborted) this.setNoteStatus(dialog, NOTE_ERROR, "error");
    } finally {
      if (this.noteController === controller) {
        this.noteController = null;
        if (save instanceof HTMLButtonElement) save.disabled = false;
      }
    }
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
