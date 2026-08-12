import { formJson, setText } from "./dom.js";

const MESSAGE = Object.freeze({
  github_rate_limited: "GitHub 요청이 제한되었습니다. 잠시 후 다시 시도하세요.",
  github_unavailable: "GitHub 정보를 불러오지 못했습니다. 다시 시도하세요.",
  invalid_repository_url: "공개 GitHub 저장소 URL을 확인하세요.",
  repository_limit_reached: "저장 한도에 도달했습니다. 기존 항목을 정리하세요.",
  session_expired: "세션이 만료되었습니다. 다시 로그인하세요.",
});
const GENERIC_MESSAGE = "저장소를 저장하지 못했습니다. 다시 시도하세요.";

class RepoCapture extends HTMLElement {
  connectedCallback() {
    const form = this.querySelector("form");
    if (!(form instanceof HTMLFormElement) || this.dataset.ready) return;
    this.dataset.ready = "true";
    /** @type {AbortController | null} */
    this.controller = null;
    form.addEventListener("submit", (event) => this.submit(event, form));
  }

  /** @param {SubmitEvent} event @param {HTMLFormElement} form */
  async submit(event, form) {
    event.preventDefault();
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const button = form.querySelector('button[type="submit"]');
    if (button instanceof HTMLButtonElement) button.disabled = true;
    setText(this, "[data-capture-message]", "저장 중입니다.");
    try {
      const response = await formJson(form, controller.signal);
      let result;
      try { result = await response.json(); }
      catch { throw new Error("invalid_json"); }
      if (!response.ok) {
        const code = result && typeof result === "object" && "errorCode" in result
          ? result.errorCode : "";
        setText(this, "[data-capture-message]",
          typeof code === "string" && Object.hasOwn(MESSAGE, code)
            ? MESSAGE[/** @type {keyof typeof MESSAGE} */ (code)] : GENERIC_MESSAGE);
        return;
      }
      if (!result || typeof result !== "object" ||
        typeof result.repositoryId !== "string" || !/^[0-9a-f-]+$/.test(result.repositoryId) ||
        (result.analysisStatus !== "ready" && result.analysisStatus !== "error"))
        throw new Error("invalid_result");
      location.href = `/repositories/${encodeURIComponent(result.repositoryId)}`;
    } catch {
      if (!controller.signal.aborted)
        setText(this, "[data-capture-message]", GENERIC_MESSAGE);
    } finally {
      if (this.controller === controller) {
        this.controller = null;
        if (button instanceof HTMLButtonElement) button.disabled = false;
      }
    }
  }
}

if (!customElements.get("repo-capture")) customElements.define("repo-capture", RepoCapture);
