import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { parseCspReport, parseTelemetry, recordTelemetry } from "../../src/telemetry.js";

test("accepts only exact bucketed RUM payloads", () => {
  assert.deepEqual(parseTelemetry({
    eventType: "web_vital", metricName: "LCP", value: 2_100,
  }, "/", "release-1"), {
    releaseId: "release-1", routeTemplate: "/", eventType: "web_vital",
    metricName: "LCP", valueBucket: "good", dimension: "none",
  });
  assert.deepEqual(parseTelemetry({
    eventType: "web_vital", metricName: "LCP", value: 2_501,
  }, "/repositories/:id", "release-1").valueBucket, "needs-improvement");
  assert.deepEqual(parseTelemetry({
    eventType: "navigation", metricName: "navigation_duration", value: 321,
  }, "/repositories/:id/notes", "release-1"), {
    releaseId: "release-1", routeTemplate: "/repositories/:id/notes",
    eventType: "navigation", metricName: "navigation_duration",
    valueBucket: "300-999", dimension: "none",
  });
  assert.equal(parseTelemetry({
    eventType: "navigation", metricName: "navigation_duration", value: 321,
  }, "/threads/:id", "release-1").routeTemplate, "/threads/:id");
  assert.equal(parseTelemetry({
    eventType: "web_vital", metricName: "LCP", value: 4_001,
  }, "/", "release-1").valueBucket, "poor");
  assert.equal(parseTelemetry({
    eventType: "web_vital", metricName: "INP", value: 200,
  }, "/", "release-1").valueBucket, "good");
  assert.equal(parseTelemetry({
    eventType: "web_vital", metricName: "INP", value: 500,
  }, "/", "release-1").valueBucket, "needs-improvement");
  assert.equal(parseTelemetry({
    eventType: "web_vital", metricName: "CLS", value: 0.251,
  }, "/", "release-1").valueBucket, "poor");

  for (const invalid of [
    { eventType: "web_vital", metricName: "LCP", value: -1 },
    { eventType: "web_vital", metricName: "LCP", value: Number.NaN },
    { eventType: "web_vital", metricName: "none", value: 1 },
    { eventType: "unknown", metricName: "none", value: 0 },
    { eventType: "client_error", metricName: "none", value: 0, code: "other", stack: "private" },
  ]) assert.throws(() => parseTelemetry(invalid, "/", "release-1"), /invalid_telemetry/);
  assert.throws(() => parseTelemetry({
    eventType: "navigation", metricName: "navigation_duration", value: 1,
  }, "/private", "release-1"), /invalid_telemetry/);

  const inherited = Object.create({
    eventType: "navigation", metricName: "navigation_duration", value: 123,
  });
  assert.throws(() => parseTelemetry(inherited, "/", "release-1"), /invalid_telemetry/);
});

test("requires telemetry and CSP structural fields to be own properties", () => {
  const inherited = {
    eventType: "navigation", metricName: "navigation_duration", value: 123,
    "violated-directive": "worker-src", "blocked-uri": "https://evil.example/private",
    "document-uri": "https://production.repo-atlas.test/",
  };
  for (const [name, value] of Object.entries(inherited)) Object.defineProperty(
    Object.prototype, name, { configurable: true, value },
  );
  try {
    assert.throws(() => parseTelemetry({}, "/", "release-1"), /invalid_telemetry/);
    assert.throws(() => parseCspReport({ "csp-report": {} }, "/", "release-1"),
      /invalid_csp_report/);
  } finally {
    for (const name of Object.keys(inherited)) Reflect.deleteProperty(Object.prototype, name);
  }
});

test("buckets navigation durations and reduces client errors to fixed codes", () => {
  const durations = [
    [99, "<100"], [100, "100-299"], [299, "100-299"], [300, "300-999"],
    [999, "300-999"], [1_000, "1000-2999"], [2_999, "1000-2999"], [3_000, ">=3000"],
  ];
  for (const [value, bucket] of durations) assert.equal(parseTelemetry({
    eventType: "navigation", metricName: "navigation_duration", value,
  }, "/login", "release-1").valueBucket, bucket);

  assert.deepEqual(parseTelemetry({
    eventType: "client_error", metricName: "none", value: 0, code: "network_error",
  }, "/", "release-1"), {
    releaseId: "release-1", routeTemplate: "/", eventType: "client_error",
    metricName: "none", valueBucket: "none", dimension: "network_error",
  });
  assert.equal(parseTelemetry({
    eventType: "client_error", metricName: "none", value: 0, code: "future-browser-code",
  }, "/", "release-1").dimension, "other");
  assert.throws(() => parseTelemetry({
    eventType: "client_error", metricName: "none", value: 1, code: "other",
  }, "/", "release-1"), /invalid_telemetry/);
});

test("reduces legacy and Reporting API CSP reports without returning private URLs", () => {
  const legacy = {
    "csp-report": {
      "violated-directive": "script-src-elem",
      "blocked-uri": "https://evil.example/private/path?token=secret",
      "document-uri": "https://production.repo-atlas.test/repositories/private-id",
      "source-file": "https://production.repo-atlas.test/private.js",
      "line-number": 123,
    },
  };
  assert.deepEqual(parseCspReport(legacy, "/repositories/:id", "release-1"), {
    releaseId: "release-1", routeTemplate: "/repositories/:id",
    eventType: "csp_violation", metricName: "none", valueBucket: "none",
    dimension: "script-src-elem:other",
  });
  assert.doesNotMatch(JSON.stringify(parseCspReport(legacy, "/repositories/:id", "release-1")),
    /private|token|evil\.example/);

  const modern = [{
    type: "csp-violation",
    body: {
      effectiveDirective: "connect-src",
      blockedURL: "https://api.github.com/repos/private",
      documentURL: "https://production.repo-atlas.test/",
      sample: "private source",
    },
  }];
  assert.equal(parseCspReport(modern, "/", "release-1").dimension, "connect-src:github");
  assert.equal(parseCspReport({
    "csp-report": {
      "violated-directive": "img-src",
      "blocked-uri": "https://production.repo-atlas.test/assets/private.png",
      "document-uri": "https://production.repo-atlas.test/",
    },
  }, "/", "release-1").dimension, "img-src:self");
  assert.equal(parseCspReport({
    "csp-report": {
      "violated-directive": "media-src",
      "blocked-uri": "https://production.repo-atlas.test/threads/private/media/private",
      "document-uri": "https://production.repo-atlas.test/threads/private",
    },
  }, "/threads/:id", "release-1").dimension, "media-src:self");
  assert.equal(parseCspReport({
    "csp-report": {
      "violated-directive": "connect-src",
      "blocked-uri": "https://api.openai.com/v1/private",
      "document-uri": "https://production.repo-atlas.test/",
    },
  }, "/", "release-1").dimension, "connect-src:openai");
  for (const [directive, blocked, origin] of [
    ["style-src-elem", "https://production.repo-atlas.test/private", "self"],
    ["script-src-attr", "https://api.github.com/private", "github"],
    ["font-src", "https://api.openai.com/private", "openai"],
    ["worker-src", "https://evil.example/private", "other"],
  ]) {
    assert.equal(parseCspReport({
      "csp-report": {
        "violated-directive": directive,
        "blocked-uri": blocked,
        "document-uri": "https://production.repo-atlas.test/",
      },
    }, "/", "release-1").dimension, `other:${origin}`);
  }
  assert.throws(() => parseCspReport({
    "csp-report": {
      "blocked-uri": "https://evil.example/",
      "document-uri": "https://production.repo-atlas.test/",
    },
  }, "/", "release-1"), /invalid_csp_report/);
  assert.throws(() => parseCspReport({
    "csp-report": {
      "violated-directive": 7, "blocked-uri": "https://evil.example/",
      "document-uri": "https://production.repo-atlas.test/",
    },
  }, "/", "release-1"), /invalid_csp_report/);
  assert.throws(() => parseCspReport([], "/", "release-1"), /invalid_csp_report/);
});

test("recordTelemetry accepts only exact safe aggregates and timestamps", async () => {
  const event = {
    releaseId: "release-1", routeTemplate: "/", eventType: "navigation",
    metricName: "navigation_duration", valueBucket: "100-299", dimension: "none",
  };
  const db = /** @type {any} */ ({
    prepare() { return { bind() { return this; } }; },
    batch() { return Promise.resolve([{ success: true }, { success: true }]); },
  });
  await recordTelemetry(db, event, 1_786_233_600);
  for (const now of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
    await assert.rejects(recordTelemetry(db, event, now), /invalid_telemetry/);
  }
  for (const invalid of [
    { ...event, privateUrl: "https://github.com/private" },
    { ...event, routeTemplate: "/private" },
    { ...event, eventType: "private-event" },
    Object.assign(Object.create({ releaseId: "release-1" }), {
      routeTemplate: "/", eventType: "navigation", metricName: "navigation_duration",
      valueBucket: "100-299", dimension: "none",
    }),
  ]) await assert.rejects(recordTelemetry(db, invalid, 1_786_233_600), /invalid_telemetry/);

  const rejecting = /** @type {any} */ ({
    ...db, batch() { return Promise.reject(new Error("private")); },
  });
  await assert.rejects(recordTelemetry(rejecting, event, 1_786_233_600), /private/);
  const unsuccessful = /** @type {any} */ ({ ...db, batch() {
    return Promise.resolve([{ success: true }, { success: false }]);
  } });
  await assert.rejects(recordTelemetry(unsuccessful, event, 1_786_233_600),
    /telemetry_storage_unavailable/);
});

test("recordTelemetry rejects non-four-digit UTC days before SQL", async () => {
  let batchCalls = 0;
  const db = /** @type {any} */ ({
    prepare() { return { bind() { return this; } }; },
    batch() { batchCalls += 1; return Promise.resolve([{ success: true }, { success: true }]); },
  });
  await assert.rejects(recordTelemetry(db, {
    releaseId: "release-1", routeTemplate: "/", eventType: "navigation",
    metricName: "navigation_duration", valueBucket: "100-299", dimension: "none",
  }, 253_402_300_800), /invalid_telemetry/);
  assert.equal(batchCalls, 0);
});

test("recordTelemetry rejects CSP dimensions with empty or extra segments before SQL", async () => {
  let batchCalls = 0;
  const db = /** @type {any} */ ({
    prepare() { return { bind() { return this; } }; },
    batch() { batchCalls += 1; return Promise.resolve([{ success: true }, { success: true }]); },
  });
  const event = {
    releaseId: "release-1", routeTemplate: "/", eventType: "csp_violation",
    metricName: "none", valueBucket: "none", dimension: "script-src:self",
  };
  for (const dimension of [
    "script-src:self::private-token", "script-src:self:", "script-src:self::...", ":self",
  ]) await assert.rejects(recordTelemetry(db, { ...event, dimension }, 1_786_233_600),
    /invalid_telemetry/);
  assert.equal(batchCalls, 0);
});

/** @type {Map<string, PropertyDescriptor | undefined>} */
const originalDescriptors = new Map();
/** @param {string} name @param {any} value */
function replaceGlobal(name, value) {
  if (!originalDescriptors.has(name)) originalDescriptors.set(name,
    Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

afterEach(() => {
  for (const [name, descriptor] of originalDescriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  originalDescriptors.clear();
});

test("browser telemetry computes bounded vitals and flushes observers exactly once", async () => {
  class ElementStub {}
  class ObserverStub {
    /** @type {ObserverStub[]} */ static instances = [];
    /** @param {(list: { getEntries(): any[] }) => void} callback */
    constructor(callback) {
      this.callback = callback; this.pending = /** @type {any[]} */ ([]); this.disconnects = 0;
      ObserverStub.instances.push(this);
    }
    /** @param {{ type: string, buffered?: boolean, durationThreshold?: number }} options */
    observe(options) { this.type = options.type; this.options = { ...options }; }
    takeRecords() { const records = this.pending; this.pending = []; return records; }
    disconnect() { this.disconnects += 1; }
  }
  /** @type {Array<[string, Blob]>} */
  const beacons = [];
  const browser = /** @type {EventTarget & Record<string, any>} */ (new EventTarget());
  const page = /** @type {EventTarget & Record<string, any>} */ (new EventTarget());
  page.visibilityState = "visible";
  browser.navigator = {
    /** @param {string} path @param {Blob} body */
    sendBeacon(path, body) { beacons.push([path, body]); return true; },
  };
  browser.performance = { getEntriesByType: () => [{ duration: 321 }] };
  browser.PerformanceObserver = ObserverStub;
  browser.document = page;
  replaceGlobal("window", browser);
  replaceGlobal("document", page);
  replaceGlobal("HTMLElement", ElementStub);
  replaceGlobal("customElements", { get: () => undefined, define() {} });

  await import(`../../public/assets/app.js?telemetry-test=${Date.now()}`);
  browser.dispatchEvent(new Event("pageshow"));
  browser.dispatchEvent(new Event("pageshow"));
  /** @param {string} type */
  const observer = (type) => {
    const found = ObserverStub.instances.find((item) => item.type === type);
    assert.ok(found);
    return found;
  };
  assert.deepEqual(observer("event").options,
    { type: "event", buffered: true, durationThreshold: 16 });
  observer("largest-contentful-paint").callback({ getEntries: () => [
    { startTime: 2_100 }, { startTime: Number.POSITIVE_INFINITY },
  ] });
  observer("layout-shift").callback({ getEntries: () => [
    { startTime: 0, value: 0.4, hadRecentInput: false },
    { startTime: 500, value: 0.3, hadRecentInput: false },
    { startTime: 1_500, value: 0.4, hadRecentInput: false },
    { startTime: 2_400, value: 0.02, hadRecentInput: false },
    { startTime: 3_300, value: 0.02, hadRecentInput: false },
    { startTime: 4_200, value: 0.02, hadRecentInput: false },
    { startTime: 5_100, value: 0.02, hadRecentInput: false },
    { startTime: 6_000, value: 0.02, hadRecentInput: false },
    { startTime: 6_500, value: 0.25, hadRecentInput: false },
    { startTime: 6_600, value: Number.POSITIVE_INFINITY, hadRecentInput: false },
    { startTime: 6_700, value: 9, hadRecentInput: true },
  ] });
  observer("layout-shift").pending = [
    { startTime: 6_900, value: 0.35, hadRecentInput: false },
  ];
  const interactions = Array.from({ length: 50 }, (_, index) => ({
    interactionId: index + 1, duration: index === 0 ? 1_300 : index === 1 ? 900 : 100,
  }));
  interactions.push({ interactionId: 2, duration: 200 });
  observer("event").pending = interactions;
  browser.dispatchEvent(Object.assign(new Event("error"), {
    message: "private-message", filename: "private-file", error: { stack: "private-stack" },
  }));
  browser.dispatchEvent(Object.assign(new Event("unhandledrejection"), {
    reason: "private-reason",
  }));
  page.visibilityState = "hidden";
  page.dispatchEvent(new Event("visibilitychange"));
  const countAfterFlush = beacons.length;
  let staleReads = 0;
  observer("layout-shift").callback({ getEntries: () => {
    staleReads += 1;
    return [{ startTime: 7_000, value: 8, hadRecentInput: false }];
  } });
  page.dispatchEvent(new Event("visibilitychange"));

  assert.equal(beacons.length, countAfterFlush);
  assert.equal(staleReads, 0);
  assert.equal(ObserverStub.instances.every((item) => item.disconnects === 1), true);
  assert.equal(beacons.every(([, blob]) => blob.type === "application/json"), true);
  const sent = await Promise.all(beacons.map(async ([path, blob]) => [path, JSON.parse(await blob.text())]));
  assert.deepEqual(sent.map(([path]) => path), Array(sent.length).fill("/telemetry"));
  assert.deepEqual(sent.map(([, event]) => event), [
    { eventType: "navigation", metricName: "navigation_duration", value: 321 },
    { eventType: "client_error", metricName: "none", value: 0, code: "other" },
    { eventType: "client_error", metricName: "none", value: 0, code: "other" },
    { eventType: "web_vital", metricName: "LCP", value: 2_100 },
    { eventType: "web_vital", metricName: "CLS", value: 0.7 },
    { eventType: "web_vital", metricName: "INP", value: 900 },
  ]);
  assert.doesNotMatch(JSON.stringify(sent), /private|message|filename|stack|reason|Infinity/);
});

/** @param {number} count */
async function collectInp(count) {
  class ElementStub {}
  class ObserverStub {
    /** @type {ObserverStub[]} */ static instances = [];
    /** @param {(list: { getEntries(): any[] }) => void} callback */
    constructor(callback) { this.callback = callback; ObserverStub.instances.push(this); }
    /** @param {{ type: string }} options */
    observe(options) { this.type = options.type; }
    takeRecords() { return this.type === "event" ? Array.from({ length: count }, (_, index) => ({
      interactionId: index + 1,
      duration: index === 0 ? 1_200 : index === 1 ? 900 : index === 2 ? 700 : 100,
    })) : []; }
    disconnect() {}
  }
  /** @type {Array<[string, Blob]>} */
  const beacons = [];
  const browser = /** @type {EventTarget & Record<string, any>} */ (new EventTarget());
  const page = /** @type {EventTarget & Record<string, any>} */ (new EventTarget());
  page.visibilityState = "visible";
  browser.navigator = {
    /** @param {string} path @param {Blob} body */
    sendBeacon(path, body) { beacons.push([path, body]); return true; },
  };
  browser.performance = { getEntriesByType: () => [] };
  browser.PerformanceObserver = ObserverStub;
  browser.document = page;
  replaceGlobal("window", browser);
  replaceGlobal("document", page);
  replaceGlobal("HTMLElement", ElementStub);
  replaceGlobal("customElements", { get: () => undefined, define() {} });
  await import(`../../public/assets/app.js?inp-boundary=${count}-${Date.now()}`);
  page.visibilityState = "hidden";
  page.dispatchEvent(new Event("visibilitychange"));
  return Promise.all(beacons.map(async ([, blob]) => JSON.parse(await blob.text())));
}

test("INP selects the required candidate at forty-nine and one hundred interactions", async () => {
  assert.deepEqual(await collectInp(49), [
    { eventType: "web_vital", metricName: "INP", value: 1_200 },
  ]);
  assert.deepEqual(await collectInp(100), [
    { eventType: "web_vital", metricName: "INP", value: 700 },
  ]);
});

test("CLS remains finite when finite session values overflow", async () => {
  class ElementStub {}
  class ObserverStub {
    /** @type {ObserverStub[]} */ static instances = [];
    /** @param {(list: { getEntries(): any[] }) => void} callback */
    constructor(callback) { this.callback = callback; ObserverStub.instances.push(this); }
    /** @param {{ type: string }} options */ observe(options) { this.type = options.type; }
    takeRecords() { return this.type === "layout-shift" ? [
      { startTime: 0, value: Number.MAX_VALUE, hadRecentInput: false },
      { startTime: 1, value: Number.MAX_VALUE, hadRecentInput: false },
    ] : []; }
    disconnect() {}
  }
  /** @type {Array<[string, Blob]>} */
  const beacons = [];
  const browser = /** @type {EventTarget & Record<string, any>} */ (new EventTarget());
  const page = /** @type {EventTarget & Record<string, any>} */ (new EventTarget());
  page.visibilityState = "visible";
  browser.navigator = {
    /** @param {string} path @param {Blob} body */
    sendBeacon(path, body) { beacons.push([path, body]); return true; },
  };
  browser.performance = { getEntriesByType: () => [] };
  browser.PerformanceObserver = ObserverStub;
  browser.document = page;
  replaceGlobal("window", browser);
  replaceGlobal("document", page);
  replaceGlobal("HTMLElement", ElementStub);
  replaceGlobal("customElements", { get: () => undefined, define() {} });
  await import(`../../public/assets/app.js?cls-overflow=${Date.now()}`);
  page.visibilityState = "hidden";
  page.dispatchEvent(new Event("visibilitychange"));
  const payloads = await Promise.all(beacons.map(async ([, blob]) => JSON.parse(await blob.text())));
  assert.deepEqual(payloads, [
    { eventType: "web_vital", metricName: "CLS", value: Number.MAX_VALUE },
  ]);
});
