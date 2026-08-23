// @ts-nocheck
import { AppError } from "./domain.js";

const HOSTS = new Set(["threads.com", "www.threads.com", "threads.net", "www.threads.net"]);
const HANDLE = /^[A-Za-z0-9._]{1,64}$/;
const SHORTCODE = /^[A-Za-z0-9_-]{1,128}$/;
const badUrl = () => { throw new AppError("invalid_threads_url", 400); };

export function normalizeThreadsUrl(raw) {
  const submitted = String(raw).trim();
  if (/^https:\/\/[^/]+:(?:443)(?:[/?#]|$)/i.test(submitted)) return badUrl();
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
  const submittedUrl = canonical ? `https://${host}/@${encodeURIComponent(username)}/post/${encodeURIComponent(shortcode)}` : `https://${host}/t/${encodeURIComponent(shortcode)}`;
  return { kind: canonical ? "canonical" : "short", submittedUrl, canonicalUrl: canonical ? `https://www.threads.com/@${encodeURIComponent(username)}/post/${encodeURIComponent(shortcode)}` : null, username, shortcode };
}

function query(url, accepted, output) {
  if (!(url instanceof URL)) { try { url = new URL(String(url)); } catch { throw new AppError("invalid_threads_query", 400); } }
  for (const key of url.searchParams.keys()) if (!accepted.has(key) || url.searchParams.getAll(key).length !== 1) throw new AppError("invalid_threads_query", 400);
  const raw = url.searchParams.get([...accepted][0]);
  return { [output]: raw && /^[1-9]\d*$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : 1 };
}
export const parseThreadsListQuery = (url) => query(url, new Set(["page"]), "page");
export const parseThreadsDetailQuery = (url) => query(url, new Set(["repliesPage"]), "repliesPage");

function safeLink(value) {
  try { const u = new URL(value); if (u.protocol !== "http:" && u.protocol !== "https:") return null; return u.href; } catch { return null; }
}
export function extractThreadsLinks(text, attachmentUrl) {
  const out = [], seen = new Set();
  const add = (value, source) => { const url = safeLink(value); if (!url || seen.has(url)) return; seen.add(url); out.push({ url, source, ordinal: out.length }); };
  if (typeof text === "string") for (const match of text.match(/https?:\/\/[^\s<>"']+/gi) ?? []) add(match.replace(/[.,!?;:]+(?=(?:\)|\]|\}|$))/g, "").replace(/[)\]}]+$/, ""), "body");
  if (typeof attachmentUrl === "string") add(attachmentUrl.trim(), "attachment");
  return out;
}

const CAPTURE = {
  "resolve-post": ["version","type","postId","generation","cursor"], "collect-conversation": ["version","type","postId","generation","cursor"],
  "collect-quote": ["version","type","postId","generation","entryId","quoteId"], "finalize-content": ["version","type","postId","generation"], "delete-archive": ["version","type","postId"],
};
const MEDIA = { "archive-entry-media":["version","type","postId","generation","entryId","mediaId","sourceUrl"], "archive-profile":["version","type","postId","generation","authorId","sourceUrl"], "retry-media":["version","type","postId","generation","mediaId","sourceUrl"], "delete-object":["version","type","objectKey"] };
function validate(raw, sets) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.version !== 1 || typeof raw.type !== "string" || !sets[raw.type]) throw new AppError("invalid_threads_queue_message", 400);
  const keys = sets[raw.type]; if (Object.keys(raw).length !== keys.length || Object.keys(raw).some((k) => !keys.includes(k))) throw new AppError("invalid_threads_queue_message", 400);
  for (const key of keys) if (key !== "version" && key !== "type") { const v = raw[key]; if (["generation"].includes(key) ? (!Number.isSafeInteger(v) || v <= 0) : ["cursor"].includes(key) ? (v !== null && typeof v !== "string") : (typeof v !== "string" || !v)) throw new AppError("invalid_threads_queue_message", 400); }
  return Object.fromEntries(keys.map((k) => [k, raw[k]]));
}
export const validateCaptureMessage = (raw) => validate(raw, CAPTURE);
export const validateMediaMessage = (raw) => validate(raw, MEDIA);
