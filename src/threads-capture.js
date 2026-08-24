import { AppError } from "./domain.js";
import {
  fetchThreadsConversationPage, fetchThreadsMedia, fetchThreadsProfile,
  fetchThreadsProfilePostsPage, resolveThreadsPostUrl,
} from "./threads-api.js";
import { normalizeThreadsUrl, validateCaptureMessage } from "./threads-domain.js";
import {
  advanceThreadsProfileCursor, claimThreadsJob, failThreadsQuote,
  failThreadsAuthorProfile, failThreadsDeletion, finalizeThreadsContent,
  listThreadsPendingQuoteWork, markThreadsEnrichmentFailure, markThreadsJobError,
  saveResolvedThreadsRoot, saveThreadsAuthorProfile, saveThreadsConversationPage,
  saveThreadsMediaDescriptors, saveThreadsNestedQuotePermalink, saveThreadsQuote,
} from "./threads.js";

const ACK = Object.freeze({ action: "ack" });
const TRANSIENT_CODES = new Set([
  "queue_unavailable", "storage_unavailable", "threads_provider_unavailable",
  "threads_rate_limited",
]);

/** @param {unknown} value */
function accessToken(value) {
  const token = value && typeof value === "object" && !Array.isArray(value) ?
    /** @type {Record<string, unknown>} */ (value).accessToken : null;
  if (typeof token !== "string" || !token)
    throw new AppError("threads_reconnect_required", 401);
  return token;
}

/** @param {unknown} value */
function retryDelay(value) {
  const delay = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 1;
  return Math.max(1, Math.min(900, delay));
}

/** @param {unknown} error */
function retryResult(error) {
  if (error instanceof AppError && TRANSIENT_CODES.has(error.code)) {
    const retryAfter = error.code === "threads_rate_limited" ? error.details.retryAfter : 1;
    return { action: "retry", delaySeconds: retryDelay(retryAfter) };
  }
  if (!(error instanceof AppError)) return { action: "retry", delaySeconds: 1 };
  return null;
}

/** @param {any} queue @param {Record<string, unknown>} message */
async function sendCapture(queue, message) {
  if (!queue || typeof queue.send !== "function") throw new Error("capture_queue_missing");
  await queue.send(validateCaptureMessage(message));
}

/** @param {Record<string, any>} message @param {any} dependencies */
async function sendPendingQuotes(message, dependencies) {
  const work = await listThreadsPendingQuoteWork(dependencies.db, {
    postId: message.postId, generation: message.generation,
  });
  for (const quote of work) await sendCapture(dependencies.captureQueue, {
    version: 1, type: "collect-quote", postId: message.postId,
    generation: message.generation, entryId: quote.parentEntryId, quoteId: quote.quoteId,
  });
  return work;
}

/** @param {Record<string, any>} message @param {Record<string, any>} job @param {any} dependencies */
async function recoverPersistedWork(message, job, dependencies) {
  if (!job.profileCompleted) {
    await sendCapture(dependencies.captureQueue, {
      version: 1, type: "resolve-post", postId: message.postId,
      generation: message.generation, cursor: job.profileCursor,
    });
    return;
  }
  if (!job.conversationCompleted) {
    await sendCapture(dependencies.captureQueue, {
      version: 1, type: "collect-conversation", postId: message.postId,
      generation: message.generation, cursor: job.conversationCursor,
    });
    if (job.conversationStarted) await sendPendingQuotes(message, dependencies);
    return;
  }
  await sendPendingQuotes(message, dependencies);
  if (job.pendingQuoteCount === 0) await sendCapture(dependencies.captureQueue, {
    version: 1, type: "finalize-content", postId: message.postId,
    generation: message.generation,
  });
}

/** @param {Record<string, any>} item @param {string} entrySourceMediaId @param {number} ordinal */
function directDescriptors(item, entrySourceMediaId, ordinal) {
  const descriptors = [];
  if (item.mediaType === "IMAGE") descriptors.push({
    entrySourceMediaId, sourceMediaId: item.id, kind: "image", ordinal,
    altText: item.altText ?? null,
  });
  if (item.mediaType === "VIDEO") {
    descriptors.push({
      entrySourceMediaId, sourceMediaId: item.id, kind: "video", ordinal,
      altText: item.altText ?? null,
    });
    if (item.thumbnailUrl) descriptors.push({
      entrySourceMediaId, sourceMediaId: item.id, kind: "video_thumbnail", ordinal,
      altText: item.altText ?? null,
    });
  }
  return descriptors;
}

/** @param {Record<string, any>} entry */
function fallbackProfile(entry) {
  return {
    id: entry.ownerId, username: entry.username,
    name: entry.username, profilePictureUrl: null,
  };
}

/** @param {unknown} error */
function providerEnrichmentError(error) {
  if (!(error instanceof AppError)) return true;
  return new Set([
    "threads_post_unavailable", "threads_provider_protocol_error",
    "threads_provider_unavailable", "threads_rate_limited",
  ]).has(error.code);
}

/** @param {Record<string, any>} entry @param {string} token @param {any} dependencies
 * @param {Record<string, any>} message */
async function enrichProfile(entry, token, dependencies, message) {
  try {
    const profile = await fetchThreadsProfile(dependencies.fetcher, {
      accessToken: token, username: entry.username, signal: dependencies.signal,
    });
    if (profile.id !== entry.ownerId)
      throw new AppError("threads_provider_protocol_error", 502);
    await saveThreadsAuthorProfile(dependencies.db, {
      postId: message.postId, generation: message.generation,
      authorId: entry.ownerId, profile, nowSeconds: dependencies.nowSeconds,
    });
  } catch (error) {
    if (error instanceof AppError && error.code === "threads_reconnect_required")
      throw error;
    if (!providerEnrichmentError(error)) throw error;
    await failThreadsAuthorProfile(dependencies.db, {
      postId: message.postId, generation: message.generation,
      authorId: entry.ownerId, errorCode: "threads_profile_unavailable",
      nowSeconds: dependencies.nowSeconds,
    });
  }
}

/** @param {Record<string, any>[]} entries @param {string} token
 * @param {any} dependencies @param {Record<string, any>} message
 * @param {string | null} [parentEntryId] */
async function enrichCarousels(
  entries, token, dependencies, message, parentEntryId = null,
) {
  for (const entry of entries.filter((item) => item.mediaType === "CAROUSEL_ALBUM")) {
    for (let ordinal = 0; ordinal < entry.children.length; ordinal += 1) {
      const childId = entry.children[ordinal];
      try {
        const child = await fetchThreadsMedia(dependencies.fetcher, {
          accessToken: token, mediaId: childId, signal: dependencies.signal,
        });
        if (child.id !== childId)
          throw new AppError("threads_provider_protocol_error", 502);
        const descriptors = directDescriptors(child, entry.id, ordinal);
        if (descriptors.length === 0)
          throw new AppError("threads_provider_protocol_error", 502);
        await saveThreadsMediaDescriptors(dependencies.db, {
          postId: message.postId, generation: message.generation,
          parentEntryId, media: descriptors, nowSeconds: dependencies.nowSeconds,
        });
      } catch (error) {
        if (error instanceof AppError && error.code === "threads_reconnect_required")
          throw error;
        if (!providerEnrichmentError(error)) throw error;
        await markThreadsEnrichmentFailure(dependencies.db, {
          postId: message.postId, generation: message.generation,
          errorCode: "threads_media_descriptor_unavailable",
          nowSeconds: dependencies.nowSeconds,
        });
      }
    }
  }
}

/** @param {Record<string, any>} message @param {any} dependencies */
async function resolvePost(message, dependencies) {
  const job = await claimThreadsJob(
    dependencies.db, message.postId, message.generation, "resolving",
  );
  if (!job) return;
  if (job.profileCompleted) {
    await recoverPersistedWork(message, job, dependencies);
    return;
  }
  if (message.cursor !== job.profileCursor) {
    await recoverPersistedWork(message, job, dependencies);
    return;
  }
  const normalized = await resolveThreadsPostUrl(
    dependencies.fetcher, normalizeThreadsUrl(job.submittedUrl), dependencies.signal,
  );
  if (!normalized.username) throw new AppError("threads_provider_protocol_error", 502);
  const token = accessToken(await dependencies.getAccessToken());
  const page = await fetchThreadsProfilePostsPage(dependencies.fetcher, {
    accessToken: token, username: normalized.username, after: message.cursor,
    signal: dependencies.signal,
  });
  const root = page.data.find((item) => {
    try { return normalizeThreadsUrl(item.permalink).shortcode === job.shortcode; }
    catch { return false; }
  });
  if (!root) {
    if (page.nextCursor === null) throw new AppError("threads_post_unavailable", 404);
    if (page.nextCursor === message.cursor)
      throw new AppError("threads_provider_protocol_error", 502);
    const advanced = await advanceThreadsProfileCursor(dependencies.db, {
      postId: message.postId, generation: message.generation,
      expectedCursor: message.cursor, nextCursor: page.nextCursor,
      nowSeconds: dependencies.nowSeconds,
    });
    if (!advanced) {
      const current = await claimThreadsJob(
        dependencies.db, message.postId, message.generation, "resolving",
      );
      if (current) await recoverPersistedWork(message, current, dependencies);
      return;
    }
    await sendCapture(dependencies.captureQueue, {
      version: 1, type: "resolve-post", postId: message.postId,
      generation: message.generation, cursor: page.nextCursor,
    });
    return;
  }
  const profile = fallbackProfile(root);
  const media = directDescriptors(root, root.id, 0);
  const saved = await saveResolvedThreadsRoot(dependencies.db, {
    postId: message.postId, generation: message.generation, profile, root,
    expectedProfileCursor: message.cursor,
    profileCursor: null, conversationCursor: null, media,
    nowSeconds: dependencies.nowSeconds,
  });
  if (!saved.applied) {
    const current = await claimThreadsJob(
      dependencies.db, message.postId, message.generation, "resolving",
    );
    if (current) await recoverPersistedWork(message, current, dependencies);
    return;
  }
  await enrichProfile(root, token, dependencies, message);
  await enrichCarousels([root], token, dependencies, message);
  await sendCapture(dependencies.captureQueue, {
    version: 1, type: "collect-conversation", postId: message.postId,
    generation: message.generation, cursor: null,
  });
}

/** @param {Record<string, any>} message @param {any} dependencies */
async function collectConversation(message, dependencies) {
  const job = await claimThreadsJob(
    dependencies.db, message.postId, message.generation, "collecting",
  );
  if (!job) return;
  if (!job.profileCompleted || job.conversationCompleted) {
    await recoverPersistedWork(message, job, dependencies);
    return;
  }
  if (message.cursor !== job.conversationCursor) {
    await recoverPersistedWork(message, job, dependencies);
    return;
  }
  if (!job.threadsMediaId || !job.rootAuthorId)
    throw new AppError("threads_provider_protocol_error", 502);
  const token = accessToken(await dependencies.getAccessToken());
  const page = await fetchThreadsConversationPage(dependencies.fetcher, {
    accessToken: token, mediaId: job.threadsMediaId, after: message.cursor,
    signal: dependencies.signal,
  });
  if (page.nextCursor !== null && page.nextCursor === message.cursor)
    throw new AppError("threads_provider_protocol_error", 502);
  const accepted = page.data.filter((entry) => entry.ownerId === job.rootAuthorId);
  const media = accepted.flatMap((entry) => directDescriptors(entry, entry.id, 0));
  const saved = await saveThreadsConversationPage(dependencies.db, {
    postId: message.postId, generation: message.generation, entries: accepted,
    expectedCursor: message.cursor, nextCursor: page.nextCursor, media,
    nowSeconds: dependencies.nowSeconds,
  });
  if (!saved.applied || saved.accepted !== accepted.length) {
    const current = await claimThreadsJob(
      dependencies.db, message.postId, message.generation, "collecting",
    );
    if (current) await recoverPersistedWork(message, current, dependencies);
    return;
  }
  await enrichCarousels(accepted, token, dependencies, message);
  if (page.nextCursor !== null) await sendCapture(dependencies.captureQueue, {
    version: 1, type: "collect-conversation", postId: message.postId,
    generation: message.generation, cursor: page.nextCursor,
  });
  const quotes = await sendPendingQuotes(message, dependencies);
  if (page.nextCursor === null && quotes.length === 0) await sendCapture(
    dependencies.captureQueue, {
      version: 1, type: "finalize-content", postId: message.postId,
      generation: message.generation,
    },
  );
}

/** @param {Record<string, any>} message @param {any} dependencies */
async function afterQuote(message, dependencies) {
  const job = await claimThreadsJob(
    dependencies.db, message.postId, message.generation, "collecting",
  );
  if (!job) return;
  if (job.conversationStarted) await sendPendingQuotes(message, dependencies);
  if (job.conversationCompleted && job.pendingQuoteCount === 0)
    await sendCapture(dependencies.captureQueue, {
      version: 1, type: "finalize-content", postId: message.postId,
      generation: message.generation,
    });
}

/** @param {Record<string, any>} message @param {any} dependencies */
async function collectQuote(message, dependencies) {
  const job = await claimThreadsJob(
    dependencies.db, message.postId, message.generation, "collecting",
  );
  if (!job) return;
  if (!job.profileCompleted || !job.conversationStarted) {
    await recoverPersistedWork(message, job, dependencies);
    return;
  }
  const pending = await listThreadsPendingQuoteWork(dependencies.db, {
    postId: message.postId, generation: message.generation,
  });
  if (!pending.some((item) => item.parentEntryId === message.entryId &&
    item.quoteId === message.quoteId)) {
    await afterQuote(message, dependencies);
    return;
  }
  const token = accessToken(await dependencies.getAccessToken());
  let quote;
  try {
    quote = await fetchThreadsMedia(dependencies.fetcher, {
      accessToken: token, mediaId: message.quoteId, signal: dependencies.signal,
    });
    if (quote.id !== message.quoteId)
      throw new AppError("threads_provider_protocol_error", 502);
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== "threads_post_unavailable") throw error;
    await failThreadsQuote(dependencies.db, {
      postId: message.postId, generation: message.generation,
      parentEntryId: message.entryId, quoteId: message.quoteId,
      errorCode: "threads_quote_unavailable", nowSeconds: dependencies.nowSeconds,
    });
    await afterQuote(message, dependencies);
    return;
  }
  const stored = await saveThreadsQuote(dependencies.db, {
    postId: message.postId, generation: message.generation,
    parentEntryId: message.entryId, profile: fallbackProfile(quote), quote,
    nestedQuotePermalink: null,
    media: directDescriptors(quote, quote.id, 0),
    nowSeconds: dependencies.nowSeconds,
  });
  if (!stored) {
    await afterQuote(message, dependencies);
    return;
  }
  await enrichProfile(quote, token, dependencies, message);
  await enrichCarousels([quote], token, dependencies, message, message.entryId);
  if (quote.quotedPostId) {
    try {
      const nested = await fetchThreadsMedia(dependencies.fetcher, {
        accessToken: token, mediaId: quote.quotedPostId, signal: dependencies.signal,
      });
      if (nested.id !== quote.quotedPostId)
        throw new AppError("threads_provider_protocol_error", 502);
      await saveThreadsNestedQuotePermalink(dependencies.db, {
        postId: message.postId, generation: message.generation,
        parentEntryId: message.entryId, quoteId: quote.id,
        permalink: nested.permalink, nowSeconds: dependencies.nowSeconds,
      });
    } catch (error) {
      if (error instanceof AppError && error.code === "threads_reconnect_required")
        throw error;
      if (!providerEnrichmentError(error)) throw error;
      await markThreadsEnrichmentFailure(dependencies.db, {
        postId: message.postId, generation: message.generation,
        errorCode: "threads_nested_quote_unavailable",
        nowSeconds: dependencies.nowSeconds,
      });
    }
  }
  await afterQuote(message, dependencies);
}

/** @param {Record<string, any>} message @param {unknown} error @param {any} dependencies */
async function terminal(message, error, dependencies) {
  if (typeof message.generation !== "number") return ACK;
  if (!dependencies?.db) throw new Error("capture_database_missing");
  const code = error instanceof AppError ? error.code : "threads_provider_unavailable";
  await markThreadsJobError(dependencies.db, {
    postId: message.postId, generation: message.generation,
    errorCode: code, nowSeconds: dependencies.nowSeconds,
  });
  return ACK;
}

/** @param {unknown} rawMessage @param {any} dependencies */
export async function handleThreadsCaptureMessage(rawMessage, dependencies) {
  let message;
  try { message = /** @type {Record<string, any>} */ (validateCaptureMessage(rawMessage)); }
  catch { return ACK; }
  try {
    if (message.type === "resolve-post") await resolvePost(message, dependencies);
    else if (message.type === "collect-conversation")
      await collectConversation(message, dependencies);
    else if (message.type === "collect-quote") await collectQuote(message, dependencies);
    else if (message.type === "finalize-content") await finalizeThreadsContent(
      dependencies.db, dependencies.mediaQueue, {
        postId: message.postId, generation: message.generation,
        nowSeconds: dependencies.nowSeconds,
      },
    );
    else if (message.type === "delete-archive") {
      if (!dependencies || typeof dependencies.deleteArchive !== "function")
        throw new Error("delete_archive_delegate_missing");
      const result = await dependencies.deleteArchive(message);
      const action = result && typeof result === "object" && !Array.isArray(result) ?
        /** @type {Record<string, unknown>} */ (result).action : null;
      if (action === "retry") return {
        action: "retry", delaySeconds: retryDelay(
          /** @type {Record<string, unknown>} */ (result).delaySeconds,
        ),
      };
      if (action !== "ack") throw new Error("invalid_delete_archive_result");
    }
    return ACK;
  } catch (error) {
    if (error instanceof AppError && error.code === "threads_reconnect_required" &&
      typeof dependencies?.markReconnectRequired === "function") {
      try { await dependencies.markReconnectRequired(); }
      catch (recordError) { return retryResult(recordError) ?? ACK; }
    }
    const retry = retryResult(error);
    if (retry) return retry;
    try { return await terminal(message, error, dependencies); }
    catch (recordError) { return retryResult(recordError) ?? ACK; }
  }
}

/** @param {unknown} rawMessage @param {any} dependencies */
export async function handleThreadsCaptureDeadLetter(rawMessage, dependencies) {
  let message;
  try { message = /** @type {Record<string, any>} */ (validateCaptureMessage(rawMessage)); }
  catch { return ACK; }
  if (message.type === "delete-archive") {
    if (!dependencies?.db) return { action: "retry", delaySeconds: 1 };
    try {
      await failThreadsDeletion(
        dependencies.db, message.postId, "queue_retries_exhausted",
        dependencies.nowSeconds,
      );
      return ACK;
    } catch (error) { return retryResult(error) ?? ACK; }
  }
  if (typeof message.generation !== "number") return ACK;
  if (!dependencies?.db) return { action: "retry", delaySeconds: 1 };
  try {
    await markThreadsJobError(dependencies.db, {
      postId: message.postId, generation: message.generation,
      errorCode: "queue_retries_exhausted", nowSeconds: dependencies.nowSeconds,
    });
    return ACK;
  } catch (error) { return retryResult(error) ?? ACK; }
}
