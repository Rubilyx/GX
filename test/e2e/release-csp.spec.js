import { expect, test } from "@playwright/test";

test.use({ trace: "off", screenshot: "off", video: "off", extraHTTPHeaders: {}, ignoreHTTPSErrors: false });

function releaseConfig() {
  const { RELEASE_BASE_URL: rawBase, RELEASE_ID: releaseId } = process.env;
  if (!rawBase && !releaseId) return null;
  if (!rawBase || !releaseId) throw new Error("release_csp_config_partial");
  let base;
  try { base = new URL(rawBase); }
  catch { throw new Error("release_base_url_invalid"); }
  if (base.protocol !== "https:" || base.username || base.password ||
      base.pathname !== "/" || base.search || base.hash || !/^[0-9a-f]{40}$/.test(releaseId))
    throw new Error("release_csp_config_invalid");
  return { base, releaseId };
}

test("browser policy violation records one known redacted CSP tuple", async ({ page, request }) => {
  const release = releaseConfig();
  test.skip(!release);
  if (!release) return;
  const health = await request.get(new URL("/health", release.base).href);
  expect(health.status()).toBe(200);
  expect(await health.json()).toEqual({ status: "ok", releaseId: release.releaseId });
  const navigation = await page.goto(new URL("/login", release.base).href);
  expect(navigation?.headers()["content-security-policy"]).toContain("report-uri /csp-report");
  await page.evaluate(() => {
    const script = document.createElement("script");
    script.src = "/__repo_atlas_csp_probe__.js";
    document.head.appendChild(script);
  });
  await page.waitForTimeout(1_000);
});
