import { setText } from "./dom.js";

class RepoPanel extends HTMLElement {
  connectedCallback() {
    const dialog = this.querySelector("[data-repository-dialog]");
    if (typeof HTMLDialogElement === "undefined" || !(dialog instanceof HTMLDialogElement) ||
      typeof dialog.showModal !== "function" || this.dataset.ready) return;
    this.dataset.ready = "true";
    /** @type {HTMLElement | null} */
    this.opener = null;
    dialog.addEventListener("close", () => {
      this.opener?.focus();
      this.opener = null;
    });
    this.addEventListener("click", (event) => this.open(event, dialog));
  }

  /** @param {MouseEvent} event @param {HTMLDialogElement} dialog */
  async open(event, dialog) {
    const target = event.target;
    const link = target instanceof Element ? target.closest("[data-repository-link]") : null;
    if (!(link instanceof HTMLAnchorElement) || event.button !== 0 || event.altKey ||
      event.ctrlKey || event.metaKey || event.shiftKey ||
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
