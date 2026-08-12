import { readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { createScanner, SyntaxKind } from "typescript/unstable/ast";

const ASSET_ROOT = "public/assets";
const LAYERS = ["reset", "tokens", "base", "layout", "components", "utilities", "overrides"];
const FORBIDDEN_PROPERTIES = new Set(["innerHTML", "outerHTML", "insertAdjacentHTML"]);
const MAX_CSS_BYTES = 1_000_000;

/** @param {string} path */
function display(path) { return path.split(sep).join("/"); }

/** @param {string[]} errors @param {string} file @param {string} rule */
function fail(errors, file, rule) { errors.push(`${display(file)}: ${rule}`); }

/** @param {string} path @param {string} directory */
function isInside(path, directory) {
  const value = relative(directory, path);
  return value !== "" && value !== ".." && !value.startsWith(`..${sep}`);
}

/** @param {string} root @param {string} absolute */
function nameFrom(root, absolute) { return display(relative(root, absolute)); }

/** @param {string} directory @param {string[]} errors @param {string} root */
async function filesUnder(directory, errors, root) {
  /** @type {string[]} */
  const files = [];
  /** @param {string} path */
  async function visit(path) {
    let entries;
    try { entries = await readdir(path, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isSymbolicLink()) { fail(errors, nameFrom(root, child), "symlink"); continue; }
      if (entry.isDirectory() && entry.name !== ".git" && entry.name !== "node_modules") await visit(child);
      else if (entry.isFile()) files.push(child);
    }
  }
  await visit(directory);
  return files.sort();
}

/** @param {string} text */
function tokens(text) {
  const scanner = createScanner(true, undefined, text);
  /** @type {{ kind: number, value: string, lineBreak: boolean }[]} */
  const values = [];
  for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFile; kind = scanner.scan())
    values.push({ kind, value: scanner.getTokenValue(), lineBreak: scanner.hasPrecedingLineBreak() });
  return values;
}

/** @param {string} text @param {string} file @param {string[]} errors */
function scanHtmlText(text, file, errors) {
  for (const match of text.matchAll(/<script\b([^>]*)>/gi))
    if (!/(?:^|\s)src\s*=/i.test(match[1])) fail(errors, file, "inline script");
  if (/\bon[a-z]+\s*=/i.test(text)) fail(errors, file, "inline event");
  if (/unsafe-inline/i.test(text)) fail(errors, file, "unsafe-inline");
  if (/unsafe-eval/i.test(text)) fail(errors, file, "unsafe-eval");
}

/** @param {string} text @param {string} file @param {string[]} errors */
function scanTemplates(text, file, errors) {
  const scanner = createScanner(true, undefined, text);
  /** @type {number[]} */
  const frames = [];
  for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFile; kind = scanner.scan()) {
    if (kind === SyntaxKind.NoSubstitutionTemplateLiteral) scanHtmlText(scanner.getTokenValue(), file, errors);
    if (kind === SyntaxKind.TemplateHead) { scanHtmlText(scanner.getTokenValue(), file, errors); frames.push(0); continue; }
    if (!frames.length) continue;
    if (kind === SyntaxKind.OpenBraceToken) { frames[frames.length - 1] += 1; continue; }
    if (kind !== SyntaxKind.CloseBraceToken) continue;
    if (frames[frames.length - 1] > 0) { frames[frames.length - 1] -= 1; continue; }
    kind = scanner.reScanTemplateToken(false);
    scanHtmlText(scanner.getTokenValue(), file, errors);
    if (kind === SyntaxKind.TemplateTail) frames.pop();
  }
}

/** @param {{ kind: number, value: string, lineBreak: boolean }[]} source @param {number} index @param {boolean} exported */
function moduleSpecifier(source, index, exported) {
  const first = source[index + 1];
  if (!first) return undefined;
  if (!exported && first.kind === SyntaxKind.StringLiteral) return first.value;
  let braces = 0;
  for (let offset = index + 1; offset < source.length; offset += 1) {
    const token = source[offset];
    if (token.kind === SyntaxKind.OpenBraceToken) braces += 1;
    else if (token.kind === SyntaxKind.CloseBraceToken) braces -= 1;
    if (braces === 0 && token.kind === SyntaxKind.FromKeyword) {
      const specifier = source[offset + 1];
      return specifier?.kind === SyntaxKind.StringLiteral ? specifier.value : "";
    }
    if (offset > index + 1 && braces === 0 && token.lineBreak &&
      (token.kind === SyntaxKind.ImportKeyword || token.kind === SyntaxKind.ExportKeyword)) break;
  }
  return exported ? undefined : "";
}

/** @param {{ kind: number, value: string, lineBreak: boolean }[]} source @param {number} index */
function propertyAt(source, index) {
  const token = source[index];
  const next = source[index + 1];
  if ((token.kind === SyntaxKind.DotToken || token.kind === SyntaxKind.QuestionDotToken) && next)
    return { name: next.value, receiver: source[index - 1]?.value ?? "" };
  if (token.kind === SyntaxKind.OpenBracketToken && isStaticCookieValue(source, index + 1) &&
    source[index + 2]?.kind === SyntaxKind.CloseBracketToken) {
    const prior = source[index - 1]?.kind === SyntaxKind.QuestionDotToken ? index - 2 : index - 1;
    return { name: next.value, receiver: source[prior]?.value ?? "" };
  }
  return undefined;
}

/** @param {{ kind: number, value: string, lineBreak: boolean }[]} source @param {number} index */
function isStaticCookieValue(source, index) {
  return source[index]?.kind === SyntaxKind.StringLiteral || source[index]?.kind === SyntaxKind.NoSubstitutionTemplateLiteral;
}

/** @param {{ kind: number, value: string, lineBreak: boolean }[]} source */
function hasStaticCookie(source) {
  for (let index = 0; index < source.length; index += 1) {
    const token = source[index];
    const next = source[index + 1];
    if (token.value.toLowerCase() === "cookie" && source[index + 1]?.kind === SyntaxKind.ColonToken && isStaticCookieValue(source, index + 2)) return true;
    if ((token.kind === SyntaxKind.DotToken || token.kind === SyntaxKind.QuestionDotToken) && next?.value.toLowerCase() === "cookie" &&
      source[index + 2]?.kind === SyntaxKind.EqualsToken && isStaticCookieValue(source, index + 3)) return true;
    if (token.kind === SyntaxKind.OpenBracketToken && source[index + 1]?.kind === SyntaxKind.StringLiteral &&
      source[index + 1].value.toLowerCase() === "cookie" && source[index + 2]?.kind === SyntaxKind.CloseBracketToken &&
      source[index + 3]?.kind === SyntaxKind.EqualsToken && isStaticCookieValue(source, index + 4)) return true;
    if (token.value === "set" && source[index + 1]?.kind === SyntaxKind.OpenParenToken &&
      source[index + 2]?.kind === SyntaxKind.StringLiteral && source[index + 2].value.toLowerCase() === "cookie" &&
      source[index + 3]?.kind === SyntaxKind.CommaToken && isStaticCookieValue(source, index + 4)) return true;
  }
  return false;
}

/** @param {string} text @param {string} file @param {string[]} errors @param {string} assetRoot */
function scanJavaScript(text, file, errors, assetRoot) {
  const source = tokens(text);
  const name = nameFrom(assetRoot, file);
  /** @type {string[]} */
  const imports = [];
  /** @param {string} specifier */
  const addImport = (specifier) => {
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) { fail(errors, name, "bare import"); return; }
    if (!specifier.endsWith(".js")) { fail(errors, name, "import extension"); return; }
    const target = resolve(dirname(file), specifier);
    if (!isInside(target, assetRoot)) { fail(errors, name, "import escapes assets"); return; }
    imports.push(target);
  };
  for (let index = 0; index < source.length; index += 1) {
    const token = source[index];
    const next = source[index + 1];
    if (token.kind === SyntaxKind.ImportKeyword) {
      if (next?.kind === SyntaxKind.OpenParenToken) fail(errors, name, "dynamic import");
      else if (next?.kind !== SyntaxKind.DotToken) {
        const specifier = moduleSpecifier(source, index, false);
        if (specifier === "") fail(errors, name, "non-static import");
        else if (specifier) addImport(specifier);
      }
    }
    if (token.kind === SyntaxKind.ExportKeyword) {
      const specifier = moduleSpecifier(source, index, true);
      if (specifier === "") fail(errors, name, "non-static export");
      else if (specifier) addImport(specifier);
    }
    const property = propertyAt(source, index);
    if (property && FORBIDDEN_PROPERTIES.has(property.name)) fail(errors, name, property.name);
    if (property?.name === "write" && property.receiver === "document") fail(errors, name, "document.write");
    if (token.value === "eval" && (next?.kind === SyntaxKind.OpenParenToken ||
      (next?.kind === SyntaxKind.QuestionDotToken && source[index + 2]?.kind === SyntaxKind.OpenParenToken))) fail(errors, name, "eval");
    if (token.kind === SyntaxKind.NewKeyword && (next?.value === "Function" ||
      (next?.kind === SyntaxKind.OpenParenToken && source[index + 2]?.value === "Function" && source[index + 3]?.kind === SyntaxKind.CloseParenToken)))
      fail(errors, name, "new Function");
    if (token.kind === SyntaxKind.StringLiteral) scanHtmlText(token.value, name, errors);
  }
  scanTemplates(text, name, errors);
  return imports;
}

/** @param {string} text @param {string} file @param {string[]} errors */
function scanTypeDirectives(text, file, errors) {
  const scanner = createScanner(false, undefined, text);
  for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFile; kind = scanner.scan()) {
    if (kind !== SyntaxKind.SingleLineCommentTrivia && kind !== SyntaxKind.MultiLineCommentTrivia) continue;
    const comment = scanner.getTokenText();
    const matches = [...comment.matchAll(/@ts-(ignore|nocheck|expect-error)(?![\w-])/g)];
    for (let index = 0; index < matches.length; index += 1) {
      const match = matches[index];
      const tail = comment.slice(match.index + match[0].length, matches[index + 1]?.index ?? comment.length).trim();
      if (match[1] !== "expect-error" || tail.length < 8) fail(errors, file, `@ts-${match[1]}`);
    }
  }
}

/** @param {string} css */
function maskCss(css) {
  let masked = "";
  let quote = "";
  let comment = false;
  for (let index = 0; index < css.length; index += 1) {
    const char = css[index];
    if (comment) {
      if (char === "*" && css[index + 1] === "/") { masked += "  "; index += 1; comment = false; }
      else masked += char === "\n" ? "\n" : " ";
    } else if (quote) {
      if (char === "\\") { masked += "  "; index += 1; }
      else { masked += char === "\n" ? "\n" : " "; if (char === quote) quote = ""; }
    } else if (char === "/" && css[index + 1] === "*") { masked += "  "; index += 1; comment = true; }
    else if (char === "\"" || char === "'") { masked += " "; quote = char; }
    else masked += char;
  }
  return { code: masked, unterminated: Boolean(comment || quote) };
}

/** @param {{ file: string, text: string }[]} sources @param {string[]} errors */
function scanCss(sources, errors) {
  if (sources.reduce((size, source) => size + Buffer.byteLength(source.text), 0) > MAX_CSS_BYTES) {
    fail(errors, "public/assets", "CSS exceeds policy limit");
    return;
  }
  const masked = sources.map((source) => ({ file: source.file, ...maskCss(source.text) }));
  for (const source of masked) if (source.unterminated) fail(errors, source.file, "CSS syntax");
  const orders = masked.flatMap((source) => [...source.code.matchAll(/@layer\s+([^;{]+);/g)].map((match) => match[1].replace(/\s+/g, " ").trim()));
  if (orders.length !== 1 || orders[0] !== LAYERS.join(", ")) fail(errors, "public/assets", "layer order");
  /** @type {Map<string, { file: string, refs: string[] }>} */
  const declarations = new Map();
  /** @type {{ file: string, token: string }[]} */
  const references = [];
  for (const source of masked) {
    if (/@import\b/i.test(source.code)) fail(errors, source.file, "@import");
    /** @type {{ layer: boolean }[]} */
    const stack = [];
    for (let index = 0, start = 0; index < source.code.length; index += 1) {
      if (source.code[index] === "{") {
        const header = source.code.slice(start, index).trim();
        const layer = /^@layer\s+([\w-]+)\s*$/.exec(header);
        const parent = stack.at(-1)?.layer ?? false;
        if (layer && !LAYERS.includes(layer[1])) fail(errors, source.file, "unknown layer");
        if (header && !header.startsWith("@") && !parent) fail(errors, source.file, "rule outside @layer");
        stack.push({ layer: parent || Boolean(layer) });
        start = index + 1;
      } else if (source.code[index] === "}") {
        if (!stack.pop()) fail(errors, source.file, "unbalanced CSS");
        start = index + 1;
      } else if (source.code[index] === ";") start = index + 1;
    }
    if (stack.length) fail(errors, source.file, "unbalanced CSS");
    for (const declaration of source.code.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+)(?:;|(?=\s*}))/g)) {
      const refs = [...declaration[2].matchAll(/var\(\s*(--[\w-]+)/g)].map((match) => match[1]);
      declarations.set(declaration[1], { file: source.file, refs });
      for (const token of refs) references.push({ file: source.file, token });
      if (refs.includes(declaration[1])) fail(errors, source.file, "token self-reference");
    }
    for (const reference of source.code.matchAll(/var\(\s*(--[\w-]+)/g)) references.push({ file: source.file, token: reference[1] });
  }
  for (const reference of references) if (!declarations.has(reference.token)) fail(errors, reference.file, "undeclared token");
  /** @type {Set<string>} */
  const visited = new Set();
  /** @type {Set<string>} */
  const active = new Set();
  /** @param {string} token */
  const visit = (token) => {
    if (active.has(token)) { fail(errors, declarations.get(token)?.file ?? "public/assets", "token cycle"); return; }
    if (visited.has(token)) return;
    visited.add(token); active.add(token);
    for (const child of declarations.get(token)?.refs ?? []) visit(child);
    active.delete(token);
  };
  for (const token of declarations.keys()) visit(token);
}

/** @param {string[]} files @param {string} root @param {string[]} errors */
async function scanSecrets(files, root, errors) {
  for (const file of files) {
    const name = nameFrom(root, file);
    if (name === "package-lock.json" || /(^|\/)(?:fixtures?|__fixtures__)(\/|$)/i.test(name)) continue;
    let text;
    try { text = await readFile(file, "utf8"); } catch { continue; }
    if (text.includes("\0")) continue;
    if (/\bsk-[A-Za-z0-9]{20,}\b/.test(text)) fail(errors, name, "OpenAI secret");
    if (/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/.test(text)) fail(errors, name, "GitHub secret");
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) fail(errors, name, "PEM private key");
    if (/\.(?:[cm]?[jt]s|d\.ts)$/i.test(name)) {
      if (hasStaticCookie(tokens(text))) fail(errors, name, "literal Cookie header");
    } else if (/^\s*Cookie\s*:\s*(?:"[^"]+"|'[^']+'|\S+)/im.test(text)) fail(errors, name, "literal Cookie header");
  }
}

/** @param {string} root @param {{ writePreloads: false | string }} options */
export async function checkSource(root, { writePreloads }) {
  /** @type {string[]} */
  const errors = [];
  root = resolve(root);
  const assets = resolve(root, ASSET_ROOT);
  const publicRoot = join(root, "public");
  const files = await filesUnder(root, errors, root);
  /** @type {{ dependencies?: Record<string, string> }} */
  let packageJson = {};
  try { packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")); }
  catch { fail(errors, "package.json", "invalid package.json"); }
  if (Object.keys(packageJson.dependencies ?? {}).length) fail(errors, "package.json", "production dependencies");
  for (const file of files) if (isInside(file, publicRoot) && extname(file).toLowerCase() === ".html") fail(errors, nameFrom(root, file), "public HTML");
  /** @type {Map<string, string[]>} */
  const graph = new Map();
  for (const file of files.filter((path) => isInside(path, assets) && extname(path) === ".js")) {
    const name = nameFrom(assets, file);
    graph.set(name, scanJavaScript(await readFile(file, "utf8"), file, errors, assets).map((child) => nameFrom(assets, child)));
  }
  for (const [file, children] of graph) for (const child of children)
    if (!graph.has(child)) fail(errors, `public/assets/${file}`, "missing import");
  for (const file of files.filter((path) => /\.(?:[cm]?[jt]s|d\.ts)$/i.test(path)))
    scanTypeDirectives(await readFile(file, "utf8"), nameFrom(root, file), errors);
  const css = await Promise.all(files.filter((path) => isInside(path, assets) && extname(path) === ".css").map(async (file) => ({ file: nameFrom(root, file), text: await readFile(file, "utf8") })));
  scanCss(css, errors);
  /** @param {string} file @param {string[]} trail */
  const validateGraph = (file, trail = []) => {
    if (trail.includes(file)) { fail(errors, `public/assets/${file}`, `import cycle: ${[...trail, file].join(" -> ")}`); return; }
    if (trail.length > 2) { fail(errors, `public/assets/${file}`, "graph depth"); return; }
    const children = graph.get(file);
    if (!children) return;
    for (const child of children) validateGraph(child, [...trail, file]);
  };
  if (!graph.has("app.js")) fail(errors, "public/assets/app.js", "missing entry");
  validateGraph("app.js");
  /** @type {Set<string>} */
  const reachable = new Set();
  /** @param {string} file */
  const reach = (file) => {
    if (reachable.has(file) || !graph.has(file)) return;
    reachable.add(file);
    for (const child of graph.get(file) ?? []) reach(child);
  };
  reach("app.js");
  const preloads = [...reachable].filter((file) => file !== "app.js").sort();
  await scanSecrets(files, root, errors);
  const manifest = resolve(root, "public", "modulepreload.json");
  const expected = `${JSON.stringify(preloads, null, 2)}\n`;
  if (typeof writePreloads === "string") {
    const target = resolve(root, writePreloads);
    if (target.toLowerCase() !== manifest.toLowerCase()) fail(errors, "public/modulepreload.json", "invalid preload path");
    else if (errors.length === 0) await writeFile(manifest, expected, "utf8");
  } else {
    try { if (await readFile(manifest, "utf8") !== expected) fail(errors, "public/modulepreload.json", "modulepreload drift"); }
    catch { fail(errors, "public/modulepreload.json", "modulepreload drift"); }
  }
  return { errors: [...new Set(errors)], preloads };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [flag, target, ...extra] = process.argv.slice(2);
  if (extra.length || (flag && (flag !== "--write-preloads" || !target))) {
    console.error("Usage: node scripts/check-source.mjs [--write-preloads public/modulepreload.json]");
    process.exitCode = 2;
  } else {
    const result = await checkSource(process.cwd(), { writePreloads: flag ? target : false });
    if (result.errors.length) { console.error(result.errors.join("\n")); process.exitCode = 1; }
  }
}
