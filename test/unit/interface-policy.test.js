import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const CSS_FILES = Object.freeze([
  "core.css", "layers.css", "login.css", "repositories.css", "tokens.css",
]);
const ASSET_ROOT = new URL("../../public/assets/", import.meta.url);

/** @typedef {{ kind: "rule" | "at-rule", prelude: string, selectors: string[], declarations: Map<string, string>, children: CssNode[] }} CssNode */

/** @param {string} name */
const asset = (name) => readFile(new URL(name, ASSET_ROOT), "utf8");

/** @param {string} source */
function stripComments(source) {
  let output = "";
  let quote = "";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      output += character;
      if (character === "\\") output += source[index += 1] ?? "";
      else if (character === quote) quote = "";
    } else if (character === '"' || character === "'") {
      quote = character;
      output += character;
    } else if (character === "\\") {
      output += character + (source[index += 1] ?? "");
    } else if (character === "/" && source[index + 1] === "*") {
      const close = source.indexOf("*/", index + 2);
      assert.notEqual(close, -1, "CSS comments must close");
      output += " ";
      index = close + 1;
    } else output += character;
  }
  return output;
}

/** @param {string} source @param {number} open @param {string} opener @param {string} closer */
function matchingDelimiter(source, open, opener, closer) {
  let depth = 1;
  let quote = "";
  for (let index = open + 1; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = "";
    } else if (character === '"' || character === "'") quote = character;
    else if (character === "\\") index += 1;
    else if (character === opener) depth += 1;
    else if (character === closer && --depth === 0) return index;
  }
  assert.fail(`unclosed ${opener}`);
}

/** @param {string} source @param {string} delimiter */
function splitTopLevel(source, delimiter) {
  const parts = [];
  let start = 0;
  let quote = "";
  let parentheses = 0;
  let brackets = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = "";
    } else if (character === '"' || character === "'") quote = character;
    else if (character === "\\") index += 1;
    else if (character === "(") parentheses += 1;
    else if (character === ")") parentheses -= 1;
    else if (character === "[") brackets += 1;
    else if (character === "]") brackets -= 1;
    else if (character === delimiter && parentheses === 0 && brackets === 0) {
      parts.push(source.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(source.slice(start));
  return parts;
}

/** @param {string} source @param {string} delimiter */
function topLevelIndex(source, delimiter) {
  const first = splitTopLevel(source, delimiter)[0];
  return first.length === source.length ? -1 : first.length;
}

/** @param {string} value */
function trimOptionalSpace(value) {
  let end = value.length;
  while (value[end - 1] === " ") {
    let slashes = 0;
    for (let index = end - 2; value[index] === "\\"; index -= 1) slashes += 1;
    if (slashes % 2 === 1) break;
    end -= 1;
  }
  return value.slice(0, end);
}

/** @param {string} source @param {string} tightBefore @param {string} tightAfter */
function normalize(source, tightBefore = "", tightAfter = "") {
  let output = "";
  let quote = "";
  let pendingSpace = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      output += character;
      if (character === "\\") output += source[index += 1] ?? "";
      else if (character === quote) quote = "";
    } else if (character === "\\") {
      const previous = output.at(-1) ?? "";
      if (pendingSpace && output && !tightAfter.includes(previous)) output += " ";
      pendingSpace = false;
      output += character + (source[index += 1] ?? "");
    } else if (character === '"' || character === "'") {
      const previous = output.at(-1) ?? "";
      if (pendingSpace && output && !tightAfter.includes(previous) && !tightBefore.includes(character))
        output += " ";
      pendingSpace = false;
      quote = character;
      output += character;
    } else if (/\s/.test(character)) pendingSpace = true;
    else {
      const previous = output.at(-1) ?? "";
      if (pendingSpace && output && !tightAfter.includes(previous) && !tightBefore.includes(character))
        output += " ";
      pendingSpace = false;
      output += character;
    }
  }
  return trimOptionalSpace(output).trimStart();
}

/** @param {string} value */
function normalizeSelector(value) {
  const source = normalize(value);
  const operators = ["~=", "|=", "^=", "$=", "*=", "="];
  let output = "";
  let quote = "";
  let attribute = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      output += character;
      if (character === "\\") output += source[index += 1] ?? "";
      else if (character === quote) quote = "";
    } else if (character === "\\") {
      output += character + (source[index += 1] ?? "");
    } else if (character === '"' || character === "'") {
      quote = character;
      output += character;
    } else if (character === "[") {
      attribute = true;
      output += character;
    } else if (attribute && character === "]") {
      attribute = false;
      output = `${trimOptionalSpace(output)}]`;
    } else if (attribute) {
      const operator = operators.find((candidate) => source.startsWith(candidate, index));
      if (operator) {
        output = trimOptionalSpace(output) + operator;
        index += operator.length - 1;
        while (source[index + 1] === " ") index += 1;
      } else if (character !== " " || (output.at(-1) !== "[" && output.at(-1) !== " "))
        output += character;
    } else if (">+~".includes(character)) {
      output = trimOptionalSpace(output) + character;
      while (source[index + 1] === " ") index += 1;
    } else output += character;
  }
  return trimOptionalSpace(output).trimStart();
}
/** @param {string} value */
const normalizeValue = (value) => normalize(value, "(),", "(,");
/** @param {string} value */
const normalizeAtRule = (value) => normalize(value, "():", "(:");

/** @param {string} body */
function parseDeclarations(body) {
  return new Map(splitTopLevel(body, ";").flatMap((entry) => {
    const colon = topLevelIndex(entry, ":");
    return colon < 0 ? [] : [[entry.slice(0, colon).trim(), normalizeValue(entry.slice(colon + 1))]];
  }));
}

/** @param {string} body */
function parseDirectDeclarations(body) {
  let direct = "";
  let start = 0;
  let quote = "";
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = "";
    } else if (character === '"' || character === "'") quote = character;
    else if (character === "\\") index += 1;
    else if (character === ";") {
      direct += body.slice(start, index + 1);
      start = index + 1;
    } else if (character === "{") {
      const close = matchingDelimiter(body, index, "{", "}");
      index = close;
      start = close + 1;
    }
  }
  return parseDeclarations(direct + body.slice(start));
}

/** @param {string} source @returns {CssNode[]} */
function parseNodes(source) {
  /** @type {CssNode[]} */
  const nodes = [];
  let start = 0;
  let quote = "";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = "";
    } else if (character === '"' || character === "'") quote = character;
    else if (character === "\\") index += 1;
    else if (character === ";") start = index + 1;
    else if (character === "{") {
      const rawPrelude = source.slice(start, index).trim();
      const close = matchingDelimiter(source, index, "{", "}");
      const body = source.slice(index + 1, close);
      if (rawPrelude) {
        const kind = rawPrelude.startsWith("@") ? "at-rule" : "rule";
        const children = parseNodes(body);
        nodes.push({
          kind,
          prelude: kind === "at-rule" ? normalizeAtRule(rawPrelude) : normalize(rawPrelude),
          selectors: kind === "rule"
            ? splitTopLevel(rawPrelude, ",").map(normalizeSelector) : [],
          declarations: parseDirectDeclarations(body),
          children,
        });
      }
      index = close;
      start = close + 1;
    }
  }
  return nodes;
}

/** @param {string} source */
const parseCss = (source) => parseNodes(stripComments(source));

/** @param {CssNode[]} nodes @returns {CssNode[]} */
const descendants = (nodes) => nodes.flatMap((node) => [node, ...descendants(node.children)]);

/** @param {CssNode[]} nodes @param {string} selector @param {Record<string, string>} expected */
function assertOwnRule(nodes, selector, expected) {
  const normalizedSelector = normalizeSelector(selector);
  const normalizedExpected = Object.entries(expected)
    .map(([property, value]) => [property, normalizeValue(value)]);
  const match = descendants(nodes).find((node) => node.kind === "rule" &&
    node.selectors.includes(normalizedSelector) && normalizedExpected.every(
      ([property, value]) => node.declarations.get(property) === value));
  assert.ok(match, `${selector} must own ${JSON.stringify(expected)}`);
  return match;
}

/** @param {string} value @param {string} token */
function countVariableReferences(value, token) {
  let count = 0;
  let quote = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = "";
    } else if (character === '"' || character === "'") quote = character;
    else if (value.startsWith("var(", index)) {
      const close = matchingDelimiter(value, index + 3, "(", ")");
      const firstArgument = splitTopLevel(value.slice(index + 4, close), ",")[0];
      if (normalize(firstArgument) === token) count += 1;
    }
  }
  return count;
}

/** @param {string} value */
function luminance(value) {
  const channels = (value.slice(1).match(/../g) ?? [])
    .map((channel) => Number.parseInt(channel, 16) / 255);
  return channels.map((channel) => channel <= 0.04045
    ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    .reduce((total, channel, index) => total + channel * [0.2126, 0.7152, 0.0722][index], 0);
}

/** @param {string} foreground @param {string} background */
const contrast = (foreground, background) => {
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
};

test("control border policy derives contrast and token use from parsed CSS declarations", async () => {
  const names = (await readdir(ASSET_ROOT)).filter((name) => name.endsWith(".css")).sort();
  assert.deepEqual(names, CSS_FILES);
  const entries = await Promise.all(CSS_FILES.map(async (name) =>
    /** @type {[string, CssNode[]]} */ ([name, parseCss(await asset(name))])));
  const stylesheets = new Map(entries);
  const tokens = stylesheets.get("tokens.css");
  const core = stylesheets.get("core.css");
  assert.ok(tokens && core, "tokens.css and core.css are required");
  const root = descendants(tokens).find((node) => node.kind === "rule" &&
    node.selectors.length === 1 && node.selectors[0] === ":root");
  assert.ok(root, "tokens.css must have one :root rule");
  const border = root.declarations.get("--color-border-control");
  const surface = root.declarations.get("--color-bg-surface");
  const page = root.declarations.get("--color-bg-page");
  assert.ok(border && surface && page, "all contrast tokens are required");
  for (const [name, value] of Object.entries({ border, surface, page }))
    assert.match(value ?? "", /^#[0-9a-f]{6}$/i, `${name} must be a literal color, not an alias`);
  assert.ok(contrast(border, surface) >= 3, "control border must be 3:1 against the surface token");
  assert.ok(contrast(border, page) >= 3, "control border must be 3:1 against the page token");

  const usageCount = [...stylesheets.values()].reduce((count, nodes) => count +
    descendants(nodes).reduce((subtotal, node) => subtotal +
      [...node.declarations.values()].reduce((uses, value) =>
        uses + countVariableReferences(value, "--color-border-control"), 0), 0), 0);
  assert.equal(usageCount, 1, "the control-border token must have one declaration use across five CSS files");
  const control = assertOwnRule(core, "input", { "border-color": "var(--color-border-control)" });
  assert.deepEqual([...control.selectors].sort(), ["input", "select", "textarea"]);
  assertOwnRule(core, "select", { "padding-inline-end": "var(--space-6)" });
  assertOwnRule(core, 'body > a[href="#main"]', {
    border: "1px solid var(--color-border-default)",
  });
});

test("global layout tokens implement the approved five width classes", async () => {
  const [tokens, core] = await Promise.all([
    asset("tokens.css").then(parseCss),
    asset("core.css").then(parseCss),
  ]);
  const root = descendants(tokens).find((node) => node.kind === "rule" &&
    node.selectors.length === 1 && node.selectors[0] === ":root");
  assert.ok(root);
  for (const [name, value] of Object.entries({
    "--content-reading": "72ch",
    "--content-standard": "1200px",
    "--content-wide": "1440px",
    "--content-main": "var(--content-standard)",
    "--layout-columns": "4",
    "--layout-gutter": "16px",
    "--layout-gap": "16px",
  })) assert.equal(root.declarations.get(name), value, name);

  /** @type {Array<[string, Record<string, string>]>} */
  const widthClasses = [
    ["600px", { "--layout-columns": "8", "--layout-gutter": "24px", "--layout-gap": "24px" }],
    ["840px", { "--layout-columns": "12", "--layout-gutter": "32px", "--layout-gap": "24px" }],
    ["1200px", { "--layout-columns": "12", "--layout-gutter": "32px", "--layout-gap": "24px" }],
    ["1600px", { "--layout-columns": "12", "--layout-gutter": "48px", "--layout-gap": "32px", "--content-main": "var(--content-wide)" }],
  ];
  for (const [width, expected] of widthClasses) {
    const prelude = normalizeAtRule(`@media (min-width: ${width})`);
    const media = descendants(tokens).filter((node) => node.kind === "at-rule" && node.prelude === prelude);
    assert.equal(media.length, 1, width);
    assertOwnRule(media[0].children, ":root", expected);
  }

  assertOwnRule(core, "body", { "min-width": "20rem" });
  assertOwnRule(core, "main", {
    width: "min(calc(100% - (2 * var(--layout-gutter))), var(--content-main))",
  });
  assertOwnRule(core, "main > * + *", { "margin-top": "var(--layout-gap)" });
});

test("typography uses the compact scale while mobile fields stay zoom-safe", async () => {
  const [tokens, core] = await Promise.all([
    asset("tokens.css").then(parseCss),
    asset("core.css").then(parseCss),
  ]);
  const root = descendants(tokens).find((node) => node.kind === "rule" &&
    node.selectors.length === 1 && node.selectors[0] === ":root");
  assert.ok(root);
  for (const [name, value] of Object.entries({
    "--text-sm": "0.75rem",
    "--text-base": "0.875rem",
    "--text-lg": "1.125rem",
    "--text-xl": "clamp(1.625rem,calc(5vw - 0.125rem),2.875rem)",
  })) assert.equal(root.declarations.get(name), value, name);

  const compact = descendants(core).filter((node) => node.kind === "at-rule" &&
    node.prelude === normalizeAtRule("@media (max-width: 599px)"));
  assert.equal(compact.length, 1);
  const fields = assertOwnRule(compact[0].children, "input", { "font-size": "1rem" });
  assert.deepEqual([...fields.selectors].sort(), ["input", "select", "textarea"]);
});

test("capture input and submit button share the medium-width row", async () => {
  const repositories = parseCss(await asset("repositories.css"));
  const medium = descendants(repositories).filter((node) => node.kind === "at-rule" &&
    node.prelude === normalizeAtRule("@media (min-width: 600px)"));
  assert.equal(medium.length, 1);
  assertOwnRule(medium[0].children, "repo-capture > form", {
    "grid-template-columns": "minmax(0, var(--content-reading)) auto",
    "justify-content": "start",
  });
  const spanning = assertOwnRule(medium[0].children, "repo-capture > form > label", {
    "grid-column": "1 / -1",
  });
  assert.deepEqual([...spanning.selectors].sort(), [
    'repo-capture>form>[role="status"]',
    "repo-capture>form>label",
  ]);
});

test("each standalone navigation selector owns its normalized 44px target declarations", async () => {
  assert.equal(
    normalizeSelector(String.raw`[ data-x = foo\]bar ]`),
    normalizeSelector(String.raw`[data-x=foo\]bar]`),
  );
  assert.equal(normalizeSelector(String.raw`[ data-x = foo\ ]`), String.raw`[data-x=foo\ ]`);
  assert.notEqual(
    normalizeSelector(String.raw`[data-x=foo\]bar]`),
    normalizeSelector(String.raw`[data-x=foo\]baz]`),
  );
  for (const [source, expected] of [
    ['[ data-x = "a b" i ]', '[data-x="a b" i]'],
    ["[ data-x ~= foo s ]", "[data-x~=foo s]"],
    ["[ data-x |= foo ]", "[data-x|=foo]"],
    ["[ data-x ^= foo ]", "[data-x^=foo]"],
    ["[ data-x $= foo ]", "[data-x$=foo]"],
    ["[ data-x *= foo ]", "[data-x*=foo]"],
  ]) assert.equal(normalizeSelector(source), expected);
  assert.notEqual(normalizeSelector('[data-x="a b"]'), normalizeSelector('[data-x="a  b"]'));
  const [core, repositories] = await Promise.all([
    asset("core.css").then(parseCss), asset("repositories.css").then(parseCss),
  ]);
  const target = { display: "inline-flex", "align-items": "center", "min-block-size": "2.75rem" };
  assertOwnRule(core, 'body > a[href="#main"]', target);
  for (const selector of [
    "repo-panel article h2 > a",
    'nav[aria-label="페이지"] > a',
    "main > p > a",
    "a[data-repository-detail-link]:not([hidden])",
  ]) assertOwnRule(repositories, selector, target);
});

test("detail and status declarations belong to real rules in the required media subtree", async () => {
  const [tokens, core, login, repositories] = await Promise.all([
    asset("tokens.css").then(parseCss), asset("core.css").then(parseCss),
    asset("login.css").then(parseCss), asset("repositories.css").then(parseCss),
  ]);
  assertOwnRule(login, "main", { "min-height": "100dvh" });
  assertOwnRule(repositories, ".repository-facts > dl", {
    display: "grid",
    "grid-template-columns": "1fr",
  });
  for (const selector of [".repository-facts > dl dt", ".repository-facts > dl dd"])
    assertOwnRule(repositories, selector, {
      padding: "var(--space-3) var(--space-4)",
      "border-top": "1px solid var(--color-border-default)",
      "overflow-wrap": "anywhere",
    });
  assertOwnRule(repositories, ".repository-facts > dl dt", {
    color: "var(--color-text-secondary)", "font-size": "var(--text-sm)", "font-weight": "650",
  });

  assertOwnRule(repositories, ".repository-facts > dl dd", { "padding-top": "0", "border-top": "0" });
  assertOwnRule(repositories, "repo-filter > form", { "grid-template-columns": "1fr" });
  assertOwnRule(repositories, "repo-panel > section", {
    display: "grid", "grid-template-columns": "1fr",
  });
  assertOwnRule(repositories, "repo-panel > section > h2", { "grid-column": "1 / -1" });
  assertOwnRule(repositories,
    "repo-capture [data-capture-status]:has([data-capture-message]:empty)", { display: "none" });
  assertOwnRule(repositories, "repo-panel article dl", {
    "grid-template-columns": "repeat(2, minmax(0, 1fr))",
  });

  /** @type {Array<[string, { filter?: number, gallery: number }]>} */
  const responsiveRules = [
    ["600px", { filter: 2, gallery: 2 }],
    ["840px", { filter: 3, gallery: 3 }],
    ["1200px", { gallery: 5 }],
  ];
  for (const [width, expected] of responsiveRules) {
    const prelude = normalizeAtRule(`@media (min-width: ${width})`);
    const media = descendants(repositories).filter((node) =>
      node.kind === "at-rule" && node.prelude === prelude);
    assert.equal(media.length, 1, width);
    if (expected.filter) assertOwnRule(media[0].children, "repo-filter > form", {
      "grid-template-columns": `repeat(${expected.filter}, minmax(0, 1fr))`,
    });
    assertOwnRule(media[0].children, "repo-panel > section", {
      "grid-template-columns": `repeat(${expected.gallery}, minmax(0, 1fr))`,
    });
    if (width === "840px") {
      assertOwnRule(media[0].children, ".repository-facts > dl", {
        "grid-template-columns": "minmax(7rem, 0.28fr) minmax(0, 1fr)",
      });
      assertOwnRule(media[0].children, ".repository-facts > dl dd", {
        "padding-top": "var(--space-3)",
        "border-top": "1px solid var(--color-border-default)",
      });
    }
  }

  const panel = await asset("repo-panel.js");
  assert.match(panel, /matchMedia\("\(min-width: 840px\)"\)/);
  assert.doesNotMatch(panel, /48rem|768px/);

  for (const [status, color, background] of [
    ["ready", "--color-status-success", "--color-bg-success"],
    ["pending", "--color-status-warning", "--color-bg-warning"],
    ["error", "--color-status-danger", "--color-bg-danger"],
  ]) assertOwnRule(repositories, `[data-analysis-status="${status}"]`, {
    color: `var(${color})`, background: `var(${background})`,
  });

  const root = descendants(tokens).find((node) => node.kind === "rule" &&
    node.selectors.length === 1 && node.selectors[0] === ":root");
  assert.equal(root?.declarations.get("--color-action-danger-hover"), "#7f2624");
  assertOwnRule(core, ".button-danger", {
    background: "var(--color-status-danger)",
    "border-color": "var(--color-status-danger)",
  });
  assertOwnRule(core, ".button-danger:hover", {
    background: "var(--color-action-danger-hover)",
    "border-color": "var(--color-action-danger-hover)",
  });
});
