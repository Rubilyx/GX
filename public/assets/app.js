import "./repo-capture.js";
import "./repo-filter.js";
import "./repo-panel.js";
import "./thread-capture.js";
import "./thread-panel.js";

if (typeof window !== "undefined") {
  /** @param {{ eventType: string, metricName: string, value: number, code?: string }} event */
  const send = (event) => {
    if (typeof window.navigator?.sendBeacon !== "function") return;
    /** @type {{ eventType: string, metricName: string, value: number, code?: string }} */
    const payload = { eventType: event.eventType, metricName: event.metricName, value: event.value };
    if (typeof event.code === "string") payload.code = event.code;
    const body = new Blob([JSON.stringify(payload)], { type: "application/json" });
    window.navigator.sendBeacon("/telemetry", body);
  };

  let navigationSent = false;
  window.addEventListener("pageshow", () => {
    if (navigationSent) return;
    const entry = window.performance?.getEntriesByType("navigation")[0];
    if (entry && Number.isFinite(entry.duration) && entry.duration >= 0) {
      send({ eventType: "navigation", metricName: "navigation_duration", value: entry.duration });
      navigationSent = true;
    }
  });

  /** @type {number | null} */
  let lcp = null;
  let clsMaximum = 0;
  let clsWindowValue = 0;
  /** @type {number | null} */
  let clsWindowStart = null;
  /** @type {number | null} */
  let clsLastEntry = null;
  let hasCls = false;
  /** @type {Map<number, number>} */
  const interactions = new Map();
  let flushed = false;
  /** @type {Array<{ observer: PerformanceObserver, collect: (entries: any[]) => void }>} */
  const observations = [];
  /** @param {string} type @param {(entries: any[]) => void} collect */
  const observe = (type, collect) => {
    if (typeof window.PerformanceObserver !== "function") return;
    try {
      const observer = new window.PerformanceObserver((list) => {
        if (!flushed) collect(list.getEntries());
      });
      const options = type === "event"
        ? { type, buffered: true, durationThreshold: 16 }
        : { type, buffered: true };
      observer.observe(options);
      observations.push({ observer, collect });
    } catch {}
  };
  observe("largest-contentful-paint", (entries) => {
    for (const entry of entries)
      if (Number.isFinite(entry.startTime) && entry.startTime >= 0)
        lcp = Math.max(lcp ?? 0, entry.startTime);
  });
  observe("layout-shift", (entries) => {
    for (const entry of entries) {
      if (entry.hadRecentInput || !Number.isFinite(entry.startTime) || entry.startTime < 0 ||
        !Number.isFinite(entry.value) || entry.value < 0) continue;
      const inWindow = clsWindowStart !== null && clsLastEntry !== null &&
        entry.startTime - clsLastEntry < 1_000 && entry.startTime - clsWindowStart < 5_000;
      const nextValue = inWindow ? clsWindowValue + entry.value : entry.value;
      if (!Number.isFinite(nextValue)) continue;
      if (!inWindow) clsWindowStart = entry.startTime;
      clsLastEntry = entry.startTime;
      clsWindowValue = nextValue;
      clsMaximum = Math.max(clsMaximum, clsWindowValue);
      hasCls = true;
    }
  });
  observe("event", (entries) => {
    for (const entry of entries) {
      if (!Number.isInteger(entry.interactionId) || entry.interactionId <= 0 ||
        !Number.isFinite(entry.duration) || entry.duration < 0) continue;
      interactions.set(
        entry.interactionId,
        Math.max(interactions.get(entry.interactionId) ?? 0, entry.duration),
      );
    }
  });

  window.addEventListener("error", () => send({
    eventType: "client_error", metricName: "none", value: 0, code: "other",
  }));
  window.addEventListener("unhandledrejection", () => send({
    eventType: "client_error", metricName: "none", value: 0, code: "other",
  }));
  window.document.addEventListener("visibilitychange", () => {
    if (window.document.visibilityState !== "hidden" || flushed) return;
    flushed = true;
    for (const { observer, collect } of observations) {
      try {
        if (typeof observer.takeRecords === "function") collect(observer.takeRecords());
      } catch {}
      try { observer.disconnect(); } catch {}
    }
    if (lcp !== null) send({ eventType: "web_vital", metricName: "LCP", value: lcp });
    if (hasCls) send({ eventType: "web_vital", metricName: "CLS", value: clsMaximum });
    const candidates = [...interactions.values()].sort((left, right) => right - left);
    const inp = candidates[Math.floor(candidates.length / 50)];
    if (inp !== undefined) send({ eventType: "web_vital", metricName: "INP", value: inp });
  });
}
