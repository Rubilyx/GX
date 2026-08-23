import test from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../../src/domain.js";
import { normalizeThreadsUrl, parseThreadsListQuery, parseThreadsDetailQuery, extractThreadsLinks, validateCaptureMessage, validateMediaMessage } from "../../src/threads-domain.js";

/** @param {() => unknown} fn @param {string} code */
const invalid = (fn, code) => assert.throws(fn, (e) => e instanceof AppError && e.code === code && e.status === 400);

test("normalizes canonical and legacy Threads URLs", () => {
  assert.deepEqual(normalizeThreadsUrl(" https://www.threads.net/@Meta/post/AbC_12?xmt=tracking#top "), { kind:"canonical", submittedUrl:"https://www.threads.net/@Meta/post/AbC_12", canonicalUrl:"https://www.threads.com/@Meta/post/AbC_12", username:"Meta", shortcode:"AbC_12" });
  assert.deepEqual(normalizeThreadsUrl("https://threads.net/t/abc-1"), { kind:"short", submittedUrl:"https://threads.net/t/abc-1", canonicalUrl:null, username:null, shortcode:"abc-1" });
  invalid(() => normalizeThreadsUrl("http://threads.com/t/x"), "invalid_threads_url");
  for (const x of ["https://threads.com.evil/t/x","https://u:p@threads.com/t/x","https://threads.com:443/t/x","https://threads.com:0443/t/x","https://threads.com:444/t/x","https://threads.com/t/x/y","https://threads.com/t/%ZZ"]) invalid(() => normalizeThreadsUrl(x), "invalid_threads_url");
});

test("parses strict Threads query pages", () => {
  assert.deepEqual(parseThreadsListQuery(new URL("https://threads.com/?page=3")), {page:3});
  assert.deepEqual(parseThreadsDetailQuery(new URL("https://threads.com/?repliesPage=no")), {repliesPage:1});
  for (const { fn, key } of [{fn:parseThreadsListQuery,key:"page"},{fn:parseThreadsDetailQuery,key:"repliesPage"}]) { invalid(() => fn(new URL(`https://x/?${key}=1&${key}=2`)), "invalid_threads_query"); invalid(() => fn(new URL("https://x/?other=1")), "invalid_threads_query"); }
});

test("extracts safe normalized links deterministically", () => {
  assert.deepEqual(extractThreadsLinks("문서 https://example.com/a). 다시 https://example.com/a", "https://meta.com"), [{url:"https://example.com/a",source:"body",ordinal:0},{url:"https://meta.com/",source:"attachment",ordinal:1}]);
  assert.deepEqual(extractThreadsLinks("javascript:alert(1) ftp://x.test http://x.test/a!", "http://x.test/a"), [{url:"http://x.test/a",source:"body",ordinal:0}]);
  assert.deepEqual(extractThreadsLinks("https://example.com/a_(b) https://example.com/a_[b] https://example.com/a_{b}", null), [
    {url:"https://example.com/a_(b)",source:"body",ordinal:0}, {url:"https://example.com/a_[b]",source:"body",ordinal:1}, {url:"https://example.com/a_%7Bb%7D",source:"body",ordinal:2},
  ]);
});

test("validates closed capture and media queue messages", () => {
  const capture = {version:1,type:"resolve-post",postId:"p",generation:2,cursor:null};
  assert.deepEqual(validateCaptureMessage(capture), capture);
  invalid(() => validateCaptureMessage({...capture, extra:true}), "invalid_threads_queue_message");
  invalid(() => validateCaptureMessage({...capture, generation:0}), "invalid_threads_queue_message");
  const media = {version:1,type:"delete-object",objectKey:"k"};
  assert.deepEqual(validateMediaMessage(media), media);
  invalid(() => validateMediaMessage({...media, extra:true}), "invalid_threads_queue_message");
});
