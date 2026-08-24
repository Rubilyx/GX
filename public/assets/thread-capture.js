import { formJson } from "./dom.js";

const MESSAGE = Object.freeze({
  invalid_threads_url: "Threads 게시물 URL을 확인하세요.",
  threads_post_not_found: "Threads 게시물을 찾을 수 없습니다.",
  threads_rate_limited: "Threads 요청이 제한되었습니다. 잠시 후 다시 시도하세요.",
  threads_reconnect_required: "Threads를 다시 연결하세요.",
  session_expired: "세션이 만료되었습니다. 다시 로그인하세요.",
  queue_unavailable: "요청을 대기열에 추가하지 못했습니다. 다시 시도하세요.",
});
const WORKING = "Threads 게시물을 보관하는 중입니다.";
const FAILED = "Threads 게시물을 보관하지 못했습니다. 다시 시도하세요.";
const ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

/** @param {unknown} value @param {string[]} keys */
function exact(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** @param {unknown} value */
function captureResult(value) {
  if (!exact(value, ["threadsPostId", "generation", "status", "duplicate"]))
    throw new Error("invalid_capture_result");
  const result = /** @type {Record<string, unknown>} */ (value);
  if (typeof result.threadsPostId !== "string" || !ID.test(result.threadsPostId) ||
    !Number.isSafeInteger(result.generation) || Number(result.generation) < 1 ||
    result.status !== "pending" || typeof result.duplicate !== "boolean")
    throw new Error("invalid_capture_result");
  return /** @type {string} */ (result.threadsPostId);
}

/** @param {unknown} value */
function errorMessage(value) {
  if (!exact(value, ["errorCode"])) return FAILED;
  const code = /** @type {Record<string, unknown>} */ (value).errorCode;
  return typeof code === "string" && Object.hasOwn(MESSAGE, code)
    ? MESSAGE[/** @type {keyof typeof MESSAGE} */ (code)] : FAILED;
}

class ThreadCapture extends HTMLElement {
  connectedCallback() {
    if (this.dataset.ready) return;
    const form = this.querySelector(":scope > form");
    if (!(form instanceof HTMLFormElement)) return;
    this.dataset.ready = "true";
    /** @type {AbortController | null} */
    this.controller = null;
    form.addEventListener("submit", (event) => {
      if (event instanceof SubmitEvent) void this.submit(event, form);
    });
  }

  disconnectedCallback() {
    this.controller?.abort();
    this.controller = null;
  }

  /** @param {SubmitEvent} event @param {HTMLFormElement} form */
  async submit(event, form) {
    if (event.defaultPrevented || !form.checkValidity()) return;
    const submitter = event.submitter;
    if (submitter !== null && !(submitter instanceof HTMLButtonElement ||
      submitter instanceof HTMLInputElement)) return;
    event.preventDefault();
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const button = submitter instanceof HTMLButtonElement || submitter instanceof HTMLInputElement
      ? submitter : form.querySelector('button[type="submit"], input[type="submit"]');
    if (button instanceof HTMLButtonElement || button instanceof HTMLInputElement)
      button.disabled = true;
    const message = this.querySelector("[data-thread-capture-message]");
    if (message instanceof HTMLElement) message.textContent = WORKING;
    try {
      const response = await formJson(form, controller.signal);
      let body;
      try { body = await response.json(); }
      catch { throw new Error("invalid_json"); }
      if (!response.ok) {
        if (message instanceof HTMLElement) message.textContent = errorMessage(body);
        return;
      }
      const id = captureResult(body);
      location.href = `/threads/${encodeURIComponent(id)}`;
    } catch {
      if (!controller.signal.aborted && message instanceof HTMLElement)
        message.textContent = FAILED;
    } finally {
      if (this.controller === controller) {
        this.controller = null;
        if (button instanceof HTMLButtonElement || button instanceof HTMLInputElement)
          button.disabled = false;
      }
    }
  }
}

if (!customElements.get("thread-capture"))
  customElements.define("thread-capture", ThreadCapture);
