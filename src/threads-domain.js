import { AppError } from "./domain.js";

/** @typedef {{ kind: "canonical" | "short", submittedUrl: string, canonicalUrl: string | null, username: string | null, shortcode: string }} ThreadsUrl */
/** @typedef {{ url: string, source: "body" | "attachment", ordinal: number }} ThreadsLink */
/** @typedef {Record<string, readonly string[]>} MessageSets */

const HOSTS = new Set(["threads.com", "www.threads.com", "threads.net", "www.threads.net"]);
const HANDLE = /^[A-Za-z0-9._]{1,64}$/;
const SHORTCODE = /^[A-Za-z0-9_-]{1,128}$/;
/** @returns {never} */
const badUrl = () => { throw new AppError("invalid_threads_url", 400); };

/** @param {unknown} raw @returns {ThreadsUrl} */
export function normalizeThreadsUrl(raw) {
  const submitted = String(raw).trim();
  const authority = submitted.match(/^https:\/\/([^/?#]*)/i)?.[1] ?? "";
  const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
  if (hostPort.includes(":")) return badUrl();
  let url;
  try { url = new URL(submitted); } catch { return badUrl(); }
  if (url.protocol !== "https:" || !HOSTS.has(url.hostname.toLowerCase()) || url.username || url.password || url.port) return badUrl();
  let parts;
  try { parts = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean).map(decodeURIComponent).map((p) => p.normalize("NFC")); } catch { return badUrl(); }
  const canonical = parts.length === 3 && parts[0].startsWith("@") && parts[1] === "post";
  const short = parts.length === 2 && parts[0] === "t";
  const username = canonical ? parts[0].slice(1) : null;
  const shortcode = (canonical ? parts[2] : short ? parts[1] : "");
  if ((!canonical && !short) || (username !== null && !HANDLE.test(username)) || !SHORTCODE.test(shortcode)) return badUrl();
  const host = url.hostname.toLowerCase();
  const encodedUsername = encodeURIComponent(username ?? "");
  const submittedUrl = canonical ? `https://${host}/@${encodedUsername}/post/${encodeURIComponent(shortcode)}` : `https://${host}/t/${encodeURIComponent(shortcode)}`;
  return { kind: canonical ? "canonical" : "short", submittedUrl, canonicalUrl: canonical ? `https://www.threads.com/@${encodedUsername}/post/${encodeURIComponent(shortcode)}` : null, username, shortcode };
}

/** @param {URL | string} url @param {Set<string>} accepted @param {string} output @returns {Record<string, number>} */
function query(url, accepted, output) {
  if (!(url instanceof URL)) { try { url = new URL(String(url)); } catch { throw new AppError("invalid_threads_query", 400); } }
  for (const key of url.searchParams.keys()) if (!accepted.has(key) || url.searchParams.getAll(key).length !== 1) throw new AppError("invalid_threads_query", 400);
  const raw = url.searchParams.get([...accepted][0]);
  return { [output]: raw && /^[1-9]\d*$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : 1 };
}
/** @param {URL | string} url @returns {{ page: number }} */
export const parseThreadsListQuery = (url) => /** @type {{ page: number }} */ (query(url, new Set(["page"]), "page"));
/** @param {URL | string} url @returns {{ repliesPage: number }} */
export const parseThreadsDetailQuery = (url) => /** @type {{ repliesPage: number }} */ (query(url, new Set(["repliesPage"]), "repliesPage"));

/** @param {string} value @returns {string | null} */
function safeLink(value) {
  try { const u = new URL(value); if (u.protocol !== "http:" && u.protocol !== "https:") return null; return u.href; } catch { return null; }
}
/** @param {string} value @returns {string} */
function trimLinkPunctuation(value) {
  let result = value;
  const pairs = [["(", ")"], ["[", "]"], ["{", "}"]];
  let changed = true;
  while (result && changed) {
    const before = result;
    result = result.replace(/[.,!?;:]+$/, "");
    while (result && pairs.some(([open, close]) => result.endsWith(close) && [...result].filter((char) => char === close).length > [...result].filter((char) => char === open).length)) result = result.slice(0, -1);
    changed = result !== before;
  }
  return result;
}

/** @param {unknown} text @param {unknown} attachmentUrl @returns {ThreadsLink[]} */
export function extractThreadsLinks(text, attachmentUrl) {
  /** @type {ThreadsLink[]} */ const out = [];
  const seen = new Set();
  /** @param {string} value @param {"body" | "attachment"} source */
  const add = (value, source) => { const url = safeLink(value); if (!url || seen.has(url)) return; seen.add(url); out.push({ url, source, ordinal: out.length }); };
  if (typeof text === "string") for (const match of text.match(/https?:\/\/[^\s<>"']+/gi) ?? []) add(trimLinkPunctuation(match), "body");
  if (typeof attachmentUrl === "string") add(attachmentUrl.trim(), "attachment");
  return out;
}

const CAPTURE = {
  "resolve-post": ["version","type","postId","generation","cursor"], "collect-conversation": ["version","type","postId","generation","cursor"],
  "collect-quote": ["version","type","postId","generation","entryId","quoteId"], "finalize-content": ["version","type","postId","generation"], "delete-archive": ["version","type","postId"],
};
const MEDIA = { "archive-entry-media":["version","type","postId","generation","entryId","mediaId","sourceUrl"], "archive-profile":["version","type","postId","generation","authorId","sourceUrl"], "retry-media":["version","type","postId","generation","mediaId","sourceUrl"], "delete-object":["version","type","objectKey"] };
/** @param {unknown} raw @param {MessageSets} sets @returns {Record<string, unknown>} */
function validate(raw, sets) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new AppError("invalid_threads_queue_message", 400);
  const message = /** @type {Record<string, unknown>} */ (raw);
  if (message.version !== 1 || typeof message.type !== "string" || !sets[message.type]) throw new AppError("invalid_threads_queue_message", 400);
  const keys = sets[message.type]; if (Object.keys(message).length !== keys.length || Object.keys(message).some((k) => !keys.includes(k))) throw new AppError("invalid_threads_queue_message", 400);
  for (const key of keys) if (key !== "version" && key !== "type") { const value = message[key]; if (["generation"].includes(key) ? (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) : ["cursor"].includes(key) ? (value !== null && typeof value !== "string") : (typeof value !== "string" || !value)) throw new AppError("invalid_threads_queue_message", 400); }
  return Object.fromEntries(keys.map((key) => [key, message[key]]));
}
/** @param {unknown} raw @returns {Record<string, unknown>} */
export const validateCaptureMessage = (raw) => validate(raw, CAPTURE);
/** @param {unknown} raw @returns {Record<string, unknown>} */
export const validateMediaMessage = (raw) => validate(raw, MEDIA);
