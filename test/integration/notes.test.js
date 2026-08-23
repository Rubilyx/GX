import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import {
  seedRepository, seedRepositoryNote, startHarness,
} from "../support/harness.js";
import {
  createRepositoryNote, deleteRepositoryNote, getRepositoryNoteSummary,
  listRepositoryNotes, updateRepositoryNote,
} from "../../src/notes.js";

/** @type {Awaited<ReturnType<typeof startHarness>>} */
let harness;
before(async () => { harness = await startHarness(); });
beforeEach(async () => { await harness.reset(); });
after(async () => { await harness.close(); });

test("lists an empty first page for an existing repository and null for a missing one", async () => {
  const env = await harness.worker.getEnv();
  await seedRepository(env.PROD_DB);
  assert.deepEqual(await listRepositoryNotes(env.PROD_DB, "repo-1", 1), {
    notes: [], page: 1, totalPages: 1, total: 0,
  });
  assert.equal(await listRepositoryNotes(env.PROD_DB, "missing", 1), null);
});

test("creates a trimmed NFC Note with a UUID", async () => {
  const env = await harness.worker.getEnv();
  await seedRepository(env.PROD_DB);
  const note = await createRepositoryNote(env.PROD_DB, "repo-1", "  cafe\u0301  ");
  assert.ok(note);
  assert.match(note.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.deepEqual({ id: "uuid", repositoryId: note.repositoryId, body: note.body }, {
    id: "uuid", repositoryId: "repo-1", body: "café",
  });
  assert.ok(Number.isInteger(note.createdAt));
  assert.equal(note.updatedAt, note.createdAt);
});

test("assigns increasing creation times to same-second Notes", async () => {
  const env = await harness.worker.getEnv();
  await seedRepository(env.PROD_DB);
  const first = await createRepositoryNote(env.PROD_DB, "repo-1", "First");
  const second = await createRepositoryNote(env.PROD_DB, "repo-1", "Second");
  assert.ok(first);
  assert.ok(second);
  assert.ok(second.createdAt > first.createdAt);
  assert.deepEqual((await listRepositoryNotes(env.PROD_DB, "repo-1", 1))?.notes.map((/** @type {any} */ note) => note.body), [
    "Second", "First",
  ]);
});

test("lists deterministic Notes in five-row pages and clamps oversized pages", async () => {
  const env = await harness.worker.getEnv();
  await seedRepository(env.PROD_DB);
  for (let index = 1; index <= 5; index += 1) {
    await seedRepositoryNote(env.PROD_DB, {
      id: `note-${index}`, body: `Note ${index}`, createdAt: index, updatedAt: index,
    });
  }
  assert.deepEqual(await listRepositoryNotes(env.PROD_DB, "repo-1", 99), {
    notes: [5, 4, 3, 2, 1].map((index) => ({
      id: `note-${index}`, repositoryId: "repo-1", body: `Note ${index}`,
      createdAt: index, updatedAt: index,
    })),
    page: 1, totalPages: 1, total: 5,
  });
  await seedRepositoryNote(env.PROD_DB, {
    id: "note-6", body: "Note 6", createdAt: 6, updatedAt: 6,
  });
  assert.deepEqual(await listRepositoryNotes(env.PROD_DB, "repo-1", 1), {
    notes: [6, 5, 4, 3, 2].map((index) => ({
      id: `note-${index}`, repositoryId: "repo-1", body: `Note ${index}`,
      createdAt: index, updatedAt: index,
    })),
    page: 1, totalPages: 2, total: 6,
  });
  const lastPage = {
    notes: [{ id: "note-1", repositoryId: "repo-1", body: "Note 1", createdAt: 1, updatedAt: 1 }],
    page: 2, totalPages: 2, total: 6,
  };
  assert.deepEqual(await listRepositoryNotes(env.PROD_DB, "repo-1", 2), lastPage);
  assert.deepEqual(await listRepositoryNotes(env.PROD_DB, "repo-1", 99), lastPage);
});

test("updates a repository-scoped Note without changing its creation time", async () => {
  const env = await harness.worker.getEnv();
  await seedRepository(env.PROD_DB);
  await seedRepository(env.PROD_DB, { id: "repo-2", githubId: "2" });
  await seedRepositoryNote(env.PROD_DB, { id: "note-1", createdAt: 1, updatedAt: 1 });

  const updated = await updateRepositoryNote(env.PROD_DB, "repo-1", "note-1", "  updated  ");
  assert.ok(updated);
  assert.deepEqual({
    id: updated.id, repositoryId: updated.repositoryId, body: updated.body, createdAt: updated.createdAt,
  }, {
    id: "note-1", repositoryId: "repo-1", body: "updated", createdAt: 1,
  });
  assert.ok(updated.updatedAt > updated.createdAt);
  assert.equal(await updateRepositoryNote(env.PROD_DB, "repo-2", "note-1", "other"), null);
  assert.equal(await deleteRepositoryNote(env.PROD_DB, "repo-2", "note-1"), false);
});

test("deletes only the intended Note", async () => {
  const env = await harness.worker.getEnv();
  await seedRepository(env.PROD_DB);
  await seedRepositoryNote(env.PROD_DB, { id: "note-1" });
  await seedRepositoryNote(env.PROD_DB, { id: "note-2", createdAt: 2, updatedAt: 2 });
  assert.equal(await deleteRepositoryNote(env.PROD_DB, "repo-1", "note-1"), true);
  assert.deepEqual(await listRepositoryNotes(env.PROD_DB, "repo-1", 1), {
    notes: [{ id: "note-2", repositoryId: "repo-1", body: "Note body", createdAt: 2, updatedAt: 2 }],
    page: 1, totalPages: 1, total: 1,
  });
});

test("summarizes count and newest Note by stable created order", async () => {
  const env = await harness.worker.getEnv();
  await seedRepository(env.PROD_DB);
  await seedRepositoryNote(env.PROD_DB, { id: "note-a", body: "Old", createdAt: 1, updatedAt: 1 });
  await seedRepositoryNote(env.PROD_DB, { id: "note-b", body: "Newest B", createdAt: 2, updatedAt: 2 });
  await seedRepositoryNote(env.PROD_DB, { id: "note-c", body: "Newest C", createdAt: 2, updatedAt: 2 });
  assert.deepEqual(await getRepositoryNoteSummary(env.PROD_DB, "repo-1"), {
    noteCount: 3, latestNote: "Newest C",
  });
});

/** @param {{ first?: any[], all?: any[], run?: any[], reject?: boolean }} [options] */
function d1Stub(options = {}) {
  const { first = [], all = [], run = [], reject = false } = options;
  /** @param {any[]} queue @param {string} operation */
  const take = (queue, operation) => {
    if (reject) throw new Error("D1 unavailable");
    if (!queue.length) throw new Error(`Unexpected D1 ${operation}`);
    return queue.shift();
  };
  return {
    prepare() {
      const statement = {
        bind() { return statement; },
        first() { return Promise.resolve(take(first, "first")); },
        all() { return Promise.resolve(take(all, "all")); },
        run() { return Promise.resolve(take(run, "run")); },
      };
      return statement;
    },
  };
}

/** @param {Record<string, any>} [overrides] */
function storedPageRow(overrides = {}) {
  return {
    parent_repository_id: "repo-1", total: 1, page: 1,
    id: "note-1", repository_id: "repo-1", body: "Note body",
    created_at: 1, updated_at: 1,
    ...overrides,
  };
}

test("returns a clamped six-Note boundary page from one D1 snapshot", async () => {
  const db = d1Stub({
    all: [{ success: true, results: [storedPageRow({
      total: 6, page: 2, id: "note-oldest", body: "Oldest Note",
    })] }],
  });
  assert.deepEqual(await listRepositoryNotes(db, "repo-1", 99), {
    notes: [{
      id: "note-oldest", repositoryId: "repo-1", body: "Oldest Note",
      createdAt: 1, updatedAt: 1,
    }],
    page: 2, totalPages: 2, total: 6,
  });
});

test("rejects Note page rows from another repository", async () => {
  await assert.rejects(
    listRepositoryNotes(d1Stub({
      all: [{ success: true, results: [storedPageRow({ repository_id: "repo-2" })] }],
    }), "repo-1", 1),
    (error) => error instanceof Error && "code" in error && "status" in error &&
      error.code === "storage_unavailable" && error.status === 503,
  );
});

test("rejects Note page rows outside stable newest-first order", async () => {
  await assert.rejects(
    listRepositoryNotes(d1Stub({
      all: [{ success: true, results: [
        storedPageRow({ total: 2, id: "note-old", created_at: 1, updated_at: 1 }),
        storedPageRow({ total: 2, id: "note-new", created_at: 2, updated_at: 2 }),
      ] }],
    }), "repo-1", 1),
    (error) => error instanceof Error && "code" in error && "status" in error &&
      error.code === "storage_unavailable" && error.status === 503,
  );
});

test("rejects Note page cardinality inconsistent with its total", async () => {
  await assert.rejects(
    listRepositoryNotes(d1Stub({
      all: [{ success: true, results: [storedPageRow({ total: 6 })] }],
    }), "repo-1", 1),
    (error) => error instanceof Error && "code" in error && "status" in error &&
      error.code === "storage_unavailable" && error.status === 503,
  );
});

test("maps failed or malformed D1 responses to storage_unavailable", async () => {
  await assert.rejects(
    listRepositoryNotes(d1Stub({ first: [{}] }), "repo-1", 1),
    (error) => error instanceof Error && "code" in error && "status" in error &&
      error.code === "storage_unavailable" && error.status === 503,
  );
  await assert.rejects(
    getRepositoryNoteSummary(d1Stub({ reject: true }), "repo-1"),
    (error) => error instanceof Error && "code" in error && "status" in error &&
      error.code === "storage_unavailable" && error.status === 503,
  );

  for (const result of [{ results: [] }, { success: false, results: [] }]) {
    await assert.rejects(
      listRepositoryNotes(d1Stub({
        first: [{ present: 1 }, { count: 0 }], all: [result],
      }), "repo-1", 1),
      (error) => error instanceof Error && "code" in error && "status" in error &&
        error.code === "storage_unavailable" && error.status === 503,
    );
  }

  for (const body of ["", " padded ", "cafe\u0301", "x".repeat(4001)]) {
    await assert.rejects(
      listRepositoryNotes(d1Stub({
        all: [{ success: true, results: [storedPageRow({ body })] }],
      }), "repo-1", 1),
      (error) => error instanceof Error && "code" in error && "status" in error &&
        error.code === "storage_unavailable" && error.status === 503,
    );
  }

  for (const latestNote of ["", " padded ", "cafe\u0301", "x".repeat(4001)]) {
    await assert.rejects(
      getRepositoryNoteSummary(d1Stub({ first: [{ note_count: 1, latest_note: latestNote }] }), "repo-1"),
      (error) => error instanceof Error && "code" in error && "status" in error &&
        error.code === "storage_unavailable" && error.status === 503,
    );
  }
});
