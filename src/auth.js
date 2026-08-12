import { AppError } from "./domain.js";

const encoder = new TextEncoder();
const PIN = /^[0-9]{6}$/;
const COOKIE_NAME = "__Host-repo_atlas_session";
const SESSION_SECONDS = 604_800;

/** @param {string} value */
function fromBase64(value) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

/** @param {Uint8Array} value */
function toBase64Url(value) {
  return btoa(String.fromCharCode(...value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** @param {string} value */
function fromBase64Url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid_base64url");
  return fromBase64(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "="));
}

/** @param {Uint8Array} left @param {Uint8Array} right */
function equalBytes(left, right) {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1)
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
}

/** @param {string} keyBase64 @param {string} value */
async function hmac(keyBase64, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    fromBase64(keyBase64),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

/** @param {string} pin @param {string} saltBase64 */
export async function derivePinDigest(pin, saltBase64) {
  if (!PIN.test(pin)) return new Uint8Array(32);
  const key = await crypto.subtle.importKey("raw", encoder.encode(pin), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({
    name: "PBKDF2",
    hash: "SHA-256",
    salt: fromBase64(saltBase64),
    iterations: 100_000,
  }, key, 256));
}

/** @param {string} pin @param {string} saltBase64 @param {string} expectedDigestBase64 */
export async function verifyPin(pin, saltBase64, expectedDigestBase64) {
  return PIN.test(pin) && equalBytes(await derivePinDigest(pin, saltBase64), fromBase64(expectedDigestBase64));
}

/** @param {string} ip @param {string} keyBase64 */
export async function hashClientIp(ip, keyBase64) {
  return toBase64Url(await hmac(keyBase64, ip));
}

/**
 * @typedef {{ nonce: string, issuedAt: number, expiresAt: number }} Session
 */

/** @param {number} nowSeconds @param {string} signingKeyBase64 */
export async function createSession(nowSeconds, signingKeyBase64) {
  const nonce = new Uint8Array(16);
  crypto.getRandomValues(nonce);
  const session = { nonce: toBase64Url(nonce), issuedAt: nowSeconds, expiresAt: nowSeconds + SESSION_SECONDS };
  const payload = toBase64Url(encoder.encode(JSON.stringify(session)));
  const signature = toBase64Url(await hmac(signingKeyBase64, payload));
  return {
    session,
    cookie: `${COOKIE_NAME}=${payload}.${signature}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_SECONDS}`,
  };
}

/** @param {string | null} cookieHeader @param {number} nowSeconds @param {string} signingKeyBase64 @returns {Promise<Session | null>} */
export async function verifySession(cookieHeader, nowSeconds, signingKeyBase64) {
  try {
    const matches = (cookieHeader ?? "")
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part.startsWith(`${COOKIE_NAME}=`));
    if (matches.length !== 1) return null;
    const token = matches[0].slice(COOKIE_NAME.length + 1);
    const parts = token.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    const actual = fromBase64Url(parts[1]);
    const expected = await hmac(signingKeyBase64, parts[0]);
    if (!equalBytes(actual, expected)) return null;

    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fromBase64Url(parts[0])));
    if (!parsed || typeof parsed !== "object" || typeof parsed.nonce !== "string" || !parsed.nonce ||
      !Number.isInteger(parsed.issuedAt) || !Number.isInteger(parsed.expiresAt) || parsed.expiresAt <= nowSeconds)
      return null;
    return { nonce: parsed.nonce, issuedAt: parsed.issuedAt, expiresAt: parsed.expiresAt };
  } catch {
    return null;
  }
}

/** @param {Session} session @param {string} signingKeyBase64 */
export async function createCsrfToken(session, signingKeyBase64) {
  return toBase64Url(await hmac(signingKeyBase64, `csrf:${session.nonce}:${session.issuedAt}`));
}

/**
 * @param {Request} request
 * @param {{ allowedOrigin: string, sessionSigningKey: string }} runtime
 * @param {FormData} formData
 */
export async function requireAuthenticatedMutation(request, runtime, formData) {
  if (request.headers.get("Origin") !== runtime.allowedOrigin)
    throw new AppError("session_expired", 401);
  const session = await verifySession(
    request.headers.get("Cookie"),
    Math.floor(Date.now() / 1_000),
    runtime.sessionSigningKey,
  );
  if (!session) throw new AppError("session_expired", 401);
  const actual = formData.get("csrf");
  const expected = await createCsrfToken(session, runtime.sessionSigningKey);
  if (typeof actual !== "string" || !equalBytes(encoder.encode(actual), encoder.encode(expected)))
    throw new AppError("session_expired", 401);
  return session;
}

const UPSERT_FAILURE = `
INSERT INTO auth_attempts (attempt_key, window_started_at, failures, locked_until, updated_at)
VALUES (?, ?, 1, 0, ?)
ON CONFLICT(attempt_key) DO UPDATE SET
  failures = CASE WHEN window_started_at = excluded.window_started_at THEN failures + 1 ELSE 1 END,
  window_started_at = excluded.window_started_at,
  locked_until = CASE
    WHEN (CASE WHEN window_started_at = excluded.window_started_at THEN failures + 1 ELSE 1 END) >= ?
    THEN excluded.updated_at + ? ELSE 0 END,
  updated_at = excluded.updated_at
RETURNING failures, locked_until`;

/** @returns {never} */
function unavailable() {
  throw new AppError("auth_guard_unavailable", 503);
}

/**
 * @param {D1Database | null} db
 * @param {{ pin: string, ip: string, nowSeconds: number, pinSalt: string, pinDigest: string, ipHmacKey: string }} input
 */
export async function authenticatePin(db, input) {
  if (!db || !input.ip) throw new AppError("auth_guard_unavailable", 503);

  let ipKey;
  try { ipKey = `ip:${await hashClientIp(input.ip, input.ipHmacKey)}`; }
  catch { unavailable(); }

  /** @type {{ locked_until: number } | undefined} */
  let ipLock;
  /** @type {{ locked_until: number } | undefined} */
  let globalLock;
  try {
    await db.prepare(
      "DELETE FROM auth_attempts WHERE attempt_key IN (SELECT attempt_key FROM auth_attempts WHERE updated_at < ? LIMIT 100)",
    ).bind(input.nowSeconds - 86_400).run();
    const current = await db.batch([
      db.prepare("SELECT attempt_key, locked_until FROM auth_attempts WHERE attempt_key = ?").bind(ipKey),
      db.prepare("SELECT attempt_key, locked_until FROM auth_attempts WHERE attempt_key = 'global'"),
    ]);
    if (current.length !== 2 || !Array.isArray(current[0]?.results) || !Array.isArray(current[1]?.results) ||
      current[0].results.length > 1 || current[1].results.length > 1)
      unavailable();
    const nextIpLock = /** @type {{ locked_until?: unknown } | undefined} */ (current[0].results[0]);
    const nextGlobalLock = /** @type {{ locked_until?: unknown } | undefined} */ (current[1].results[0]);
    if ((current[0].results.length === 1 && (!nextIpLock || !Number.isInteger(nextIpLock.locked_until))) ||
      (current[1].results.length === 1 && (!nextGlobalLock || !Number.isInteger(nextGlobalLock.locked_until))))
      unavailable();
    ipLock = /** @type {{ locked_until: number } | undefined} */ (nextIpLock);
    globalLock = /** @type {{ locked_until: number } | undefined} */ (nextGlobalLock);
  } catch { unavailable(); }

  if (globalLock && globalLock.locked_until > input.nowSeconds)
    throw new AppError("auth_locked", 429, { scope: "global" });
  if (ipLock && ipLock.locked_until > input.nowSeconds)
    throw new AppError("auth_locked", 429, { scope: "ip" });

  let valid;
  try { valid = await verifyPin(input.pin, input.pinSalt, input.pinDigest); }
  catch { unavailable(); }
  if (valid) {
    try { await db.prepare("DELETE FROM auth_attempts WHERE attempt_key = ?").bind(ipKey).run(); }
    catch { unavailable(); }
    return { ok: true };
  }

  const windowStart = input.nowSeconds - (input.nowSeconds % 900);
  let ipLockedUntil;
  let globalLockedUntil;
  try {
    const failures = await db.batch([
      db.prepare(UPSERT_FAILURE).bind(ipKey, windowStart, input.nowSeconds, 5, 900),
      db.prepare(UPSERT_FAILURE).bind("global", windowStart, input.nowSeconds, 50, 1_800),
    ]);
    if (failures.length !== 2 || !Array.isArray(failures[0]?.results) || !Array.isArray(failures[1]?.results) ||
      failures[0].results.length !== 1 || failures[1].results.length !== 1)
      unavailable();
    const ipFailure = /** @type {{ locked_until?: unknown }} */ (failures[0].results[0]);
    const globalFailure = /** @type {{ locked_until?: unknown }} */ (failures[1].results[0]);
    if (!Number.isInteger(ipFailure?.locked_until) || !Number.isInteger(globalFailure?.locked_until))
      unavailable();
    ipLockedUntil = /** @type {number} */ (ipFailure.locked_until);
    globalLockedUntil = /** @type {number} */ (globalFailure.locked_until);
  } catch { unavailable(); }

  if (globalLockedUntil > input.nowSeconds)
    throw new AppError("auth_locked", 429, { scope: "global" });
  if (ipLockedUntil > input.nowSeconds)
    throw new AppError("auth_locked", 429, { scope: "ip" });
  throw new AppError("invalid_pin", 401);
}
