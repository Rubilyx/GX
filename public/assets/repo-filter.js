import "./dom.js";

class RepoFilter extends HTMLElement {
  connectedCallback() {
    const form = this.querySelector("form");
    if (!(form instanceof HTMLFormElement) || this.dataset.ready) return;
    this.dataset.ready = "true";
    for (const control of form.querySelectorAll("#q, #tag")) {
      if (!(control instanceof HTMLInputElement || control instanceof HTMLSelectElement)) continue;
      control.addEventListener("pointerdown", () => { control.dataset.pointerFocus = ""; });
      control.addEventListener("keydown", () => { delete control.dataset.pointerFocus; });
      control.addEventListener("blur", () => { delete control.dataset.pointerFocus; });
    }
    for (const select of form.querySelectorAll('[name="category"], [name="tag"]')) {
      select.addEventListener("change", () => {
        const page = form.elements.namedItem("page");
        if (page instanceof HTMLInputElement) page.value = "1";
        /** @type {Array<[{ setAttribute(name: string, value: string): void }, string]>} */
        const empty = [];
        for (const control of form.elements) {
          if ((control instanceof HTMLInputElement || control instanceof HTMLSelectElement ||
            control instanceof HTMLTextAreaElement) && control.name && control.value === "") {
            empty.push([control, control.name]);
            control.removeAttribute("name");
          }
        }
        try { form.requestSubmit(); }
        finally {
          for (const [control, name] of empty) control.setAttribute("name", name);
        }
      });
    }
  }
}

if (!customElements.get("repo-filter")) customElements.define("repo-filter", RepoFilter);
