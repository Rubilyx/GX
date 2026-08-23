import { AppError } from "./domain.js";
import {
  THREADS_SCOPES, debugThreadsAccessToken, exchangeLongLivedThreadsToken,
  exchangeThreadsCode, refreshThreadsAccessToken,
} from "./threads-api.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const OAUTH_COOKIE = "__Host-threads_oauth_state";
const STATE_SECONDS = 600;
const REFRESH_SECONDS = 604_800;
const HKDF_SALT = encoder.encode("repo-atlas-threads-v1");
const TOKEN_AAD = encoder.encode("threads-access-token-v1");
const MAXIMUM_PROVIDER_VALUE = 256;
const MAXIMUM_ACCESS_TOKEN_BYTES = 256;
const MAXIMUM_CIPHERTEXT_VALUE = 384;

/** @typedef {(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>} Fetcher */
/** @typedef {(length: number) => Uint8Array} RandomBytes */
/** @typedef {{ providerUserId: string, encryptedAccessToken: string, tokenNonce: string, scopes: string[], expiresAt: number, refreshedAt: number, updatedAt: number }} Credential */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

/** @param {unknown} value */
function boundedString(value) {
  if (typeof value !== "string" || !value || value.length > MAXIMUM_PROVIDER_VALUE)
    throw new AppError("threads_reconnect_required", 401);
  return value;
}

/** @param {unknown} value */
function boundedAccessToken(value) {
  if (typeof value !== "string" || !value) throw new AppError("threads_reconnect_required", 401);
  const bytes = encoder.encode(value);
  if (bytes.byteLength > MAXIMUM_ACCESS_TOKEN_BYTES)
    throw new AppError("threads_reconnect_required", 401);
  return { value, bytes };
}

/** @param {unknown} value @param {number} maximum */
function storedString(value, maximum) {
  if (typeof value !== "string" || !value || value.length > maximum) throw new Error("invalid_stored_value");
  return value;
}

/** @param {Uint8Array} value */
function toBase64Url(value) {
  return btoa(String.fromCharCode(...value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** @param {string} value */
function fromBase64Url(value) {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid_base64url");
  const decoded = Uint8Array.from(
    atob(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=")),
    (character) => character.charCodeAt(0),
  );
  if (toBase64Url(decoded) !== value) throw new Error("noncanonical_base64url");
  return decoded;
}

/** @param {string} value */
function masterKey(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0)
    throw new Error("invalid_threads_token_key");
  const decoded = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  if (decoded.length !== 32) throw new Error("invalid_threads_token_key");
  return decoded;
}

/** @param {string} tokenKey @param {string} info */
async function derivedBytes(tokenKey, info) {
  const material = await crypto.subtle.importKey("raw", masterKey(tokenKey), "HKDF", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({
    name: "HKDF", hash: "SHA-256", salt: HKDF_SALT, info: encoder.encode(info),
  }, material, 256);
}

/** @param {string} tokenKey */
async function stateKey(tokenKey) {
  return crypto.subtle.importKey("raw", await derivedBytes(tokenKey, "state-hmac-v1"),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

/** @param {string} tokenKey @param {KeyUsage[]} usages */
async function tokenKey(tokenKey, usages) {
  return crypto.subtle.importKey("raw", await derivedBytes(tokenKey, "token-aes-v1"),
    "AES-GCM", false, usages);
}

/** @param {Uint8Array} left @param {Uint8Array} right */
function equalBytes(left, right) {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1)
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
}

/** @param {RandomBytes | undefined} source @param {number} length */
function freshBytes(source, length) {
  const value = source ? source(length) : crypto.getRandomValues(new Uint8Array(length));
  if (!(value instanceof Uint8Array) || value.length !== length) throw new Error("invalid_random_bytes");
  return new Uint8Array(value);
}

/** @param {string} tokenKeyValue @param {string} payload */
async function signState(tokenKeyValue, payload) {
  return new Uint8Array(await crypto.subtle.sign("HMAC", await stateKey(tokenKeyValue), encoder.encode(payload)));
}

/** @param {string} code @param {number} status @returns {never} */
function oauthFailure(code, status) {
  throw new AppError(code, status, { setCookie: clearThreadsOAuthCookie() });
}

/** @param {unknown} error @returns {never} */
function clearAndThrow(error) {
  if (error instanceof AppError) {
    if (error.details.setCookie === clearThreadsOAuthCookie()) throw error;
    throw new AppError(error.code, error.status, { ...error.details, setCookie: clearThreadsOAuthCookie() });
  }
  throw new AppError("storage_unavailable", 503, { setCookie: clearThreadsOAuthCookie() });
}

/** @param {unknown} value @param {string} code @param {number} status */
function requireInteger(value, code, status) {
  if (!Number.isSafeInteger(value) || /** @type {number} */ (value) < 0) throw new AppError(code, status);
  return /** @type {number} */ (value);
}

/** @param {unknown} value */
function configuredString(value) {
  if (typeof value !== "string" || !value || value.length > MAXIMUM_PROVIDER_VALUE)
    throw new AppError("threads_oauth_invalid", 400);
  return value;
}

/** @param {unknown} value */
function redirectUrl(value) {
  let url;
  try { url = new URL(String(value)); } catch { throw new AppError("threads_oauth_invalid", 400); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search ||
    url.pathname !== "/threads/oauth/callback") throw new AppError("threads_oauth_invalid", 400);
  return url;
}

/** @param {string[]} scopes */
function exactScopes(scopes) {
  return scopes.length === THREADS_SCOPES.length &&
    scopes.every((scope, index) => scope === THREADS_SCOPES[index]) &&
    new Set(scopes).size === scopes.length;
}

export const clearThreadsOAuthCookie = () =>
  `${OAUTH_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;

/**
 * @param {{ appId: string, redirectUri: string, sessionNonce: string, tokenKey: string, nowSeconds: number, randomBytes?: RandomBytes }} input
 */
export async function beginThreadsOAuth(input) {
  const appId = configuredString(input?.appId);
  const redirect = redirectUrl(input?.redirectUri);
  const sessionNonce = configuredString(input?.sessionNonce);
  const nowSeconds = requireInteger(input?.nowSeconds, "threads_oauth_invalid", 400);
  const state = toBase64Url(freshBytes(input?.randomBytes, 32));
  const payload = toBase64Url(encoder.encode(JSON.stringify({
    v: 1, state, sessionNonce, expiresAt: nowSeconds + STATE_SECONDS,
  })));
  const signature = toBase64Url(await signState(input?.tokenKey, payload));
  const authorize = new URL("https://threads.net/oauth/authorize");
  authorize.search = new URLSearchParams({
    client_id: appId, redirect_uri: redirect.href, scope: THREADS_SCOPES.join(","),
    response_type: "code", state,
  }).toString();
  return {
    location: authorize.href,
    setCookie: `${OAUTH_COOKIE}=${payload}.${signature}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${STATE_SECONDS}`,
  };
}

/** @param {string | null | undefined} cookieHeader @param {string} tokenKeyValue @param {number} nowSeconds */
async function readState(cookieHeader, tokenKeyValue, nowSeconds) {
  try {
    const matches = (cookieHeader ?? "").split(";").map((part) => part.trim())
      .filter((part) => part.startsWith(`${OAUTH_COOKIE}=`));
    if (matches.length !== 1) oauthFailure("invalid_threads_oauth_callback", 400);
    const parts = matches[0].slice(OAUTH_COOKIE.length + 1).split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) oauthFailure("invalid_threads_oauth_callback", 400);
    const actual = fromBase64Url(parts[1]);
    const expected = await signState(tokenKeyValue, parts[0]);
    if (!equalBytes(actual, expected)) oauthFailure("invalid_threads_oauth_callback", 400);
    const raw = JSON.parse(decoder.decode(fromBase64Url(parts[0])));
    if (!plainObject(raw) || Object.keys(raw).length !== 4 ||
      !["v", "state", "sessionNonce", "expiresAt"].every((key) => Object.hasOwn(raw, key)) ||
      raw.v !== 1 || typeof raw.state !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(raw.state) ||
      typeof raw.sessionNonce !== "string" || !raw.sessionNonce || raw.sessionNonce.length > MAXIMUM_PROVIDER_VALUE ||
      !Number.isSafeInteger(raw.expiresAt) || /** @type {number} */ (raw.expiresAt) <= nowSeconds ||
      /** @type {number} */ (raw.expiresAt) - nowSeconds > STATE_SECONDS)
      oauthFailure("invalid_threads_oauth_callback", 400);
    return /** @type {{ state: string, sessionNonce: string, expiresAt: number }} */ (raw);
  } catch (error) {
    if (error instanceof AppError) throw error;
    oauthFailure("invalid_threads_oauth_callback", 400);
  }
}

/** @param {string} value @param {string} tokenKeyValue @param {RandomBytes | undefined} randomBytes */
async function encryptAccessToken(value, tokenKeyValue, randomBytes) {
  const accessToken = boundedAccessToken(value);
  const nonce = freshBytes(randomBytes, 12);
  const ciphertext = await crypto.subtle.encrypt({
    name: "AES-GCM", iv: nonce, additionalData: TOKEN_AAD,
  }, await tokenKey(tokenKeyValue, ["encrypt"]), accessToken.bytes);
  return { encryptedAccessToken: toBase64Url(new Uint8Array(ciphertext)), tokenNonce: toBase64Url(nonce) };
}

/** @param {Credential} credential @param {string} tokenKeyValue */
async function decryptAccessToken(credential, tokenKeyValue) {
  const nonce = fromBase64Url(credential.tokenNonce);
  const ciphertext = fromBase64Url(credential.encryptedAccessToken);
  if (nonce.length !== 12 || ciphertext.length < 17 || ciphertext.length > MAXIMUM_PROVIDER_VALUE + 16)
    throw new Error("invalid_encrypted_threads_token");
  const plaintext = await crypto.subtle.decrypt({
    name: "AES-GCM", iv: nonce, additionalData: TOKEN_AAD,
  }, await tokenKey(tokenKeyValue, ["decrypt"]), ciphertext);
  return boundedAccessToken(decoder.decode(plaintext)).value;
}

/** @param {unknown} value @returns {Credential | null} */
function credentialRow(value) {
  try {
    if (!plainObject(value)) return null;
    const scopes = typeof value.scopes_json === "string" && value.scopes_json.length <= 2_048
      ? JSON.parse(value.scopes_json) : null;
    if (!Array.isArray(scopes) || !scopes.every((scope) => typeof scope === "string") || !exactScopes(scopes))
      return null;
    return {
      providerUserId: boundedString(value.provider_user_id),
      encryptedAccessToken: storedString(value.encrypted_access_token, MAXIMUM_CIPHERTEXT_VALUE),
      tokenNonce: storedString(value.token_nonce, 16), scopes,
      expiresAt: requireInteger(value.expires_at, "threads_reconnect_required", 401),
      refreshedAt: requireInteger(value.refreshed_at, "threads_reconnect_required", 401),
      updatedAt: requireInteger(value.updated_at, "threads_reconnect_required", 401),
    };
  } catch { return null; }
}

/** @param {D1Database} db */
async function readCredential(db) {
  try {
    return credentialRow(await db.prepare(
      `SELECT provider_user_id, encrypted_access_token, token_nonce, scopes_json,
              expires_at, refreshed_at, updated_at
       FROM threads_oauth_credentials WHERE singleton_id = 1`,
    ).first());
  } catch { throw new AppError("storage_unavailable", 503); }
}

/** @param {unknown} value */
function changedOnce(value) {
  return Array.isArray(value) && value.length === 1 && value[0]?.success === true &&
    Number.isSafeInteger(value[0]?.meta?.changes) && value[0].meta.changes === 1;
}

/** @param {{ appId: string, userId: string, isValid: boolean, expiresAt: number, scopes: string[] }} debug @param {string} appId @param {string} providerUserId @param {number} nowSeconds */
function verifiedDebug(debug, appId, providerUserId, nowSeconds) {
  return debug.isValid === true && debug.appId === appId && debug.userId === providerUserId &&
    Number.isSafeInteger(debug.expiresAt) && debug.expiresAt > nowSeconds && exactScopes(debug.scopes);
}

/**
 * @param {D1Database} db
 * @param {{ appId: string, appSecret: string, redirectUri: string, callbackUrl: string, cookieHeader?: string | null, tokenKey: string, nowSeconds: number, fetcher: Fetcher, randomBytes?: RandomBytes, signal?: AbortSignal }} input
 */
export async function finishThreadsOAuth(db, input) {
  try {
    const appId = configuredString(input?.appId);
    const appSecret = configuredString(input?.appSecret);
    const redirect = redirectUrl(input?.redirectUri);
    const nowSeconds = requireInteger(input?.nowSeconds, "threads_oauth_invalid", 400);
    let callback;
    try { callback = new URL(String(input?.callbackUrl)); }
    catch { oauthFailure("invalid_threads_oauth_callback", 400); }
    if (callback.origin !== redirect.origin || callback.pathname !== redirect.pathname || callback.hash ||
      callback.username || callback.password)
      oauthFailure("invalid_threads_oauth_callback", 400);
    const keys = [...callback.searchParams.keys()];
    const successFields = ["code", "state"];
    const deniedFields = ["error", "error_reason", "error_description", "state"];
    const exactFields = (/** @type {string[]} */ expected) =>
      keys.length === expected.length && expected.every((key) => callback.searchParams.getAll(key).length === 1) &&
      keys.every((key) => expected.includes(key));
    const success = exactFields(successFields);
    const denied = exactFields(deniedFields);
    if (!success && !denied) oauthFailure("invalid_threads_oauth_callback", 400);
    const callbackState = callback.searchParams.get("state");
    const code = success ? callback.searchParams.get("code") : null;
    const description = denied ? callback.searchParams.get("error_description") : null;
    if (!callbackState || callbackState.length > MAXIMUM_PROVIDER_VALUE ||
      (success && (!code || code.length > MAXIMUM_PROVIDER_VALUE)) ||
      (denied && (callback.searchParams.get("error") !== "access_denied" ||
        callback.searchParams.get("error_reason") !== "user_denied" || !description ||
        description.length > MAXIMUM_PROVIDER_VALUE)))
      oauthFailure("invalid_threads_oauth_callback", 400);
    const signed = await readState(input?.cookieHeader, input?.tokenKey, nowSeconds);
    if (!equalBytes(encoder.encode(callbackState), encoder.encode(signed.state)))
      oauthFailure("invalid_threads_oauth_callback", 400);
    if (denied) oauthFailure("threads_oauth_denied", 400);

    const exchanged = await exchangeThreadsCode(input.fetcher, {
      clientId: appId, clientSecret: appSecret, redirectUri: redirect.href,
      code: /** @type {string} */ (code), signal: input?.signal,
    });
    const longLived = await exchangeLongLivedThreadsToken(input.fetcher, {
      clientSecret: appSecret, accessToken: exchanged.accessToken, signal: input?.signal,
    });
    const longAccessToken = boundedAccessToken(longLived.accessToken).value;
    const debug = await debugThreadsAccessToken(input.fetcher, {
      accessToken: longAccessToken, signal: input?.signal,
    });
    if (!verifiedDebug(debug, appId, exchanged.userId, nowSeconds))
      oauthFailure("threads_reconnect_required", 401);
    const encrypted = await encryptAccessToken(longAccessToken, input?.tokenKey, input?.randomBytes);
    const statement = db.prepare(
      `INSERT INTO threads_oauth_credentials
        (singleton_id, provider_user_id, encrypted_access_token, token_nonce, scopes_json,
         expires_at, refreshed_at, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(singleton_id) DO UPDATE SET
         provider_user_id = excluded.provider_user_id,
         encrypted_access_token = excluded.encrypted_access_token,
         token_nonce = excluded.token_nonce,
         scopes_json = excluded.scopes_json,
         expires_at = excluded.expires_at,
         refreshed_at = excluded.refreshed_at,
         updated_at = excluded.updated_at`,
    ).bind(exchanged.userId, encrypted.encryptedAccessToken, encrypted.tokenNonce,
      JSON.stringify(debug.scopes), debug.expiresAt, nowSeconds, nowSeconds);
    let stored;
    try { stored = await db.batch([statement]); }
    catch { throw new AppError("storage_unavailable", 503); }
    if (!changedOnce(stored)) throw new AppError("storage_unavailable", 503);
    return { providerUserId: exchanged.userId, scopes: [...debug.scopes], setCookie: clearThreadsOAuthCookie() };
  } catch (error) { clearAndThrow(error); }
}

/**
 * @param {D1Database} db
 * @param {{ appId: string, tokenKey: string, nowSeconds: number, fetcher: Fetcher, randomBytes?: RandomBytes, signal?: AbortSignal }} input
 */
export async function refreshStoredThreadsCredential(db, input) {
  const appId = configuredString(input?.appId);
  const nowSeconds = requireInteger(input?.nowSeconds, "threads_reconnect_required", 401);
  const credential = await readCredential(db);
  if (!credential || credential.expiresAt <= nowSeconds) return { refreshed: false, reconnectRequired: true };
  let accessToken;
  try { accessToken = await decryptAccessToken(credential, input?.tokenKey); }
  catch { return { refreshed: false, reconnectRequired: true }; }
  if (credential.expiresAt - nowSeconds > REFRESH_SECONDS)
    return { refreshed: false, reconnectRequired: false };
  let refreshed;
  let debug;
  try {
    refreshed = await refreshThreadsAccessToken(input.fetcher, { accessToken, signal: input?.signal });
    const refreshedAccessToken = boundedAccessToken(refreshed.accessToken).value;
    debug = await debugThreadsAccessToken(input.fetcher, { accessToken: refreshedAccessToken, signal: input?.signal });
    refreshed = { ...refreshed, accessToken: refreshedAccessToken };
  } catch (error) {
    if (error instanceof AppError && error.code === "threads_reconnect_required")
      return { refreshed: false, reconnectRequired: true };
    throw error;
  }
  if (!verifiedDebug(debug, appId, credential.providerUserId, nowSeconds))
    return { refreshed: false, reconnectRequired: true };
  let encrypted;
  try { encrypted = await encryptAccessToken(refreshed.accessToken, input?.tokenKey, input?.randomBytes); }
  catch { return { refreshed: false, reconnectRequired: true }; }
  const statement = db.prepare(
    `UPDATE threads_oauth_credentials SET
       encrypted_access_token = ?, token_nonce = ?, scopes_json = ?, expires_at = ?,
       refreshed_at = ?, updated_at = ?
     WHERE singleton_id = 1 AND provider_user_id = ? AND encrypted_access_token = ?
       AND token_nonce = ? AND expires_at = ?`,
  ).bind(encrypted.encryptedAccessToken, encrypted.tokenNonce, JSON.stringify(debug.scopes),
    debug.expiresAt, nowSeconds, nowSeconds, credential.providerUserId,
    credential.encryptedAccessToken, credential.tokenNonce, credential.expiresAt);
  let rotated;
  try { rotated = await db.batch([statement]); }
  catch { throw new AppError("storage_unavailable", 503); }
  if (!changedOnce(rotated)) throw new AppError("storage_unavailable", 503);
  return { refreshed: true, reconnectRequired: false };
}

/**
 * @param {D1Database} db
 * @param {{ appId: string, tokenKey: string, nowSeconds: number, fetcher: Fetcher, randomBytes?: RandomBytes, signal?: AbortSignal }} input
 */
export async function getThreadsAccessToken(db, input) {
  const refresh = await refreshStoredThreadsCredential(db, input);
  if (refresh.reconnectRequired) throw new AppError("threads_reconnect_required", 401);
  const credential = await readCredential(db);
  if (!credential || credential.expiresAt <= input.nowSeconds || !exactScopes(credential.scopes))
    throw new AppError("threads_reconnect_required", 401);
  let accessToken;
  try { accessToken = await decryptAccessToken(credential, input?.tokenKey); }
  catch { throw new AppError("threads_reconnect_required", 401); }
  return {
    accessToken, providerUserId: credential.providerUserId,
    expiresAt: credential.expiresAt, scopes: [...credential.scopes],
  };
}

/** @param {D1Database} db */
export async function disconnectThreads(db) {
  let result;
  try { result = await db.prepare("DELETE FROM threads_oauth_credentials WHERE singleton_id = 1").run(); }
  catch { throw new AppError("storage_unavailable", 503); }
  if (!result || result.success !== true || !Number.isSafeInteger(result.meta?.changes) ||
    (result.meta.changes !== 0 && result.meta.changes !== 1))
    throw new AppError("storage_unavailable", 503);
  return result.meta.changes === 1;
}
