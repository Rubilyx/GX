import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import {
  chmod, copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";

import {
  checkCompatibility, createRelease, hashTree, recordDeployment, sha256,
  verifyManifest, verifyRelease,
} from "../../scripts/release.mjs";

const ABC_ROW = {
  path: "src/worker.js",
  sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  size: 3,
};
const RELEASE_ID = "a".repeat(40);
const ARCHIVE_SHA256 = "b".repeat(64);
const WORKER_VERSION_ID = "095f00a7-23a7-43b7-a227-e4c97cab5f22";
const execFile = promisify(execFileCallback);
const GATES = [
  "types", "css", "sourcePolicy", "unit", "integration", "browser",
  "accessibility", "noJavaScript",
];
const THREADS_APP_ID = "123456789012345";
const THREADS_SECRETS = [
  "OPENAI_API_KEY", "PROD_IP_HMAC_KEY", "PROD_PIN_DIGEST", "PROD_PIN_SALT",
  "PROD_SESSION_KEY", "THREADS_APP_SECRET", "THREADS_TOKEN_KEY",
];
const THREADS_QUEUE_VARS = {
  THREADS_CAPTURE_QUEUE_NAME: "gx-threads-capture",
  THREADS_MEDIA_QUEUE_NAME: "gx-threads-media",
  THREADS_CAPTURE_DLQ_NAME: "gx-threads-capture-dlq",
  THREADS_MEDIA_DLQ_NAME: "gx-threads-media-dlq",
};
const THREADS_R2 = [{ binding: "THREADS_MEDIA", bucket_name: "gx-threads-media" }];
const THREADS_QUEUES = {
  producers: [
    { binding: "THREADS_CAPTURE_QUEUE", queue: "gx-threads-capture" },
    { binding: "THREADS_MEDIA_QUEUE", queue: "gx-threads-media" },
  ],
  consumers: [
    { queue: "gx-threads-capture", max_batch_size: 10, max_retries: 3, dead_letter_queue: "gx-threads-capture-dlq" },
    { queue: "gx-threads-media", max_batch_size: 1, max_retries: 3, dead_letter_queue: "gx-threads-media-dlq" },
    { queue: "gx-threads-capture-dlq", max_batch_size: 10, max_retries: 0 },
    { queue: "gx-threads-media-dlq", max_batch_size: 1, max_retries: 0 },
  ],
};
const THREADS_TRIGGERS = { crons: ["0 3 * * *"] };

/** @param {Buffer} tar @param {string} wanted */
function tarMode(tar, wanted) {
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    /** @param {number} start @param {number} end */
    const field = (start, end) => header.subarray(start, end).toString("ascii").replace(/\0.*$/, "");
    const name = [field(345, 500), field(0, 100)].filter(Boolean).join("/");
    const size = Number.parseInt(field(124, 136).trim() || "0", 8);
    if (name === wanted) return Number.parseInt(field(100, 108).trim(), 8);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error(`missing_tar_path:${wanted}`);
}

/** @param {string} root @param {string[]} args */
async function git(root, args) {
  const result = await execFile("git", args, { cwd: root, encoding: "utf8" });
  return result.stdout.trim();
}

/** @param {string} root @param {string} path @param {string} content */
async function writeFixture(root, path, content) {
  const target = join(root, path);
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, content);
}

/** @param {string} path */
async function waitForFile(path) {
  for (let attempt = 0; attempt < 5_000; attempt += 1) {
    try { await readFile(path); return; }
    catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT")
        throw error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1));
  }
  throw new Error(`file_wait_timeout:${path}`);
}

/** @param {import("node:test").TestContext} context @param {Record<string, any>} [wranglerOverrides] */
async function releaseRepository(context, wranglerOverrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "repo-atlas-release-repository-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const packageJson = {
    name: "release-fixture",
    version: "1.0.0",
    private: true,
    type: "module",
    dependencies: {},
    devDependencies: { "svg-tags": "1.0.0", typescript: "7.0.2", wrangler: "4.114.0" },
  };
  const packageLock = {
    name: "release-fixture",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: "release-fixture",
        version: "1.0.0",
        devDependencies: { "svg-tags": "1.0.0", typescript: "7.0.2", wrangler: "4.114.0" },
      },
      "node_modules/svg-tags": { version: "1.0.0", dev: true },
      "node_modules/typescript": { version: "7.0.2", dev: true, license: "Apache-2.0" },
      "node_modules/wrangler": { version: "4.114.0", dev: true, license: "MIT OR Apache-2.0" },
    },
  };
  const files = {
    ".gitignore": "node_modules/\nartifacts/\n.release*/\n.wrangler/\n",
    ".nvmrc": "24.18.0\n",
    "migrations/0001.sql": "CREATE TABLE example (id TEXT PRIMARY KEY);\n",
    "package-lock.json": `${JSON.stringify(packageLock, null, 2)}\n`,
    "package.json": `${JSON.stringify(packageJson, null, 2)}\n`,
    "playwright.config.js": "export default {};\n",
    "public/assets/app.js": "export {};\n",
    "public/assets/layers.css": "@layer reset, tokens, base, layout, components, utilities, overrides;\n",
    "public/modulepreload.json": "[]\n",
    "scripts/check-source.mjs": "export {};\n",
    "src/openai.js": "export const PROMPT_VERSION = 'fixture';\n",
    "stylelint.config.mjs": "export default {};\n",
    "test/unit/placeholder.test.js": "export {};\n",
    "tsconfig.json": "{}\n",
    "worker-configuration.d.ts": "export {};\n",
    "wrangler.jsonc": `${JSON.stringify({
      name: "release-fixture",
      main: "src/openai.js",
      workers_dev: true,
      preview_urls: true,
      secrets: { required: THREADS_SECRETS },
      d1_databases: [
        { binding: "PROD_DB", database_name: "production" },
        { binding: "PREVIEW_DB", database_name: "preview" },
      ],
      route: "legacy.example/*",
      routes: [{ pattern: "legacy.example", custom_domain: true }],
      r2_buckets: THREADS_R2,
      queues: THREADS_QUEUES,
      triggers: THREADS_TRIGGERS,
      vars: THREADS_QUEUE_VARS,
      env: {
        test: {
          name: "release-fixture-test",
          vars: {
            THREADS_APP_ID: "test-threads-app",
            THREADS_CAPTURE_QUEUE_NAME: "repo-atlas-test-threads-capture",
            THREADS_MEDIA_QUEUE_NAME: "repo-atlas-test-threads-media",
            THREADS_CAPTURE_DLQ_NAME: "repo-atlas-test-threads-capture-dlq",
            THREADS_MEDIA_DLQ_NAME: "repo-atlas-test-threads-media-dlq",
          },
          secrets: { required: THREADS_SECRETS },
          d1_databases: [{
            binding: "PROD_DB",
            database_name: "release-fixture-test",
            database_id: "00000000-0000-0000-0000-000000000001",
          }],
          ratelimits: [{
            name: "REPORT_RATE_LIMITER",
            namespace_id: "1001",
            simple: { limit: 60, period: 60 },
          }],
          r2_buckets: [{
            binding: "THREADS_MEDIA",
            bucket_name: "repo-atlas-test-threads-media",
          }],
          queues: {
            producers: [
              { binding: "THREADS_CAPTURE_QUEUE", queue: "repo-atlas-test-threads-capture" },
              { binding: "THREADS_MEDIA_QUEUE", queue: "repo-atlas-test-threads-media" },
            ],
            consumers: [
              { queue: "repo-atlas-test-threads-capture", max_batch_size: 10, max_retries: 3, dead_letter_queue: "repo-atlas-test-threads-capture-dlq" },
              { queue: "repo-atlas-test-threads-media", max_batch_size: 1, max_retries: 3, dead_letter_queue: "repo-atlas-test-threads-media-dlq" },
              { queue: "repo-atlas-test-threads-capture-dlq", max_batch_size: 10, max_retries: 0 },
              { queue: "repo-atlas-test-threads-media-dlq", max_batch_size: 1, max_retries: 0 },
            ],
          },
          triggers: { crons: ["0 3 * * *"] },
          services: [{ binding: "PROVIDER_FIXTURE", service: "provider-fixture" }],
        },
      },
      ...wranglerOverrides,
    }, null, 2)}\n`,
  };
  for (const [path, content] of Object.entries(files)) await writeFixture(root, path, content);
  await writeFixture(root, "node_modules/typescript/package.json", `${JSON.stringify({
    name: "typescript", version: "7.0.2", license: "Apache-2.0",
  })}\n`);
  await writeFixture(root, "node_modules/wrangler/package.json", `${JSON.stringify({
    name: "wrangler", version: "4.114.0", license: "MIT OR Apache-2.0",
  })}\n`);
  await writeFixture(root, "node_modules/svg-tags/package.json", `${JSON.stringify({
    name: "svg-tags", version: "1.0.0", licenses: [{
      type: "MIT", url: "http://www.opensource.org/licenses/MIT",
    }],
  })}\n`);
  await git(root, ["init", "-b", "main"]);
  await git(root, ["add", "."]);
  await git(root, ["update-index", "--chmod=+x", "scripts/check-source.mjs"]);
  await git(root, ["-c", "user.name=Repo Atlas", "-c", "user.email=repo-atlas@example.invalid",
    "commit", "-m", "fixture"]);
  const head = await git(root, ["rev-parse", "HEAD"]);
  const summary = join(root, "artifacts", "test-summary.json");
  await writeFixture(root, "artifacts/test-summary.json", `${JSON.stringify({
    commit: head,
    gates: Object.fromEntries(GATES.map((gate) => [gate, "passed"])),
  }, null, 2)}\n`);
  return { head, root, summary };
}

/** @param {import("node:test").TestContext} context */
async function verifiedDirectory(context) {
  const root = await mkdtemp(join(tmpdir(), "repo-atlas-release-record-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "VERIFIED"),
    `${JSON.stringify({ archiveSha256: ARCHIVE_SHA256, releaseId: RELEASE_ID }, null, 2)}\n`,
  );
  return root;
}

/** @param {string} directory @param {Record<string, any>} overrides */
function recordOptions(directory, overrides = {}) {
  return {
    directory,
    releaseId: RELEASE_ID,
    archiveSha256: ARCHIVE_SHA256,
    sourceAttestationId: "1234567",
    workerVersionId: WORKER_VERSION_ID,
    safariEvidenceUrl: "https://evidence.example/safari/1",
    iosEvidenceUrl: "https://evidence.example/ios/1",
    temporaryRelaxation: false,
    ...overrides,
  };
}

/** @param {string} parent @param {Record<string, any>} overrides */
function createOptions(parent, overrides = {}) {
  return {
    root: process.cwd(),
    out: join(parent, "release"),
    releaseId: RELEASE_ID,
    productionHost: "gx.zra.workers.dev",
    openAiModel: "gpt-5.6-terra-2026-08-01",
    temporaryRelaxation: false,
    trustedTypesMode: "report-only",
    threadsAppId: THREADS_APP_ID,
    testSummary: join(parent, "summary.json"),
    ...overrides,
  };
}

/** @param {import("node:test").TestContext} context */
async function manifestFixture(context) {
  const root = await mkdtemp(join(tmpdir(), "repo-atlas-release-manifest-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src"));
  await writeFile(join(root, ABC_ROW.path), "abc");
  await writeFile(
    join(root, "release-manifest.json"),
    `${JSON.stringify({ files: [ABC_ROW] }, null, 2)}\n`,
  );
  return root;
}

/** @param {import("node:test").TestContext} context */
async function releaseFixture(context) {
  const base = await mkdtemp(join(tmpdir(), "repo-atlas-release-verify-"));
  context.after(() => rm(base, { recursive: true, force: true }));
  const payload = join(base, "payload");
  await mkdir(join(payload, "src"), { recursive: true });
  await writeFile(join(payload, ABC_ROW.path), "abc");
  await writeFile(join(payload, "release-metadata.json"), `${JSON.stringify({
    nodeVersion: "24.18.0",
    npmVersion: "11.16.0",
    openAiModel: "gpt-5.6-terra-2026-08-01",
    temporaryRelaxation: false,
    productionHost: "gx.zra.workers.dev",
    promptVersion: "repo-atlas-v1.0",
    releaseId: RELEASE_ID,
    schema: 2,
    trustedTypesMode: "report-only",
    typescriptVersion: "7.0.2",
    wranglerVersion: "4.114.0",
  }, null, 2)}\n`);
  await writeFile(
    join(payload, "release-manifest.json"),
    `${JSON.stringify({ files: await hashTree(payload, new Set(["release-manifest.json"])) }, null, 2)}\n`,
  );
  const archive = join(base, "archive.tar.gz");
  await writeFile(archive, "abc");
  const record = join(base, "deployment-record.json");
  await writeFile(record, `${JSON.stringify({
    releaseId: RELEASE_ID,
    archiveSha256: ABC_ROW.sha256,
    sourceAttestationId: "1234567",
    workerVersionId: WORKER_VERSION_ID,
    safariEvidenceUrl: "https://evidence.example/safari/1",
    iosEvidenceUrl: "https://evidence.example/ios/1",
    temporaryRelaxation: false,
    recordedAt: "2026-08-10T00:00:00.000Z",
  }, null, 2)}\n`);
  return { archive, base, payload, record };
}

/** @param {string} payload */
async function writeSchema1Metadata(payload) {
  const metadataPath = join(payload, "release-metadata.json");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  metadata.schema = 1;
  metadata.productionHost = "repo.example";
  metadata.stagingHost = "staging.repo.example";
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  await replaceManifest(payload, {
    files: await hashTree(payload, new Set(["release-manifest.json"])),
  });
}

/** @param {import("node:test").TestContext} context @param {boolean} [providerOnHealth] */
async function compatibilityPayload(context, providerOnHealth = false) {
  const base = await mkdtemp(join(tmpdir(), "repo-atlas-compatibility-payload-"));
  context.after(() => rm(base, { recursive: true, force: true }));
  const payload = join(base, "payload");
  await mkdir(payload);
  for (const directory of ["migrations", "public", "src", "test/support"])
    await cp(join(process.cwd(), directory), join(payload, directory), { recursive: true });
  for (const file of ["package.json", "wrangler.jsonc"])
    await copyFile(join(process.cwd(), file), join(payload, file));
  if (providerOnHealth) {
    await writeFile(join(payload, "test", "support", "harness.js"), `
      let calls;
      export async function startHarness() {
        return {
          async setProviderMode(options) { calls = options.calls; },
          worker: {
            async fetch(input) {
              if (new URL(input).pathname === "/health") calls?.push({ method: "GET", path: "/health" });
              return new Response("ok", { status: 200 });
            },
            async getEnv() { return { PROD_DB: {} }; },
          },
          providerCalls() { return []; },
          async close() {},
        };
      }
      export async function login() { return { cookie: String(Date.now()) }; }
      export async function seedRepository() {}
    `);
  }
  await writeFile(join(payload, "release-metadata.json"), `${JSON.stringify({
    nodeVersion: "24.18.0",
    npmVersion: "11.16.0",
    openAiModel: "gpt-5.6-terra-2026-08-01",
    temporaryRelaxation: false,
    productionHost: "gx.zra.workers.dev",
    promptVersion: "repo-atlas-v1.0",
    releaseId: RELEASE_ID,
    schema: 2,
    trustedTypesMode: "report-only",
    typescriptVersion: "7.0.2",
    wranglerVersion: "4.114.0",
  }, null, 2)}\n`);
  await writeFile(
    join(payload, "release-manifest.json"),
    `${JSON.stringify({ files: await hashTree(payload, new Set(["release-manifest.json"])) }, null, 2)}\n`,
  );
  return payload;
}

/** @param {import("node:test").TestContext} context @param {string} evidence */
async function hangingCompatibilityPayload(context, evidence) {
  const payload = await compatibilityPayload(context);
  const grandchildScript = "setTimeout(() => process.exit(0), 5000); setInterval(() => {}, 1000);";
  await writeFile(join(payload, "test", "support", "harness.js"), `
    import { spawn } from "node:child_process";
    import { writeFile } from "node:fs/promises";
    export async function startHarness() {
      const grandchild = spawn(process.execPath, ["--eval", ${JSON.stringify(grandchildScript)}], {
        stdio: "ignore", windowsHide: true,
      });
      await writeFile(${JSON.stringify(evidence)}, JSON.stringify({
        direct: process.pid,
        grandchild: grandchild.pid,
      }) + "\\n");
      setTimeout(() => process.exit(97), 5000);
      await new Promise(() => {});
    }
    export async function login() {}
    export async function seedRepository() {}
  `);
  await writeFile(
    join(payload, "release-manifest.json"),
    `${JSON.stringify({ files: await hashTree(payload, new Set(["release-manifest.json"])) }, null, 2)}\n`,
  );
  return payload;
}

/** @param {number} pid */
function processExists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ESRCH")
      return false;
    throw error;
  }
}

/** @param {string} root @param {unknown} value */
async function replaceManifest(root, value) {
  await writeFile(join(root, "release-manifest.json"), `${JSON.stringify(value, null, 2)}\n`);
}

test("hashTree emits stable POSIX paths with byte digests and sizes", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "repo-atlas-release-hash-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "nested", "z.txt"), "");
  await writeFile(join(root, "a.txt"), "abc");

  assert.deepEqual(await hashTree(root, new Set()), [
    {
      path: "a.txt",
      sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      size: 3,
    },
    {
      path: "nested/z.txt",
      sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      size: 0,
    },
  ]);
});

test("hashTree sorts complete POSIX paths globally", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "repo-atlas-release-global-order-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "a"));
  await writeFile(join(root, "a", "file"), "nested\n");
  await writeFile(join(root, "a.txt"), "sibling\n");

  assert.deepEqual((await hashTree(root, new Set())).map(({ path }) => path), [
    "a.txt", "a/file",
  ]);
});

test("hashTree rejects links instead of following them", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "repo-atlas-release-link-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "target"));
  await writeFile(join(root, "target", "file.txt"), "safe\n");
  await symlink(join(root, "target"), join(root, "alias"), "junction");

  await assert.rejects(hashTree(root, new Set()), /symlink/);
  await assert.rejects(hashTree(root, new Set(["alias"])), /symlink/);
});

test("verifyManifest accepts an exact manifest", async (context) => {
  await verifyManifest(await manifestFixture(context));
});

test("verifyManifest rejects changed, missing, and extra payload files", async (context) => {
  /** @type {Array<[string, (root: string) => Promise<void>, RegExp]>} */
  const cases = [
    ["changed", (root) => writeFile(join(root, ABC_ROW.path), "abd"), /digest_mismatch/],
    ["missing", (root) => unlink(join(root, ABC_ROW.path)), /missing_file/],
    ["extra", (root) => writeFile(join(root, "extra.txt"), "x"), /extra_file/],
  ];
  for (const [name, mutate, expected] of cases) {
    await context.test(name, async (testContext) => {
      const root = await manifestFixture(testContext);
      await mutate(root);
      await assert.rejects(verifyManifest(root), expected);
    });
  }
});

test("verifyManifest rejects malformed exact shapes, paths, hashes, sizes, and order", async (context) => {
  /** @type {Array<[string, unknown, RegExp]>} */
  const invalidRows = [
    ["extra root key", { files: [ABC_ROW], extra: true }, /invalid_manifest_shape/],
    ["extra row key", { files: [{ ...ABC_ROW, extra: true }] }, /invalid_manifest_row/],
    ["duplicate", { files: [ABC_ROW, ABC_ROW] }, /duplicate_path/],
    ["absolute", { files: [{ ...ABC_ROW, path: "/src/worker.js" }] }, /invalid_path/],
    ["drive", { files: [{ ...ABC_ROW, path: "C:/src/worker.js" }] }, /invalid_path/],
    ["traversal", { files: [{ ...ABC_ROW, path: "src/../worker.js" }] }, /invalid_path/],
    ["backslash", { files: [{ ...ABC_ROW, path: "src\\worker.js" }] }, /invalid_path/],
    ["empty segment", { files: [{ ...ABC_ROW, path: "src//worker.js" }] }, /invalid_path/],
    ["NUL", { files: [{ ...ABC_ROW, path: "src/worker.js\0" }] }, /invalid_path/],
    ["hash", { files: [{ ...ABC_ROW, sha256: ABC_ROW.sha256.toUpperCase() }] }, /invalid_sha256/],
    ["size", { files: [{ ...ABC_ROW, size: -1 }] }, /invalid_size/],
    [
      "order",
      { files: [{ ...ABC_ROW, path: "z.txt" }, ABC_ROW] },
      /noncanonical_order/,
    ],
  ];
  for (const [name, manifest, expected] of invalidRows) {
    await context.test(name, async (testContext) => {
      const root = await manifestFixture(testContext);
      await replaceManifest(root, manifest);
      await assert.rejects(verifyManifest(root), expected);
    });
  }
});

test("verifyManifest rejects a symlink added to the payload", async (context) => {
  const root = await manifestFixture(context);
  await symlink(join(root, "src"), join(root, "linked-src"), "junction");
  await assert.rejects(verifyManifest(root), /symlink/);
});

test("verifyManifest rejects a symlinked manifest", async (context) => {
  const root = await manifestFixture(context);
  const manifest = await readFile(join(root, "release-manifest.json"));
  await unlink(join(root, "release-manifest.json"));
  await writeFile(join(root, "z-manifest.json"), manifest);
  try {
    await symlink(join(root, "z-manifest.json"), join(root, "release-manifest.json"), "file");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EPERM") {
      context.skip("file symlinks require Windows Developer Mode");
      return;
    }
    throw error;
  }

  await assert.rejects(verifyManifest(root), /symlink:release-manifest\.json/);
});

test("verifyManifest rejects a manifest junction before reading it", async (context) => {
  const root = await manifestFixture(context);
  await unlink(join(root, "release-manifest.json"));
  await mkdir(join(root, "manifest-target"));
  await symlink(
    join(root, "manifest-target"),
    join(root, "release-manifest.json"),
    "junction",
  );

  await assert.rejects(verifyManifest(root), /symlink:release-manifest\.json/);
});

test("recordDeployment exclusively writes the exact marker-bound record", async (context) => {
  const directory = await verifiedDirectory(context);
  const path = await recordDeployment(recordOptions(directory));
  const record = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(Object.keys(record), [
    "releaseId", "archiveSha256", "sourceAttestationId", "workerVersionId",
    "safariEvidenceUrl", "iosEvidenceUrl", "temporaryRelaxation", "recordedAt",
  ]);
  assert.equal(record.releaseId, RELEASE_ID);
  assert.equal(record.archiveSha256, ARCHIVE_SHA256);
  assert.equal(record.workerVersionId, WORKER_VERSION_ID);
  assert.equal(new Date(record.recordedAt).toISOString(), record.recordedAt);
});

test("recordDeployment rejects invalid inputs and VERIFIED marker mismatches", async (context) => {
  /** @type {Array<[string, Record<string, any>, RegExp]>} */
  const cases = [
    ["release", { releaseId: "A".repeat(40) }, /invalid_deployment_record/],
    ["archive", { archiveSha256: "B".repeat(64) }, /invalid_deployment_record/],
    ["attestation", { sourceAttestationId: "12x" }, /invalid_deployment_record/],
    ["attestation type", { sourceAttestationId: 123 }, /invalid_deployment_record/],
    ["Worker UUID", { workerVersionId: "not-a-uuid" }, /invalid_deployment_record/],
    ["Safari URL", { safariEvidenceUrl: "http://evidence.example/safari" }, /invalid_deployment_record/],
    ["iOS credentials", { iosEvidenceUrl: "https://user:pass@evidence.example/ios" }, /invalid_deployment_record/],
    ["strict null evidence", { safariEvidenceUrl: null, iosEvidenceUrl: null }, /invalid_deployment_record/],
    ["relaxed URL evidence", { temporaryRelaxation: true }, /invalid_deployment_record/],
    ["one null evidence", { safariEvidenceUrl: null }, /invalid_deployment_record/],
    ["missing relaxation", { temporaryRelaxation: undefined }, /invalid_deployment_record/],
    ["marker release", { releaseId: "c".repeat(40) }, /verified_marker_mismatch/],
    ["marker archive", { archiveSha256: "d".repeat(64) }, /verified_marker_mismatch/],
  ];
  for (const [name, overrides, expected] of cases) {
    await context.test(name, async (testContext) => {
      const directory = await verifiedDirectory(testContext);
      await assert.rejects(recordDeployment(recordOptions(directory, overrides)), expected);
    });
  }
});

test("temporary relaxation recordDeployment stores only null Safari and iOS evidence", async (context) => {
  const directory = await verifiedDirectory(context);
  const path = await recordDeployment(recordOptions(directory, {
    temporaryRelaxation: true,
    safariEvidenceUrl: null,
    iosEvidenceUrl: null,
  }));
  const record = JSON.parse(await readFile(path, "utf8"));
  assert.equal(record.temporaryRelaxation, true);
  assert.equal(record.safariEvidenceUrl, null);
  assert.equal(record.iosEvidenceUrl, null);
});

test("recordDeployment refuses to overwrite an existing record", async (context) => {
  const directory = await verifiedDirectory(context);
  await recordDeployment(recordOptions(directory));
  await assert.rejects(recordDeployment(recordOptions(directory)), /deployment_record_exists/);
});

test("verifyRelease reads an exact payload, record, and archive without rewriting them", async (context) => {
  const fixture = await releaseFixture(context);
  const before = await hashTree(fixture.base, new Set());
  const result = await verifyRelease(fixture.payload, {
    record: fixture.record,
    archive: fixture.archive,
  });
  assert.equal(result.releaseId, RELEASE_ID);
  assert.equal(await sha256(fixture.archive), ABC_ROW.sha256);
  assert.deepEqual(await hashTree(fixture.base, new Set()), before);
});

test("verifyRelease rejects a schema-2 payload for another valid DNS production host", async (context) => {
  const fixture = await releaseFixture(context);
  const metadataPath = join(fixture.payload, "release-metadata.json");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  metadata.productionHost = "repo.example";
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  await replaceManifest(fixture.payload, {
    files: await hashTree(fixture.payload, new Set(["release-manifest.json"])),
  });

  await assert.rejects(verifyRelease(fixture.payload), /invalid_release_metadata/);
});

test("verifyRelease rejects an exact schema-1 predecessor payload by default", async (context) => {
  const fixture = await releaseFixture(context);
  await writeSchema1Metadata(fixture.payload);
  await assert.rejects(verifyRelease(fixture.payload), /invalid_release_metadata/);
});

test("verifyRelease rejects malformed records, mismatched releases, and archive tampering", async (context) => {
  /** @type {Array<[string, (fixture: any, record: Record<string, any>) => Promise<void>, RegExp]>} */
  const cases = [
    ["extra key", async (fixture, record) => { record.extra = true; }, /invalid_deployment_record/],
    ["type", async (fixture, record) => { record.sourceAttestationId = 123; }, /invalid_deployment_record/],
    ["URL", async (fixture, record) => {
      record.safariEvidenceUrl = "http://evidence.example/safari";
    }, /invalid_deployment_record/],
    ["UUID", async (fixture, record) => { record.workerVersionId = "invalid"; }, /invalid_deployment_record/],
    ["release", async (fixture, record) => { record.releaseId = "c".repeat(40); }, /record_release_mismatch/],
    ["archive", async (fixture) => { await writeFile(fixture.archive, "abd"); }, /archive_digest_mismatch/],
  ];
  for (const [name, mutate, expected] of cases) {
    await context.test(name, async (testContext) => {
      const fixture = await releaseFixture(testContext);
      const record = JSON.parse(await readFile(fixture.record, "utf8"));
      await mutate(fixture, record);
      if (name !== "archive")
        await writeFile(fixture.record, `${JSON.stringify(record, null, 2)}\n`);
      await assert.rejects(verifyRelease(fixture.payload, {
        record: fixture.record, archive: fixture.archive,
      }), expected);
    });
  }
  const fixture = await releaseFixture(context);
  await assert.rejects(
    verifyRelease(fixture.payload, { record: fixture.record }),
    /record_archive_pair_required/,
  );
  const mismatch = await releaseFixture(context);
  const metadata = JSON.parse(await readFile(join(mismatch.payload, "release-metadata.json"), "utf8"));
  metadata.openAiModel = "gpt-5.6-terra";
  metadata.temporaryRelaxation = true;
  await writeFile(
    join(mismatch.payload, "release-metadata.json"),
    `${JSON.stringify(metadata, null, 2)}\n`,
  );
  await writeFile(
    join(mismatch.payload, "release-manifest.json"),
    `${JSON.stringify({ files: await hashTree(mismatch.payload, new Set(["release-manifest.json"])) }, null, 2)}\n`,
  );
  await assert.rejects(verifyRelease(mismatch.payload, {
    record: mismatch.record, archive: mismatch.archive,
  }), /temporary_relaxation_mismatch/);
});

test("createRelease rejects unsupported top-level production binding sections", async (context) => {
  /** @type {Array<[string, any[]]>} */
  const cases = [
    ["kv_namespaces", [{ binding: "CACHE", id: "0".repeat(32) }]],
    ["services", [{ binding: "OTHER_WORKER", service: "other-worker" }]],
  ];
  for (const [section, value] of cases) {
    await context.test(section, async (testContext) => {
      const repository = await releaseRepository(testContext, { [section]: value });
      const out = join(repository.root, `.release-${section}`);
      await assert.rejects(createRelease(createOptions(repository.root, {
        root: repository.root,
        out,
        releaseId: repository.head,
        testSummary: repository.summary,
      })), new RegExp(`unsupported_wrangler_binding:${section}`));
      await assert.rejects(readFile(join(out, "VERIFIED")), /ENOENT/);
    });
  }
});

test("createRelease preserves the exact production graph and isolated compatibility environment", async (context) => {
  const repository = await releaseRepository(context);
  const nodeVersion = Object.getOwnPropertyDescriptor(process.versions, "node");
  if (!nodeVersion) throw new Error("missing_node_version_descriptor");
  Object.defineProperty(process.versions, "node", { value: "24.18.0" });
  context.after(() => Object.defineProperty(process.versions, "node", nodeVersion));
  const created = await createRelease(createOptions(repository.root, {
    root: repository.root,
    out: join(repository.root, ".release-threads"),
    releaseId: repository.head,
    testSummary: repository.summary,
  }));
  const config = JSON.parse(await readFile(join(created.payload, "wrangler.jsonc"), "utf8"));
  assert.deepEqual(config.r2_buckets, THREADS_R2);
  assert.deepEqual(config.queues, THREADS_QUEUES);
  assert.deepEqual(config.triggers, THREADS_TRIGGERS);
  assert.equal(config.env.test.name, "release-fixture-test");
  assert.deepEqual(config.env.test.r2_buckets, [{
    binding: "THREADS_MEDIA", bucket_name: "repo-atlas-test-threads-media",
  }]);
  assert.deepEqual(config.env.test.queues.consumers, [
    { queue: "repo-atlas-test-threads-capture", max_batch_size: 10, max_retries: 3, dead_letter_queue: "repo-atlas-test-threads-capture-dlq" },
    { queue: "repo-atlas-test-threads-media", max_batch_size: 1, max_retries: 3, dead_letter_queue: "repo-atlas-test-threads-media-dlq" },
    { queue: "repo-atlas-test-threads-capture-dlq", max_batch_size: 10, max_retries: 0 },
    { queue: "repo-atlas-test-threads-media-dlq", max_batch_size: 1, max_retries: 0 },
  ]);
  assert.deepEqual(config.env.test.triggers, THREADS_TRIGGERS);
  assert.deepEqual(config.secrets.required, THREADS_SECRETS);
  assert.deepEqual(config.vars, {
    ENVIRONMENT: "deployed",
    PRODUCTION_HOST: "gx.zra.workers.dev",
    OPENAI_MODEL: "gpt-5.6-terra-2026-08-01",
    RELEASE_ID: repository.head,
    TRUSTED_TYPES_MODE: "report-only",
    THREADS_APP_ID,
    ...THREADS_QUEUE_VARS,
  });
});

test("createRelease rejects incomplete or internally inconsistent Threads resources", async (context) => {
  /** @type {Array<[string, Record<string, any>]>} */
  const cases = [
    ["missing app secret", { secrets: { required: THREADS_SECRETS.filter((name) => name !== "THREADS_APP_SECRET") } }],
    ["missing token key", { secrets: { required: THREADS_SECRETS.filter((name) => name !== "THREADS_TOKEN_KEY") } }],
    ["queue var mismatch", { vars: { ...THREADS_QUEUE_VARS, THREADS_MEDIA_DLQ_NAME: "gx-threads-wrong-dlq" } }],
    ["extra bucket", { r2_buckets: [...THREADS_R2, { binding: "EXTRA", bucket_name: "gx-extra" }] }],
    ["extra producer", { queues: { ...THREADS_QUEUES, producers: [...THREADS_QUEUES.producers, { binding: "EXTRA", queue: "gx-extra" }] } }],
    ["extra cron", { triggers: { crons: ["0 3 * * *", "0 4 * * *"] } }],
  ];
  for (const [name, overrides] of cases) {
    await context.test(name, async (testContext) => {
      const repository = await releaseRepository(testContext, overrides);
      await assert.rejects(createRelease(createOptions(repository.root, {
        root: repository.root,
        out: join(repository.root, `.release-${name.replaceAll(" ", "-")}`),
        releaseId: repository.head,
        testSummary: repository.summary,
      })), /invalid_wrangler_config/);
    });
  }
});

test("createRelease rejects a mutable model alias before creating output", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "repo-atlas-release-create-invalid-"));
  context.after(() => rm(parent, { recursive: true, force: true }));
  const out = join(parent, "release");
  await assert.rejects(createRelease(createOptions(parent, {
    out, openAiModel: "gpt-5.6-terra",
  })), /invalid_model/);
  await assert.rejects(readFile(out), /ENOENT/);
});

test("temporary relaxation permits only gpt-5.6-terra and records it in metadata", async (context) => {
  const repository = await releaseRepository(context);
  const nodeVersion = Object.getOwnPropertyDescriptor(process.versions, "node");
  if (!nodeVersion) throw new Error("missing_node_version_descriptor");
  Object.defineProperty(process.versions, "node", { value: "24.18.0" });
  context.after(() => Object.defineProperty(process.versions, "node", nodeVersion));
  await assert.rejects(
    createRelease(createOptions(repository.root, {
      root: repository.root,
      out: join(repository.root, ".release-strict"),
      releaseId: repository.head,
      testSummary: repository.summary,
      openAiModel: "gpt-5.6-terra",
    })),
    /invalid_model/,
  );
  const created = await createRelease(createOptions(repository.root, {
    root: repository.root,
    out: join(repository.root, ".release-relaxed"),
    releaseId: repository.head,
    testSummary: repository.summary,
    openAiModel: "gpt-5.6-terra",
    temporaryRelaxation: true,
  }));
  const metadata = JSON.parse(await readFile(join(created.payload, "release-metadata.json"), "utf8"));
  assert.equal(metadata.openAiModel, "gpt-5.6-terra");
  assert.equal(metadata.temporaryRelaxation, true);
  /** @type {Array<[string, Record<string, any>]>} */
  const cases = [
    ["immutable snapshot", { openAiModel: "gpt-5.6-terra-2026-08-01", temporaryRelaxation: true }],
    ["latest alias", { openAiModel: "gpt-5.6-terra-latest", temporaryRelaxation: true }],
    ["missing relaxation", { temporaryRelaxation: undefined }],
    ["non-boolean relaxation", { temporaryRelaxation: "true" }],
  ];
  for (const [name, options] of cases) {
    await context.test(name, async () => {
      await assert.rejects(createRelease(createOptions(repository.root, {
        root: repository.root,
        out: join(repository.root, `.release-${name.replaceAll(" ", "-")}`),
        releaseId: repository.head,
        testSummary: repository.summary,
        ...options,
      })), /invalid_(model|temporary_relaxation)/);
    });
  }
});

test("createRelease rejects malformed IDs, model shapes, hosts, and Trusted Types mode", async (context) => {
  /** @type {Array<[string, Record<string, any>, RegExp]>} */
  const cases = [
    ["release ID", { releaseId: "A".repeat(40) }, /invalid_release_id/],
    ["model prefix", { openAiModel: "gpt-5.6-mini-2026-08-01" }, /invalid_model/],
    ["model suffix", { openAiModel: "gpt-5.6-terra-SNAPSHOT" }, /invalid_model/],
    ["scheme", { productionHost: "https://repo.example" }, /invalid_hosts/],
    ["path", { productionHost: "repo.example/path" }, /invalid_hosts/],
    ["credentials", { productionHost: "user@repo.example" }, /invalid_hosts/],
    ["port", { productionHost: "repo.example:443" }, /invalid_hosts/],
    ["uppercase", { productionHost: "Repo.example" }, /invalid_hosts/],
    ["IP", { productionHost: "127.0.0.1" }, /invalid_hosts/],
    ["unexpected host", { productionHost: "other.example" }, /invalid_hosts/],
    ["Trusted Types", { trustedTypesMode: "disabled" }, /invalid_trusted_types_mode/],
  ];
  for (const [name, overrides, expected] of cases) {
    await context.test(name, async (testContext) => {
      const parent = await mkdtemp(join(tmpdir(), "repo-atlas-release-create-input-"));
      testContext.after(() => rm(parent, { recursive: true, force: true }));
      await assert.rejects(createRelease(createOptions(parent, overrides)), expected);
    });
  }
});

test("createRelease requires releaseId to equal the repository HEAD", async (context) => {
  const repository = await releaseRepository(context);
  await assert.rejects(createRelease(createOptions(repository.root, {
    root: repository.root,
    out: join(repository.root, ".release-sha"),
    releaseId: "c".repeat(40),
    testSummary: repository.summary,
  })), /release_head_mismatch/);
});

test("createRelease requires the exact eight passed gates for the same commit", async (context) => {
  /** @type {Array<[string, (summary: Record<string, any>) => void, RegExp]>} */
  const cases = [
    ["commit", (summary) => { summary.commit = "c".repeat(40); }, /summary_commit_mismatch/],
    ["root key", (summary) => { summary.extra = true; }, /invalid_gate_summary/],
    ["missing gate", (summary) => { delete summary.gates.unit; }, /invalid_gate_summary/],
    ["extra gate", (summary) => { summary.gates.extra = "passed"; }, /invalid_gate_summary/],
    ["non-passed gate", (summary) => { summary.gates.browser = true; }, /invalid_gate_summary/],
  ];
  for (const [name, mutate, expected] of cases) {
    await context.test(name, async (testContext) => {
      const repository = await releaseRepository(testContext);
      const summary = JSON.parse(await readFile(repository.summary, "utf8"));
      mutate(summary);
      await writeFile(repository.summary, `${JSON.stringify(summary, null, 2)}\n`);
      await assert.rejects(createRelease(createOptions(repository.root, {
        root: repository.root,
        out: join(repository.root, `.release-${name.replaceAll(" ", "-")}`),
        releaseId: repository.head,
        testSummary: repository.summary,
      })), expected);
    });
  }
});

test("createRelease rejects a dirty tracked workspace", async (context) => {
  const repository = await releaseRepository(context);
  await writeFile(join(repository.root, "package.json"), "{}\n");
  await assert.rejects(createRelease(createOptions(repository.root, {
    root: repository.root,
    out: join(repository.root, ".release-dirty"),
    releaseId: repository.head,
    testSummary: repository.summary,
  })), /dirty_tracked_tree/);
});

test("createRelease rejects output equal to or below a copied root without pollution", async (context) => {
  const cases = [
    ["equal", join(".github")],
    [
      "descendant",
      join("public", "..", process.platform === "win32" ? "PUBLIC" : "public", "review-release"),
    ],
  ];
  for (const [name, relativeOut] of cases) {
    await context.test(name, async (testContext) => {
      const repository = await releaseRepository(testContext);
      const out = join(repository.root, relativeOut);
      await assert.rejects(createRelease(createOptions(repository.root, {
        root: repository.root,
        out,
        releaseId: repository.head,
        testSummary: repository.summary,
      })), /release_output_inside_source/);
      await assert.rejects(lstat(out), (error) =>
        error && typeof error === "object" && "code" in error && error.code === "ENOENT");
    });
  }
});

test("createRelease rejects workspace bytes changed after preflight", async (context) => {
  const repository = await releaseRepository(context);
  const out = join(repository.root, ".release-race");
  const operation = createRelease(createOptions(repository.root, {
    root: repository.root,
    out,
    releaseId: repository.head,
    testSummary: repository.summary,
  }));
  await waitForFile(join(out, "payload", "src", "openai.js"));
  await writeFile(join(repository.root, "worker-configuration.d.ts"), "changed\n");

  await assert.rejects(operation, /source_changed:worker-configuration\.d\.ts/);
});

test("createRelease rejects ignored or ordinary untracked entries below copied roots", async (context) => {
  for (const path of ["public/assets/extra.js", "test/support/.wrangler/state.json"]) {
    await context.test(path, async (testContext) => {
      const repository = await releaseRepository(testContext);
      await writeFixture(repository.root, path, "untracked\n");
      await assert.rejects(createRelease(createOptions(repository.root, {
        root: repository.root,
        out: join(repository.root, ".release-purity"),
        releaseId: repository.head,
        testSummary: repository.summary,
      })), /untracked_or_ignored/);
    });
  }
});

test("createRelease refuses modulepreload drift without repairing copied bytes", async (context) => {
  const repository = await releaseRepository(context);
  const drift = "[\n  \"missing.js\"\n]\n";
  await writeFile(join(repository.root, "public", "modulepreload.json"), drift);
  await git(repository.root, ["add", "public/modulepreload.json"]);
  await git(repository.root, [
    "-c", "user.name=Repo Atlas", "-c", "user.email=repo-atlas@example.invalid",
    "commit", "-m", "drift",
  ]);
  const releaseId = await git(repository.root, ["rev-parse", "HEAD"]);
  await writeFile(repository.summary, `${JSON.stringify({
    commit: releaseId,
    gates: Object.fromEntries(GATES.map((gate) => [gate, "passed"])),
  }, null, 2)}\n`);
  const out = join(repository.root, ".release-drift");
  await assert.rejects(createRelease(createOptions(repository.root, {
    root: repository.root, out, releaseId, testSummary: repository.summary,
  })), /source_policy_failed:.*modulepreload drift/);
  assert.equal(await readFile(join(out, "payload", "public", "modulepreload.json"), "utf8"), drift);
  await assert.rejects(readFile(join(out, "VERIFIED")), /ENOENT/);
});

test("createRelease allows default and outside-root outputs with repeatable archives", async (context) => {
  const repository = await releaseRepository(context);
  const outsideRoot = await mkdtemp(join(tmpdir(), "repo-atlas-release-outside-"));
  context.after(() => rm(outsideRoot, { recursive: true, force: true }));
  const firstOut = join(repository.root, ".release");
  const secondOut = join(outsideRoot, "release");
  const common = {
    root: repository.root,
    releaseId: repository.head,
    productionHost: "gx.zra.workers.dev",
    testSummary: repository.summary,
  };
  const first = await createRelease(createOptions(repository.root, { ...common, out: firstOut }));
  const second = await createRelease(createOptions(repository.root, { ...common, out: secondOut }));

  assert.deepEqual(
    await readFile(join(first.payload, "package.json")),
    await readFile(join(repository.root, "package.json")),
  );
  assert.deepEqual(
    await readFile(join(first.payload, "public", "modulepreload.json")),
    await readFile(join(repository.root, "public", "modulepreload.json")),
  );
  const config = JSON.parse(await readFile(join(first.payload, "wrangler.jsonc"), "utf8"));
  assert.equal(config.workers_dev, true);
  assert.equal(config.preview_urls, false);
  assert.equal(Object.hasOwn(config, "route"), false);
  assert.equal(Object.hasOwn(config, "routes"), false);
  assert.deepEqual(config.secrets, { required: [
    ...THREADS_SECRETS,
  ] });
  assert.deepEqual(config.d1_databases, [{ binding: "PROD_DB", database_name: "production" }]);
  assert.equal(config.env.test.name, "release-fixture-test");
  assert.deepEqual(config.env.test.r2_buckets, [{
    binding: "THREADS_MEDIA", bucket_name: "repo-atlas-test-threads-media",
  }]);
  assert.deepEqual(config.env.test.queues.consumers, [
    { queue: "repo-atlas-test-threads-capture", max_batch_size: 10, max_retries: 3, dead_letter_queue: "repo-atlas-test-threads-capture-dlq" },
    { queue: "repo-atlas-test-threads-media", max_batch_size: 1, max_retries: 3, dead_letter_queue: "repo-atlas-test-threads-media-dlq" },
    { queue: "repo-atlas-test-threads-capture-dlq", max_batch_size: 10, max_retries: 0 },
    { queue: "repo-atlas-test-threads-media-dlq", max_batch_size: 1, max_retries: 0 },
  ]);
  assert.deepEqual(config.r2_buckets, THREADS_R2);
  assert.deepEqual(config.queues, THREADS_QUEUES);
  assert.deepEqual(config.triggers, THREADS_TRIGGERS);
  assert.deepEqual(config.vars, {
    ENVIRONMENT: "deployed",
    PRODUCTION_HOST: "gx.zra.workers.dev",
    OPENAI_MODEL: "gpt-5.6-terra-2026-08-01",
    RELEASE_ID: repository.head,
    TRUSTED_TYPES_MODE: "report-only",
    THREADS_APP_ID,
    ...THREADS_QUEUE_VARS,
  });
  const licenses = JSON.parse(await readFile(join(first.payload, "licenses.json"), "utf8"));
  assert.deepEqual(licenses, [
    { name: "svg-tags", version: "1.0.0", license: "MIT", dev: true },
    { name: "typescript", version: "7.0.2", license: "Apache-2.0", dev: true },
    { name: "wrangler", version: "4.114.0", license: "MIT OR Apache-2.0", dev: true },
  ]);
  const sbom = JSON.parse(await readFile(join(first.payload, "sbom.cdx.json"), "utf8"));
  assert.equal(sbom.bomFormat, "CycloneDX");
  assert.equal(Object.hasOwn(sbom, "serialNumber"), false);
  assert.equal(Object.hasOwn(sbom.metadata, "timestamp"), false);
  const metadata = await verifyRelease(first.payload);
  assert.deepEqual(Object.keys(metadata).sort(), [
    "nodeVersion", "npmVersion", "openAiModel", "productionHost", "promptVersion",
    "releaseId", "schema", "temporaryRelaxation", "trustedTypesMode", "typescriptVersion",
    "wranglerVersion",
  ]);
  assert.equal(metadata.schema, 2);
  assert.equal(metadata.releaseId, repository.head);
  assert.equal(metadata.nodeVersion, "24.18.0");
  await verifyRelease(first.verify);
  assert.equal(first.archiveSha256, second.archiveSha256);
  assert.equal(await readFile(join(firstOut, "archive.sha256"), "utf8"), `${first.archiveSha256}\n`);
  assert.equal(
    await readFile(join(firstOut, "VERIFIED"), "utf8"),
    `${JSON.stringify({ archiveSha256: first.archiveSha256, releaseId: repository.head }, null, 2)}\n`,
  );
  assert.deepEqual(
    await readFile(join(first.payload, "release-manifest.json")),
    await readFile(join(second.payload, "release-manifest.json")),
  );
  assert.deepEqual(
    await readFile(join(first.payload, "sbom.cdx.json")),
    await readFile(join(second.payload, "sbom.cdx.json")),
  );
  const archive = await readFile(first.archive);
  const tar = gunzipSync(archive);
  assert.equal(tarMode(tar, "scripts/check-source.mjs"), 0o755);
  assert.equal(tarMode(tar, "package.json"), 0o644);
  assert.equal(tarMode(tar, "release-metadata.json"), 0o644);
  assert.deepEqual([...archive.subarray(4, 8)], [0, 0, 0, 0]);
  assert.equal(archive[9], 255);
});

test("createRelease discovers npm from a sibling lib/node_modules layout", async (context) => {
  const repository = await releaseRepository(context);
  const install = await mkdtemp(join(tmpdir(), "repo-atlas-node-lib-layout-"));
  context.after(() => rm(install, { recursive: true, force: true }));
  const executableDirectory = join(install, "bin");
  const npmDirectory = join(install, "lib", "node_modules", "npm");
  await mkdir(executableDirectory, { recursive: true });
  await mkdir(dirname(npmDirectory), { recursive: true });
  const executable = join(executableDirectory, process.platform === "win32" ? "node.exe" : "node");
  await copyFile(process.execPath, executable);
  if (process.platform !== "win32") await chmod(executable, 0o755);
  const currentNpm = process.platform === "win32"
    ? join(dirname(process.execPath), "node_modules", "npm")
    : join(dirname(process.execPath), "..", "lib", "node_modules", "npm");
  await symlink(currentNpm, npmDirectory, process.platform === "win32" ? "junction" : "dir");
  const out = join(repository.root, ".release-lib-layout");
  const options = createOptions(repository.root, {
    root: repository.root,
    out,
    releaseId: repository.head,
    testSummary: repository.summary,
  });
  const moduleUrl = pathToFileURL(join(process.cwd(), "scripts", "release.mjs")).href;

  await execFile(executable, [
    "--input-type=module", "--eval",
    `import { createRelease } from ${JSON.stringify(moduleUrl)}; await createRelease(${JSON.stringify(options)});`,
  ], { cwd: process.cwd(), encoding: "utf8" });
  await verifyRelease(join(out, "payload"));
});

test("checkCompatibility requires a prior release unless first-release is explicit", async () => {
  const originalFetch = globalThis.fetch;
  await assert.rejects(checkCompatibility({ root: process.cwd() }), /previous_release_required/);
  assert.deepEqual(
    await checkCompatibility({ root: process.cwd(), firstRelease: true }),
    { skipped: true },
  );
  assert.equal(globalThis.fetch, originalFetch);
  await assert.rejects(checkCompatibility({
    root: process.cwd(), previousDir: "payload", firstRelease: true,
  }), /invalid_compatibility_options/);
});

test("checkCompatibility runs the previous payload in a child without mutating parent fetch", async (context) => {
  const previousDir = await compatibilityPayload(context);
  const originalFetch = globalThis.fetch;
  assert.deepEqual(
    await checkCompatibility({ root: process.cwd(), previousDir }),
    { skipped: false },
  );
  assert.equal(globalThis.fetch, originalFetch);
});

test("checkCompatibility alone reads an exact schema-1 predecessor", async (context) => {
  const previousDir = await compatibilityPayload(context);
  await writeSchema1Metadata(previousDir);
  assert.deepEqual(
    await checkCompatibility({ root: process.cwd(), previousDir }),
    { skipped: false },
  );
});

test("checkCompatibility rejects a previous read path that contacts a provider", async (context) => {
  const previousDir = await compatibilityPayload(context, true);
  await assert.rejects(
    checkCompatibility({ root: process.cwd(), previousDir }),
    /compatibility_failed/,
  );
});

test("checkCompatibility timeout kills its child tree before temporary cleanup", async (context) => {
  const evidenceRoot = await mkdtemp(join(tmpdir(), "repo-atlas-compatibility-timeout-"));
  context.after(() => rm(evidenceRoot, { recursive: true, force: true }));
  const evidence = join(evidenceRoot, "pids.json");
  const previousDir = await hangingCompatibilityPayload(context, evidence);
  const started = Date.now();

  await assert.rejects(checkCompatibility({
    root: process.cwd(), previousDir, timeoutMs: 1_000,
  }), /compatibility_failed/);

  const pids = JSON.parse(await readFile(evidence, "utf8"));
  assert.equal(processExists(pids.direct), false);
  assert.equal(processExists(pids.grandchild), false);
  assert.deepEqual(
    (await readdir(join(process.cwd(), ".release"))).filter((name) =>
      name.startsWith("compatibility-")),
    [],
  );
  assert.ok(Date.now() - started < 4_000, "injected compatibility timeout was ignored");
});

test("release CLI records temporary relaxation without evidence URLs", async (context) => {
  const directory = await verifiedDirectory(context);
  const script = join(process.cwd(), "scripts", "release.mjs");
  await execFile(process.execPath, [
    script, "record",
    "--dir", directory,
    "--release-id", RELEASE_ID,
    "--archive-sha256", ARCHIVE_SHA256,
    "--source-attestation-id", "1234567",
    "--worker-version", WORKER_VERSION_ID,
    "--temporary-relaxation",
  ], { cwd: process.cwd(), encoding: "utf8" });
  const record = JSON.parse(await readFile(join(directory, "deployment-record.json"), "utf8"));
  assert.equal(record.temporaryRelaxation, true);
  assert.equal(record.safariEvidenceUrl, null);
  assert.equal(record.iosEvidenceUrl, null);
});

test("release CLI recognizes only the four exact commands", async () => {
  const script = join(process.cwd(), "scripts", "release.mjs");
  await execFile(process.execPath, [script, "compatibility", "--first-release"], {
    cwd: process.cwd(), encoding: "utf8",
  });
  await assert.rejects(
    execFile(process.execPath, [script, "compatibility"], {
      cwd: process.cwd(), encoding: "utf8",
    }),
    (error) => error instanceof Error && /** @type {any} */ (error).code === 1 &&
      /previous_release_required/.test(/** @type {any} */ (error).stderr),
  );
  await assert.rejects(
    execFile(process.execPath, [script, "build"], {
      cwd: process.cwd(), encoding: "utf8",
    }),
    (error) => error instanceof Error && /** @type {any} */ (error).code === 2 &&
      /Usage:/.test(/** @type {any} */ (error).stderr),
  );
});

test("release create rejects the removed staging host option", async () => {
  const script = join(process.cwd(), "scripts", "release.mjs");
  await assert.rejects(
    execFile(process.execPath, [script, "create",
      "--release-id", RELEASE_ID,
      "--out", join(tmpdir(), "repo-atlas-release-cli"),
      "--production-host", "repo.example",
      "--staging-host", "staging.repo.example",
      "--openai-model", "gpt-5.6-terra-2026-08-01",
      "--trusted-types-mode", "report-only",
      "--test-summary", join(tmpdir(), "repo-atlas-release-summary.json"),
    ], { cwd: process.cwd(), encoding: "utf8" }),
    (error) => error instanceof Error && /** @type {any} */ (error).code === 2 &&
      /Usage:/.test(/** @type {any} */ (error).stderr),
  );
});

test("release create requires one canonical bounded decimal Threads app ID", async (context) => {
  const script = join(process.cwd(), "scripts", "release.mjs");
  for (const value of [undefined, "", "0", "01", "abc", "1.2", "1".repeat(33)]) {
    await context.test(value === undefined ? "missing" : JSON.stringify(value), async () => {
      const args = [
        script, "create", "--release-id", RELEASE_ID,
        "--out", join(tmpdir(), "repo-atlas-release-cli"),
        "--production-host", "gx.zra.workers.dev",
        "--openai-model", "gpt-5.6-terra-2026-08-01",
        "--trusted-types-mode", "report-only",
        "--test-summary", join(tmpdir(), "repo-atlas-release-summary.json"),
      ];
      if (value !== undefined) args.push("--threads-app-id", value);
      await assert.rejects(
        execFile(process.execPath, args, { cwd: process.cwd(), encoding: "utf8" }),
        (error) => error instanceof Error && /** @type {any} */ (error).code === 2 &&
          /Usage:/.test(/** @type {any} */ (error).stderr),
      );
    });
  }
});
