/** @param {{ querySelector(selector: string): { textContent: string | null } | null }} root @param {string} selector @param {unknown} value */
export function setText(root, selector, value) {
  const node = root.querySelector(selector);
  if (node && node.textContent !== String(value ?? "")) node.textContent = String(value ?? "");
}

/** @param {HTMLFormElement} form @param {AbortSignal} [signal] */
export async function formJson(form, signal) {
  return fetch(form.action, {
    method: form.method,
    body: new FormData(form),
    headers: { Accept: "application/json" },
    credentials: "same-origin",
    signal,
  });
}
