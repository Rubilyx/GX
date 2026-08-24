const ID = "([0-9a-f-]+)";

/** @type {any[]} */
const THREADS_ROUTES = [
  { path: "/threads",
    kind: "list", methods: ["GET", "POST"], queryAllowed: true, template: "/threads",
  },
  { path: "/threads/connect",
    kind: "connect", methods: ["GET"], queryAllowed: false, template: "/threads/connect",
  },
  { path: "/threads/oauth/callback",
    kind: "callback", methods: ["GET"], queryAllowed: true,
    template: "/threads/oauth/callback",
  },
  { path: "/threads/disconnect",
    kind: "disconnect", methods: ["POST"], queryAllowed: false,
    template: "/threads/disconnect",
  },
  {
    pattern: new RegExp(`^/threads/${ID}$`), kind: "detail", methods: ["GET"],
    queryAllowed: true, template: "/threads/:id", post: 1, media: 0, action: null,
  },
  {
    pattern: new RegExp(`^/threads/${ID}/(sync|delete)$`), kind: null, methods: ["POST"],
    queryAllowed: false, template: null, post: 1, media: 0, action: 2,
  },
  {
    pattern: new RegExp(`^/threads/${ID}/media/${ID}$`), kind: "media",
    methods: ["GET", "HEAD"], queryAllowed: false,
    template: "/threads/:id/media/:mediaId", post: 1, media: 2, action: null,
  },
  {
    pattern: new RegExp(`^/threads/${ID}/media/${ID}/(retry)$`), kind: "retry",
    methods: ["POST"], queryAllowed: false,
    template: "/threads/:id/media/:mediaId/retry", post: 1, media: 2, action: 3,
  },
];

/** @param {string} pathname */
export function matchThreadsRoute(pathname) {
  if (typeof pathname !== "string") return null;
  for (const route of THREADS_ROUTES) {
    if (route.path) {
      if (pathname !== route.path) continue;
      return {
        kind: route.kind, methods: [...route.methods], queryAllowed: route.queryAllowed,
        template: route.template, postId: null, mediaId: null, action: null,
      };
    }
    const match = route.pattern.exec(pathname);
    if (!match) continue;
    const action = route.action === null ? null : match[route.action];
    const kind = route.kind ?? action;
    const template = route.template ?? `/threads/:id/${action}`;
    return {
      kind, methods: [...route.methods], queryAllowed: route.queryAllowed, template,
      postId: match[route.post], mediaId: route.media ? match[route.media] : null,
      action,
    };
  }
  return null;
}

/** @param {unknown} value */
function configuredNames(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("threads_queue_not_configured");
  const names = /** @type {Record<string, unknown>} */ (value);
  const result = [names.capture, names.media, names.captureDlq, names.mediaDlq];
  if (result.some((name) => typeof name !== "string" || !name) ||
    new Set(result).size !== result.length) throw new Error("threads_queue_not_configured");
  return /** @type {string[]} */ (result);
}

/** @param {unknown} candidate */
function queueMessage(candidate) {
  return candidate && typeof candidate === "object" && !Array.isArray(candidate) &&
    typeof /** @type {Record<string, unknown>} */ (candidate).ack === "function" &&
    typeof /** @type {Record<string, unknown>} */ (candidate).retry === "function"
    ? /** @type {any} */ (candidate) : null;
}

/** @param {any} item */
async function acknowledge(item) {
  try { await item.ack(); } catch {}
}

/** @param {any} item @param {unknown} rawDelay */
async function retry(item, rawDelay) {
  const delay = Number.isSafeInteger(rawDelay) ? /** @type {number} */ (rawDelay) : 1;
  const delaySeconds = delay > 0 ? Math.min(900, delay) : 1;
  try { await item.retry({ delaySeconds }); } catch {}
}

/**
 * @param {unknown} batch
 * @param {unknown} names
 * @param {{ validateCapture(message: unknown): unknown, validateMedia(message: unknown): unknown,
 * capture(message: unknown): Promise<unknown>, media(message: unknown): Promise<unknown>,
 * captureDlq(message: unknown): Promise<unknown>, mediaDlq(message: unknown): Promise<unknown> }} adapters
 */
export async function dispatchThreadsQueue(batch, names, adapters) {
  const [captureName, mediaName, captureDlqName, mediaDlqName] = configuredNames(names);
  if (!batch || typeof batch !== "object" || Array.isArray(batch) ||
    typeof /** @type {Record<string, unknown>} */ (batch).queue !== "string" ||
    !Array.isArray(/** @type {Record<string, unknown>} */ (batch).messages))
    throw new Error("threads_queue_not_configured");
  const queue = /** @type {Record<string, any>} */ (batch).queue;
  const route = new Map([
    [captureName, { validate: adapters.validateCapture, handle: adapters.capture }],
    [mediaName, { validate: adapters.validateMedia, handle: adapters.media }],
    [captureDlqName, { validate: adapters.validateCapture, handle: adapters.captureDlq }],
    [mediaDlqName, { validate: adapters.validateMedia, handle: adapters.mediaDlq }],
  ]).get(queue);
  if (!route) throw new Error("threads_queue_not_configured");
  for (const candidate of /** @type {Record<string, any>} */ (batch).messages) {
    const item = queueMessage(candidate);
    if (!item) continue;
    let body;
    try { body = route.validate(item.body); }
    catch { await acknowledge(item); continue; }
    let result;
    try { result = await route.handle(body); }
    catch { result = { action: "retry", delaySeconds: 1 }; }
    const outcome = result && typeof result === "object" && !Array.isArray(result)
      ? /** @type {Record<string, unknown>} */ (result) : {};
    if (outcome.action === "retry") await retry(item, outcome.delaySeconds);
    else await acknowledge(item);
  }
}

/**
 * @param {unknown} controller
 * @param {unknown} context
 * @param {{ refresh(nowSeconds: number): Promise<unknown> }} adapters
 */
export function dispatchThreadsScheduled(controller, context, adapters) {
  if (!controller || typeof controller !== "object" || Array.isArray(controller) ||
    /** @type {Record<string, unknown>} */ (controller).cron !== "0 3 * * *" ||
    typeof /** @type {Record<string, unknown>} */ (controller).scheduledTime !== "number" ||
    !Number.isFinite(/** @type {Record<string, number>} */ (controller).scheduledTime) ||
    !context || typeof context !== "object" || Array.isArray(context) ||
    typeof /** @type {Record<string, unknown>} */ (context).waitUntil !== "function" ||
    !adapters || typeof adapters.refresh !== "function")
    throw new Error("threads_schedule_not_configured");
  const nowSeconds = Math.floor(
    /** @type {Record<string, number>} */ (controller).scheduledTime / 1_000,
  );
  const promise = Promise.resolve().then(() => adapters.refresh(nowSeconds));
  /** @type {{ waitUntil(promise: Promise<unknown>): void }} */ (context).waitUntil(promise);
  return promise;
}
