import { setText } from "./dom.js";

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

    const dialog = this.querySelector("[data-repository-dialog]");
    const detailSupported = typeof HTMLDialogElement !== "undefined" &&
      dialog instanceof HTMLDialogElement && typeof dialog.showModal === "function";
    if (detailSupported) {
      dialog.addEventListener("close", () => {
        this.opener?.focus();
        this.opener = null;
      });
    }

    const deleteDialog = this.querySelector("[data-repository-delete-dialog]");
    const deleteForm = deleteDialog?.querySelector("[data-repository-delete-form]");
    const deleteConfirm = deleteDialog?.querySelector("[data-repository-delete-confirm]");
    const deleteSupported = typeof HTMLDialogElement !== "undefined" &&
      deleteDialog instanceof HTMLDialogElement && typeof deleteDialog.showModal === "function" &&
      deleteForm instanceof HTMLFormElement && deleteConfirm instanceof HTMLButtonElement;
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
      if (!(owner instanceof HTMLElement) || !(name instanceof HTMLElement) ||
        !(form instanceof HTMLFormElement) || !(confirm instanceof HTMLButtonElement))
        throw new Error("missing_delete_nodes");
      setText(dialog, "[data-repository-delete-name]", `${owner.textContent}${name.textContent}`);
      form.setAttribute("action", `${source.pathname}/delete`);
      confirm.disabled = false;
      this.deleteOpener = link;
      dialog.showModal();
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
      if (!(summary instanceof HTMLTextAreaElement) || !(note instanceof HTMLTextAreaElement) ||
        !(detail instanceof HTMLAnchorElement)) throw new Error("missing_dialog_nodes");
      summary.value = repository.summary ?? "요약이 아직 없습니다.";
      note.value = repository.personalNote;
      detail.href = detailHref;
      detail.hidden = false;
      this.opener = link;
      dialog.showModal();
    } catch {
      location.href = original;
    }
  }
}

if (!customElements.get("repo-panel")) customElements.define("repo-panel", RepoPanel);
