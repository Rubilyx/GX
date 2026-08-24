import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { checkSource } from "../../scripts/check-source.mjs";

const execFileAsync = promisify(execFile);

/** @param {Record<string, string>} files */
async function fixture(files) {
  const root = await mkdtemp(join(tmpdir(), "repo-atlas-policy-"));
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, contents);
  }
  return root;
}

function safeFiles(extra = {}) {
  return {
    "package.json": JSON.stringify({ dependencies: {} }),
    "public/modulepreload.json": "[\n  \"capture.js\",\n  \"dom.js\"\n]\n",
    "public/assets/app.js": 'import "./capture.js";',
    "public/assets/capture.js": 'import { set } from "./dom.js"; set(document.body, "ok");',
    "public/assets/dom.js": "export const set = (node, value) => { node.textContent = value; };",
    "public/assets/layers.css": "@layer reset, tokens, base, layout, components, utilities, overrides;",
    "public/assets/tokens.css": "@layer tokens { :root { --color-bg-page: #fff; } }",
    "public/assets/core.css": "@layer base { body { background: var(--color-bg-page); } }",
    ...extra,
  };
}

function safeFilesWithoutEntry(extra = {}) {
  const { "public/assets/app.js": entry, ...files } = safeFiles(extra);
  return { ...files, "public/modulepreload.json": "[]\n" };
}

/** @param {import("node:test").TestContext} context @param {Record<string, string>} files */
async function errorsFor(context, files) {
  const root = await fixture(files);
  context.after(() => rm(root, { recursive: true, force: true }));
  return (await checkSource(root, { writePreloads: false })).errors.join("\n");
}

test("accepts a two-deep safe graph and emits selective preloads", async (context) => {
  const root = await fixture(safeFiles());
  context.after(() => rm(root, { recursive: true, force: true }));
  const result = await checkSource(root, { writePreloads: false });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.preloads, ["capture.js", "dom.js"]);
});

test("requires the browser entry module", async (context) => {
  const errors = await errorsFor(context, safeFilesWithoutEntry());
  assert.match(errors, /public\/assets\/app\.js: missing entry/);
});

test("rejects dependency, public HTML, deep graph, cycle, and invalid imports", async (context) => {
  const errors = await errorsFor(context, safeFiles({
    "package.json": JSON.stringify({ dependencies: { lit: "3.0.0" } }),
    "public/index.html": "<main>forbidden</main>",
    "public/assets/app.js": 'import "./one.js"; import "./cycle-a.js"; import("./dynamic.js"); import "bare";',
    "public/assets/one.js": 'import "./two.js";',
    "public/assets/two.js": 'import "./three.js";',
    "public/assets/three.js": 'import "./one.js"; import "../escape.js";',
    "public/assets/cycle-a.js": 'import "./cycle-b.js";',
    "public/assets/cycle-b.js": 'import "./cycle-a.js";',
    "public/assets/unreachable.js": 'import "./missing"; import "./gone.js"; document["innerHTML"] = "bad"; document["write"]("bad");',
  }));
  assert.match(errors, /production dependencies/);
  assert.match(errors, /public HTML/);
  assert.match(errors, /graph depth/);
  assert.match(errors, /import cycle/);
  assert.match(errors, /dynamic import/);
  assert.match(errors, /bare import/);
  assert.match(errors, /escapes assets/);
  assert.match(errors, /import extension/);
  assert.match(errors, /missing import/);
  assert.match(errors, /innerHTML/);
  assert.match(errors, /document\.write/);
});

test("rejects unsafe sinks and generated HTML", async (context) => {
  const errors = await errorsFor(context, safeFiles({
    "public/assets/capture.js": [
      'import { set } from "./dom.js";',
      'document.body.innerHTML = "bad";',
      'document.write("bad"); document["write"]("bad");',
      'eval("bad"); new Function("return 1");',
      'set(document.body, "<script>bad</script><button onclick=bad>bad</button> unsafe-inline unsafe-eval");',
    ].join("\n"),
  }));
  assert.match(errors, /innerHTML/);
  assert.match(errors, /document\.write/);
  assert.match(errors, /eval/);
  assert.match(errors, /new Function/);
  assert.match(errors, /inline script/);
  assert.match(errors, /inline event/);
  assert.match(errors, /unsafe-inline/);
  assert.match(errors, /unsafe-eval/);
});

test("rejects forbidden and unexplained TypeScript directives", async (context) => {
  const errors = await errorsFor(context, safeFiles({
    "public/assets/capture.js": [
      'import { set } from "./dom.js";',
      "// @ts-ignore",
      "// @ts-nocheck",
      "// @ts-expect-error short",
      'set(document.body, "ok");',
    ].join("\n"),
  }));
  assert.match(errors, /@ts-ignore/);
  assert.match(errors, /@ts-nocheck/);
  assert.match(errors, /@ts-expect-error/);
});

test("rejects CSS imports, layer violations, and token errors", async (context) => {
  const errors = await errorsFor(context, safeFiles({
    "public/assets/tokens.css": [
      '@import "bad.css";',
      ":root { --outside: #fff; }",
      "@layer unknown { .x { color: var(--missing); } }",
      "@layer tokens { :root { --self: var(--self); --a: var(--b); --b: var(--a); } }",
    ].join("\n"),
  }));
  assert.match(errors, /@import/);
  assert.match(errors, /outside @layer/);
  assert.match(errors, /unknown layer/);
  assert.match(errors, /undeclared token/);
  assert.match(errors, /token self-reference/);
  assert.match(errors, /token cycle/);
});

test("writes preloads only for clean sources and detects check-only drift", async (context) => {
  const root = await fixture(safeFiles({ "public/modulepreload.json": "[]\n" }));
  context.after(() => rm(root, { recursive: true, force: true }));
  const drift = await checkSource(root, { writePreloads: false });
  assert.match(drift.errors.join("\n"), /modulepreload drift/);
  const written = await checkSource(root, { writePreloads: join(root, "public/modulepreload.json") });
  assert.deepEqual(written.errors, []);
  assert.equal(await readFile(join(root, "public/modulepreload.json"), "utf8"), "[\n  \"capture.js\",\n  \"dom.js\"\n]\n");
});

test("does not overwrite preloads when source errors exist", async (context) => {
  const root = await fixture(safeFiles({
    "public/modulepreload.json": "[\n  \"old.js\"\n]\n",
    "public/assets/capture.js": 'document.body.innerHTML = "bad";',
  }));
  context.after(() => rm(root, { recursive: true, force: true }));
  const result = await checkSource(root, { writePreloads: join(root, "public/modulepreload.json") });
  assert.match(result.errors.join("\n"), /innerHTML/);
  assert.equal(await readFile(join(root, "public/modulepreload.json"), "utf8"), "[\n  \"old.js\"\n]\n");
});

test("CLI enters the checker and returns a policy exit code", async (context) => {
  const root = await fixture(safeFiles());
  context.after(() => rm(root, { recursive: true, force: true }));
  const checker = join(process.cwd(), "scripts/check-source.mjs");
  const clean = await execFileAsync(process.execPath, [checker], { cwd: root });
  assert.equal(clean.stderr, "");
  await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { disallowed: "1.0.0" } }));
  await assert.rejects(
    execFileAsync(process.execPath, [checker], { cwd: root, encoding: "utf8", env: { ...process.env } }),
    /** @param {any} error */ (error) => error.code === 1 && /production dependencies/.test(error.stderr),
  );
});

test("reports secret rules without disclosing secret values", async (context) => {
  const openAi = ["sk", "12345678901234567890"].join("-");
  const github = ["ghp_", "12345678901234567890"].join("");
  const errors = await errorsFor(context, safeFiles({
    "public/assets/secret.js": `const a = "${openAi}"; const b = "${github}"; const headers = { ${["Cookie", '"literal-value"'].join(": ")} };\n// ${["-----BEGIN", "PRIVATE KEY-----"].join(" ")}`,
    "fixtures/ignored.js": `const ignored = "${openAi}";`,
    "package-lock.json": `"${github}"`,
  }));
  assert.match(errors, /OpenAI secret/);
  assert.match(errors, /GitHub secret/);
  assert.match(errors, /PEM private key/);
  assert.match(errors, /literal Cookie header/);
  assert.doesNotMatch(errors, new RegExp(`${openAi}|${github}|literal-value`));
});

test("Threads boundary source is scanned and logging stays fixed-field only", async (context) => {
  const worker = await readFile(join(process.cwd(), "src/worker.js"), "utf8");
  const boundary = await readFile(join(process.cwd(), "src/threads-worker.js"), "utf8");
  const logCalls = [...`${worker}\n${boundary}`.matchAll(
    /console\.(?:log|error|warn|info|debug)\([^;]*\);/g,
  )].map((match) => match[0]);
  assert.deepEqual(logCalls, ["console.log(record);"]);
  assert.doesNotMatch(logCalls.join("\n"),
    /token|state|code|text|cdn|provider|path|query|header|body|url/i);

  const secret = ["sk", "12345678901234567890"].join("-");
  const errors = await errorsFor(context, safeFiles({
    "src/threads-worker.js": `const unsafe = "${secret}";`,
  }));
  assert.match(errors, /src\/threads-worker\.js: OpenAI secret/);
  assert.doesNotMatch(errors, new RegExp(secret));
});

test("parses ASI imports and export-from edges into the preload graph", async (context) => {
  const root = await fixture(safeFiles({
    "public/modulepreload.json": "[\n  \"capture.js\",\n  \"dom.js\",\n  \"reexport.js\"\n]\n",
    "public/assets/app.js": 'import "./capture.js"\nimport "./reexport.js"',
    "public/assets/capture.js": "export const capture = true;",
    "public/assets/reexport.js": 'export { set } from "./dom.js"',
  }));
  context.after(() => rm(root, { recursive: true, force: true }));
  const result = await checkSource(root, { writePreloads: false });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.preloads, ["capture.js", "dom.js", "reexport.js"]);
});

test("rejects a bare ASI import before a following valid import", async (context) => {
  const errors = await errorsFor(context, safeFiles({
    "public/assets/app.js": 'import "bare"\nimport "./capture.js"',
  }));
  assert.match(errors, /app\.js: bare import/);
});

test("rejects optional, computed, and parenthesized unsafe sinks", async (context) => {
  const errors = await errorsFor(context, safeFiles({
    "public/assets/capture.js": [
      'import { set } from "./dom.js";',
      'document.body?.innerHTML = "bad";',
      'document.body?.["outerHTML"] = "bad";',
      'document.body?.insertAdjacentHTML("beforeend", "bad");',
      'document?.write("bad"); document?.["write"]("bad");',
      'eval?.("bad"); new (Function)("return 1");',
      'set(document.body, "ok");',
    ].join("\n"),
  }));
  assert.match(errors, /innerHTML/);
  assert.match(errors, /outerHTML/);
  assert.match(errors, /insertAdjacentHTML/);
  assert.match(errors, /document\.write/);
  assert.match(errors, /eval/);
  assert.match(errors, /new Function/);
});

test("rejects computed no-substitution-template sink names", async (context) => {
  const errors = await errorsFor(context, safeFiles({
    "public/assets/capture.js": [
      'import { set } from "./dom.js";',
      'document[`write`]("bad");',
      'document.body?.[`innerHTML`] = "bad";',
      'document.body?.[`outerHTML`] = "bad";',
      'document.body?.[`insertAdjacentHTML`]("beforeend", "bad");',
      'set(document.body, "ok");',
    ].join("\n"),
  }));
  assert.match(errors, /document\.write/);
  assert.match(errors, /innerHTML/);
  assert.match(errors, /outerHTML/);
  assert.match(errors, /insertAdjacentHTML/);
});

test("rejects interpolated HTML and data-src script tags", async (context) => {
  const errors = await errorsFor(context, safeFiles({
    "public/assets/capture.js": [
      'import { set } from "./dom.js";',
      'const value = "bad";',
      'set(document.body, `<script>${value}</script>`);',
      'set(document.body, "<script data-src=\"/app.js\"></script>");',
    ].join("\n"),
  }));
  assert.match(errors, /inline script/);
});

test("requires one balanced exact layer order and cross-file token graph", async (context) => {
  const missingOrder = await errorsFor(context, safeFiles({ "public/assets/layers.css": "" }));
  assert.match(missingOrder, /layer order/);
  const duplicateOrder = await errorsFor(context, safeFiles({
    "public/assets/layers.css": "@layer reset, tokens, base, layout, components, utilities, overrides;\n@layer reset, tokens, base, layout, components, utilities, overrides;",
  }));
  assert.match(duplicateOrder, /layer order/);
  const unbalanced = await errorsFor(context, safeFiles({
    "public/assets/tokens.css": "@layer tokens { :root { --color-bg-page: #fff; }",
  }));
  assert.match(unbalanced, /unbalanced CSS/);
  const crossFileCycle = await errorsFor(context, safeFiles({
    "public/assets/tokens.css": "@layer tokens { :root { --a: var(--b); } }",
    "public/assets/core.css": "@layer base { body { --b: var(--a); color: var(--a); } }",
  }));
  assert.match(crossFileCycle, /token cycle/);
  const commentedToken = await errorsFor(context, safeFiles({
    "public/assets/tokens.css": "@layer tokens { /* --ghost: #fff; */ :root { --color-bg-page: #fff; } }",
    "public/assets/core.css": "@layer base { body { color: var(--ghost, #fff); } }",
  }));
  assert.match(commentedToken, /undeclared token/);
});

test("rejects unterminated CSS comments and quotes after otherwise balanced CSS", async (context) => {
  const comment = await errorsFor(context, safeFiles({
    "public/assets/tokens.css": "@layer tokens { :root { --color-bg-page: #fff; } } /*",
  }));
  assert.match(comment, /CSS syntax/);
  const quote = await errorsFor(context, safeFiles({
    "public/assets/tokens.css": '@layer tokens { :root { --color-bg-page: #fff; } } "',
  }));
  assert.match(quote, /CSS syntax/);
});

test("scans every exact TypeScript directive including root declarations", async (context) => {
  const errors = await errorsFor(context, safeFiles({
    "worker-configuration.d.ts": "// @ts-ignore root directive\ndeclare const value: string;",
    "src/multiple.js": "// @ts-expect-error enough explanation @ts-nocheck\nconst value = 1;",
    "test/near-miss.ts": "// @ts-expect-errors this is not a directive\nconst value = 1;",
  }));
  assert.match(errors, /worker-configuration\.d\.ts: @ts-ignore/);
  assert.match(errors, /src\/multiple\.js: @ts-nocheck/);
  assert.doesNotMatch(errors, /near-miss/);
});

test("rejects literal Cookie forms but permits a runtime value", async (context) => {
  const errors = await errorsFor(context, safeFiles({
    "public/assets/capture.js": [
      'import { set } from "./dom.js";',
      'const headers = { Cookie: "object-value" };',
      'new Headers().set("Cookie", "set-value");',
      'headers["Cookie"] = "indexed-value";',
      'const runtime = location.href; headers.Cookie = runtime;',
      'set(document.body, "ok");',
    ].join("\n"),
    "notes.txt": ["Cookie", "raw-value"].join(": "),
  }));
  assert.match(errors, /capture\.js: literal Cookie header/);
  assert.match(errors, /notes\.txt: literal Cookie header/);
  assert.doesNotMatch(errors, /object-value|set-value|indexed-value|raw-value/);
});

test("rejects static dot Cookie assignments but permits runtime assignments", async (context) => {
  const errors = await errorsFor(context, safeFiles({
    "public/assets/capture.js": [
      'import { set } from "./dom.js";',
      'const headers = {}; headers.Cookie = "static-value";',
      'const runtime = location.href; headers.cOoKiE = runtime;',
      'set(document.body, "ok");',
    ].join("\n"),
  }));
  assert.match(errors, /literal Cookie header/);
  assert.doesNotMatch(errors, /static-value/);
});

test("leaves disconnected deep and cyclic graphs out of graph validation and preloads", async (context) => {
  const root = await fixture(safeFiles({
    "public/assets/orphan-a.js": 'import "./orphan-b.js";',
    "public/assets/orphan-b.js": 'import "./orphan-c.js";',
    "public/assets/orphan-c.js": 'import "./orphan-d.js";',
    "public/assets/orphan-d.js": 'import "./orphan-a.js";',
  }));
  context.after(() => rm(root, { recursive: true, force: true }));
  const result = await checkSource(root, { writePreloads: false });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.preloads, ["capture.js", "dom.js"]);
});

test("writes only the canonical preload path and rejects symlinks and uppercase HTML", async (context) => {
  const root = await fixture(safeFiles({ "public/Index.HTML": "forbidden" }));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "linked-target"));
  await symlink(join(root, "linked-target"), join(root, "public/assets/linked"), "junction");
  const errors = await checkSource(root, { writePreloads: false });
  assert.match(errors.errors.join("\n"), /public HTML/);
  assert.match(errors.errors.join("\n"), /symlink/);
  const blocked = await checkSource(root, { writePreloads: join(root, "public", "other.json") });
  assert.match(blocked.errors.join("\n"), /invalid preload path/);
  await assert.rejects(stat(join(root, "public", "other.json")), { code: "ENOENT" });
});

test("accepts a root-relative canonical preload destination", async (context) => {
  const root = await fixture(safeFiles({ "public/modulepreload.json": "[]\n" }));
  context.after(() => rm(root, { recursive: true, force: true }));
  const result = await checkSource(root, { writePreloads: "public/modulepreload.json" });
  assert.deepEqual(result.errors, []);
  assert.equal(await readFile(join(root, "public/modulepreload.json"), "utf8"), "[\n  \"capture.js\",\n  \"dom.js\"\n]\n");
});

test("rejects a noncanonical preload destination without writing it", async (context) => {
  const root = await fixture(safeFiles());
  context.after(() => rm(root, { recursive: true, force: true }));
  const result = await checkSource(root, { writePreloads: "public/other.json" });
  assert.match(result.errors.join("\n"), /invalid preload path/);
  await assert.rejects(stat(join(root, "public/other.json")), { code: "ENOENT" });
});

// @ts-expect-error incompatible assignment proves this directive suppresses a real type error
const typeDirectiveProof = /** @type {number} */ ("not-a-number");
void typeDirectiveProof;
