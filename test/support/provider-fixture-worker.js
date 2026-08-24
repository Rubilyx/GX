const metadata = {
  id: 9007199254740000, owner: { login: "OpenAI" }, name: "example",
  html_url: "https://github.com/OpenAI/example", description: "Example repository",
  homepage: null, default_branch: "main", language: "JavaScript",
  stargazers_count: 10, forks_count: 2, license: { spdx_id: "MIT" },
  topics: ["example"], updated_at: "2026-08-09T00:00:00Z",
  pushed_at: "2026-08-08T00:00:00Z",
};
const analysis = {
  summary: "예제 저장소의 핵심 사용법을 보여준다.",
  problem: "작동하는 최소 예제가 필요하다.", values: ["구조가 단순하다."],
  audience: "JavaScript 개발자", cautions: "예제 목적의 저장소다.",
  primaryCategory: "Backend", tags: ["example"],
};
const fields = [
  "id", "media_product_type", "media_type", "media_url", "permalink", "owner",
  "username", "text", "timestamp", "shortcode", "thumbnail_url", "children",
  "is_quote_post", "quoted_post", "link_attachment_url", "alt_text", "root_post",
  "replied_to",
].join(",");
const profileFields = "id,username,name,threads_profile_picture_url";

/** @param {string} id @param {string} shortcode @param {string} [ownerId]
 * @param {Record<string, unknown>} [overrides] */
function threadsMedia(id, shortcode, ownerId = "12345", overrides = {}) {
  return {
    id, media_product_type: "THREADS", media_type: "TEXT_POST",
    permalink: `https://www.threads.com/@${ownerId === "12345" ? "meta" : "other"}/post/${shortcode}`,
    owner: { id: ownerId }, username: ownerId === "12345" ? "meta" : "other",
    text: `Fixture ${id}`, timestamp: "2026-08-24T00:00:00+0000", shortcode,
    ...overrides,
  };
}

const root = threadsMedia("root-1", "RootShort", "12345", {
  media_type: "CAROUSEL_ALBUM",
  text: "Fixture root https://example.com/archive",
  link_attachment_url: "https://example.com/archive",
  alt_text: "보관용 루트 캐러셀",
  children: { data: [{ id: "root-image" }, { id: "root-video" }] },
});
const rootImage = threadsMedia("root-image", "RootImage", "12345", {
  media_type: "IMAGE", media_url: "https://scontent.cdninstagram.com/fixture-image",
  alt_text: "보관용 이미지",
});
const rootVideo = threadsMedia("root-video", "RootVideo", "12345", {
  media_type: "VIDEO", media_url: "https://scontent.cdninstagram.com/fixture-video",
  thumbnail_url: "https://scontent.cdninstagram.com/fixture-thumbnail",
  alt_text: "보관용 비디오",
});
const sharedQuote = threadsMedia("shared-quote", "SharedQuote", "12345", {
  media_type: "IMAGE",
  media_url: "https://scontent.cdninstagram.com/fixture-quote-image",
  text: "한 단계 인용 본문", is_quote_post: true,
  quoted_post: { id: "nested-quote" }, alt_text: "인용 이미지",
});
const nestedQuote = threadsMedia("nested-quote", "NestedQuote", "12345", {
  text: "두 번째 인용은 permalink만 보존",
});
const corruptRoot = threadsMedia("corrupt-root", "CorruptImage", "12345", {
  media_type: "CAROUSEL_ALBUM", text: "Corrupt image with readable video",
  children: { data: [{ id: "corrupt-image" }, { id: "root-video" }] },
});
const corruptImage = threadsMedia("corrupt-image", "CorruptImageMedia", "12345", {
  media_type: "IMAGE", media_url: "https://scontent.cdninstagram.com/fixture-corrupt",
  alt_text: "재시도할 손상 이미지",
});

const authorReplies = Array.from({ length: 13 }, (_, offset) => {
  const number = offset + 1;
  const id = `author-reply-${String(number).padStart(2, "0")}`;
  return threadsMedia(id, `Reply${String(number).padStart(2, "0")}`, "12345", {
    text: `작성자 답글 ${number}`,
    timestamp: `2026-08-24T00:${String(number).padStart(2, "0")}:00+0000`,
    root_post: { id: "root-1" },
    replied_to: { id: number === 1 ? "root-1"
      : `author-reply-${String(number - 1).padStart(2, "0")}` },
    ...(number <= 2 ? {
      is_quote_post: true, quoted_post: { id: "shared-quote" },
    } : {}),
  });
});
const otherReplies = [1, 2].map((number) => threadsMedia(
  `other-reply-${number}`, `OtherReply${number}`, "67890", {
    text: `제외할 다른 사용자 답글 ${number}`,
    timestamp: `2026-08-24T00:${String(number * 4).padStart(2, "0")}:30+0000`,
    root_post: { id: "root-1" }, replied_to: { id: "root-1" },
  },
));
/** @type {Readonly<Record<string, ReturnType<typeof threadsMedia>>>} */
const graphMedia = Object.freeze({
  "root-1": root, "root-image": rootImage, "root-video": rootVideo,
  "shared-quote": sharedQuote, "nested-quote": nestedQuote,
  "corrupt-root": corruptRoot, "corrupt-image": corruptImage,
});
/** @type {Readonly<Record<string, { body: string, contentType: string }>>} */
const mediaBodies = Object.freeze({
  "fixture-avatar": { body: "fixture-avatar-bytes", contentType: "image/jpeg" },
  "fixture-image": { body: "fixture-image-bytes", contentType: "image/jpeg" },
  "fixture-video": { body: "fixture-video-bytes-for-range", contentType: "video/mp4" },
  "fixture-thumbnail": { body: "fixture-thumbnail-bytes", contentType: "image/jpeg" },
  "fixture-quote-image": { body: "fixture-quote-image-bytes", contentType: "image/jpeg" },
});
let conversationStarts = 0;
let corruptDownloads = 0;

/** @param {URL} url @param {string[]} keys */
function exactQuery(url, keys) {
  return [...url.searchParams.keys()].length === keys.length &&
    keys.every((key) => url.searchParams.getAll(key).length === 1);
}
/** @param {Request} request */
function bearer(request) {
  return /^Bearer\s+[^\s]+$/.test(request.headers.get("authorization") ?? "");
}
function unexpected() {
  console.log("provider_fixture:unexpected_request");
  return new Response("provider_fixture_unexpected_request", { status: 502 });
}
/** @param {unknown[]} data @param {string | null} nextCursor */
function threadsPage(data, nextCursor) {
  return nextCursor ? {
    data, paging: {
      next: `https://graph.threads.net/v1.0/root-1/conversation?after=${nextCursor}`,
    },
  } : { data };
}
/** @param {string | null} after */
function conversationPage(after) {
  if (after === null) {
    conversationStarts += 1;
    return threadsPage([...authorReplies.slice(0, 4), otherReplies[0]], "conversation-2");
  }
  if (after === "conversation-2")
    return threadsPage([...authorReplies.slice(4, 8), otherReplies[1]], "conversation-3");
  if (after === "conversation-3") return threadsPage(
    authorReplies.slice(8, conversationStarts >= 2 ? 13 : 12), null,
  );
  return null;
}

export default {
  /** @param {Request} request */
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.origin === "https://api.github.com" &&
      url.pathname === "/repos/OpenAI/example" && !url.search) {
      console.log("provider_fixture:github_metadata"); return Response.json(metadata);
    }
    if (request.method === "GET" && url.origin === "https://api.github.com" &&
      url.pathname === "/repos/OpenAI/example/readme" && url.search === "?ref=main") {
      console.log("provider_fixture:github_readme");
      return new Response("# Example", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    if (request.method === "POST" && url.origin === "https://api.openai.com" &&
      url.pathname === "/v1/responses" && !url.search) {
      console.log("provider_fixture:openai_response");
      return Response.json({ model: "gpt-5.6-terra-test-snapshot", output: [{
        type: "message", content: [{ type: "output_text", text: JSON.stringify(analysis) }],
      }] });
    }
    if (request.method === "GET" && url.origin === "https://www.threads.com" &&
      url.pathname === "/t/RootShort" && !url.search &&
      !request.headers.get("authorization")) {
      console.log("provider_fixture:threads_short_url");
      return new Response(null, { status: 302, headers: {
        Location: "https://www.threads.com/@meta/post/RootShort",
      } });
    }
    if (request.method === "POST" && url.origin === "https://graph.threads.net" &&
      url.pathname === "/v1.0/oauth/access_token" && !url.search &&
      !request.headers.get("authorization")) {
      const form = new URLSearchParams(await request.text());
      if ([...form.keys()].length !== 5 || ![
        "client_id", "client_secret", "grant_type", "redirect_uri", "code",
      ].every((key) => form.getAll(key).length === 1) ||
        form.get("grant_type") !== "authorization_code") return unexpected();
      console.log("provider_fixture:threads_exchange_code");
      return Response.json({ access_token: "short-token", user_id: "author-1" });
    }
    if (request.method === "GET" && url.origin === "https://graph.threads.net" &&
      url.pathname === "/v1.0/access_token" &&
      exactQuery(url, ["grant_type", "client_secret", "access_token"]) &&
      url.searchParams.get("grant_type") === "th_exchange_token" &&
      !request.headers.get("authorization")) {
      console.log("provider_fixture:threads_exchange_long_lived");
      return Response.json({ access_token: "long-token", token_type: "bearer", expires_in: 5_184_000 });
    }
    if (request.method === "GET" && url.origin === "https://graph.threads.net" &&
      url.pathname === "/v1.0/refresh_access_token" &&
      exactQuery(url, ["grant_type", "access_token"]) &&
      url.searchParams.get("grant_type") === "th_refresh_token" &&
      !request.headers.get("authorization")) {
      console.log("provider_fixture:threads_refresh_token");
      return Response.json({ access_token: "refreshed-token", token_type: "bearer", expires_in: 5_184_000 });
    }
    if (request.method === "GET" && url.origin === "https://graph.threads.net" &&
      url.pathname === "/v1.0/debug_token" && exactQuery(url, ["input_token"]) &&
      bearer(request) && request.headers.get("authorization") ===
        `Bearer ${url.searchParams.get("input_token")}`) {
      console.log("provider_fixture:threads_debug_token");
      return Response.json({ data: {
        app_id: "test-threads-app", type: "USER", application: "Repo Atlas",
        user_id: "author-1", data_access_expires_at: 1_999_000_000,
        expires_at: 2_000_000_000, issued_at: 1_900_000_000, is_valid: true,
        scopes: ["threads_basic", "threads_profile_discovery", "threads_read_replies"],
        granular_scopes: [{ scope: "threads_basic" }, {
          scope: "threads_profile_discovery", target_ids: ["author-1"],
        }],
      } });
    }
    if (request.method === "GET" && url.origin === "https://graph.threads.net" &&
      url.pathname === "/v1.0/profile_lookup" &&
      exactQuery(url, ["fields", "username"]) &&
      url.searchParams.get("fields") === profileFields &&
      url.searchParams.get("username") === "meta" && bearer(request)) {
      console.log("provider_fixture:threads_profile");
      return Response.json({
        id: "12345", username: "meta", name: "Meta",
        threads_profile_picture_url: "https://scontent.cdninstagram.com/fixture-avatar",
      });
    }
    if (request.method === "GET" && url.origin === "https://graph.threads.net" &&
      url.pathname === "/v1.0/profile_posts" &&
      exactQuery(url, url.searchParams.has("after")
        ? ["fields", "username", "after"] : ["fields", "username"]) &&
      url.searchParams.get("fields") === fields &&
      url.searchParams.get("username") === "meta" && bearer(request)) {
      const after = url.searchParams.get("after");
      if (after !== null && after !== "cursor-1") return unexpected();
      console.log("provider_fixture:threads_profile_posts");
      return Response.json({ data: after === null ? [root, corruptRoot] : [] });
    }
    const conversationMatch = /^\/v1\.0\/([^/]+)\/conversation$/.exec(url.pathname);
    if (request.method === "GET" && url.origin === "https://graph.threads.net" &&
      conversationMatch && ["root-1", "corrupt-root"].includes(
        decodeURIComponent(conversationMatch[1])) &&
      exactQuery(url, url.searchParams.has("after") ? ["fields", "after"] : ["fields"]) &&
      url.searchParams.get("fields") === fields && bearer(request)) {
      const conversationId = decodeURIComponent(conversationMatch[1]);
      const page = conversationId === "corrupt-root"
        ? url.searchParams.get("after") === null ? { data: [] } : null
        : conversationPage(url.searchParams.get("after"));
      if (!page) return unexpected();
      console.log("provider_fixture:threads_conversation"); return Response.json(page);
    }
    const mediaMatch = /^\/v1\.0\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && url.origin === "https://graph.threads.net" &&
      mediaMatch && exactQuery(url, ["fields"]) &&
      url.searchParams.get("fields") === fields && bearer(request)) {
      const media = graphMedia[decodeURIComponent(mediaMatch[1])];
      if (!media) return unexpected();
      console.log("provider_fixture:threads_media"); return Response.json(media);
    }
    if (request.method === "GET" && url.origin === "https://scontent.cdninstagram.com" &&
      !url.search && !request.headers.get("authorization") && /^\/[^/]+$/.test(url.pathname)) {
      const object = decodeURIComponent(url.pathname.slice(1));
      if (object === "fixture-corrupt") {
        corruptDownloads += 1;
        const body = corruptDownloads === 1 ? "bad" : "good";
        console.log("provider_fixture:threads_media_body");
        return new Response(body, { headers: {
          "Content-Type": "image/jpeg", "Content-Length": "4",
        } });
      }
      const media = mediaBodies[object];
      if (!media) return unexpected();
      console.log("provider_fixture:threads_media_body");
      return new Response(media.body, { headers: {
        "Content-Type": media.contentType,
        "Content-Length": String(new TextEncoder().encode(media.body).byteLength),
      } });
    }
    return unexpected();
  },
};
