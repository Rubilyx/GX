import { expect, loginAndSeed, test } from "./fixtures.js";
import { seedThreadsArchive } from "../support/harness.js";

const cases = [
  { width: 320, columns: 4, gutter: 16, gap: 16, filter: 1, gallery: 1, max: 288 },
  { width: 390, columns: 4, gutter: 16, gap: 16, filter: 1, gallery: 1, max: 358 },
  { width: 599, columns: 4, gutter: 16, gap: 16, filter: 1, gallery: 1, max: 567 },
  { width: 600, columns: 8, gutter: 24, gap: 24, filter: 3, gallery: 2, max: 552 },
  { width: 768, columns: 8, gutter: 24, gap: 24, filter: 3, gallery: 2, max: 720 },
  { width: 839, columns: 8, gutter: 24, gap: 24, filter: 3, gallery: 2, max: 791 },
  { width: 840, columns: 12, gutter: 32, gap: 24, filter: 3, gallery: 3, max: 776 },
  { width: 1024, columns: 12, gutter: 32, gap: 24, filter: 3, gallery: 3, max: 960 },
  { width: 1037, height: 1097, columns: 12, gutter: 32, gap: 24, filter: 3, gallery: 3, max: 973 },
  { width: 1317, height: 1379, columns: 12, gutter: 32, gap: 24, filter: 3, gallery: 3, max: 1200 },
  { width: 1389, height: 1379, columns: 12, gutter: 32, gap: 24, filter: 3, gallery: 3, max: 1200 },
  { width: 1440, columns: 12, gutter: 32, gap: 24, filter: 3, gallery: 3, max: 1200 },
  { width: 1920, columns: 12, gutter: 48, gap: 32, filter: 3, gallery: 3, max: 1440 },
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
      const capture = document.querySelector("repo-capture > form");
      const categoryNav = document.querySelector(".category-filter");
      const gallery = document.querySelector("repo-panel > section");
      const title = document.querySelector(".repository-title");
      const avatar = document.querySelector(".repository-avatar");
      const search = document.querySelector("#q");
      const tag = document.querySelector("#tag");
      const tagStyleTarget = tag;
      const submit = document.querySelector('repo-filter > form > button[type="submit"]');
      const header = document.querySelector(".index-header");
      const heading = header?.querySelector("h1");
      const logout = header?.querySelector('form[action="/session/logout"]');
      const captureStatus = document.querySelector("[data-capture-status]");
      const owner = title?.querySelector(".repository-owner");
      const name = title?.querySelector(".repository-name");
      if (!(main instanceof HTMLElement) || !(filter instanceof HTMLElement) ||
          !(capture instanceof HTMLElement) || !(categoryNav instanceof HTMLElement) ||
          !(gallery instanceof HTMLElement) || !(title instanceof HTMLElement) ||
          !(avatar instanceof HTMLImageElement))
        throw new Error("responsive_nodes_missing");
      if (!(search instanceof HTMLInputElement) || !(tag instanceof HTMLSelectElement) ||
          !(tagStyleTarget instanceof HTMLElement) ||
          !(submit instanceof HTMLButtonElement))
        throw new Error("responsive_filter_nodes_missing");
      if (!(header instanceof HTMLElement) || !(heading instanceof HTMLElement) ||
          !(logout instanceof HTMLFormElement) || !(captureStatus instanceof HTMLElement))
        throw new Error("responsive_header_nodes_missing");
      if (!(owner instanceof HTMLElement) || !(name instanceof HTMLElement))
        throw new Error("responsive_repository_title_nodes_missing");
      const card = avatar.closest("article");
      const searchLabel = search.closest("label");
      const tagLabel = tag.closest("label");
      if (!(searchLabel instanceof HTMLLabelElement) ||
          !(tagLabel instanceof HTMLLabelElement) ||
          !(card instanceof HTMLElement))
        throw new Error("responsive_layout_nodes_missing");
      const metadata = card.querySelector(".repository-metadata");
      const badges = [...card.querySelectorAll(".repository-badge")];
      if (!(metadata instanceof HTMLElement) || badges.length === 0)
        throw new Error("responsive_repository_metadata_missing");
      const headerBox = header.getBoundingClientRect();
      const headingBox = heading.getBoundingClientRect();
      const logoutBox = logout.getBoundingClientRect();
      const ownerBox = owner.getBoundingClientRect();
      const nameBox = name.getBoundingClientRect();
      const avatarBox = avatar.getBoundingClientRect();
      const cardBox = card.getBoundingClientRect();
      const metadataBox = metadata.getBoundingClientRect();
      const tagLabelBox = tagLabel.getBoundingClientRect();
      const searchControlBox = search.getBoundingClientRect();
      const tagControlBox = tag.getBoundingClientRect();
      const submitBox = submit.getBoundingClientRect();
      return {
        viewport: innerWidth,
        overflow: document.documentElement.scrollWidth > innerWidth,
        columns: Number(root.getPropertyValue("--layout-columns")),
        gutter: Number.parseFloat(root.getPropertyValue("--layout-gutter")),
        gap: Number.parseFloat(root.getPropertyValue("--layout-gap")),
        main: main.getBoundingClientRect().width,
        captureWidth: capture.getBoundingClientRect().width,
        filter: getComputedStyle(filter).gridTemplateColumns.split(" ").length,
        filterInsideHeader: header.contains(filter),
        gallery: getComputedStyle(gallery).gridTemplateColumns.split(" ").length,
        selectPaddingEnd: Number.parseFloat(getComputedStyle(tagStyleTarget).paddingInlineEnd),
        headingFontSize: Number.parseFloat(getComputedStyle(heading).fontSize),
        searchControlTop: searchControlBox.top,
        tagControlTop: tagControlBox.top,
        tagBottom: tagLabelBox.bottom,
        buttonTop: submitBox.top,
        buttonBottom: submitBox.bottom,
        metadataColumns: getComputedStyle(metadata).gridTemplateColumns.split(" ").length,
        metadataInsideCard: metadataBox.left >= cardBox.left && metadataBox.right <= cardBox.right,
        badgeOverflow: badges.some((badge) => badge.scrollWidth > badge.clientWidth),
        titleDecoration: getComputedStyle(title).textDecorationLine,
        headerRight: headerBox.right,
        headingTop: headingBox.top,
        headingBottom: headingBox.bottom,
        logoutTop: logoutBox.top,
        logoutRight: logoutBox.right,
        captureStatusDisplay: getComputedStyle(captureStatus).display,
        ownerBottom: ownerBox.bottom,
        nameTop: nameBox.top,
        ownerLeft: ownerBox.left,
        nameLeft: nameBox.left,
        avatarWidth: avatarBox.width,
        avatarHeight: avatarBox.height,
        avatarRadius: getComputedStyle(avatar).borderRadius,
        avatarLeft: avatarBox.left,
        avatarRight: avatarBox.right,
        cardLeft: cardBox.left,
        cardRight: cardBox.right,
        filterBottom: filter.getBoundingClientRect().bottom,
        captureTop: capture.getBoundingClientRect().top,
        captureBottom: capture.getBoundingClientRect().bottom,
        categoryTop: categoryNav.getBoundingClientRect().top,
        categoryBottom: categoryNav.getBoundingClientRect().bottom,
        galleryTop: gallery.getBoundingClientRect().top,
        categoryOverflowX: getComputedStyle(categoryNav).overflowX,
      };
    });
    expect(layout).toMatchObject({
      viewport: scenario.width,
      overflow: false,
      columns: scenario.columns,
      gutter: scenario.gutter,
      gap: scenario.gap,
      filter: scenario.filter,
      filterInsideHeader: true,
      gallery: scenario.gallery,
      metadataColumns: 3,
      metadataInsideCard: true,
      badgeOverflow: false,
      titleDecoration: "none",
    });
    expect(layout.selectPaddingEnd).toBeGreaterThanOrEqual(32);
    expect(layout.headingFontSize).toBe(24);
    expect(Math.abs(layout.avatarWidth - 48)).toBeLessThanOrEqual(1);
    expect(Math.abs(layout.avatarHeight - 48)).toBeLessThanOrEqual(1);
    expect(layout.avatarRadius).toBe("50%");
    expect(layout.avatarLeft).toBeGreaterThanOrEqual(layout.cardLeft);
    expect(layout.avatarRight).toBeLessThanOrEqual(layout.cardRight);
    expect(Math.abs(layout.main - scenario.max)).toBeLessThanOrEqual(1);
    const expectedCaptureWidth = scenario.width >= 840 ? layout.main * 0.6 : layout.main;
    expect(Math.abs(layout.captureWidth - expectedCaptureWidth)).toBeLessThanOrEqual(1);
    expect(Math.abs(layout.logoutRight - layout.headerRight)).toBeLessThanOrEqual(1);
    expect(layout.captureStatusDisplay).toBe("none");
    expect(layout.filterBottom).toBeLessThanOrEqual(layout.captureTop);
    expect(layout.captureBottom).toBeLessThanOrEqual(layout.categoryTop);
    expect(layout.categoryBottom).toBeLessThanOrEqual(layout.galleryTop);
    expect(layout.categoryOverflowX).toBe("auto");
    expect(layout.nameTop).toBeGreaterThanOrEqual(layout.ownerBottom);
    expect(Math.abs(layout.nameLeft - layout.ownerLeft)).toBeLessThanOrEqual(1);
    if (scenario.width >= 600)
      expect(Math.abs(layout.buttonBottom - layout.tagBottom)).toBeLessThanOrEqual(1);
    if (scenario.width >= 840) {
      expect(Math.abs(layout.searchControlTop - layout.tagControlTop)).toBeLessThanOrEqual(1);
      expect(Math.abs(layout.searchControlTop - layout.headingTop)).toBeLessThanOrEqual(1);
    } else if (scenario.width < 600) {
      expect(layout.buttonTop).toBeGreaterThanOrEqual(layout.tagBottom);
    }
    if (scenario.width < 840)
      expect(layout.searchControlTop).toBeGreaterThanOrEqual(layout.headingBottom);
    if (scenario.width < 600) expect(layout.logoutTop).toBeGreaterThan(layout.headingBottom);
    else expect(Math.abs(layout.logoutTop - layout.headingTop)).toBeLessThanOrEqual(1);
  }
});

test("Threads media and actions remain usable without overflow at 360px and 840px", async ({
  page, harness,
}) => {
  test.skip(test.info().project.name !== "chromium", "canonical Threads geometry uses Chromium");
  const env = await harness.remoteWorker.getEnv();
  const postId = "31111111-1111-4111-8111-111111111111";
  const rootId = "32222222-2222-4222-8222-222222222222";
  await seedThreadsArchive(env.PROD_DB, {
    id: postId, rootEntryId: rootId, authorId: "34567", username: "responsive",
    displayName: "Responsive Author", shortcode: "ResponsiveMedia",
    threadsMediaId: "responsive-root", rootMediaType: "CAROUSEL_ALBUM",
    submittedUrl: "https://www.threads.com/@responsive/post/ResponsiveMedia",
    canonicalUrl: "https://www.threads.com/@responsive/post/ResponsiveMedia",
    rootPermalink: "https://www.threads.com/@responsive/post/ResponsiveMedia",
  });
  const media = [
    { id: "33333333-3333-4333-8333-333333333333", source: "responsive-image", kind: "image", ordinal: 0, type: "image/jpeg", body: "image" },
    { id: "34444444-4444-4444-8444-444444444444", source: "responsive-video", kind: "video", ordinal: 1, type: "video/mp4", body: "video" },
    { id: "35555555-5555-4555-8555-555555555555", source: "responsive-video", kind: "video_thumbnail", ordinal: 1, type: "image/jpeg", body: "thumb" },
  ];
  for (const item of media) {
    const key = `threads/responsive/${item.id}`;
    const stored = await env.THREADS_MEDIA.put(key, new Blob([item.body]), {
      httpMetadata: { contentType: item.type },
    });
    await env.PROD_DB.prepare(
      `INSERT INTO threads_media
         (id, entry_id, source_media_id, kind, ordinal, status, r2_key,
          content_type, bytes, etag, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?, 1, 1)`,
    ).bind(
      item.id, rootId, item.source, item.kind, item.ordinal, key, item.type,
      item.body.length, stored.httpEtag,
    ).run();
  }
  await loginAndSeed(page);
  await page.goto(`/threads/${postId}`);
  for (const [width, columns] of [[360, 1], [840, 2]]) {
    await page.setViewportSize({ width, height: 900 });
    const geometry = await page.evaluate(() => {
      const gallery = document.querySelector(".thread-media");
      const video = document.querySelector("video");
      const actions = [...document.querySelectorAll(
        ".thread-actions button, [data-thread-delete] > summary",
      )];
      if (!(gallery instanceof HTMLElement) || !(video instanceof HTMLVideoElement) ||
        actions.some((item) => !(item instanceof HTMLElement)))
        throw new Error("threads_responsive_nodes_missing");
      const videoBox = video.getBoundingClientRect();
      return {
        overflow: document.documentElement.scrollWidth > innerWidth,
        columns: getComputedStyle(gallery).gridTemplateColumns.split(" ").length,
        videoHeight: videoBox.height, videoLeft: videoBox.left, videoRight: videoBox.right,
        minimumAction: Math.min(...actions.map((item) => item.getBoundingClientRect().height)),
      };
    });
    expect(geometry.overflow).toBe(false);
    expect(geometry.columns).toBe(columns);
    expect(geometry.videoHeight).toBeGreaterThanOrEqual(44);
    expect(geometry.videoLeft).toBeGreaterThanOrEqual(0);
    expect(geometry.videoRight).toBeLessThanOrEqual(width);
    expect(geometry.minimumAction).toBeGreaterThanOrEqual(44);
  }
});
