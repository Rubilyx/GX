import assert from "node:assert/strict";
import test from "node:test";
import {
  authenticatePin,
  createCsrfToken,
  createSession,
  derivePinDigest,
  requireAuthenticatedMutation,
  verifyPin,
  verifySession,
} from "../../src/auth.js";
import { AppError } from "../../src/domain.js";

const salt = "cmVwby1hdGxhcy10ZXN0LXNhbHQ=";
const digest = "X3eotQ9GFhyeDwcCPzwVmINdYuMBwamov6bQPl+DQWk=";
const key = "cmVwby1hdGxhcy10ZXN0LXNlc3Npb24ta2V5";
const validInput = Object.freeze({
  pin: "123456",
  ip: "192.0.2.30",
  nowSeconds: 1_800_000_000,
  pinSalt: salt,
  pinDigest: digest,
  ipHmacKey: key,
});
const emptyReads = [{ results: [] }, { results: [] }];
const unlockedFailures = [
  { results: [{ failures: 1, locked_until: 0 }] },
  { results: [{ failures: 1, locked_until: 0 }] },
];

/**
 * @param {{ fault?: string, reads?: unknown, failures?: unknown }} options
 * @returns {D1Database}
 */
function guardDb({ fault, reads = emptyReads, failures = unlockedFailures } = {}) {
  let batches = 0;
  return /** @type {D1Database} */ (/** @type {unknown} */ ({
    /** @param {string} sql */
    prepare(sql) {
      if (fault === "upsert" && sql.startsWith("\nINSERT INTO auth_attempts")) throw new Error("D1 unavailable");
      return {
        bind() { return this; },
        async run() {
          if (fault === "cleanup" && sql.includes("updated_at < ?")) throw new Error("D1 unavailable");
          if (fault === "delete" && sql === "DELETE FROM auth_attempts WHERE attempt_key = ?")
            throw new Error("D1 unavailable");
          return {};
        },
      };
    },
    async batch() {
      batches += 1;
      if (fault === "read" && batches === 1) throw new Error("D1 unavailable");
      if (fault === "failure-batch" && batches === 2) throw new Error("D1 unavailable");
      return batches === 1 ? reads : failures;
    },
  }));
}

/** @param {Promise<unknown>} operation */
async function assertGuardUnavailable(operation) {
  await assert.rejects(
    operation,
    (error) => error instanceof AppError && error.code === "auth_guard_unavailable" && error.status === 503,
  );
}

test("matches the committed 100000 iteration PIN vector", async () => {
  assert.equal(Buffer.from(await derivePinDigest("123456", salt)).toString("base64"), digest);
  assert.equal(await verifyPin("123456", salt, digest), true);
  assert.equal(await verifyPin("123457", salt, digest), false);
  assert.equal(await verifyPin("１２３４５６", salt, digest), false);
});

test("signs a seven-day session and rejects tampering or expiry", async () => {
  const issued = await createSession(1_800_000_000, key);
  assert.match(issued.cookie, /^__Host-repo_atlas_session=/);
  assert.match(issued.cookie, /HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=604800/);
  assert.equal((await verifySession(issued.cookie, 1_800_604_799, key))?.expiresAt, 1_800_604_800);
  assert.equal(
    await verifySession(
      issued.cookie.replace("__Host-repo_atlas_session=", "__Host-repo_atlas_session=x"),
      1_800_000_001,
      key,
    ),
    null,
  );
  assert.equal(await verifySession(issued.cookie, 1_800_604_800, key), null);
});

test("binds CSRF to the session and exact Origin", async () => {
  const issued = await createSession(1_800_000_000, key);
  const csrf = await createCsrfToken(issued.session, key);
  const form = new FormData();
  form.set("csrf", csrf);
  const request = new Request("https://production.repo-atlas.test/repositories", {
    method: "POST",
    headers: {
      Origin: "https://production.repo-atlas.test",
      Cookie: issued.cookie,
    },
    body: form,
  });
  const runtime = {
    allowedOrigin: "https://production.repo-atlas.test",
    sessionSigningKey: key,
  };
  const session = await requireAuthenticatedMutation(request, runtime, await request.clone().formData());
  assert.equal(session.nonce, issued.session.nonce);

  const wrongOrigin = new Request("https://production.repo-atlas.test/repositories", {
    method: "POST",
    headers: { Origin: "https://evil.test", Cookie: issued.cookie },
    body: new URLSearchParams({ csrf }),
  });
  await assert.rejects(
    requireAuthenticatedMutation(wrongOrigin, runtime, await request.clone().formData()),
    (error) => error instanceof AppError && error.code === "session_expired" && error.status === 401,
  );

  const wrongCsrf = new FormData();
  wrongCsrf.set("csrf", `${csrf}x`);
  await assert.rejects(
    requireAuthenticatedMutation(request, runtime, wrongCsrf),
    (error) => error instanceof AppError && error.code === "session_expired" && error.status === 401,
  );
});

test("converts D1 and crypto guard faults to exact 503 AppError", async (context) => {
  for (const fault of ["cleanup", "read", "upsert", "failure-batch"])
    await context.test(fault, () => assertGuardUnavailable(
      authenticatePin(guardDb({ fault }), { ...validInput, pin: "000000" }),
    ));
  await context.test("successful-PIN delete", () => assertGuardUnavailable(
    authenticatePin(guardDb({ fault: "delete" }), validInput),
  ));
  await context.test("IP-HMAC", () => assertGuardUnavailable(
    authenticatePin(guardDb(), { ...validInput, ipHmacKey: "%" }),
  ));
});

test("fails closed on malformed lock-read results", async (context) => {
  for (const [name, reads] of /** @type {Array<[string, unknown]>} */ ([
    ["short batch", [{ results: [] }]],
    ["missing results", [{}, { results: [] }]],
    ["non-array results", [{ results: null }, { results: [] }]],
    ["missing row value", [{ results: [null] }, { results: [] }]],
    ["malformed row", [{ results: [{ locked_until: Number.NaN }] }, { results: [] }]],
  ])) await context.test(name, () => assertGuardUnavailable(authenticatePin(guardDb({ reads }), validInput)));
});

test("fails closed on malformed failure-batch results", async (context) => {
  for (const [name, failures] of /** @type {Array<[string, unknown]>} */ ([
    ["short batch", [{ results: [{ locked_until: 0 }] }]],
    ["missing RETURNING row", [{ results: [] }, { results: [{ locked_until: 0 }] }]],
    ["non-array results", [{ results: null }, { results: [{ locked_until: 0 }] }]],
    ["non-integer lock", [{ results: [{ locked_until: 0.5 }] }, { results: [{ locked_until: 0 }] }]],
  ])) await context.test(name, () => assertGuardUnavailable(authenticatePin(
    guardDb({ failures }),
    { ...validInput, pin: "000000" },
  )));
});
