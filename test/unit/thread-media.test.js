import assert from "node:assert/strict";
import { test } from "node:test";
import { AppError } from "../../src/domain.js";
import {
  handleThreadsMediaMessage, parseSingleRange,
} from "../../src/thread-media.js";
import {
  downloadThreadsMedia,
} from "../../src/thread-media-download.js";

const ACK = { action: "ack" };

/** @param {Record<string, unknown>} row */
function mediaDb(row) {
  return {
    prepare(/** @type {string} */ sql) {
      return {
        bind() {
          return {
            async first() {
              return String(sql).includes("COUNT(*) AS count") ?
                { count: 1 } : structuredClone(row);
            },
            async run() { return { success: true, meta: { changes: 1 } }; },
          };
        },
      };
    },
  };
}

function rawMedia(overrides = {}) {
  return {
    id: "source-1", media_product_type: "THREADS", media_type: "IMAGE",
    media_url: "https://scontent.cdninstagram.com/object", permalink:
      "https://www.threads.com/@meta/post/SourceOne", owner: { id: "author-1" },
    username: "meta", text: "media", timestamp: "2026-08-24T00:00:00Z",
    shortcode: "SourceOne", ...overrides,
  };
}

/** @param {BodyInit} body @param {ResponseInit} init */
function streamingResponse(body, init) {
  const response = new Response(body, init);
  const forbidden = () => { throw new Error("test_media_body_was_buffered"); };
  for (const name of ["arrayBuffer", "blob", "bytes", "json", "text"])
    Object.defineProperty(response, name, { value: forbidden });
  return response;
}

function recordingBucket() {
  /** @type {Map<string, { bytes: Uint8Array, contentType: string, etag: string }>} */
  const objects = new Map();
  /** @type {string[]} */
  const deleted = [];
  return {
    objects, deleted,
    /** @param {string} key @param {ReadableStream<Uint8Array>} body
     * @param {{ httpMetadata: { contentType: string },
     * onlyIf?: { etagMatches?: string, etagDoesNotMatch?: string } }} options */
    async put(key, body, options) {
      assert.ok(body instanceof ReadableStream);
      const current = objects.get(key);
      if (options.onlyIf?.etagMatches !== undefined &&
        current?.etag !== options.onlyIf.etagMatches) return null;
      if (options.onlyIf?.etagDoesNotMatch === "*" && current) return null;
      const reader = body.getReader();
      /** @type {Uint8Array[]} */
      const chunks = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        assert.ok(value instanceof Uint8Array);
        chunks.push(value); size += value.byteLength;
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      objects.set(key, { bytes, contentType: options.httpMetadata.contentType,
        etag: "unit-etag" });
      return { key, size, etag: "unit-etag", httpEtag: '"unit-etag"' };
    },
    /** @param {string} key */
    async head(key) {
      const object = objects.get(key);
      return object ? { key, size: object.bytes.byteLength, etag: object.etag,
        httpEtag: `"${object.etag}"` } : null;
    },
    /** @param {string} key */
    async delete(key) { deleted.push(key); objects.delete(key); },
  };
}

const knownLength = Symbol("knownLength");

/** @param {() => Promise<void>} run */
async function withFixedLengthStream(run) {
  const globals = /** @type {any} */ (globalThis);
  const previous = globals.FixedLengthStream;
  globals.FixedLengthStream = class extends TransformStream {
    /** @param {number} length */
    constructor(length) {
      let bytes = 0;
      super({
        transform(chunk, controller) {
          bytes += chunk.byteLength;
          if (bytes > length) throw new TypeError("fixed_length_exceeded");
          controller.enqueue(chunk);
        },
        flush() {
          if (bytes !== length) throw new TypeError("fixed_length_mismatch");
        },
      });
      Object.defineProperty(this.readable, knownLength, { value: length });
    }
  };
  try { await run(); }
  finally {
    if (previous === undefined) delete globals.FixedLengthStream;
    else globals.FixedLengthStream = previous;
  }
}

test("declared media keeps a known-length stream while R2 consumes it concurrently", async () => {
  await withFixedLengthStream(async () => {
    let stored = new Uint8Array();
    const result = await downloadThreadsMedia({
      /** @param {string} key @param {ReadableStream<Uint8Array>} body */
      async put(key, body) {
        assert.equal((/** @type {any} */ (body))[knownLength], 4);
        stored = new Uint8Array(await new Response(body).arrayBuffer());
        return { key, size: stored.byteLength, httpEtag: '"fixed"' };
      },
    }, async () => streamingResponse(new Uint8Array([1, 2, 3, 4]), { headers: {
      "Content-Type": "image/jpeg", "Content-Length": "4",
    } }), {
      url: "https://scontent.cdninstagram.com/object", key: "threads/fixed/image",
      expected: new Set(["image/jpeg"]), maximumBytes: 16,
    });
    assert.deepEqual(stored, new Uint8Array([1, 2, 3, 4]));
    assert.deepEqual(result, {
      key: "threads/fixed/image", size: 4, httpEtag: '"fixed"',
      contentType: "image/jpeg",
    });
  });
});

test("a short declared fixed-length stream remains a terminal byte mismatch", async () => {
  await withFixedLengthStream(async () => {
    await assert.rejects(downloadThreadsMedia({
      /** @param {string} key @param {ReadableStream<Uint8Array>} body */
      async put(key, body) {
        await new Response(body).arrayBuffer();
        return { key, size: 3, httpEtag: '"short"' };
      },
    }, async () => streamingResponse(new Uint8Array([1, 2, 3]), { headers: {
      "Content-Type": "image/jpeg", "Content-Length": "4",
    } }), {
      url: "https://scontent.cdninstagram.com/object", key: "threads/fixed/short",
      expected: new Set(["image/jpeg"]), maximumBytes: 16,
    }), (error) => error instanceof AppError &&
      error.code === "media_byte_mismatch" && error.status === 400);
  });
});

test("an early R2 failure aborts the fixed-length pump without hanging", async () => {
  await withFixedLengthStream(async () => {
    const operation = downloadThreadsMedia({
      async put() { throw new Error("r2_unavailable"); },
    }, async () => streamingResponse(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array([1, 2, 3, 4])); },
    }), { headers: {
      "Content-Type": "image/jpeg", "Content-Length": "4",
    } }), {
      url: "https://scontent.cdninstagram.com/object", key: "threads/fixed/failure",
      expected: new Set(["image/jpeg"]), maximumBytes: 16,
    });
    await assert.rejects(Promise.race([
      operation,
      new Promise((resolve, reject) => setTimeout(
        () => reject(new Error("fixed_length_abort_timeout")), 250,
      )),
    ]), (error) => error instanceof AppError &&
      error.code === "media_storage_unavailable");
  });
});

/** @param {{ url?: string, contentType?: string, contentLength?: string | null,
 * body?: BodyInit, maximumBytes?: number, cdn?: (url: URL, call: number) => Response }} [options] */
async function archiveEntry(options = {}) {
  const url = options.url ?? "https://scontent.cdninstagram.com/object";
  const bucket = recordingBucket();
  /** @type {URL[]} */
  const calls = [];
  let cdnCalls = 0;
  /** @param {RequestInfo | URL} input @param {RequestInit} [init] */
  const fetcher = async (input, init = {}) => {
    const request = new Request(input, init);
    const requestUrl = new URL(request.url);
    calls.push(requestUrl);
    if (requestUrl.origin === "https://graph.threads.net") {
      return streamingResponse(JSON.stringify(rawMedia({ media_url: url })), {
        headers: { "Content-Type": "application/json" },
      });
    }
    cdnCalls += 1;
    if (options.cdn) return options.cdn(requestUrl, cdnCalls);
    const headers = new Headers({
      "Content-Type": options.contentType ?? "image/jpeg",
    });
    if (options.contentLength !== null)
      headers.set("Content-Length", options.contentLength ?? "4");
    return streamingResponse(options.body ?? new Uint8Array([1, 2, 3, 4]), { headers });
  };
  /** @type {Array<{ db: unknown, input: unknown }>} */
  const recalculations = [];
  const result = await handleThreadsMediaMessage({
    version: 1, type: "archive-entry-media", postId: "post-1", generation: 2,
    entryId: "entry-1", mediaId: "media-1",
  }, {
    db: mediaDb({
      media_id: "media-1", entry_id: "entry-1", source_media_id: "source-1",
      kind: "image", ordinal: 0, status: "pending", r2_key: null,
      content_type: null, bytes: null, etag: null, error_code: null,
      attempt_count: 0, upload_lease: null, upload_started_at: null,
      pending_r2_key: null, upload_recovering: 0,
    }), bucket, fetcher, getAccessToken: async () => ({ accessToken: "token" }),
    recalculateStatus: async (/** @type {unknown} */ db,
      /** @type {unknown} */ input) => { recalculations.push({ db, input }); },
    nowSeconds: 100, maximumBytes: options.maximumBytes,
  });
  return { bucket, calls, cdnCalls, recalculations, result };
}

test("streams allowlisted image media to one deterministic key without response buffering", async () => {
  for (const host of [
    "cdninstagram.com", "scontent.cdninstagram.com", "fbcdn.net", "video.fbcdn.net",
  ]) {
    const archived = await archiveEntry({ url: `https://${host}/object` });
    assert.deepEqual(archived.result, ACK);
    const entries = [...archived.bucket.objects];
    assert.equal(entries.length, 1);
    assert.match(entries[0][0],
      /^threads\/posts\/post-1\/source-1\/image-0\/[0-9a-f-]{36}$/);
    assert.deepEqual(entries[0][1], {
      bytes: new Uint8Array([1, 2, 3, 4]), contentType: "image/jpeg",
      etag: "unit-etag",
    });
    assert.equal(archived.cdnCalls, 1);
  }
});

test("accepts a matching streamed video MIME and rejects an image MIME for video", async () => {
  const good = await archiveEntry({ contentType: "image/webp; charset=binary" });
  assert.equal([...good.bucket.objects.values()][0]?.contentType, "image/webp");
  const bad = await archiveEntry({ contentType: "video/mp4" });
  assert.deepEqual(bad.result, ACK);
  assert.equal(bad.bucket.objects.size, 0);
});

test("rejects CDN suffix lookalikes and custom ports before a media request", async () => {
  for (const url of [
    "https://evilcdninstagram.com/object",
    "https://cdninstagram.com.example.test/object",
    "https://fbcdn.net.example.test/object",
    "https://cdninstagram.com:443/object",
    "https://cdninstagram.com:0443/object",
    "https://cdninstagram.com:444/object",
    "https:////cdninstagram.com/object",
    "https:///cdninstagram.com/object",
    "https:\\\\cdninstagram.com\\object",
    "https://cdninstagram.com\\object",
    "https://cdninstagram.com/path\\object",
    "////cdninstagram.com/object",
  ]) {
    const archived = await archiveEntry({ url });
    assert.deepEqual(archived.result, ACK);
    assert.equal(archived.cdnCalls, 0, url);
    assert.equal(archived.bucket.objects.size, 0, url);
  }
});

test("allows three HTTPS CDN redirects, cancels them, and rejects a downgrade or fourth redirect", async () => {
  let cancellations = 0;
  const redirect = (/** @type {string} */ location) => streamingResponse(new ReadableStream({
    cancel() { cancellations += 1; },
  }), { status: 302, headers: { Location: location } });
  const good = await archiveEntry({ cdn(url, call) {
    if (call <= 3) return redirect(`https://hop-${call}.fbcdn.net/object`);
    return streamingResponse(new Uint8Array([1]), {
      headers: { "Content-Type": "image/png", "Content-Length": "1" },
    });
  } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(good.cdnCalls, 4);
  assert.equal(cancellations, 3);
  assert.equal(good.bucket.objects.size, 1);

  const fourth = await archiveEntry({ cdn(url, call) {
    return redirect(`https://hop-${call}.fbcdn.net/object`);
  } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(fourth.cdnCalls, 4);
  assert.equal(fourth.bucket.objects.size, 0);

  const downgrade = await archiveEntry({ cdn() {
    return redirect("http://scontent.cdninstagram.com/object");
  } });
  assert.equal(downgrade.cdnCalls, 1);
  assert.equal(downgrade.bucket.objects.size, 0);

  for (const port of ["443", "0443", "444"]) {
    for (const location of [
      `https://scontent.cdninstagram.com:${port}/object`,
      `//scontent.cdninstagram.com:${port}/object`,
    ]) {
      const explicitPort = await archiveEntry({ cdn() { return redirect(location); } });
      assert.equal(explicitPort.cdnCalls, 1, location);
      assert.equal(explicitPort.bucket.objects.size, 0, location);
    }
  }

  for (const location of [
    "https:////scontent.cdninstagram.com/object",
    "https:///scontent.cdninstagram.com/object",
    "https:\\\\scontent.cdninstagram.com\\object",
    "https://scontent.cdninstagram.com\\object",
    "//\\scontent.cdninstagram.com/object",
    "///scontent.cdninstagram.com/object",
    "////scontent.cdninstagram.com/object",
  ]) {
    const malformed = await archiveEntry({ cdn() { return redirect(location); } });
    assert.equal(malformed.cdnCalls, 1, location);
    assert.equal(malformed.bucket.objects.size, 0, location);
  }

  const relative = await archiveEntry({ cdn(url, call) {
    if (call === 1) return redirect("/relative-object");
    return streamingResponse(new Uint8Array([9]), {
      headers: { "Content-Type": "image/png", "Content-Length": "1" },
    });
  } });
  assert.equal(relative.cdnCalls, 2);
  assert.equal(relative.bucket.objects.size, 1);
});

test("enforces declared and counted byte limits without retaining a partial object", async () => {
  const declared = await archiveEntry({ maximumBytes: 32, contentLength: "33" });
  assert.equal(declared.bucket.objects.size, 0);

  const missingLength = await archiveEntry({
    maximumBytes: 32, contentLength: null,
    body: new Uint8Array([1, 2, 3, 4, 5]),
  });
  assert.equal([...missingLength.bucket.objects.values()][0]?.bytes.byteLength, 5);

  const oversized = await archiveEntry({
    maximumBytes: 32, contentLength: null, body: new Uint8Array(33),
  });
  assert.equal(oversized.bucket.objects.size, 0);

  for (const invalid of ["-1", "1.5", "9007199254740992"])
    assert.equal((await archiveEntry({ maximumBytes: 32, contentLength: invalid }))
      .bucket.objects.size, 0);
});

test("deletes a just-written object when the provider stream is truncated", async () => {
  const archived = await archiveEntry({
    contentLength: "4", body: new Uint8Array([1, 2, 3]),
  });
  assert.equal(archived.bucket.objects.size, 0);
  assert.equal(archived.bucket.deleted.length, 1);
  assert.match(archived.bucket.deleted[0],
    /^threads\/posts\/post-1\/source-1\/image-0\/[0-9a-f-]{36}$/);
});

test("parses one closed, suffix, or open byte range and rejects invalid ranges", () => {
  assert.equal(parseSingleRange(null, 100), null);
  assert.deepEqual(parseSingleRange("bytes=10-19", 100), {
    offset: 10, length: 10, contentRange: "bytes 10-19/100",
  });
  assert.deepEqual(parseSingleRange("bytes=-10", 100), {
    offset: 90, length: 10, contentRange: "bytes 90-99/100",
  });
  assert.deepEqual(parseSingleRange("bytes=90-", 100), {
    offset: 90, length: 10, contentRange: "bytes 90-99/100",
  });
  for (const raw of [
    "bytes=0-1,4-5", "items=0-1", "bytes=100-101", "bytes=20-10",
    "bytes=-0", "bytes=--", "bytes=", "bytes=9007199254740992-",
  ]) assert.throws(() => parseSingleRange(raw, 100), /invalid_media_range/, raw);
});
