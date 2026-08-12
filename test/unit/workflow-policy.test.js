import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";

/** @param {string} name */
const workflow = (name) => readFile(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), "utf8");

async function currentWorkflows() {
  const directory = new URL("../../.github/workflows/", import.meta.url);
  const names = (await readdir(directory)).filter((name) => /\.ya?ml$/.test(name)).sort();
  return Promise.all(names.map(async (name) => ({ name, source: await readFile(new URL(name, directory), "utf8") })));
}
const allowedActions = new Set([
  "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
  "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
  "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
  "actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6",
]);
const expectedSecrets = [
  "PROD_PIN_SALT", "PROD_PIN_DIGEST", "PROD_IP_HMAC_KEY", "PROD_SESSION_KEY",
  "OPENAI_API_KEY",
];

/** @param {string} source */
function runBodies(source) {
  const lines = source.split("\n");
  const bodies = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(lines[index]);
    if (!match) continue;
    const indent = match[1].length;
    const body = match[2] && !/^[>|][-+]?\s*$/.test(match[2]) ? [match[2]] : [];
    while (index + 1 < lines.length) {
      const next = lines[index + 1];
      const nextIndent = /^\s*/.exec(next)?.[0].length ?? 0;
      if (next.trim() && nextIndent <= indent) break;
      body.push(next.trim());
      index += 1;
    }
    bodies.push(body.join("\n"));
  }
  return bodies;
}

/** @param {string} source @param {string} value */
function occurrences(source, value) {
  return source.split(value).length - 1;
}

/** @param {string} source */
function stepBlocks(source) {
  const lines = source.split("\n");
  const starts = lines.flatMap((line, index) => /^      - /.test(line) ? [index] : []);
  return starts.map((start, index) => lines.slice(start, starts[index + 1]).join("\n"));
}

/** @param {string} line @param {number} start */
function shellSegment(line, start) {
  const invocation = line.slice(start);
  const boundary = invocation.search(/[ \t](?:#|&&|\|\||;|\||&)(?:[ \t]|$)/);
  return boundary === -1 ? invocation : invocation.slice(0, boundary);
}

/** @param {string} line */
function assertCanonicalRun(line) {
  assert.match(line, /^\s*(?:-\s+)?run:\s*(?:[>|][-+]?\s*|\S.*)$/, line.trim());
  assert.doesNotMatch(line, /^\s*(?:-\s+)?run:\s*\*/, line.trim());
}

/** @param {string} source @param {string[]} expected */
function assertPermissionDeclarations(source, expected) {
  const declarations = source.split("\n").filter((line) =>
    /^\s*(?:permissions|"permissions"|'permissions')\s*:/.test(line));
  assert.deepEqual(declarations, expected);
}

/** @param {string} source */
function assertNoJobRunnerContext(source) {
  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] !== "    env:") continue;
    for (const line of lines.slice(index + 1)) {
      if (line.trim() && (line.match(/^\s*/)?.[0].length ?? 0) <= 4) break;
      assert.doesNotMatch(line, /\$\{\{\s*runner\./, line.trim());
    }
  }
}

/** @param {string} line */
function assertWranglerCommand(line) {
  const pattern = /\b(?:npx[ \t]+)?["']?wrangler["']?(?=[ \t])/g;
  const commands = [...line.matchAll(pattern)];
  assert.equal(commands.length, 1, line.trim());
  assert.match(commands[0][0], /^npx[ \t]+wrangler\b/, line.trim());
  const command = shellSegment(line, commands[0].index ?? 0);
  assert.ok(command.includes('--env=""'), line.trim());
}

/** @param {string} line */
function assertAttestationCommand(line) {
  assert.equal(occurrences(line, "gh attestation verify"), 1, line.trim());
  const command = shellSegment(line, line.indexOf("gh attestation verify"));
  assert.match(command, /--repo "\$GITHUB_REPOSITORY"(?:\s|$)/, line.trim());
  assert.match(command, /--signer-workflow "\$GITHUB_REPOSITORY\/\.github\/workflows\/release\.yml"(?:\s|$)/, line.trim());
  assert.match(command, /--source-digest "\$(?:GITHUB_SHA|PREVIOUS_RELEASE_ID|RELEASE_ID)"(?:\s|$)/, line.trim());
  assert.match(command, /--source-ref refs\/heads\/main(?:\s|$)/, line.trim());
  assert.match(command, /--deny-self-hosted-runners(?:\s|$)/, line.trim());
}

/** @param {string} source @param {string} job */
function permissions(source, job) {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line === `  ${job}:`);
  assert.notEqual(start, -1, job);
  const endOffset = lines.slice(start + 1).findIndex((line) => /^  \S/.test(line));
  const block = lines.slice(start, endOffset === -1 ? undefined : start + endOffset + 1);
  const heading = block.findIndex((line) => line === "    permissions:");
  assert.notEqual(heading, -1, `${job} permissions`);
  const values = [];
  for (const line of block.slice(heading + 1)) {
    if (/^      \S/.test(line)) values.push(line);
    else if (line.trim()) break;
  }
  return values;
}

test("required workflows exist before any release policy can pass", async () => {
  const [ci, release, rollback] = await Promise.all([
    workflow("ci"), workflow("release"), workflow("rollback"),
  ]);
  assert.ok(ci && release && rollback);
});

test("Cloudflare resources use the approved GX naming contract", async () => {
  const [ci, release, rollback, configText, packageText] = await Promise.all([
    workflow("ci"),
    workflow("release"),
    workflow("rollback"),
    readFile(new URL("../../wrangler.jsonc", import.meta.url), "utf8"),
    readFile(new URL("../../package.json", import.meta.url), "utf8"),
  ]);
  const config = JSON.parse(configText);
  assert.equal(config.name, "gx");
  assert.equal(config.workers_dev, true);
  assert.equal(config.preview_urls, false);
  assert.equal(config.route, undefined);
  assert.equal(config.routes, undefined);
  assert.equal(config.env.test.name, "repo-atlas-test");
  assert.equal(config.env.test.d1_databases[0].database_name, "repo-atlas-test-production");
  assert.equal(config.env.test.d1_databases.length, 1);
  assert.equal(JSON.parse(packageText).name, "repo-atlas");
  assert.match(release, /\["PROD_DB", "gx-production"\]/);
  for (const source of [release, rollback]) {
    assert.match(source, /source\.name !== "gx"/);
    assert.match(source, /JSON\.stringify\(\{ name: "gx" \}\)/);
  }
  assert.match(release, /process\.env\.PRODUCTION_HOST !== "gx\.zra\.workers\.dev"/);
  assert.match(rollback, /host !== "gx\.zra\.workers\.dev"/);
  for (const source of [release, rollback]) {
    assert.match(source, /workers\/scripts\/gx\/subdomain/);
    assert.match(source, /body\.success !== true \|\| body\.result\?\.enabled !== true \|\|\s*body\.result\?\.previews_enabled !== false/);
    assert.doesNotMatch(source, /workers\/domains|custom_domain|triggers deploy/);
  }
  assert.ok(release.indexOf("workers/scripts/gx/subdomain") < release.indexOf("migrations apply PROD_DB"));
  assert.ok(rollback.lastIndexOf("workers/scripts/gx/subdomain") < rollback.indexOf("npx wrangler versions deploy"));
  assert.match(rollback, /source\.workers_dev !== true \|\| source\.preview_urls !== false \|\|\s*Object\.hasOwn\(source, "route"\) \|\| Object\.hasOwn\(source, "routes"\)/);
  const forbidden = /STAGING_|PREVIEW_|--preview-alias|stagingHost|staging-gx|^  preview:|environment: preview|needs: preview/m;
  const current = await currentWorkflows();
  assert.deepEqual(current.map(({ name }) => name), ["ci.yml", "release.yml", "rollback.yml"]);
  for (const { name, source } of current) assert.doesNotMatch(source, forbidden, name);
});

test("runbook documents only the steady-state production release contract", async () => {
  const runbook = await readFile(new URL("../../docs/operations/release.md", import.meta.url), "utf8");
  assert.match(runbook, /gx\.zra\.workers\.dev/);
  assert.match(runbook, /preview_urls: false/);
  assert.match(runbook, /previews_enabled: false/);
  assert.match(runbook, /`Release` workflow/);
  assert.match(runbook, /`Rollback` workflow/);
  assert.doesNotMatch(runbook, /STAGING_|PREVIEW_|staging-gx|gx-preview|dual-runtime|Post-success|versions secret delete|d1 delete|environments\/preview|final-github-decommission|```bash/);
});

test("candidate proves private subdomain state before uploading a version", async () => {
  const release = await workflow("release");
  const readback = release.indexOf("candidate_subdomain_readback_invalid");
  const upload = release.indexOf("npx wrangler versions upload --tag");
  assert.ok(readback !== -1 && readback < upload);
  assert.match(release.slice(0, upload), /body\.result\?\.enabled !== true \|\|\s*body\.result\?\.previews_enabled !== false/);
});

test("candidate preflight binds exact five secrets to authenticated latest-version detail before upload", async () => {
  const release = await workflow("release");
  const list = release.indexOf("/workers/scripts/gx/versions?deployable=true&per_page=100");
  const detail = release.indexOf("/workers/scripts/gx/versions/${encodeURIComponent(latestVersionId)}");
  const verified = release.indexOf("latest_version_secret_set_invalid");
  const dryRun = release.indexOf("npx wrangler versions upload --dry-run");
  const upload = release.indexOf("npx wrangler versions upload --tag");
  assert.ok(list !== -1 && list < detail && detail < verified && verified < dryRun && dryRun < upload);
  const preflightStart = release.lastIndexOf("const required =", list);
  assert.ok(preflightStart !== -1 && preflightStart < list);
  const preflight = release.slice(preflightStart, dryRun);
  assert.match(preflight, /latest_version_list_readback_invalid/);
  assert.match(preflight, /latest_version_detail_readback_invalid/);
  assert.match(preflight, /response\.status !== 200/);
  assert.match(preflight, /body\?\.success !== true/);
  assert.match(preflight, /result\?\.items/);
  assert.match(preflight, /resources\?\.bindings/);
  assert.match(preflight, /binding\.type === "secret_text"/);
  assert.match(preflight, /latest-version-secrets\.json/);
  assert.match(preflight, /const required = \["OPENAI_API_KEY","PROD_IP_HMAC_KEY","PROD_PIN_DIGEST","PROD_PIN_SALT","PROD_SESSION_KEY"\]/);
  assert.doesNotMatch(release, /wrangler (?:versions )?secret list|Secret Name:/);
});

test("release binds active and candidate PROD_DB before backup and immediately before mutation", async () => {
  const release = await workflow("release");
  const initial = release.indexOf("active_prod_db_binding_mismatch");
  const backup = release.indexOf("npx wrangler d1 export PROD_DB");
  const recheck = release.indexOf("active_prod_db_binding_changed");
  const migration = release.indexOf("npx wrangler d1 migrations apply PROD_DB");
  assert.ok(initial !== -1 && initial < backup && backup < recheck && recheck < migration);
  assert.ok(occurrences(release, 'versions view "$ACTIVE_WORKER_VERSION_ID" --json --env=""') >= 2);
  assert.ok(occurrences(release, 'activeProd[0].id !== candidateProd[0].database_id') >= 2);
  assert.doesNotMatch(release, /non_first_release_production_empty|pre-mutation-production-count/);
  const deploy = release.indexOf('npx wrangler versions deploy "$WORKER_VERSION_ID@100%"');
  const status = release.indexOf("promotion_version_mismatch");
  const countCommand = release.indexOf('SELECT COUNT(*) AS count FROM repositories');
  const smoke = release.indexOf("name: Run production read-only smoke");
  assert.equal(occurrences(release, "SELECT COUNT(*) AS count FROM repositories"), 1);
  assert.ok(deploy < status && status < countCommand && countCommand < smoke);
  const countStep = release.slice(countCommand, smoke);
  assert.match(countStep, /production-count\.json[\s\S]*require_detail=\$\{count > 0 \? "true" : "false"\}/);
  assert.doesNotMatch(countStep, /\bcount\s*(?:===|==|<=)\s*0|0\s*(?:===|==|>=)\s*count/);
});

test("schema-1 predecessor reading is confined to the compatibility gate", async () => {
  const release = await workflow("release");
  const schema = release.indexOf("PREVIOUS_SCHEMA=");
  const schema1 = release.indexOf("schema1_predecessor_compatibility_only");
  const generic = release.indexOf("node scripts/release.mjs verify --dir .release/previous/payload");
  const compatibility = release.indexOf("npm run release:compatibility -- --previous-dir .release/previous/payload");
  assert.ok(schema !== -1 && schema < generic && generic < schema1 && schema1 < compatibility);
  assert.match(release.slice(schema, schema1), /if \[\[ "\$PREVIOUS_SCHEMA" = "2" \]\]; then[\s\S]*node scripts\/release\.mjs verify/);
  assert.match(release.slice(generic, schema1 + 80), /elif \[\[ "\$PREVIOUS_SCHEMA" = "1" \]\]; then/);
});

test("rollback proves current and target PROD_DB continuity twice before deploy", async () => {
  const rollback = await workflow("rollback");
  const initial = rollback.indexOf("current_prod_db_binding_mismatch");
  const recheck = rollback.indexOf("current_prod_db_binding_changed");
  const deploy = rollback.indexOf('npx wrangler versions deploy "$WORKER_VERSION_ID@100%"');
  assert.ok(initial !== -1 && initial < recheck && recheck < deploy);
  assert.ok(occurrences(rollback, 'versions view "$ACTIVE_WORKER_VERSION_ID" --json --env=""') >= 2);
  assert.match(rollback, /activeProd\[0\]\.id !== expectedD1\.get\("PROD_DB"\)/);
  assert.match(rollback, /activeProd\[0\]\.id !== targetProd\[0\]\.database_id/);
});

test("version readbacks reject unsupported resources and exact ASSETS config drift", async () => {
  const [release, rollback] = await Promise.all([workflow("release"), workflow("rollback")]);
  for (const source of [release, rollback]) {
    assert.match(source, /unsupported_worker_binding_type/);
    assert.match(source, /JSON\.stringify\(config\.assets\) !== JSON\.stringify\(expectedAssets\)/);
  }
  assert.ok(occurrences(rollback, "unsupported_worker_binding_type") >= 2);
  assert.ok(occurrences(rollback, "expectedAssets") >= 2);
  assert.ok(occurrences(rollback, "assets[0].name !== expectedAssets.binding") >= 2);
});

test("starting and restored health require exact HTTP 200 and status ok", async () => {
  const release = await workflow("release");
  for (const error of ["starting_release_health_invalid", "automatic_rollback_health_mismatch"])
    assert.match(release, new RegExp(`response\\.status !== 200 \\|\\| body\\?\\.status !== "ok"[\\s\\S]*${error}`));
});

test("release validates the production-only artifact before candidate upload", async () => {
  const release = await workflow("release");
  const verified = release.indexOf("node scripts/release.mjs verify --dir .release/payload");
  const guarded = release.indexOf("generated_worker_subdomain_config_invalid");
  const upload = release.indexOf("npx wrangler versions upload --tag");
  assert.ok(verified !== -1 && verified < guarded && guarded < upload);
  const guard = release.slice(verified, upload);
  assert.match(guard, /readFile\("\.release\/verify\/wrangler\.jsonc", "utf8"\)/);
  assert.match(guard, /config\.name !== "gx" \|\| config\.workers_dev !== true \|\| config\.preview_urls !== false/);
  assert.match(guard, /Object\.hasOwn\(config, "route"\) \|\| Object\.hasOwn\(config, "routes"\)/);
  assert.match(guard, /config\.d1_databases\.length !== 1/);
  assert.match(guard, /JSON\.stringify\(config\.assets\) !== JSON\.stringify\(expectedAssets\)/);
  assert.match(guard, /config\.secrets\.required/);
  assert.match(guard, /Object\.keys\(config\.vars\)/);
  assert.match(guard, /metadata\.schema !== 2/);
});

test("workflows pin only the approved actions and avoid privileged triggers and runners", async () => {
  const sources = (await currentWorkflows()).map(({ source }) => source);
  const used = sources.flatMap((source) => {
    const declarations = source.split("\n").filter((line) => /["']?uses["']?\s*:/.test(line));
    for (const line of declarations)
      assert.match(line, /^\s*(?:-\s+)?uses:\s*\S+(?:\s+#.*)?$/, line.trim());
    return declarations.map((line) => /^\s*(?:-\s+)?uses:\s*(\S+)/.exec(line)?.[1] ?? "");
  });
  assert.ok(used.length > 0);
  assert.deepEqual([...new Set(used)].sort(), [...new Set(used.filter((item) => allowedActions.has(item)))].sort());
  assert.ok([...allowedActions].every((action) => used.includes(action)));
  for (const source of sources) {
    const runs = source.split("\n").filter((line) => /["']?run["']?\s*:/.test(line));
    for (const line of runs) assertCanonicalRun(line);
    const runners = source.split("\n").filter((line) => /["']?runs-on["']?\s*:/.test(line));
    assert.ok(runners.length > 0);
    for (const line of runners) assert.match(line, /^\s*runs-on: ubuntu-latest$/, line.trim());
    for (const block of stepBlocks(source).filter((value) => /^\s*(?:-\s+)?uses:/m.test(value)))
      assert.doesNotMatch(block, /\$\{\{[^}]*\bsecrets\b/);
  }
  assert.doesNotMatch(sources.join("\n"), /pull_request_target|actions\/download-artifact@/);
});

test("CI has read-only permissions and records all eight gates only after the full matrix", async () => {
  const [ci, packageText] = await Promise.all([
    workflow("ci"),
    readFile(new URL("../../package.json", import.meta.url), "utf8"),
  ]);
  const scripts = JSON.parse(packageText).scripts;
  assert.deepEqual(Object.fromEntries([
    "check", "check:types", "lint:css", "check:source", "preloads",
    "test:unit", "test:integration", "test:e2e",
  ].map((name) => [name, scripts[name]])), {
    check: "npm run check:types && npm run lint:css && npm run check:source && npm run test:unit",
    "check:types": "tsc -p tsconfig.json",
    "lint:css": "stylelint \"public/assets/*.css\"",
    "check:source": "node scripts/check-source.mjs",
    preloads: "node scripts/check-source.mjs --write-preloads public/modulepreload.json",
    "test:unit": "node --test --test-reporter=spec test/unit/*.test.js",
    "test:integration": "node --test --test-reporter=spec test/integration/*.test.js",
    "test:e2e": "playwright test",
  });
  assertPermissionDeclarations(ci, ["permissions:"]);
  assert.match(ci, /on:\n  push:\n    branches: \[main\]\n  pull_request:/);
  assert.match(ci, /^permissions:\n  contents: read\n\njobs:/m);
  assert.match(ci, /actions\/checkout@[0-9a-f]{40}[\s\S]*persist-credentials: false/);
  for (const command of [
    "npm ci", "npm run preloads", "git diff --exit-code public/modulepreload.json",
    "npm run check", "npm run test:integration",
    "npx playwright install --with-deps chromium firefox webkit chrome msedge", "npm run test:e2e",
  ]) assert.match(ci, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(ci, /commit:process\.env\.COMMIT/);
  for (const gate of ["types", "css", "sourcePolicy", "unit", "integration", "browser", "accessibility", "noJavaScript"])
    assert.match(ci, new RegExp(`${gate}:'passed'`));
  assert.ok(ci.indexOf("Record passed gates") > ci.indexOf("npm run test:e2e"));
  assert.match(ci, /if: always\(\)[\s\S]*retention-days: 30/);
});

test("production workflows share serialization, exact permissions, and secret-safe shell boundaries", async () => {
  const [release, rollback] = await Promise.all([workflow("release"), workflow("rollback")]);
  const releasePermissions = ["permissions: {}", "    permissions:", "    permissions:"];
  const rollbackPermissions = ["permissions: {}", "    permissions:"];
  assertPermissionDeclarations(release, releasePermissions);
  assertPermissionDeclarations(rollback, rollbackPermissions);
  for (const source of [release, rollback]) {
    assertNoJobRunnerContext(source);
    assert.match(source, /permissions: \{\}/);
    assert.match(source, /runs-on: ubuntu-latest/);
    assert.match(source, /if \[\[ -n "\$\{CLOUDFLARE_ENV:-\}" \]\]; then exit 1; fi/);
    for (const body of runBodies(source)) assert.doesNotMatch(body, /\$\{\{[^}]*\bsecrets\b/);
    assert.doesNotMatch(source, /^      [A-Z][A-Z0-9_]*:\s*\$\{\{\s*(?:secrets(?:\.|\[)|github\.token)/m);
    const wranglerLine = /\b(?:npx[ \t]+)?["']?wrangler["']?(?=[ \t])/;
    for (const line of source.split("\n").filter((value) => wranglerLine.test(value))) {
      assertWranglerCommand(line);
    }
    for (const line of source.split("\n").filter((value) => value.includes("gh attestation verify")))
      assertAttestationCommand(line);
    for (const block of stepBlocks(source).filter((value) => /\bgh\s+(?:api|attestation|release|run)\b/.test(value)))
      assert.match(block, /^          GH_TOKEN: \$\{\{ (?:github\.token|secrets\.RELEASE_ADMIN_TOKEN) \}\}$/m);
  }
  assert.doesNotMatch(release, /^concurrency:/m);
  assert.match(release, /candidate:\n[\s\S]*?environment: candidate[\s\S]*?concurrency:\n      group: repo-atlas-candidate\n      cancel-in-progress: false\n      queue: max/);
  assert.match(release, /promote:\n[\s\S]*?concurrency:\n      group: repo-atlas-production\n      cancel-in-progress: false\n      queue: max/);
  assert.doesNotMatch(rollback, /^concurrency:/m);
  assert.match(rollback, /rollback:\n[\s\S]*?concurrency:\n      group: repo-atlas-production\n      cancel-in-progress: false\n      queue: max/);
  assert.deepEqual(permissions(release, "candidate"), [
    "      contents: read",
    "      id-token: write",
    "      attestations: write",
    "      artifact-metadata: write",
  ]);
  assert.deepEqual(permissions(release, "promote"), [
    "      actions: read",
    "      attestations: read",
    "      contents: write",
  ]);
  assert.deepEqual(permissions(rollback, "rollback"), [
    "      attestations: read",
    "      contents: read",
  ]);
  assert.ok(occurrences(release, "GH_TOKEN: ${{ github.token }}") >= 2);
  assert.ok(occurrences(rollback, "GH_TOKEN: ${{ github.token }}") >= 1);
  assert.match(release, /RELEASE_ADMIN_TOKEN: \$\{\{ secrets\.RELEASE_ADMIN_TOKEN \}\}/);
  assert.throws(() => assertCanonicalRun('      - { run: "echo ${{ secrets.X }}" }'));
  assert.throws(() => assertCanonicalRun("        run: *secret_run"));
  assert.throws(() => assertWranglerCommand("npx wrangler whoami"));
  assert.throws(() => assertWranglerCommand("npx wrangler delete repo-atlas"));
  assert.throws(() => assertWranglerCommand('npx wrangler whoami & echo --env=""'));
  assert.throws(() => assertAttestationCommand('gh attestation verify artifact # --repo "$GITHUB_REPOSITORY" --signer-workflow "$GITHUB_REPOSITORY/.github/workflows/release.yml" --source-digest "$GITHUB_SHA" --source-ref refs/heads/main --deny-self-hosted-runners'));
  assert.throws(() => assertAttestationCommand('gh attestation verify artifact & echo --repo "$GITHUB_REPOSITORY" --signer-workflow "$GITHUB_REPOSITORY/.github/workflows/release.yml" --source-digest "$GITHUB_SHA" --source-ref refs/heads/main --deny-self-hosted-runners'));
  assert.throws(() => assertPermissionDeclarations(`${release}\npermissions: write-all\n`, releasePermissions));
  assert.throws(() => assertPermissionDeclarations(release.replace("    permissions:\n      contents: read", "    permissions:\n      contents: read\n    permissions: write-all"), releasePermissions));
  assert.throws(() => assertNoJobRunnerContext(release.replace("      CLOUDFLARE_ACCOUNT_ID: ${{ vars.CLOUDFLARE_ACCOUNT_ID }}", "      BACKUP_CIPHERTEXT: ${{ runner.temp }}/backup.gpg")));
});

test("release fails closed on source, dispatch, model, repository, attestation, and output identity", async () => {
  const release = await workflow("release");
  assert.match(release, /temporary_relaxation:\s*\n\s*description:[^\n]*\n\s*required:\s*true\s*\n\s*default:\s*false\s*\n\s*type:\s*boolean/);
  assert.match(release, /TEMPORARY_RELAXATION:\s*\$\{\{ inputs\.temporary_relaxation \}\}/);
  assert.match(release, /gpt-5\\.6-terra/);
  assert.match(release, /--temporary-relaxation/);
  assert.match(release, /temporaryRelaxation/);
  assert.match(release, /safari_evidence_url:[\s\S]*required: false[\s\S]*default: ""[\s\S]*ios_evidence_url:[\s\S]*required: false[\s\S]*default: ""/);
  assert.match(release, /name: Verify approved model exists/);
  assert.match(release, /refs\/heads\/main/);
  assert.ok(occurrences(release, "/git/ref/heads/main") >= 2);
  assert.doesNotMatch(release, /git fetch|FETCH_HEAD/);
  assert.ok(release.indexOf("Validate real production bindings") < release.indexOf("npx wrangler"));
  assert.match(release, /missing_production_d1_bindings/);
  assert.match(release, /databases\.length !== 1/);
  assert.match(release, /\["PROD_DB", "gx-production"\]/);
  assert.match(release, /missing_production_rate_limit/);
  assert.match(release, /api\.openai\.com\/v1\/models/);
  assert.match(release, /immutable-releases/);
  assert.match(release, /immutable_releases_disabled/);
  assert.ok(occurrences(release, "/immutable-releases") >= 3);
  assert.ok(occurrences(release, "response.status !== 200 || body?.enabled !== true") >= 3);
  assert.ok(occurrences(release, "RELEASE_ADMIN_TOKEN: ${{ secrets.RELEASE_ADMIN_TOKEN }}") >= 3);
  assert.ok(release.lastIndexOf("/immutable-releases") < release.indexOf('gh release create "repo-atlas-$GITHUB_SHA"'));
  assert.match(release, /gh run download "\$GITHUB_RUN_ID" -n "candidate-\$GITHUB_SHA" -D \.release/);
  assert.match(release, /gh attestation verify "\$subject" --bundle \.release\/source-attestation\.json/);
  assert.match(release, /gh attestation verify \.release\/deployment-record\.json --bundle \.release\/record-attestation\.json/);
  assert.match(release, /\^\[0-9\]\+\$/);
  assert.match(release, /\^\[0-9a-f\]\{64\}\$/);
  assert.match(release, /\^\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[1-8\]\[0-9a-f\]\{3\}-\[89ab\]\[0-9a-f\]\{3\}-\[0-9a-f\]\{12\}\$/);
  assert.match(release, /version\.annotations\?\.\["workers\/tag"\] === process\.env\.GITHUB_SHA/);
  assert.match(release, /versions view "\$WORKER_VERSION_ID" --json --env=""/);
  assert.match(release, /candidate_version_binding_mismatch/);
  assert.match(release, /binding\.type === "assets"/);
  assert.match(release, /assets\.length !== 1/);
  assert.match(release, /binding\.type === "secret_text"/);
  assert.match(release, /binding\.type === "plain_text"/);
  assert.match(release, /metadata\.productionHost !== process\.env\.PRODUCTION_HOST/);
  assert.match(release, /metadata\.schema !== 2/);
  assert.match(release, /gh api --paginate --slurp "\/repos\/\$GITHUB_REPOSITORY\/releases\?per_page=100"/);
  assert.doesNotMatch(release, /gh release list --limit 100/);
  assert.ok(occurrences(release, "/git/ref/tags/") >= 2);
  assert.ok(occurrences(release, "/releases?per_page=100") >= 2);
  assert.match(release, /candidate_tag_reserved/);
  assert.match(release, /malformed_repo_atlas_release_tag/);
  assert.match(release, /published_tag_ref_mismatch/);
  assert.match(release, /published_release_identity_invalid/);
  for (const value of ["active_predecessor_not_single", "active_predecessor_not_retained",
    "retained_release_record_invalid", "active_predecessor_changed"])
    assert.ok(release.includes(value), value);
  assert.match(release, /gh attestation verify \.release\/predecessor-record\/deployment-record\.json[^\n]*--source-digest "\$PREVIOUS_RELEASE_ID"/);
  assert.match(release, /const retained = releases\.slice\(0, 5\)/);
  assert.match(release, /ACTIVE_WORKER_VERSION_ID: \$\{\{ steps\.previous\.outputs\.active_worker_version_id \}\}/);
  assert.ok(release.indexOf("active_predecessor_changed") < release.indexOf("migrations apply PROD_DB"));
  assert.doesNotMatch(release, /const id = releases\[0\]/);
  assert.match(release, /latest_version_secret_set_invalid/);
  assert.ok(occurrences(release, "--experimental-provision=false --experimental-auto-create=false") >= 2);
  assert.match(release, /versions deploy "\$WORKER_VERSION_ID@100%" --yes[\s\S]*--config \.release\/deploy\.jsonc/);
  assert.match(release, /JSON\.stringify\(\{ name: source\.name \}/);
  for (const body of runBodies(release)) assert.doesNotMatch(body, /\$\{\{\s*steps\.previous\.outputs/);
  assert.match(release, /FIRST_RELEASE: \$\{\{ steps\.previous\.outputs\.first_release \}\}/);
  assert.match(release, /PREVIOUS_RELEASE_ID: \$\{\{ steps\.previous\.outputs\.previous_release_id \}\}/);
  assert.match(release, /\["archiveSha256","iosEvidenceUrl","recordedAt","releaseId","safariEvidenceUrl","sourceAttestationId","temporaryRelaxation","workerVersionId"\]/);
  assert.match(release, /record\.temporaryRelaxation !== metadata\.temporaryRelaxation/);
});

test("temporary relaxation is propagated and bounded in its own release commands", async () => {
  const [release, rollback] = await Promise.all([workflow("release"), workflow("rollback")]);
  const candidate = stepBlocks(release).find((block) => block.includes("name: Create verified candidate"));
  const record = stepBlocks(release).find((block) => block.includes("name: Bind immutable deployment record"));
  const preflight = stepBlocks(release).find((block) => block.includes("name: Validate dispatch and external prerequisites"));
  assert.ok(candidate && record && preflight);
  assert.match(candidate, /create_args=\(\)\n\s*\[\[ "\$TEMPORARY_RELAXATION" = true \]\] && create_args\+=\(--temporary-relaxation\)\n\s*node scripts\/release\.mjs create[^\n]*"\$\{create_args\[@\]\}"/);
  assert.match(record, /if \[\[ "\$TEMPORARY_RELAXATION" = true \]\]; then\n\s*record_args\+=\(--temporary-relaxation\)\n\s*else\n\s*record_args\+=\(--safari-evidence-url "\$SAFARI_EVIDENCE_URL" --ios-evidence-url "\$IOS_EVIDENCE_URL"\)\n\s*fi\n\s*node scripts\/release\.mjs record "\$\{record_args\[@\]\}"/);
  assert.match(preflight, /if \(relaxed\) \{\n\s*if \(process\.env\.OPENAI_MODEL !== "gpt-5\.6-terra" \|\| process\.env\.SAFARI_EVIDENCE_URL \|\| process\.env\.IOS_EVIDENCE_URL\)/);
  assert.match(preflight, /httpsUrl\("SAFARI_EVIDENCE_URL"\);\n\s*httpsUrl\("IOS_EVIDENCE_URL"\);\n\s*if \(!\/\^gpt-5\\\.6-terra-\[a-z0-9\._-\]\*\[a-z0-9\]\$\//);
  assert.match(rollback, /const relaxed = record\.temporaryRelaxation === true;\n\s*if \(metadata\.schema !== 2\) throw new Error\("rollback_metadata_schema_invalid"\);\n\s*if \(JSON\.stringify\(Object\.keys\(record\)\.sort\(\)\) !== JSON\.stringify\(expected\) \|\|\n\s*record\.temporaryRelaxation !== metadata\.temporaryRelaxation \|\| metadata\.temporaryRelaxation !== relaxed \|\|\n\s*\(relaxed \? record\.safariEvidenceUrl !== null \|\| record\.iosEvidenceUrl !== null :\n\s*!httpsUrl\(record\.safariEvidenceUrl\) \|\| !httpsUrl\(record\.iosEvidenceUrl\)\)\)/);
  const guard = release.indexOf("temporary_relaxation_requires_first_release");
  assert.notEqual(guard, -1);
  assert.ok(guard < release.indexOf('npx wrangler d1 export PROD_DB'));
  assert.ok(guard < release.indexOf('npx wrangler versions deploy "$WORKER_VERSION_ID@100%"'));
});

test("release preserves backup, compatibility, exact promotion, production verification, and automatic rollback", async () => {
  const release = await workflow("release");
  assert.match(release, /release-smoke\.spec\.js --project=chromium/);
  for (const line of release.split("\n").filter((value) => /playwright test test\/e2e\/release-(?:smoke|csp)\.spec\.js/.test(value)))
    assert.match(line, /--retries=0\s*$/, line.trim());
  assert.match(release, /RELEASE_REQUIRE_DETAIL: \$\{\{ steps\.production_data\.outputs\.require_detail \}\}/);
  assert.match(release, /backup_encryption_key_invalid/);
  assert.match(release, /\^\[A-Za-z0-9\+\/\]\{43\}=\$/);
  assert.match(release, /trusted_types_previous_not_report_only/);
  assert.match(release, /trusted_types_observation_incomplete/);
  assert.match(release, /trusted_types_violations_present/);
  assert.match(release, /PREVIOUS_MODE=.*release-metadata\.json[\s\S]*if \[\[ "\$PREVIOUS_MODE" = "report-only" \]\]; then[\s\S]*telemetry_daily[\s\S]*elif \[\[ "\$PREVIOUS_MODE" != "enforce" \]\]; then/);
  assert.match(release, /published\.publishedAt/);
  assert.doesNotMatch(release, /record\.recordedAt/);
  for (const value of ["umask 077", "$RUNNER_TEMP", "chmod 600", "trap cleanup EXIT", "--pinentry-mode loopback", "--passphrase-fd 0"])
    assert.ok(release.includes(value), value);
  assert.equal(occurrences(release, "${{ runner.temp }}/repo-atlas-${{ github.sha }}.sql.gpg"), 3);
  assert.doesNotMatch(release, /\.release\/prod-backup\.sql|--passphrase\s+"\$/);
  assert.ok(release.indexOf("Upload encrypted production backup") < release.indexOf("migrations apply PROD_DB"));
  assert.match(release, /release:compatibility -- --previous-dir \.release\/previous\/payload/);
  assert.match(release, /versions deploy "\$WORKER_VERSION_ID@100%" --yes[\s\S]*--env=""/);
  assert.match(release, /versions deploy "\$ACTIVE_WORKER_VERSION_ID@100%" --yes[\s\S]*--config \.release\/deploy\.jsonc/);
  assert.match(release, /if: failure\(\) && steps\.promote_version\.outputs\.started == 'true'/);
  assert.match(release, /starting-release-id/);
  assert.match(release, /automatic_rollback_version_mismatch/);
  assert.match(release, /automatic_rollback_health_mismatch/);
  assert.match(release, /name: Always verify automatic rollback\n\s*if: always\(\) && steps\.automatic_rollback\.outcome != 'skipped'/);
  assert.doesNotMatch(release, /triggers deploy/);
  assert.match(release, /gh release create "repo-atlas-\$GITHUB_SHA"/);
});

test("rollback binds a newest-five immutable release to every identity before mutation", async () => {
  const rollback = await workflow("rollback");
  for (const value of [
    "--paginate", "--slurp", "newest_five", "rollback_asset_set_invalid",
    "targetCommitish", "archive_digest_mismatch", "record_release_mismatch", "metadata_release_mismatch",
    "worker_version_mismatch", "worker_version_tag_mismatch", "recheck_newest_five_failed",
  ]) assert.ok(rollback.includes(value), value);
  assert.ok(occurrences(rollback, "/releases?per_page=100") >= 2);
  assert.doesNotMatch(rollback, /gh release list --limit 100/);
  assert.ok(occurrences(rollback, "/git/ref/heads/main") >= 2);
  assert.ok(occurrences(rollback, "/git/ref/tags/") >= 2);
  assert.doesNotMatch(rollback, /git fetch|FETCH_HEAD/);
  assert.match(rollback, /actions\/checkout@[0-9a-f]{40}[\s\S]*persist-credentials: false/);
  assert.ok(rollback.lastIndexOf("recheck_newest_five_failed") < rollback.indexOf("npx wrangler versions deploy"));
  assert.match(rollback, /for subject in "\.rollback\/repo-atlas-\$RELEASE_ID\.tar\.gz" \.rollback\/release-manifest\.json \.rollback\/deployment-record\.json/);
  assert.match(rollback, /npx wrangler versions deploy "\$WORKER_VERSION_ID@100%" --yes[\s\S]*--env=""/);
  assert.match(rollback, /versions deploy "\$WORKER_VERSION_ID@100%"[^\n]*--config \.rollback\/deploy\.jsonc/);
  assert.ok(occurrences(rollback, 'binding.type === "secret_text"') >= 2);
  assert.ok(occurrences(rollback, 'binding.type === "plain_text"') >= 2);
  assert.ok(occurrences(rollback, 'binding.type === "assets"') >= 2);
  assert.ok(occurrences(rollback, "JSON.stringify(config.assets) !== JSON.stringify(expectedAssets)") >= 2);
  assert.ok(occurrences(rollback, 'readFile(".rollback/payload/wrangler.jsonc", "utf8")') >= 2);
  assert.ok(rollback.lastIndexOf("JSON.stringify(config.assets) !== JSON.stringify(expectedAssets)") <
    rollback.indexOf("npx wrangler versions deploy"));
  assert.match(rollback, /JSON\.stringify\(\{ name: source\.name \}/);
  assert.match(rollback, /id: rollback_version[\s\S]*continue-on-error: true/);
  assert.match(rollback, /if: always\(\)[\s\S]*deployments status[\s\S]*rollback_command_failed/);
  assert.doesNotMatch(rollback, /npx wrangler rollback/);
  assert.match(rollback, /RELEASE_MODE="read-only"[^\n]*release-smoke\.spec\.js --project=chromium --retries=0/);
  assert.doesNotMatch(rollback, /D1 remains unchanged/);
  assert.match(rollback, /metadata\.schema !== 2/);
  assert.match(rollback, /d1\.length !== 1/);
  assert.match(rollback, /requiredSecrets = \["OPENAI_API_KEY","PROD_IP_HMAC_KEY","PROD_PIN_DIGEST","PROD_PIN_SALT","PROD_SESSION_KEY"\]/);
  assert.match(rollback, /expectedVars\.size/);
  assert.ok(rollback.indexOf("metadata.schema !== 2") < rollback.indexOf("npx wrangler versions deploy"));
  assert.match(rollback, /\["archiveSha256","iosEvidenceUrl","recordedAt","releaseId","safariEvidenceUrl","sourceAttestationId","temporaryRelaxation","workerVersionId"\]/);
  assert.match(rollback, /record\.temporaryRelaxation !== metadata\.temporaryRelaxation/);
});

test("runtime release gates are project-selectable and Wrangler names only known secrets", async () => {
  const [smoke, csp, configText] = await Promise.all([
    readFile(new URL("../e2e/release-smoke.spec.js", import.meta.url), "utf8"),
    readFile(new URL("../e2e/release-csp.spec.js", import.meta.url), "utf8"),
    readFile(new URL("../../wrangler.jsonc", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(smoke, /test\.skip\(test\.info\(\)\.project\.name !== "chromium"\)/);
  assert.match(smoke, /release_config_partial/);
  assert.match(smoke, /RELEASE_REQUIRE_DETAIL/);
  assert.doesNotMatch(smoke, /rawRequireDetail &&/);
  assert.match(smoke, /rawRequireDetail !== "true" && rawRequireDetail !== "false"/);
  assert.match(smoke, /if \(release\.requireDetail\) expect\(count\)\.toBeGreaterThan\(0\)/);
  assert.doesNotMatch(smoke, /repository_analysis_error/);
  assert.match(smoke, /release_provider_not_created/);
  assert.ok(smoke.indexOf("current.origin === release.base.origin") <
    smoke.indexOf('current.searchParams.get("flash") !== "repository_created"'));
  assert.match(smoke, /form\[action="\/repositories\/\$\{createdId\}\/delete"\]/);
  assert.match(csp, /page\.goto\(new URL\("\/login", release\.base\)\.href\)/);
  assert.match(csp, /release_csp_config_partial/);
  assert.match(csp, /script\.src = "\/__repo_atlas_csp_probe__\.js"/);
  assert.match(csp, /report-uri \/csp-report/);
  assert.doesNotMatch(csp, /request\.post\(new URL\("\/csp-report"/);
  const config = JSON.parse(configText);
  assert.deepEqual(config.secrets?.required, expectedSecrets);
  assert.deepEqual(config.env.test.secrets.required, expectedSecrets);
  assert.deepEqual(config.d1_databases, [
    {
      binding: "PROD_DB",
      database_name: "gx-production",
      database_id: "5e031f7f-52cc-495a-9cd9-e080bd0090ac",
      migrations_dir: "migrations",
    },
  ]);
  assert.deepEqual(config.ratelimits, [
    {
      name: "REPORT_RATE_LIMITER",
      namespace_id: "2001",
      simple: { limit: 60, period: 60 },
    },
  ]);
  assert.equal(config.vars, undefined);
  assert.equal(config.routes, undefined);
  assert.equal(config.route, undefined);
  assert.equal(config.hosts, undefined);
  assert.equal(config.host, undefined);
  for (const name of ["PRODUCTION_HOST", "OPENAI_MODEL", "RELEASE_ID", "TRUSTED_TYPES_MODE"])
    assert.equal(config.vars?.[name], undefined);
});
