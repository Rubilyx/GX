import { expect, loginAndSeed, test } from "./fixtures.js";

const cases = [
  { width: 320, columns: 4, gutter: 16, gap: 16, filter: 1, gallery: 1, max: 288 },
  { width: 390, columns: 4, gutter: 16, gap: 16, filter: 1, gallery: 1, max: 358 },
  { width: 768, columns: 8, gutter: 24, gap: 24, filter: 2, gallery: 2, max: 720 },
  { width: 1024, columns: 12, gutter: 32, gap: 24, filter: 3, gallery: 3, max: 960 },
  { width: 1037, height: 1097, columns: 12, gutter: 32, gap: 24, filter: 3, gallery: 3, max: 973 },
  { width: 1440, columns: 12, gutter: 32, gap: 24, filter: 3, gallery: 5, max: 1200 },
  { width: 1920, columns: 12, gutter: 48, gap: 32, filter: 3, gallery: 5, max: 1440 },
];

test("reference widths use the approved grid without horizontal overflow", async ({ page }) => {
  test.skip(test.info().project.name !== "chromium", "canonical layout metrics use Chromium");
  await loginAndSeed(page);
  for (const scenario of cases) {
    await page.setViewportSize({ width: scenario.width, height: scenario.height ?? 900 });
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(scenario.width);
    const layout = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const main = document.querySelector("main");
      const filter = document.querySelector("repo-filter > form");
      const gallery = document.querySelector("repo-panel > section");
      const title = document.querySelector("[data-repository-link]");
      const select = document.querySelector("repo-filter select");
      const header = document.querySelector(".index-header");
      const heading = header?.querySelector("h1");
      const logout = header?.querySelector('form[action="/session/logout"]');
      const captureStatus = document.querySelector("[data-capture-status]");
      if (!(main instanceof HTMLElement) || !(filter instanceof HTMLElement) ||
          !(gallery instanceof HTMLElement) || !(title instanceof HTMLElement) ||
          !(select instanceof HTMLElement) || !(header instanceof HTMLElement) ||
          !(heading instanceof HTMLElement) || !(logout instanceof HTMLFormElement) ||
          !(captureStatus instanceof HTMLElement)) throw new Error("responsive_header_nodes_missing");
      const headerBox = header.getBoundingClientRect();
      const headingBox = heading.getBoundingClientRect();
      const logoutBox = logout.getBoundingClientRect();
      return {
        viewport: innerWidth,
        overflow: document.documentElement.scrollWidth > innerWidth,
        columns: Number(root.getPropertyValue("--layout-columns")),
        gutter: Number.parseFloat(root.getPropertyValue("--layout-gutter")),
        gap: Number.parseFloat(root.getPropertyValue("--layout-gap")),
        main: main.getBoundingClientRect().width,
        filter: getComputedStyle(filter).gridTemplateColumns.split(" ").length,
        gallery: getComputedStyle(gallery).gridTemplateColumns.split(" ").length,
        selectPaddingEnd: Number.parseFloat(getComputedStyle(select).paddingInlineEnd),
        titleDecoration: getComputedStyle(title).textDecorationLine,
        headerRight: headerBox.right,
        headingTop: headingBox.top,
        headingBottom: headingBox.bottom,
        logoutTop: logoutBox.top,
        logoutRight: logoutBox.right,
        captureStatusDisplay: getComputedStyle(captureStatus).display,
      };
    });
    expect(layout).toMatchObject({
      viewport: scenario.width,
      overflow: false,
      columns: scenario.columns,
      gutter: scenario.gutter,
      gap: scenario.gap,
      filter: scenario.filter,
      gallery: scenario.gallery,
      titleDecoration: "none",
    });
    expect(layout.selectPaddingEnd).toBeGreaterThanOrEqual(24);
    expect(Math.abs(layout.main - scenario.max)).toBeLessThanOrEqual(1);
    expect(Math.abs(layout.logoutRight - layout.headerRight)).toBeLessThanOrEqual(1);
    expect(layout.captureStatusDisplay).toBe("none");
    if (scenario.width < 600) expect(layout.logoutTop).toBeGreaterThan(layout.headingBottom);
    else expect(Math.abs(layout.logoutTop - layout.headingTop)).toBeLessThanOrEqual(1);
  }
});
