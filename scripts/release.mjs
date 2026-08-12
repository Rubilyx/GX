import { createHash } from "node:crypto";
import { execFile as execFileCallback, spawn, spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile,
} from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseArgs, promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { checkSource } from "./check-source.mjs";
import { PROMPT_VERSION } from "../src/openai.js";

const execFile = promisify(execFileCallback);

/** @param {string} path */
export async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** @param {string} root @param {Set<string>} ignored */
export async function hashTree(root, ignored) {
  root = resolve(root);
  /** @type {{ path: string, sha256: string, size: number }[]} */
  const files = [];
  /** @param {string} directory */
  async function visit(directory) {
    for (const name of (await readdir(directory)).sort()) {
      const absolute = join(directory, name);
      const path = relative(root, absolute).split(sep).join("/");
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new Error(`symlink:${path}`);
      if (!info.isDirectory() && !info.isFile()) throw new Error(`special_file:${path}`);
      if (ignored.has(path)) continue;
      if (info.isDirectory()) await visit(absolute);
      else files.push({ path, sha256: await sha256(absolute), size: info.size });
    }
  }
  await visit(root);
  return files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

/**
 * @param {unknown} value
 * @param {string[]} keys
 * @returns {value is Record<string, unknown>}
 */
function exactObject(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

/** @param {unknown} value @returns {value is string} */
function manifestPath(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\0") ||
    value.startsWith("/") || /^[A-Za-z]:/.test(value)) return false;
  const parts = value.split("/");
  return parts.every((part) => part && part !== "." && part !== "..");
}

const RELEASE_PATTERN = /^[a-f0-9]{40}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const RECORD_KEYS = [
  "releaseId", "archiveSha256", "sourceAttestationId", "workerVersionId",
  "safariEvidenceUrl", "iosEvidenceUrl", "temporaryRelaxation", "recordedAt",
];
const METADATA_KEYS = [
  "nodeVersion", "npmVersion", "openAiModel", "productionHost", "promptVersion",
  "releaseId", "schema", "temporaryRelaxation", "trustedTypesMode", "typescriptVersion",
  "wranglerVersion",
];
const SCHEMA_1_METADATA_KEYS = [
  "nodeVersion", "npmVersion", "openAiModel", "productionHost", "promptVersion",
  "releaseId", "schema", "stagingHost", "temporaryRelaxation", "trustedTypesMode",
  "typescriptVersion", "wranglerVersion",
];
const GATE_KEYS = [
  "types", "css", "sourcePolicy", "unit", "integration", "browser",
  "accessibility", "noJavaScript",
];
const REQUIRED_DIRECTORIES = ["migrations", "public", "scripts", "src", "test"];
const REQUIRED_FILES = [
  ".nvmrc", "package.json", "package-lock.json", "playwright.config.js",
  "stylelint.config.mjs", "tsconfig.json", "worker-configuration.d.ts", "wrangler.jsonc",
];
const OPTIONAL_DIRECTORIES = [".github", "docs/operations"];
const OPTIONAL_FILES = ["README.md"];
const RELEASE_WRANGLER_SECTIONS = new Set([
  "$schema", "assets", "compatibility_date", "d1_databases", "dev", "env", "main", "name",
  "observability", "preview_urls", "ratelimits", "route", "routes", "secrets", "vars", "workers_dev",
]);

/** @param {unknown} value */
function evidenceUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
  } catch { return false; }
}

/** @param {unknown} value */
function dnsHost(value) {
  if (typeof value !== "string" || value !== value.toLowerCase() || value.length > 253 ||
    value.startsWith(".") || value.endsWith(".") || isIP(value)) return false;
  return value.split(".").every((label) => label.length > 0 && label.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label));
}

/** @param {unknown} value @param {boolean} relaxed */
const modelAllowed = (value, relaxed) => relaxed
  ? value === "gpt-5.6-terra"
  : typeof value === "string" && /^gpt-5\.6-terra-[a-z0-9._-]*[a-z0-9]$/.test(value);

/** @param {{ temporaryRelaxation: boolean, safariEvidenceUrl: unknown, iosEvidenceUrl: unknown }} record */
const evidenceAllowed = (record) => record.temporaryRelaxation
  ? record.safariEvidenceUrl === null && record.iosEvidenceUrl === null
  : evidenceUrl(record.safariEvidenceUrl) && evidenceUrl(record.iosEvidenceUrl);

/** @param {unknown} value @param {boolean} [legacyRead] */
function validMetadata(value, legacyRead = false) {
  const schema2 = exactObject(value, METADATA_KEYS) && value.schema === 2 &&
    value.productionHost === "gx.zra.workers.dev";
  const schema1 = legacyRead && exactObject(value, SCHEMA_1_METADATA_KEYS) && value.schema === 1 &&
    dnsHost(value.stagingHost) && value.productionHost !== value.stagingHost;
  return (schema1 || schema2) &&
    typeof value.releaseId === "string" && RELEASE_PATTERN.test(value.releaseId) &&
    typeof value.temporaryRelaxation === "boolean" &&
    modelAllowed(value.openAiModel, value.temporaryRelaxation) && dnsHost(value.productionHost) &&
    typeof value.promptVersion === "string" && Boolean(value.promptVersion) &&
    [value.nodeVersion, value.npmVersion, value.typescriptVersion, value.wranglerVersion]
      .every((version) => typeof version === "string" && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) &&
    (value.trustedTypesMode === "report-only" || value.trustedTypesMode === "enforce");
}

/** @param {unknown} value */
function validRecord(value) {
  if (!exactObject(value, RECORD_KEYS)) return false;
  if (typeof value.releaseId !== "string" || !RELEASE_PATTERN.test(value.releaseId) ||
    typeof value.archiveSha256 !== "string" || !DIGEST_PATTERN.test(value.archiveSha256) ||
    typeof value.sourceAttestationId !== "string" || !/^[0-9]+$/.test(value.sourceAttestationId) ||
    typeof value.workerVersionId !== "string" || !UUID_PATTERN.test(value.workerVersionId) ||
    typeof value.temporaryRelaxation !== "boolean" || !evidenceAllowed(/** @type {any} */ (value)) ||
    typeof value.recordedAt !== "string") return false;
  try { return new Date(value.recordedAt).toISOString() === value.recordedAt; }
  catch { return false; }
}

/** @param {unknown} value */
function json(value) { return `${JSON.stringify(value, null, 2)}\n`; }

/** @param {string} root @param {string[]} args */
async function git(root, args) {
  const result = await execFile("git", args, {
    cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, windowsHide: true,
  });
  return result.stdout.trim();
}

/** @param {string} root @param {string[]} args */
async function gitRaw(root, args) {
  const result = await execFile("git", args, {
    cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, windowsHide: true,
  });
  return result.stdout;
}

/** @param {string} path */
function approvedPath(path) {
  return REQUIRED_FILES.includes(path) || OPTIONAL_FILES.includes(path) ||
    [...REQUIRED_DIRECTORIES, ...OPTIONAL_DIRECTORIES]
      .some((directory) => path.startsWith(`${directory}/`));
}

/** @param {string} value */
function comparablePath(value) {
  const path = resolve(value);
  return process.platform === "win32" ? path.toLowerCase() : path;
}

/** @param {string} root @param {string} path */
async function fileState(root, path) {
  const absolute = join(root, ...path.split("/"));
  const info = await lstat(absolute);
  if (info.isSymbolicLink()) throw new Error(`symlink:${path}`);
  if (!info.isFile() || comparablePath(await realpath(absolute)) !== comparablePath(absolute))
    throw new Error(`reparse_or_special:${path}`);
  return { sha256: await sha256(absolute), size: info.size };
}

/** @param {string} root @param {Set<string>} tracked @param {string} directory */
async function inspectCopiedDirectory(root, tracked, directory) {
  const absolute = join(root, ...directory.split("/"));
  const rootInfo = await lstat(absolute);
  if (rootInfo.isSymbolicLink()) throw new Error(`symlink:${directory}`);
  if (!rootInfo.isDirectory() || comparablePath(await realpath(absolute)) !== comparablePath(absolute))
    throw new Error(`reparse_or_special:${directory}`);
  /** @param {string} parent @param {string} relativeParent */
  async function visit(parent, relativeParent) {
    const entries = await readdir(parent, { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const path = `${relativeParent}/${entry.name}`;
      if (!manifestPath(path)) throw new Error(`invalid_path:${path}`);
      const child = join(parent, entry.name);
      const info = await lstat(child);
      if (info.isSymbolicLink()) throw new Error(`symlink:${path}`);
      if (comparablePath(await realpath(child)) !== comparablePath(child))
        throw new Error(`reparse_or_special:${path}`);
      if (info.isDirectory()) {
        if (![...tracked].some((trackedPath) => trackedPath.startsWith(`${path}/`)))
          throw new Error(`untracked_or_ignored:${path}`);
        await visit(child, path);
      } else if (info.isFile()) {
        if (!tracked.has(path)) throw new Error(`untracked_or_ignored:${path}`);
      } else throw new Error(`reparse_or_special:${path}`);
    }
  }
  await visit(absolute, directory);
}

/** @param {string} root */
async function releaseSources(root) {
  const rows = (await gitRaw(root, ["ls-files", "-z", "-s"]))
    .split("\0").filter(Boolean).map((row) => {
      const match = /^(\d{6}) [a-f0-9]+ \d\t(.+)$/.exec(row);
      if (!match || !manifestPath(match[2])) throw new Error("invalid_git_index");
      return { mode: match[1], path: match[2] };
    }).filter((row) => approvedPath(row.path));
  const tracked = new Set(rows.map((row) => row.path));
  for (const directory of REQUIRED_DIRECTORIES) {
    if (!rows.some((row) => row.path.startsWith(`${directory}/`)))
      throw new Error(`missing_release_source:${directory}`);
  }
  for (const path of REQUIRED_FILES) {
    if (!tracked.has(path)) throw new Error(`missing_release_source:${path}`);
  }
  for (const row of rows) {
    if (row.mode === "120000") throw new Error(`git_symlink:${row.path}`);
    if (row.mode === "160000") throw new Error(`git_submodule:${row.path}`);
    if (row.mode !== "100644" && row.mode !== "100755")
      throw new Error(`invalid_git_mode:${row.path}`);
  }
  const ignored = (await gitRaw(root, ["ls-files", "-z", "-ci", "--exclude-standard"]))
    .split("\0").filter((path) => path && approvedPath(path));
  if (ignored.length) throw new Error(`untracked_or_ignored:${ignored[0]}`);
  for (const directory of REQUIRED_DIRECTORIES) await inspectCopiedDirectory(root, tracked, directory);
  for (const directory of OPTIONAL_DIRECTORIES) {
    if (rows.some((row) => row.path.startsWith(`${directory}/`)))
      await inspectCopiedDirectory(root, tracked, directory);
  }
  for (const path of [...REQUIRED_FILES, ...OPTIONAL_FILES].filter((path) => tracked.has(path))) {
    const absolute = join(root, ...path.split("/"));
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) throw new Error(`symlink:${path}`);
    if (!info.isFile() || comparablePath(await realpath(absolute)) !== comparablePath(absolute))
      throw new Error(`reparse_or_special:${path}`);
  }
  rows.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return Promise.all(rows.map(async (row) => ({ ...row, ...await fileState(root, row.path) })));
}

/** @param {string} root */
async function currentMigrations(root) {
  if (await git(root, ["status", "--porcelain=v1", "--untracked-files=no", "--", "migrations"]))
    throw new Error("dirty_tracked_migrations");
  const rows = (await gitRaw(root, ["ls-files", "-z", "-s", "--", "migrations"]))
    .split("\0").filter(Boolean).map((row) => {
      const match = /^(\d{6}) [a-f0-9]+ \d\t(.+)$/.exec(row);
      if (!match || !manifestPath(match[2]) || !match[2].startsWith("migrations/"))
        throw new Error("invalid_git_index");
      if (match[1] === "120000") throw new Error(`git_symlink:${match[2]}`);
      if (match[1] === "160000") throw new Error(`git_submodule:${match[2]}`);
      if (match[1] !== "100644" && match[1] !== "100755")
        throw new Error(`invalid_git_mode:${match[2]}`);
      return match[2];
    });
  if (!rows.length) throw new Error("missing_release_source:migrations");
  await inspectCopiedDirectory(root, new Set(rows), "migrations");
  return rows.sort();
}

/** @param {unknown} value */
function licenseName(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!Array.isArray(value) || !value.length) return undefined;
  const names = value.map((entry) => typeof entry === "string" ? entry :
    entry !== null && typeof entry === "object" && !Array.isArray(entry) &&
      Object.getPrototypeOf(entry) === Object.prototype && Object.hasOwn(entry, "type") &&
      typeof entry.type === "string" ? entry.type : undefined);
  return names.every((name) => typeof name === "string" && name.trim())
    ? names.map((name) => /** @type {string} */ (name).trim()).join(" OR ") : undefined;
}

/** @param {string} path */
function lockPackageName(path) {
  const marker = "node_modules/";
  return path.slice(path.lastIndexOf(marker) + marker.length);
}

/** @param {string} root @param {unknown} lock */
async function installedLicenses(root, lock) {
  if (lock === null || typeof lock !== "object" || Array.isArray(lock) ||
    Object.getPrototypeOf(lock) !== Object.prototype) throw new Error("invalid_package_lock");
  const packages = /** @type {Record<string, unknown>} */ (lock).packages;
  if (!packages || typeof packages !== "object" || Array.isArray(packages))
    throw new Error("invalid_package_lock");
  const rows = [];
  for (const [path, locked] of Object.entries(packages)) {
    if (!path.startsWith("node_modules/") || !locked || typeof locked !== "object") continue;
    const lockEntry = /** @type {Record<string, unknown>} */ (locked);
    const packageFile = join(root, ...path.split("/"), "package.json");
    let info;
    try { info = await lstat(dirname(packageFile)); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink() ||
      comparablePath(await realpath(dirname(packageFile))) !== comparablePath(dirname(packageFile)))
      throw new Error(`invalid_installed_package:${path}`);
    /** @type {any} */
    let packageJson;
    try { packageJson = JSON.parse(await readFile(packageFile, "utf8")); }
    catch { throw new Error(`invalid_installed_package:${path}`); }
    const license = licenseName(packageJson.license ?? packageJson.licenses);
    if (packageJson.name !== lockPackageName(path) || typeof lockEntry.version !== "string" ||
      packageJson.version !== lockEntry.version) throw new Error(`package_lock_mismatch:${path}`);
    if (!license) throw new Error(`missing_license:${path}`);
    rows.push({
      name: packageJson.name,
      version: packageJson.version,
      license,
      dev: lockEntry.dev === true,
    });
  }
  rows.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 :
    left.version < right.version ? -1 : left.version > right.version ? 1 : 0);
  return rows;
}

/** @param {string} root */
async function npmDetails(root) {
  const executableDirectory = dirname(process.execPath);
  const candidates = [
    join(executableDirectory, "node_modules", "npm"),
    join(executableDirectory, "..", "lib", "node_modules", "npm"),
  ];
  let npmRoot;
  let npmPackage;
  for (const candidate of candidates) {
    let packageText;
    try { packageText = await readFile(join(candidate, "package.json"), "utf8"); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue;
      throw new Error("local_npm_missing");
    }
    try { npmPackage = JSON.parse(packageText); }
    catch { throw new Error("local_npm_invalid"); }
    npmRoot = candidate;
    break;
  }
  if (!npmRoot || !npmPackage) throw new Error("local_npm_missing");
  if (typeof npmPackage.version !== "string") throw new Error("local_npm_invalid");
  const result = await execFile(process.execPath, [
    join(npmRoot, "bin", "npm-cli.js"), "sbom", "--omit=dev", "--sbom-format", "cyclonedx",
  ], { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  let sbom;
  try { sbom = JSON.parse(result.stdout); }
  catch { throw new Error("invalid_sbom"); }
  if (!sbom || sbom.bomFormat !== "CycloneDX" || typeof sbom.serialNumber !== "string" ||
    !sbom.metadata || typeof sbom.metadata !== "object" ||
    typeof sbom.metadata.timestamp !== "string" || !Array.isArray(sbom.components))
    throw new Error("invalid_sbom");
  delete sbom.serialNumber;
  delete sbom.metadata.timestamp;
  return { npmVersion: npmPackage.version, sbom };
}

/** @param {Buffer} tar @param {Set<string>} executable */
function normalizeTar(tar, executable) {
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    /** @param {number} start @param {number} end */
    const field = (start, end) => header.subarray(start, end).toString("ascii").replace(/\0.*$/, "");
    const name = [field(345, 500), field(0, 100)].filter(Boolean).join("/");
    if (!manifestPath(name)) throw new Error("invalid_tar");
    const sizeText = header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim();
    const size = Number.parseInt(sizeText || "0", 8);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("invalid_tar");
    header.fill(0, 100, 108);
    header.write((executable.has(name) ? 0o755 : 0o644).toString(8).padStart(7, "0"), 100, "ascii");
    header.fill(0, 108, 116);
    header.write("0000000", 108, "ascii");
    header.fill(0, 116, 124);
    header.write("0000000", 116, "ascii");
    header.fill(0, 136, 148);
    header.write("00000000000", 136, "ascii");
    header.fill(0, 265, 329);
    header.fill(0x20, 148, 156);
    const checksum = header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0");
    header.write(checksum, 148, "ascii");
    header[154] = 0;
    header[155] = 0x20;
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return tar;
}

/** @param {string} payload @param {string} tarPath @param {string[]} paths */
function createTar(payload, tarPath, paths) {
  const result = spawnSync("tar", [
    "-c", "--format=ustar", "-f", tarPath, "--null", "-T", "-",
  ], {
    cwd: payload,
    input: Buffer.from(`${paths.join("\0")}\0`),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0)
    throw new Error(`tar_create_failed:${result.stderr?.trim() ?? result.error?.message ?? "unknown"}`);
}

/** @param {string} archive @param {string} directory */
function extractTar(archive, directory) {
  const result = spawnSync("tar", ["-x", "-f", archive, "-C", directory], {
    encoding: "utf8", maxBuffer: 16 * 1024 * 1024, windowsHide: true,
  });
  if (result.error || result.status !== 0)
    throw new Error(`tar_extract_failed:${result.stderr?.trim() ?? result.error?.message ?? "unknown"}`);
}

/** @param {string} root */
export async function verifyManifest(root) {
  const manifestFile = join(root, "release-manifest.json");
  let info;
  try { info = await lstat(manifestFile); }
  catch { throw new Error("invalid_manifest"); }
  if (info.isSymbolicLink()) throw new Error("symlink:release-manifest.json");
  if (!info.isFile() || comparablePath(await realpath(manifestFile)) !== comparablePath(manifestFile))
    throw new Error("special_file:release-manifest.json");
  let manifest;
  try { manifest = JSON.parse(await readFile(manifestFile, "utf8")); }
  catch { throw new Error("invalid_manifest"); }
  if (!exactObject(manifest, ["files"]) || !Array.isArray(manifest.files))
    throw new Error("invalid_manifest_shape");
  const seen = new Set();
  /** @type {string | undefined} */
  let previous;
  for (const row of manifest.files) {
    if (!exactObject(row, ["path", "sha256", "size"])) throw new Error("invalid_manifest_row");
    if (!manifestPath(row.path)) throw new Error("invalid_path");
    if (typeof row.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(row.sha256))
      throw new Error("invalid_sha256");
    if (typeof row.size !== "number" || !Number.isSafeInteger(row.size) || row.size < 0)
      throw new Error("invalid_size");
    if (seen.has(row.path)) throw new Error(`duplicate_path:${row.path}`);
    if (previous !== undefined && previous > row.path) throw new Error("noncanonical_order");
    seen.add(row.path);
    previous = row.path;
  }
  const actual = await hashTree(root, new Set(["release-manifest.json"]));
  const byPath = new Map(actual.map((row) => [row.path, row]));
  for (const expected of manifest.files) {
    const row = byPath.get(expected.path);
    if (!row) throw new Error(`missing_file:${expected.path}`);
    if (row.size !== expected.size) throw new Error(`size_mismatch:${expected.path}`);
    if (row.sha256 !== expected.sha256) throw new Error(`digest_mismatch:${expected.path}`);
    byPath.delete(expected.path);
  }
  if (byPath.size) throw new Error(`extra_file:${byPath.keys().next().value}`);
  return manifest.files;
}

/** @param {{ directory: string, releaseId: string, archiveSha256: string, sourceAttestationId: string, workerVersionId: string, safariEvidenceUrl: string | null, iosEvidenceUrl: string | null, temporaryRelaxation: boolean }} options */
export async function recordDeployment(options) {
  const record = {
    releaseId: options.releaseId,
    archiveSha256: options.archiveSha256,
    sourceAttestationId: options.sourceAttestationId,
    workerVersionId: options.workerVersionId,
    safariEvidenceUrl: options.safariEvidenceUrl,
    iosEvidenceUrl: options.iosEvidenceUrl,
    temporaryRelaxation: options.temporaryRelaxation,
    recordedAt: new Date().toISOString(),
  };
  if (!validRecord(record)) throw new Error("invalid_deployment_record");
  let marker;
  let markerText;
  try {
    markerText = await readFile(join(options.directory, "VERIFIED"), "utf8");
    marker = JSON.parse(markerText);
  } catch { throw new Error("invalid_verified_marker"); }
  if (!exactObject(marker, ["archiveSha256", "releaseId"]) ||
    typeof marker.archiveSha256 !== "string" || typeof marker.releaseId !== "string" ||
    !DIGEST_PATTERN.test(marker.archiveSha256) || !RELEASE_PATTERN.test(marker.releaseId) ||
    markerText !== json({ archiveSha256: marker.archiveSha256, releaseId: marker.releaseId }))
    throw new Error("invalid_verified_marker");
  if (marker.releaseId !== record.releaseId || marker.archiveSha256 !== record.archiveSha256)
    throw new Error("verified_marker_mismatch");
  const path = join(options.directory, "deployment-record.json");
  try { await writeFile(path, json(record), { encoding: "utf8", flag: "wx" }); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST")
      throw new Error("deployment_record_exists");
    throw error;
  }
  return path;
}

/** @param {string} directory @param {{ record?: string, archive?: string, legacyRead?: boolean }} [options] */
export async function verifyRelease(directory, options = {}) {
  await verifyManifest(directory);
  let metadata;
  let metadataText;
  try {
    metadataText = await readFile(join(directory, "release-metadata.json"), "utf8");
    metadata = JSON.parse(metadataText);
  } catch { throw new Error("invalid_release_metadata"); }
  if (!validMetadata(metadata, options.legacyRead === true) || metadataText !== json(metadata))
    throw new Error("invalid_release_metadata");
  if (Boolean(options.record) !== Boolean(options.archive))
    throw new Error("record_archive_pair_required");
  if (options.record && options.archive) {
    let record;
    let recordText;
    try {
      recordText = await readFile(options.record, "utf8");
      record = JSON.parse(recordText);
    } catch { throw new Error("invalid_deployment_record"); }
    if (!validRecord(record) || recordText !== json(record)) throw new Error("invalid_deployment_record");
    if (record.releaseId !== metadata.releaseId) throw new Error("record_release_mismatch");
    if (record.temporaryRelaxation !== metadata.temporaryRelaxation)
      throw new Error("temporary_relaxation_mismatch");
    if (await sha256(options.archive) !== record.archiveSha256)
      throw new Error("archive_digest_mismatch");
  }
  return metadata;
}

/** @param {{ root?: string, out: string, releaseId: string, productionHost: string, openAiModel: string, temporaryRelaxation: boolean, trustedTypesMode: string, testSummary: string }} options */
export async function createRelease(options) {
  if (typeof options.releaseId !== "string" || !RELEASE_PATTERN.test(options.releaseId))
    throw new Error("invalid_release_id");
  if (typeof options.temporaryRelaxation !== "boolean") throw new Error("invalid_temporary_relaxation");
  if (!modelAllowed(options.openAiModel, options.temporaryRelaxation)) throw new Error("invalid_model");
  if (options.productionHost !== "gx.zra.workers.dev") throw new Error("invalid_hosts");
  if (options.trustedTypesMode !== "report-only" && options.trustedTypesMode !== "enforce")
    throw new Error("invalid_trusted_types_mode");
  const root = resolve(options.root ?? process.cwd());
  if (typeof options.out !== "string" || !options.out ||
    typeof options.testSummary !== "string" || !options.testSummary)
    throw new Error("invalid_release_paths");
  const out = resolve(root, options.out);
  const summaryPath = resolve(root, options.testSummary);
  const comparableOut = comparablePath(out);
  if ([...REQUIRED_DIRECTORIES, ...OPTIONAL_DIRECTORIES].some((directory) => {
    const sourceRoot = comparablePath(join(root, ...directory.split("/")));
    return comparableOut === sourceRoot || comparableOut.startsWith(`${sourceRoot}${sep}`);
  })) throw new Error("release_output_inside_source");
  if (await git(root, ["rev-parse", "HEAD"]) !== options.releaseId)
    throw new Error("release_head_mismatch");
  let summary;
  try { summary = JSON.parse(await readFile(summaryPath, "utf8")); }
  catch { throw new Error("invalid_gate_summary"); }
  if (!exactObject(summary, ["commit", "gates"])) throw new Error("invalid_gate_summary");
  const gates = summary.gates;
  if (!exactObject(gates, GATE_KEYS) ||
    GATE_KEYS.some((gate) => gates[gate] !== "passed"))
    throw new Error("invalid_gate_summary");
  if (summary.commit !== options.releaseId) throw new Error("summary_commit_mismatch");
  if (await git(root, ["status", "--porcelain=v1", "--untracked-files=no"]))
    throw new Error("dirty_tracked_tree");
  const sources = await releaseSources(root);
  if (process.versions.node !== "24.18.0") throw new Error("invalid_node_version");
  try { await lstat(out); throw new Error("release_output_exists"); }
  catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT")
      throw error;
  }
  await mkdir(out);
  const payload = join(out, "payload");
  await mkdir(payload);
  for (const source of sources) {
    const { path } = source;
    const target = join(payload, ...path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(root, ...path.split("/")), target);
    const copied = await fileState(payload, path);
    if (copied.sha256 !== source.sha256 || copied.size !== source.size)
      throw new Error(`source_changed:${path}`);
  }
  for (const source of sources) {
    const current = await fileState(root, source.path);
    if (current.sha256 !== source.sha256 || current.size !== source.size)
      throw new Error(`source_changed:${source.path}`);
  }
  if (await git(root, ["rev-parse", "HEAD"]) !== options.releaseId ||
    await git(root, ["status", "--porcelain=v1", "--untracked-files=no"]))
    throw new Error("source_changed:tracked_tree");

  const sourceCheck = await checkSource(payload, { writePreloads: false });
  if (sourceCheck.errors.length) throw new Error(`source_policy_failed:${sourceCheck.errors.join("|")}`);
  const preloadPath = join(payload, "public", "modulepreload.json");
  const preload = await readFile(preloadPath);
  const preloadWrite = await checkSource(payload, { writePreloads: "public/modulepreload.json" });
  if (preloadWrite.errors.length) throw new Error(`source_policy_failed:${preloadWrite.errors.join("|")}`);
  if (!preload.equals(await readFile(preloadPath))) throw new Error("modulepreload_drift");

  const configPath = join(payload, "wrangler.jsonc");
  let config;
  try { config = JSON.parse(await readFile(configPath, "utf8")); }
  catch { throw new Error("invalid_wrangler_config"); }
  if (!config || typeof config !== "object" || Array.isArray(config))
    throw new Error("invalid_wrangler_config");
  const unsupportedSection = Object.keys(config)
    .find((section) => !RELEASE_WRANGLER_SECTIONS.has(section));
  if (unsupportedSection) throw new Error(`unsupported_wrangler_binding:${unsupportedSection}`);
  config.workers_dev = true;
  config.preview_urls = false;
  delete config.route;
  delete config.routes;
  const databases = Array.isArray(config.d1_databases)
    ? /** @type {any[]} */ (config.d1_databases) : [];
  const productionDatabase = databases.find((database) => database?.binding === "PROD_DB");
  if (!productionDatabase) throw new Error("invalid_wrangler_config");
  config.d1_databases = [productionDatabase];
  config.secrets = { required: [
    "PROD_PIN_SALT", "PROD_PIN_DIGEST", "PROD_IP_HMAC_KEY", "PROD_SESSION_KEY", "OPENAI_API_KEY",
  ] };
  config.vars = {
    ENVIRONMENT: "deployed",
    PRODUCTION_HOST: options.productionHost,
    OPENAI_MODEL: options.openAiModel,
    RELEASE_ID: options.releaseId,
    TRUSTED_TYPES_MODE: options.trustedTypesMode,
  };
  await writeFile(configPath, json(config));

  const artifacts = join(payload, "artifacts");
  await mkdir(artifacts);
  const normalizedSummary = {
    commit: options.releaseId,
    gates: Object.fromEntries(GATE_KEYS.map((gate) => [gate, "passed"])),
  };
  await writeFile(join(artifacts, "test-summary.json"), json(normalizedSummary));

  let lock;
  try { lock = JSON.parse(await readFile(join(payload, "package-lock.json"), "utf8")); }
  catch { throw new Error("invalid_package_lock"); }
  const licenses = await installedLicenses(root, lock);
  await writeFile(join(payload, "licenses.json"), json(licenses));
  const { npmVersion, sbom } = await npmDetails(root);
  await writeFile(join(payload, "sbom.cdx.json"), json(sbom));
  const typescript = licenses.find((row) => row.name === "typescript" && !row.name.includes("/"));
  const wrangler = licenses.find((row) => row.name === "wrangler");
  if (!typescript || !wrangler) throw new Error("release_tool_version_missing");
  const metadata = {
    nodeVersion: process.versions.node,
    npmVersion,
    openAiModel: options.openAiModel,
    productionHost: options.productionHost,
    promptVersion: PROMPT_VERSION,
    releaseId: options.releaseId,
    schema: 2,
    temporaryRelaxation: options.temporaryRelaxation,
    trustedTypesMode: options.trustedTypesMode,
    typescriptVersion: typescript.version,
    wranglerVersion: wrangler.version,
  };
  await writeFile(join(payload, "release-metadata.json"), json(metadata));
  const manifest = { files: await hashTree(payload, new Set(["release-manifest.json"])) };
  await writeFile(join(payload, "release-manifest.json"), json(manifest));

  const archive = join(out, `repo-atlas-${options.releaseId}.tar.gz`);
  const tarPath = archive.slice(0, -3);
  const archivePaths = (await hashTree(payload, new Set())).map((row) => row.path);
  createTar(payload, tarPath, archivePaths);
  const executable = new Set(sources.filter(({ mode }) => mode === "100755").map(({ path }) => path));
  const normalizedTar = normalizeTar(await readFile(tarPath), executable);
  const compressed = gzipSync(normalizedTar, { level: 9 });
  compressed.fill(0, 4, 8);
  compressed[9] = 255;
  await writeFile(archive, compressed, { flag: "wx" });
  await rm(tarPath, { force: true });
  const archiveSha256 = await sha256(archive);
  await writeFile(join(out, "archive.sha256"), `${archiveSha256}\n`, { flag: "wx" });
  const verify = join(out, "verify");
  await mkdir(verify);
  extractTar(archive, verify);
  await verifyRelease(verify);
  await writeFile(
    join(out, "VERIFIED"),
    json({ archiveSha256, releaseId: options.releaseId }),
    { flag: "wx" },
  );
  return { archive, archiveSha256, directory: out, payload, releaseId: options.releaseId, verify };
}

/** @param {string} working @param {NodeJS.ProcessEnv} env @param {number} timeoutMs */
function runCompatibilityChild(working, env, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [
      "--test", "--test-reporter=spec", "compatibility.test.mjs",
    ], {
      cwd: working,
      detached: process.platform !== "win32",
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    /** @type {Buffer[]} */
    const stdout = [];
    const outputLimit = 16 * 1024 * 1024;
    let stdoutSize = 0;
    let stderrSize = 0;
    let failed = false;
    let terminating = false;
    let terminationFailed = false;

    function terminate() {
      if (terminating || child.pid === undefined) return;
      terminating = true;
      if (process.platform === "win32") {
        const result = spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          encoding: "utf8", windowsHide: true,
        });
        terminationFailed = Boolean(result.error) || result.status !== 0;
        return;
      }
      try { process.kill(-child.pid, "SIGKILL"); }
      catch (error) {
        terminationFailed = !error || typeof error !== "object" || !("code" in error) ||
          error.code !== "ESRCH";
      }
    }

    child.stdout.on("data", (chunk) => {
      stdoutSize += chunk.length;
      if (stdoutSize > outputLimit) { failed = true; terminate(); }
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrSize += chunk.length;
      if (stderrSize > outputLimit) { failed = true; terminate(); }
    });
    child.once("error", () => { failed = true; });
    const timer = setTimeout(() => { failed = true; terminate(); }, timeoutMs);
    child.once("close", (code) => {
      clearTimeout(timer);
      const exercised = Buffer.concat(stdout).toString("utf8").includes("compatibility_smoke_passed");
      if (failed || terminationFailed || code !== 0 || !exercised)
        rejectPromise(new Error("compatibility_child_failed"));
      else resolvePromise(undefined);
    });
  });
}

/** @param {{ root?: string, previousDir?: string, firstRelease?: boolean, timeoutMs?: number }} options */
export async function checkCompatibility(options) {
  if (options.firstRelease === true && options.previousDir)
    throw new Error("invalid_compatibility_options");
  if (options.firstRelease === true) return { skipped: true };
  if (!options.previousDir) throw new Error("previous_release_required");
  const timeoutMs = options.timeoutMs ?? 120_000;
  const root = resolve(options.root ?? process.cwd());
  const previous = resolve(root, options.previousDir);
  await verifyRelease(previous, { legacyRead: true });
  const migrations = await currentMigrations(root);
  const releaseRoot = join(root, ".release");
  await mkdir(releaseRoot, { recursive: true });
  const temporary = await mkdtemp(join(releaseRoot, "compatibility-"));
  const working = join(temporary, "payload");
  try {
    await cp(previous, working, { recursive: true, errorOnExist: true, force: false });
    const migrationRoot = join(working, "migrations");
    await rm(migrationRoot, { recursive: true, force: true });
    await mkdir(migrationRoot);
    for (const path of migrations) {
      const relativePath = path.slice("migrations/".length);
      const target = join(migrationRoot, ...relativePath.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await copyFile(join(root, ...path.split("/")), target);
    }
    const runner = `
      import test from "node:test";
      const support = await import("./test/support/harness.js");
      test("previous application reads current schema", async () => {
        const harness = await support.startHarness();
        const calls = [];
        try {
          await harness.setProviderMode({ calls });
          const origin = "https://production.repo-atlas.test";
          const health = await harness.worker.fetch(origin + "/health");
          if (health.status !== 200) throw new Error("compatibility_health");
          const session = await support.login(harness.worker, { origin });
          const list = await harness.worker.fetch(origin + "/", {
            headers: { Cookie: session.cookie },
          });
          if (list.status !== 200) throw new Error("compatibility_list");
          const env = await harness.worker.getEnv();
          await support.seedRepository(env.PROD_DB, {
            id: "c0ffee00-0000-4000-8000-000000000001", githubId: "9007199254740001",
          });
          const detail = await harness.worker.fetch(
            origin + "/repositories/c0ffee00-0000-4000-8000-000000000001", {
            headers: { Cookie: session.cookie },
          });
          if (detail.status !== 200) throw new Error("compatibility_detail");
          if (calls.length || harness.providerCalls().length)
            throw new Error("compatibility_provider_call");
          console.log("compatibility_smoke_passed");
        } finally {
          await harness.close();
        }
      });
    `;
    await writeFile(join(working, "compatibility.test.mjs"), runner, { flag: "wx" });
    const childEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;
    try { await runCompatibilityChild(working, childEnv, timeoutMs); }
    catch { throw new Error("compatibility_failed"); }
    return { skipped: false };
  } finally {
    if (dirname(temporary) !== releaseRoot) throw new Error("invalid_compatibility_cleanup");
    await rm(temporary, { recursive: true, force: true });
  }
}

const USAGE = "Usage: node scripts/release.mjs <create|verify|record|compatibility> [options]";

function usageError() {
  const error = new Error(USAGE);
  error.name = "UsageError";
  return error;
}

/** @param {string[]} args @param {Record<string, { type: "string" | "boolean" }>} options */
function cliValues(args, options) {
  let parsed;
  try {
    parsed = parseArgs({ args, options, strict: true, allowPositionals: false, tokens: true });
  } catch { throw usageError(); }
  const seen = new Set();
  for (const token of parsed.tokens) {
    if (token.kind !== "option") continue;
    if (seen.has(token.name)) throw usageError();
    seen.add(token.name);
  }
  return parsed.values;
}

/**
 * @param {Record<string, string | boolean | undefined>} values
 * @param {string[]} names
 * @returns {Record<string, string>}
 */
function requireStrings(values, names) {
  if (names.some((name) => typeof values[name] !== "string" || !values[name]))
    throw usageError();
  return /** @type {Record<string, string>} */ (/** @type {unknown} */ (values));
}

/** @param {string[]} argv */
async function runCli(argv) {
  const [command, ...args] = argv;
  if (command === "create") {
    const values = cliValues(args, {
      "release-id": { type: "string" },
      out: { type: "string" },
      "production-host": { type: "string" },
      "openai-model": { type: "string" },
      "temporary-relaxation": { type: "boolean" },
      "trusted-types-mode": { type: "string" },
      "test-summary": { type: "string" },
    });
    const required = requireStrings(values, [
      "release-id", "out", "production-host", "openai-model",
      "trusted-types-mode", "test-summary",
    ]);
    await createRelease({
      root: process.cwd(),
      out: required.out,
      releaseId: required["release-id"],
      productionHost: required["production-host"],
      openAiModel: required["openai-model"],
      temporaryRelaxation: values["temporary-relaxation"] === true,
      trustedTypesMode: required["trusted-types-mode"],
      testSummary: required["test-summary"],
    });
    return;
  }
  if (command === "verify") {
    const values = cliValues(args, {
      dir: { type: "string" }, record: { type: "string" }, archive: { type: "string" },
    });
    const required = requireStrings(values, ["dir"]);
    await verifyRelease(required.dir, {
      record: typeof values.record === "string" ? values.record : undefined,
      archive: typeof values.archive === "string" ? values.archive : undefined,
    });
    return;
  }
  if (command === "record") {
    const values = cliValues(args, {
      dir: { type: "string" },
      "release-id": { type: "string" },
      "archive-sha256": { type: "string" },
      "source-attestation-id": { type: "string" },
      "worker-version": { type: "string" },
      "safari-evidence-url": { type: "string" },
      "ios-evidence-url": { type: "string" },
      "temporary-relaxation": { type: "boolean" },
    });
    const required = requireStrings(values, [
      "dir", "release-id", "archive-sha256", "source-attestation-id", "worker-version",
    ]);
    const temporaryRelaxation = values["temporary-relaxation"] === true;
    if (temporaryRelaxation && (values["safari-evidence-url"] !== undefined ||
      values["ios-evidence-url"] !== undefined)) throw usageError();
    const evidence = temporaryRelaxation ? null : requireStrings(values, [
      "safari-evidence-url", "ios-evidence-url",
    ]);
    await recordDeployment({
      directory: required.dir,
      releaseId: required["release-id"],
      archiveSha256: required["archive-sha256"],
      sourceAttestationId: required["source-attestation-id"],
      workerVersionId: required["worker-version"],
      safariEvidenceUrl: evidence?.["safari-evidence-url"] ?? null,
      iosEvidenceUrl: evidence?.["ios-evidence-url"] ?? null,
      temporaryRelaxation,
    });
    return;
  }
  if (command === "compatibility") {
    const values = cliValues(args, {
      "previous-dir": { type: "string" }, "first-release": { type: "boolean" },
    });
    await checkCompatibility({
      root: process.cwd(),
      previousDir: typeof values["previous-dir"] === "string" ? values["previous-dir"] : undefined,
      firstRelease: values["first-release"] === true,
    });
    return;
  }
  throw usageError();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { await runCli(process.argv.slice(2)); }
  catch (error) {
    const usage = error instanceof Error && error.name === "UsageError";
    console.error(usage ? USAGE : error instanceof Error ? error.message : "release_failed");
    process.exitCode = usage ? 2 : 1;
  }
}
