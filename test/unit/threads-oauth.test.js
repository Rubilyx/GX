import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../../src/domain.js";
import {
  beginThreadsOAuth, clearThreadsOAuthCookie, finishThreadsOAuth,
} from "../../src/threads-oauth.js";

const TOKEN_KEY = "cmVwby1hdGxhcy10aHJlYWRzLXRlc3Qta2V5LTAwMDE=";
const REDIRECT_URI = "https://app.test/threads/oauth/callback";

/** @typedef {Parameters<typeof finishThreadsOAuth>[1]} CallbackInput */

/** @param {string} setCookie */
function requestCookie(setCookie) { return setCookie.split(";", 1)[0]; }

/** @param {string} setCookie */
function cookiePayload(setCookie) {
  const token = requestCookie(setCookie).split("=", 2)[1];
  const payload = token.split(".", 1)[0].replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(Buffer.from(payload.padEnd(Math.ceil(payload.length / 4) * 4, "="), "base64").toString("utf8"));
}

/** @param {number} fill @param {number} [nowSeconds] */
async function begin(fill, nowSeconds = 1_000) {
  return beginThreadsOAuth({
    appId: "app-1", redirectUri: REDIRECT_URI, sessionNonce: "pin-session-1",
    tokenKey: TOKEN_KEY, nowSeconds,
    randomBytes: (length) => new Uint8Array(length).fill(fill),
  });
}

/** @param {Partial<CallbackInput>} [overrides] @returns {CallbackInput} */
function successfulCallback(overrides = {}) {
  return {
    appId: "app-1", appSecret: "app-secret", redirectUri: REDIRECT_URI,
    callbackUrl: REDIRECT_URI, tokenKey: TOKEN_KEY, nowSeconds: 1_001,
    /** @param {number} length */
    randomBytes: (length) => new Uint8Array(length).fill(9),
    /** @param {RequestInfo | URL} input @param {RequestInit} [init] */
    fetcher: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname.endsWith("/oauth/access_token"))
        return Response.json({ access_token: "short-token", user_id: "author-1" });
      if (url.pathname.endsWith("/access_token"))
        return Response.json({ access_token: "long-token", token_type: "bearer", expires_in: 5_184_000 });
      if (url.pathname.endsWith("/debug_token"))
        return Response.json({ data: { app_id: "app-1", user_id: "author-1", is_valid: true, expires_at: 5_185_001, scopes: ["threads_basic", "threads_profile_discovery", "threads_read_replies"] } });
      return assert.fail(`unexpected provider URL ${url}`);
    },
    ...overrides,
  };
}

function acceptingDb() {
  return {
    prepare() { return { bind() { return this; } }; },
    async batch() { return [{ success: true, meta: { changes: 1 } }]; },
  };
}

/** @param {Promise<unknown>} promise @param {string} code */
async function rejectsCleared(promise, code = "invalid_threads_oauth_callback") {
  await assert.rejects(promise, (error) =>
    error instanceof AppError && error.code === code &&
    error.details.setCookie === clearThreadsOAuthCookie());
}

test("creates a signed ten-minute Lax OAuth state bound to the initiating session", async () => {
  const started = await begin(7);
  assert.match(started.location, /^https:\/\/threads\.net\/oauth\/authorize\?/);
  const authorize = new URL(started.location);
  assert.deepEqual([...authorize.searchParams.keys()], ["client_id", "redirect_uri", "scope", "response_type", "state"]);
  assert.equal(authorize.searchParams.get("client_id"), "app-1");
  assert.equal(authorize.searchParams.get("redirect_uri"), REDIRECT_URI);
  assert.equal(authorize.searchParams.get("scope"), "threads_basic,threads_profile_discovery,threads_read_replies");
  assert.equal(authorize.searchParams.get("response_type"), "code");
  assert.match(authorize.searchParams.get("state") ?? "", /^[A-Za-z0-9_-]{43}$/);
  assert.match(started.setCookie,
    /^__Host-threads_oauth_state=.*; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=600$/);
  assert.deepEqual(cookiePayload(started.setCookie), {
    v: 1, state: authorize.searchParams.get("state"),
    sessionNonce: "pin-session-1", expiresAt: 1_600,
  });
  assert.equal(clearThreadsOAuthCookie(),
    "__Host-threads_oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");
});

test("callback trusts only the signed OAuth cookie and clears it without requiring the PIN cookie", async () => {
  const started = await begin(7);
  const state = new URL(started.location).searchParams.get("state");
  const result = await finishThreadsOAuth(/** @type {any} */ (acceptingDb()), successfulCallback({
    callbackUrl: `${REDIRECT_URI}?code=code-1&state=${state}`,
    cookieHeader: requestCookie(started.setCookie),
  }));
  assert.deepEqual(result, {
    providerUserId: "author-1",
    scopes: ["threads_basic", "threads_profile_discovery", "threads_read_replies"],
    setCookie: clearThreadsOAuthCookie(),
  });
});

test("callback rejects altered, expired, mismatched, duplicated, and unknown state inputs before exchange", async () => {
  const started = await begin(7);
  const state = new URL(started.location).searchParams.get("state");
  const cookie = requestCookie(started.setCookie);
  let providerCalls = 0;
  const blocked = { fetcher: async () => { providerCalls += 1; return new Response(); } };
  const cases = [
    { callbackUrl: `${REDIRECT_URI}?code=code-1&state=${state}`, cookieHeader: `${cookie}x` },
    { callbackUrl: `${REDIRECT_URI}?code=code-1&state=${state}`, cookieHeader: cookie, nowSeconds: 1_600 },
    { callbackUrl: `${REDIRECT_URI}?code=code-1&state=wrong`, cookieHeader: cookie },
    { callbackUrl: `${REDIRECT_URI}?code=one&code=two&state=${state}`, cookieHeader: cookie },
    { callbackUrl: `${REDIRECT_URI}?code=code-1&state=${state}&extra=1`, cookieHeader: cookie },
    { callbackUrl: `https://evil.test/threads/oauth/callback?code=code-1&state=${state}`, cookieHeader: cookie },
    { callbackUrl: `${REDIRECT_URI}?code=code-1&state=${state}`, cookieHeader: `${cookie}; ${cookie}` },
  ];
  for (const item of cases) await rejectsCleared(finishThreadsOAuth(
    /** @type {any} */ (acceptingDb()), successfulCallback({ ...blocked, ...item }),
  ));
  assert.equal(providerCalls, 0);
});

test("callback accepts only the exact state-authenticated provider denial form and performs no external work", async () => {
  const started = await begin(7);
  const state = new URL(started.location).searchParams.get("state");
  const cookieHeader = requestCookie(started.setCookie);
  let providerCalls = 0;
  let databaseCalls = 0;
  const db = {
    prepare() { databaseCalls += 1; return { bind() { return this; } }; },
    async batch() { databaseCalls += 1; return []; },
  };
  const denied = new URL(REDIRECT_URI);
  denied.search = new URLSearchParams({
    error: "access_denied", error_reason: "user_denied",
    error_description: "The user denied the request.", state: state ?? "",
  }).toString();
  const input = successfulCallback({
    callbackUrl: denied.href, cookieHeader,
    fetcher: async () => { providerCalls += 1; return new Response(); },
  });
  await rejectsCleared(finishThreadsOAuth(/** @type {any} */ (db), input), "threads_oauth_denied");
  assert.equal(providerCalls, 0);
  assert.equal(databaseCalls, 0);

  const malformed = [
    `${denied.href}&extra=1`,
    `${denied.href}&error=access_denied`,
    `${denied.href}&code=code-1`,
    `${REDIRECT_URI}?error=other&error_reason=user_denied&error_description=Denied&state=${state}`,
    `${REDIRECT_URI}?error=access_denied&error_reason=other&error_description=Denied&state=${state}`,
    `${REDIRECT_URI}?error=access_denied&error_reason=user_denied&error_description=&state=${state}`,
    `${REDIRECT_URI}?error=access_denied&error_reason=user_denied&error_description=Denied&state=wrong`,
  ];
  for (const callbackUrl of malformed) await rejectsCleared(finishThreadsOAuth(
    /** @type {any} */ (db), { ...input, callbackUrl },
  ));
  assert.equal(providerCalls, 0);
  assert.equal(databaseCalls, 0);
});

test("callback requires debugger-confirmed app, user, validity, expiry, and exact sorted unique scopes", async () => {
  const started = await begin(7);
  const state = new URL(started.location).searchParams.get("state");
  const callbackUrl = `${REDIRECT_URI}?code=code-1&state=${state}`;
  const cookieHeader = requestCookie(started.setCookie);
  const validDebug = { app_id: "app-1", user_id: "author-1", is_valid: true, expires_at: 5_185_001, scopes: ["threads_basic", "threads_profile_discovery", "threads_read_replies"] };
  for (const debug of [
    { ...validDebug, app_id: "other-app" },
    { ...validDebug, user_id: "other-user" },
    { ...validDebug, is_valid: false },
    { ...validDebug, expires_at: 1_001 },
    { ...validDebug, scopes: ["threads_basic", "threads_read_replies"] },
    { ...validDebug, scopes: [...validDebug.scopes, "threads_manage_insights"] },
    { ...validDebug, scopes: [...validDebug.scopes].reverse() },
    { ...validDebug, scopes: ["threads_basic", "threads_basic", "threads_profile_discovery", "threads_read_replies"] },
  ]) {
    const fetcher = successfulCallback().fetcher;
    await rejectsCleared(finishThreadsOAuth(/** @type {any} */ (acceptingDb()), successfulCallback({
      callbackUrl, cookieHeader,
      /** @param {RequestInfo | URL} input @param {RequestInit} [init] */
      fetcher: async (input, init) => {
        const request = new Request(input, init);
        if (new URL(request.url).pathname.endsWith("/debug_token")) return Response.json({ data: debug });
        return /** @type {any} */ (fetcher)(input, init);
      },
    })), "threads_reconnect_required");
  }
});
