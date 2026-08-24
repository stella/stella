import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import type { SafeId } from "@/api/lib/branded-types";
import { toSafeId } from "@/api/lib/branded-types";
import type {
  CorpusJobInput,
  FencedRemoteEffect,
} from "@/api/lib/corpus-index/core";
import {
  corpusDocumentsDeleteQuery,
  createCorpusIndexer,
  deleteQueryChunks,
  settleAll,
  settleAllCleanup,
  settleBoth,
  splitIngestRequests,
} from "@/api/lib/corpus-index/core";
import type { TimestampCasToken } from "@/api/lib/db/timestamp-cas";
import { CORPUS_INDEX_COMMIT } from "@/api/lib/legal-search/corpus-index-client";
import { corpusIndexId } from "@/api/lib/legal-search/index-naming";
import { isRecord } from "@/api/lib/type-guards";

/**
 * A batch is sized in rows, but a passage family turns one row into as many
 * documents as it has passages, so the NDJSON body a batch serializes to is
 * not bounded by the row count. These tests pin the byte bound and the row
 * boundary it must never cut across.
 */

const utf8Bytes = (value: string): number => Buffer.byteLength(value, "utf-8");

const builtRow = (id: string, passages: number, filler: string) => ({
  row: { id },
  docs: Array.from({ length: passages }, (_, seq) => ({
    document_id: id,
    seq,
    text: filler,
  })),
});

const ingestedIds = (requests: ReturnType<typeof splitIngestRequests>) =>
  requests.flatMap(({ ndjson }) =>
    ndjson.split("\n").map((line) => {
      const doc: Record<string, unknown> = JSON.parse(line);
      return `${String(doc["document_id"])}:${String(doc["seq"])}`;
    }),
  );

const requestUrl = (input: Parameters<typeof fetch>[0]): string => {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
};

describe("splitIngestRequests", () => {
  test("a group that fits stays one request", () => {
    const group = [builtRow("a", 3, "x"), builtRow("b", 2, "x")];

    const requests = splitIngestRequests(group, 1_000_000);

    expect(requests).toHaveLength(1);
    expect(requests.at(0)?.entries).toHaveLength(2);
    expect(requests.at(0)?.ndjson.split("\n")).toHaveLength(5);
  });

  test("every document is sent exactly once, in order, across the split", () => {
    const group = [
      builtRow("a", 4, "x".repeat(400)),
      builtRow("b", 4, "x".repeat(400)),
      builtRow("c", 4, "x".repeat(400)),
    ];

    const requests = splitIngestRequests(group, 2000);

    expect(requests.length).toBeGreaterThan(1);
    // No document dropped, none duplicated, document order preserved — the
    // indexer marks a row indexed on the strength of this.
    expect(ingestedIds(requests)).toEqual([
      ...["a", "b", "c"].flatMap((id) => [0, 1, 2, 3].map((s) => `${id}:${s}`)),
    ]);
    // And every row is accounted for by exactly one request.
    expect(
      requests.flatMap(({ entries }) => entries.map(({ row }) => row.id)),
    ).toEqual(["a", "b", "c"]);
  });

  test("no request exceeds the budget while rows still fit whole", () => {
    const group = Array.from({ length: 12 }, (_, index) =>
      builtRow(`row-${index}`, 5, "x".repeat(200)),
    );
    const maxBytes = 4000;

    for (const { ndjson } of splitIngestRequests(group, maxBytes)) {
      expect(utf8Bytes(ndjson)).toBeLessThanOrEqual(maxBytes);
    }
  });

  test("a row is never cut across two requests", () => {
    const group = [builtRow("a", 20, "x".repeat(100)), builtRow("b", 1, "x")];

    const requests = splitIngestRequests(group, 500);

    for (const { entries, ndjson } of requests) {
      const documentIds = new Set(
        ndjson.split("\n").map((line) => {
          const doc: Record<string, unknown> = JSON.parse(line);
          return String(doc["document_id"]);
        }),
      );
      // A row split across requests could be marked indexed while half its
      // passages were still missing from the index.
      expect([...documentIds].sort()).toEqual(
        entries.map(({ row }) => row.id).sort(),
      );
    }
  });

  test("a single oversized row is sent whole rather than cut", () => {
    const group = [builtRow("huge", 40, "x".repeat(500))];

    const requests = splitIngestRequests(group, 100);

    // Keeping the row's mark honest outweighs the budget here; one court
    // decision bounds the overshoot.
    expect(requests).toHaveLength(1);
    expect(requests.at(0)?.ndjson.split("\n")).toHaveLength(40);
  });

  test("the budget counts UTF-8 bytes, not code units", () => {
    // Czech/Slovak/Arabic legal text is multi-byte; sizing on `.length` would
    // under-count the wire body by up to 3x and defeat the bound.
    const group = [builtRow("cz", 1, "ř".repeat(300))];
    const [request] = splitIngestRequests(group, 1_000_000);
    const ndjson = request?.ndjson ?? "";

    expect(utf8Bytes(ndjson)).toBeGreaterThan(ndjson.length);
  });

  test("an empty group produces no requests", () => {
    expect(splitIngestRequests([], 1000)).toEqual([]);
  });
});

describe("settleBoth", () => {
  test("a fast failure waits for its sibling before surfacing", async () => {
    let siblingFinished = false;
    const sibling = new Promise<string>((resolve) => {
      setTimeout(() => {
        siblingFinished = true;
        resolve("loaded");
      }, 25);
    });

    const caught = await settleBoth(
      Promise.reject(new Error("boom")),
      sibling,
    ).catch((error: unknown) => error);

    expect(caught instanceof Error ? caught.message : null).toBe("boom");
    // The point of the helper: the paired corpus read is finished, so the
    // caller's next slice cannot start on top of a request still in flight and
    // drift past the concurrency bound.
    expect(siblingFinished).toBe(true);
  });

  test("the first failure in argument order wins", async () => {
    const caught = await settleBoth(
      Promise.reject(new Error("text read")),
      Promise.reject(new Error("ast read")),
    ).catch((error: unknown) => error);

    expect(caught instanceof Error ? caught.message : null).toBe("text read");
  });

  test("both values are returned in order when neither fails", async () => {
    expect(
      await settleBoth(Promise.resolve("text"), Promise.resolve(null)),
    ).toEqual(["text", null]);
  });
});

describe("settleAll", () => {
  test("waits for every sibling before exposing the first rejection", async () => {
    let siblingSettled = false;
    const outcome = await settleAll([
      Promise.reject(new Error("first")),
      new Promise<string>((resolve) => {
        setTimeout(() => {
          siblingSettled = true;
          resolve("second");
        }, 25);
      }),
    ]).then(
      () => null,
      (error: unknown) => error,
    );

    expect(siblingSettled).toBe(true);
    expect(outcome instanceof Error ? outcome.message : null).toBe("first");
  });

  test("preserves input order when every sibling succeeds", async () => {
    expect(
      await settleAll([Promise.resolve("first"), Promise.resolve("second")]),
    ).toEqual(["first", "second"]);
  });
});

describe("settleAllCleanup", () => {
  test("waits for every sibling and reports every rejection without throwing", async () => {
    let siblingSettled = false;
    const reported: unknown[] = [];

    await settleAllCleanup(
      [
        Promise.reject(new Error("first")),
        new Promise<string>((_resolve, reject) => {
          setTimeout(() => {
            siblingSettled = true;
            reject(new Error("second"));
          }, 25);
        }),
      ],
      (error) => {
        reported.push(error);
      },
    );

    expect(siblingSettled).toBe(true);
    expect(
      reported.map((error) => (error instanceof Error ? error.message : null)),
    ).toEqual(["first", "second"]);
  });
});

describe("idempotent corpus removals", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("a missing retired index is recorded as an achieved deletion", async () => {
    const row = {
      id: toSafeId<"caseLawDecision">("retired-index-row"),
      country: "CZ",
      textS3Key: null,
      astS3Key: null,
      contentHash: null,
      indexedHash: null,
      indexedGeneration: null,
      // SAFETY: the removal path never reads the fabricated timestamp token.
      // eslint-disable-next-line typescript/no-unsafe-type-assertion
      updatedAtToken: "2026-01-01 00:00:00" as TimestampCasToken,
    };
    const recorded: CorpusJobInput<"caseLawDecision">[] = [];
    const indexer = createCorpusIndexer<"caseLawDecision", typeof row>({
      family: "case_law",
      captureStep: "test",
      granularity: "document",
      generationProjectionIndexIds: () => [],
      buildDocs: () => [],
      readCorpusText: async () => "unused",
      selectMissing: async () => [],
      selectStale: async () => [],
      fetchFulltext: async () => null,
      markIndexedBatch: async () => new Set(),
      insertSucceededJobs: async () => undefined,
      recordJobs: async (_db, jobs) => {
        recorded.push(...jobs);
      },
      recordDeleteJobs: async (_db, { jobs }) => {
        recorded.push(...jobs);
      },
    });
    globalThis.fetch = Object.assign(
      async () => new Response("missing", { status: 404 }),
      { preconnect: originalFetch.preconnect },
    );
    const scopedDb: ScopedDb = async () => {
      throw new Error("removal should not open a database transaction");
    };

    const removed = await indexer.remove(
      row.id,
      scopedDb,
      corpusIndexId("case_law_retired", "CZ"),
    );

    expect(removed.isOk()).toBe(true);
    expect(recorded).toMatchObject([
      { entityId: row.id, operation: "delete", status: "succeeded" },
    ]);
  });

  test("a successful deletion records its opstamp", async () => {
    const row = {
      id: toSafeId<"caseLawDecision">("settled-delete-row"),
      country: "CZ",
      textS3Key: null,
      astS3Key: null,
      contentHash: null,
      indexedHash: null,
      indexedGeneration: null,
      // SAFETY: the removal path never reads the fabricated timestamp token.
      // eslint-disable-next-line typescript/no-unsafe-type-assertion
      updatedAtToken: "2026-01-01 00:00:00" as TimestampCasToken,
    };
    const deleteRecords: {
      jobs: CorpusJobInput<"caseLawDecision">[];
      opstamp: number | null;
    }[] = [];
    const indexer = createCorpusIndexer<"caseLawDecision", typeof row>({
      family: "case_law",
      captureStep: "test",
      granularity: "document",
      generationProjectionIndexIds: () => [],
      buildDocs: () => [],
      readCorpusText: async () => "unused",
      selectMissing: async () => [],
      selectStale: async () => [],
      fetchFulltext: async () => null,
      markIndexedBatch: async () => new Set(),
      insertSucceededJobs: async () => undefined,
      recordJobs: async () => undefined,
      recordDeleteJobs: async (_db, { jobs, opstamp }) => {
        deleteRecords.push({ jobs: [...jobs], opstamp });
      },
    });
    let nextDeleteOpstamp = 40;
    globalThis.fetch = Object.assign(
      async () => {
        nextDeleteOpstamp += 1;
        return new Response(JSON.stringify({ opstamp: nextDeleteOpstamp }), {
          status: 200,
        });
      },
      { preconnect: originalFetch.preconnect },
    );
    const scopedDb: ScopedDb = async () => {
      throw new Error("removal should not open a database transaction");
    };

    const removed = await indexer.remove(
      row.id,
      scopedDb,
      corpusIndexId("case_law_v2", "CZ"),
    );

    expect(removed.isOk()).toBe(true);
    expect(deleteRecords).toMatchObject([
      {
        jobs: [{ entityId: row.id, operation: "delete", status: "succeeded" }],
        opstamp: 41,
      },
    ]);
  });

  test("a fenced removal records guard failures after the remote effect", async () => {
    const row = {
      id: toSafeId<"caseLawDecision">("expired-removal-lease-row"),
      country: "CZ",
      textS3Key: null,
      astS3Key: null,
      contentHash: null,
      indexedHash: null,
      indexedGeneration: null,
      // SAFETY: the removal path never reads the fabricated timestamp token.
      // eslint-disable-next-line typescript/no-unsafe-type-assertion
      updatedAtToken: "2026-01-01 00:00:00" as TimestampCasToken,
    };
    const recorded: CorpusJobInput<"caseLawDecision">[] = [];
    const indexer = createCorpusIndexer<"caseLawDecision", typeof row>({
      family: "case_law",
      captureStep: "test",
      granularity: "document",
      generationProjectionIndexIds: () => [],
      buildDocs: () => [],
      readCorpusText: async () => "unused",
      selectMissing: async () => [],
      selectStale: async () => [],
      fetchFulltext: async () => null,
      markIndexedBatch: async () => new Set(),
      insertSucceededJobs: async () => undefined,
      recordJobs: async (_db, jobs) => {
        recorded.push(...jobs);
      },
      recordDeleteJobs: async (_db, { jobs }) => {
        recorded.push(...jobs);
      },
    });
    let nextDeleteOpstamp = 0;
    globalThis.fetch = Object.assign(
      async () => {
        nextDeleteOpstamp += 1;
        return new Response(JSON.stringify({ opstamp: nextDeleteOpstamp }), {
          status: 200,
        });
      },
      { preconnect: originalFetch.preconnect },
    );
    const scopedDb: ScopedDb = async () => {
      throw new Error("removal should not open a database transaction");
    };

    const removed = await indexer.removeFenced({
      beforeRemoteEffect: async ({ effect, onLeaseLost }) => {
        await effect();
        await onLeaseLost();
        throw new Error("writer lease expired after delete");
      },
      entityId: row.id,
      indexId: corpusIndexId("case_law_v1", "CZ"),
      onLeaseLost: async () => await Promise.resolve(),
      operation: "redact",
      scopedDb,
    });

    expect(removed.isErr()).toBe(true);
    expect(recorded).toMatchObject([
      {
        entityId: row.id,
        errorMessage: "writer lease expired after delete",
        operation: "redact",
        status: "failed",
      },
    ]);
  });
});

describe("fenced serving-generation appends", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("never crosses the external boundary before every target is reserved", async () => {
    const row = {
      id: toSafeId<"caseLawDecision">("reserved-serving-row"),
      country: "CZ",
      textS3Key: null,
      astS3Key: null,
      contentHash: "current",
      indexedHash: null,
      indexedGeneration: null,
      // SAFETY: the test adapter does not inspect the fabricated token.
      // eslint-disable-next-line typescript/no-unsafe-type-assertion
      updatedAtToken: "2026-01-01 00:00:00" as TimestampCasToken,
    };
    const events: string[] = [];
    let nextDeleteOpstamp = 0;
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        const url = input instanceof Request ? input.url : String(input);
        events.push(url.includes("/ingest") ? "ingest" : "remote");
        if (url.includes("/delete-tasks")) {
          nextDeleteOpstamp += 1;
          return new Response(JSON.stringify({ opstamp: nextDeleteOpstamp }), {
            status: 200,
          });
        }
        return new Response(
          url.includes("/ingest")
            ? JSON.stringify({ num_docs_for_processing: 1 })
            : JSON.stringify({}),
          { status: 200 },
        );
      },
      { preconnect: originalFetch.preconnect },
    );
    const scopedDb: ScopedDb = async (callback) =>
      // SAFETY: this adapter's database callbacks only observe that the
      // reservation/mark boundaries occurred; they never query the fake tx.
      // eslint-disable-next-line typescript/no-unsafe-type-assertion -- inert transaction boundary for ordering test
      await callback({} as Transaction);
    const indexer = createCorpusIndexer<"caseLawDecision", typeof row>({
      family: "case_law",
      captureStep: "test",
      granularity: "document",
      generationProjectionIndexIds: () => [],
      buildDocs: (selected) => [{ document_id: selected.id, text: "body" }],
      readCorpusText: async () => "body",
      selectMissing: async () => [row],
      selectStale: async () => [],
      fetchFulltext: async () => "body",
      markIndexedBatch: async (_tx, { rows }) =>
        new Set(rows.map((selected) => selected.id)),
      insertSucceededJobs: async () => undefined,
      recordJobs: async () => undefined,
      recordDeleteJobs: async () => undefined,
    });

    expect(
      await indexer.backfillFenced(scopedDb, 1, "case_law_v1", {
        beforeDatabaseMark: async () => {
          events.push("mark-guard");
        },
        beforeRemoteEffect: async ({ effect }) => {
          events.push("remote-guard");
          return await effect();
        },
        recoverRemoteEffectLeaseLoss: async () => await Promise.resolve(),
        reserveExternalAppend: async (_tx, { generation, rows }) => {
          events.push("reserved");
          expect(generation).toBe("case_law_v1");
          expect(rows).toEqual([row]);
          return new Map(
            rows.map((selected) => [
              selected.id,
              {
                indexIds: [corpusIndexId(generation, selected.country)],
                revision: 1,
                mayHaveCopy: true,
              },
            ]),
          );
        },
      }),
    ).toEqual({ indexed: 1, status: "advanced" });

    const reservation = events.indexOf("reserved");
    const firstRemote = events.indexOf("remote-guard");
    expect(reservation).toBeGreaterThanOrEqual(0);
    expect(firstRemote).toBeGreaterThan(reservation);
    expect(events).toContain("ingest");

    events.length = 0;
    expect(
      await indexer.backfillFenced(scopedDb, 1, "case_law_v1", {
        beforeDatabaseMark: async () => {
          events.push("mark-guard");
        },
        beforeRemoteEffect: async ({ effect }) => {
          events.push("remote-guard");
          return await effect();
        },
        recoverRemoteEffectLeaseLoss: async () => await Promise.resolve(),
        reserveExternalAppend: async () => {
          events.push("reservation-missed");
          return new Map();
        },
      }),
    ).toEqual({ indexed: 0, status: "retry" });
    expect(events).toEqual(["mark-guard", "reservation-missed"]);
  });
});

/**
 * The indexer's audit trail is the only record of a row it could not place: a
 * row that is neither marked indexed nor recorded failed is invisible to an
 * operator. Failed jobs are buffered per group so several failure sites share
 * one write, and this pins the part that is easy to lose again — the buffer
 * must not outlive the group that filled it, and it must be flushed even when
 * the work around it throws.
 */
describe("failed index jobs always reach the audit trail", () => {
  const originalFetch = globalThis.fetch;
  const GENERATION = "case_law_v2";
  const CZ_INDEX_ID = corpusIndexId(GENERATION, "CZ");

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const makeRow = (id: string, country: string) => ({
    id: toSafeId<"caseLawDecision">(id),
    country,
    textS3Key: null,
    astS3Key: null,
    contentHash: `hash-${id}`,
    indexedHash: null,
    indexedGeneration: null,
    // SAFETY: tests fabricate the branded token the adapters normally
    // select as `updated_at::text`.
    // eslint-disable-next-line typescript/no-unsafe-type-assertion
    updatedAtToken: "2026-01-01 00:00:00" as TimestampCasToken,
  });

  beforeEach(() => {
    // The CZ index rejects its ingest; the SK index accepts. Everything else
    // the indexer probes succeeds.
    let nextDeleteOpstamp = 0;
    const resolveUrl = (input: Parameters<typeof fetch>[0]): string => {
      if (typeof input === "string") {
        return input;
      }
      return input instanceof URL ? input.href : input.url;
    };
    const stub = async (input: Parameters<typeof fetch>[0]) => {
      const url = resolveUrl(input);
      if (url.includes(`${CZ_INDEX_ID}/ingest`)) {
        return new Response("rejected", { status: 500 });
      }
      if (url.includes("/ingest")) {
        return new Response(JSON.stringify({ num_docs_for_processing: 1 }), {
          status: 200,
        });
      }
      if (url.includes("/delete-tasks")) {
        nextDeleteOpstamp += 1;
        return new Response(JSON.stringify({ opstamp: nextDeleteOpstamp }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };
    globalThis.fetch = Object.assign(stub, {
      preconnect: originalFetch.preconnect,
    });
  });

  test("an earlier group's failure is recorded even when a later group throws", async () => {
    const recorded: {
      indexId: string;
      jobs: CorpusJobInput<"caseLawDecision">[];
    }[] = [];
    const czRow = makeRow("dec-cz", "CZ");
    const skRow = makeRow("dec-sk", "SK");

    // The only place `backfill` opens a transaction is the compare-and-set
    // commit, so failing here is exactly the DB error being simulated — and it
    // means the fake never has to conjure a `Transaction`.
    const scopedDb: ScopedDb = async () => {
      throw new Error("connection reset during CAS");
    };

    const indexer = createCorpusIndexer<"caseLawDecision", typeof czRow>({
      family: "case_law",
      captureStep: "test",
      granularity: "document",
      generationProjectionIndexIds: () => [],
      buildDocs: (row) => [{ document_id: row.id, text: "body" }],
      readCorpusText: async () => "body",
      selectMissing: async () => [czRow, skRow],
      selectStale: async () => [],
      fetchFulltext: async () => "body",
      markIndexedBatch: async (_tx, { rows }) =>
        new Set(rows.map((row) => row.id)),
      insertSucceededJobs: async () => undefined,
      recordJobs: async (_db, jobs, indexId) => {
        recorded.push({ indexId, jobs: [...jobs] });
      },
      recordDeleteJobs: async () => undefined,
    });

    const outcome = await indexer.backfill(scopedDb, 10, GENERATION).then(
      () => null,
      (error: unknown) => error,
    );

    // The later group's failure still propagates, so the daemon retries.
    expect(outcome instanceof Error ? outcome.message : null).toBe(
      "connection reset during CAS",
    );

    // ...and the earlier group's rejected ingest left an audit row behind.
    const czJobs = recorded.filter((entry) => entry.indexId === CZ_INDEX_ID);
    expect(czJobs).toHaveLength(1);
    expect(czJobs.at(0)?.jobs.map((job) => job.entityId)).toEqual([czRow.id]);
    expect(czJobs.at(0)?.jobs.at(0)?.status).toBe("failed");
    expect(czJobs.at(0)?.jobs.at(0)?.operation).toBe("index");
  });

  test("a lease-lost ingest is converted into a failed audit job", async () => {
    const row = makeRow("dec-lease-lost", "SK");
    const recorded: CorpusJobInput<"caseLawDecision">[] = [];
    let lastUrl = "";
    let recoveries = 0;
    const stub = async (input: Parameters<typeof fetch>[0]) => {
      if (typeof input === "string") {
        lastUrl = input;
      } else if (input instanceof URL) {
        lastUrl = input.href;
      } else {
        lastUrl = input.url;
      }
      if (lastUrl.includes("/ingest")) {
        return new Response(JSON.stringify({ num_docs_for_processing: 1 }), {
          status: 200,
        });
      }
      if (lastUrl.includes("/delete-tasks")) {
        return new Response(JSON.stringify({ opstamp: 1 }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };
    globalThis.fetch = Object.assign(stub, {
      preconnect: originalFetch.preconnect,
    });
    const scopedDb: ScopedDb = async (callback) =>
      // SAFETY: this invariant observes transaction boundaries only.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- deliberately inert transaction
      await callback({} as Transaction);
    const indexer = createCorpusIndexer<"caseLawDecision", typeof row>({
      family: "case_law",
      captureStep: "test",
      granularity: "document",
      generationProjectionIndexIds: () => [],
      buildDocs: (selected) => [{ document_id: selected.id, text: "body" }],
      readCorpusText: async () => "body",
      selectMissing: async () => [row],
      selectStale: async () => [],
      fetchFulltext: async () => "body",
      markIndexedBatch: async () => new Set(),
      insertSucceededJobs: async () => undefined,
      recordJobs: async (_db, jobs) => {
        recorded.push(...jobs);
      },
      recordDeleteJobs: async () => undefined,
    });

    const outcome: unknown = await indexer
      .backfillFenced(scopedDb, 1, GENERATION, {
        beforeDatabaseMark: async () => await Promise.resolve(),
        beforeRemoteEffect: async ({ effect, onLeaseLost }) => {
          lastUrl = "";
          const result = await effect();
          if (lastUrl.includes("/ingest")) {
            await onLeaseLost();
            throw new Error("writer lease expired after ingest");
          }
          return result;
        },
        recoverRemoteEffectLeaseLoss: async () => {
          recoveries += 1;
        },
        reserveExternalAppend: async (_tx, { generation, rows }) =>
          new Map(
            rows.map((selected) => [
              selected.id,
              {
                indexIds: [corpusIndexId(generation, selected.country)],
                revision: 1,
                mayHaveCopy: true,
              },
            ]),
          ),
      })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(outcome instanceof Error ? outcome.message : null).toContain(
      "writer lease expired after ingest",
    );
    expect(recoveries).toBe(1);
    const failedIngests = recorded.filter(
      ({ operation, status }) => operation === "index" && status === "failed",
    );
    expect(failedIngests).toHaveLength(1);
    expect(failedIngests.at(0)).toMatchObject({
      entityId: row.id,
      operation: "index",
      status: "failed",
    });
    expect(failedIngests.at(0)?.errorMessage).toContain(
      "writer lease expired after ingest",
    );
  });

  test("reserved replays delete every durable target in rebuild and serving modes", async () => {
    const calls: { method: string; url: string; body?: string }[] = [];
    let nextDeleteOpstamp = 0;
    const stub = async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      let url: string;
      if (typeof input === "string") {
        url = input;
      } else if (input instanceof URL) {
        url = input.href;
      } else {
        url = input.url;
      }
      calls.push({
        method: init?.method ?? "GET",
        url,
        ...(typeof init?.body === "string" ? { body: init.body } : {}),
      });
      if (url.includes("/ingest")) {
        return new Response(JSON.stringify({ num_docs_for_processing: 1 }), {
          status: 200,
        });
      }
      if (url.includes("/delete-tasks")) {
        nextDeleteOpstamp += 1;
        return new Response(JSON.stringify({ opstamp: nextDeleteOpstamp }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };
    globalThis.fetch = Object.assign(stub, {
      preconnect: originalFetch.preconnect,
    });

    const row = {
      ...makeRow("dec-replay", "CZ"),
      indexedGeneration: corpusIndexId("case_law_v1", "CZ"),
      projectionIndexId: corpusIndexId(GENERATION, "SK"),
    };
    const scopedDb: ScopedDb = async (callback) =>
      // SAFETY: this test's adapter ignores the transaction; the callback
      // boundary itself is what the indexer must cross before reporting success.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the fake transaction is deliberately inert
      await callback({} as Transaction);
    const commitEvents: string[] = [];
    const indexer = createCorpusIndexer<"caseLawDecision", typeof row>({
      family: "case_law",
      captureStep: "test",
      granularity: "document",
      generationProjectionIndexIds: (selected) => [selected.projectionIndexId],
      buildDocs: (selected) => [{ document_id: selected.id, text: "body" }],
      readCorpusText: async () => "body",
      selectMissing: async () => [row],
      selectStale: async () => [],
      fetchFulltext: async () => "body",
      markIndexedBatch: async (_tx, { rows }) => {
        commitEvents.push("mark");
        return new Set(rows.map((selected) => selected.id));
      },
      insertSucceededJobs: async () => undefined,
      recordJobs: async () => undefined,
      recordDeleteJobs: async () => undefined,
    });

    let guardedEffects = 0;
    let guardedMarks = 0;
    const outcome = await indexer.backfillRows(scopedDb, [row], GENERATION, {
      commit: CORPUS_INDEX_COMMIT.auto,
      beforeDatabaseMark: async () => {
        guardedMarks += 1;
        commitEvents.push("guard");
      },
      beforeRemoteEffect: async ({ effect }) => {
        guardedEffects += 1;
        return await effect();
      },
      recoverRemoteEffectLeaseLoss: async () => await Promise.resolve(),
      reserveExternalAppend: async (_tx, { generation, rows }) =>
        new Map(
          rows.map((selected) => [
            selected.id,
            {
              indexIds: [
                corpusIndexId(generation, selected.country),
                selected.projectionIndexId,
              ],
              revision: 2,
              mayHaveCopy: true,
            },
          ]),
        ),
    });

    expect(outcome).toEqual({ indexed: 1, refreshed: 0, unread: 0 });
    const deleteCalls = calls
      .map(({ url, body }, index) => ({ url, body, index }))
      .filter(({ url }) => url.includes("/delete-tasks"));
    const ingestCall = calls.findIndex(({ url }) => url.includes("/ingest"));
    expect(deleteCalls).toHaveLength(2);
    expect(deleteCalls.map(({ url }) => new URL(url).pathname).sort()).toEqual(
      [
        `/api/v1/${corpusIndexId(GENERATION, "CZ")}/delete-tasks`,
        `/api/v1/${corpusIndexId(GENERATION, "SK")}/delete-tasks`,
      ].sort(),
    );
    expect(deleteCalls.every(({ index }) => index < ingestCall)).toBe(true);
    expect(deleteCalls.map(({ body }) => body)).toEqual([
      JSON.stringify({ query: 'document_id:"dec-replay"' }),
      JSON.stringify({ query: 'document_id:"dec-replay"' }),
    ]);
    expect(guardedEffects).toBe(calls.length);
    expect(guardedMarks).toBe(2);
    expect(commitEvents).toEqual(["guard", "guard", "mark"]);

    calls.length = 0;
    commitEvents.length = 0;
    guardedEffects = 0;
    guardedMarks = 0;
    const sameIndexRow = {
      ...makeRow("dec-replay-same", "CZ"),
      indexedGeneration: corpusIndexId(GENERATION, "CZ"),
      projectionIndexId: corpusIndexId(GENERATION, "CZ"),
    };
    expect(
      await indexer.backfillRows(scopedDb, [sameIndexRow], GENERATION, {
        commit: CORPUS_INDEX_COMMIT.auto,
        beforeDatabaseMark: async () => {
          guardedMarks += 1;
          commitEvents.push("guard");
        },
        beforeRemoteEffect: async ({ effect }) => {
          guardedEffects += 1;
          return await effect();
        },
        recoverRemoteEffectLeaseLoss: async () => await Promise.resolve(),
        reserveExternalAppend: async (_tx, { generation, rows }) =>
          new Map(
            rows.map((selected) => [
              selected.id,
              {
                indexIds: [
                  corpusIndexId(generation, selected.country),
                  selected.projectionIndexId,
                ],
                revision: 2,
                mayHaveCopy: true,
              },
            ]),
          ),
      }),
    ).toEqual({ indexed: 1, refreshed: 0, unread: 0 });
    expect(
      calls.filter(({ url }) => url.includes("/delete-tasks")),
    ).toHaveLength(1);
    expect(guardedEffects).toBe(calls.length);
    expect(guardedMarks).toBe(2);
    expect(commitEvents).toEqual(["guard", "guard", "mark"]);

    calls.length = 0;
    commitEvents.length = 0;
    guardedEffects = 0;
    guardedMarks = 0;
    const lateReservedIndexId = corpusIndexId(GENERATION, "PL");
    expect(
      await indexer.backfillFenced(scopedDb, 1, GENERATION, {
        beforeDatabaseMark: async () => {
          guardedMarks += 1;
          commitEvents.push("guard");
        },
        beforeRemoteEffect: async ({ effect }) => {
          guardedEffects += 1;
          return await effect();
        },
        recoverRemoteEffectLeaseLoss: async () => await Promise.resolve(),
        reserveExternalAppend: async (_tx, { generation, rows }) =>
          new Map(
            rows.map((selected) => [
              selected.id,
              {
                indexIds: [
                  corpusIndexId(generation, selected.country),
                  selected.projectionIndexId,
                  lateReservedIndexId,
                ],
                revision: 2,
                mayHaveCopy: true,
              },
            ]),
          ),
      }),
    ).toEqual({ indexed: 1, status: "advanced" });
    expect(
      calls
        .filter(({ url }) => url.includes("/delete-tasks"))
        .map(({ url }) => new URL(url).pathname)
        .sort(),
    ).toEqual(
      [
        `/api/v1/${corpusIndexId(GENERATION, "CZ")}/delete-tasks`,
        `/api/v1/${corpusIndexId(GENERATION, "SK")}/delete-tasks`,
        `/api/v1/${lateReservedIndexId}/delete-tasks`,
      ].sort(),
    );
    expect(guardedEffects).toBe(calls.length);
    expect(guardedMarks).toBe(2);
    expect(commitEvents).toEqual(["guard", "guard", "mark"]);
  });
});

/**
 * Acceptance and durability are not the same thing. `commit=auto` returns
 * once the documents are buffered, so an indexer that dies inside the
 * commit window loses them — and the caller has already been told the
 * batch was accepted, which is what it marks `indexedHash` on. The row is
 * then neither missing (it has a hash) nor stale (the hash matches), so
 * nothing ever selects it again and the gap is permanent and silent.
 *
 * A bulk rebuild can afford `auto` because its completeness is checked
 * against a census afterwards. The steady-state paths cannot, so the mode
 * is pinned per entry point rather than left to whichever call site was
 * written last.
 */
describe("ingest commit mode", () => {
  const originalFetch = globalThis.fetch;
  const GENERATION = "case_law_v2";

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const row = {
    id: toSafeId<"caseLawDecision">("dec-commit"),
    country: "SK",
    textS3Key: null,
    astS3Key: null,
    contentHash: "hash-dec-commit",
    indexedHash: null,
    indexedGeneration: null,
    projectionIndexId: corpusIndexId(GENERATION, "SK"),
    // SAFETY: tests fabricate the branded token the adapters normally
    // select as `updated_at::text`.
    // eslint-disable-next-line typescript/no-unsafe-type-assertion
    updatedAtToken: "2026-01-01 00:00:00" as TimestampCasToken,
  };

  const scopedDb: ScopedDb = async (callback) =>
    // SAFETY: this test's adapter ignores the transaction.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the fake transaction is deliberately inert
    await callback({} as Transaction);

  const fencedGuards = {
    beforeDatabaseMark: async () => undefined,
    beforeRemoteEffect: async <T>({ effect }: FencedRemoteEffect<T>) =>
      await effect(),
    recoverRemoteEffectLeaseLoss: async () => await Promise.resolve(),
    reserveExternalAppend: async (
      _tx: Transaction,
      { generation }: { generation: string; rows: readonly (typeof row)[] },
    ) =>
      new Map([
        [
          row.id,
          {
            indexIds: [corpusIndexId(generation, row.country)],
            revision: 1,
            mayHaveCopy: false,
          },
        ],
      ]),
  };

  /** The commit modes the engine was asked for, in request order. */
  const recordCommitModes = (): string[] => {
    const modes: string[] = [];
    const resolveUrl = (input: Parameters<typeof fetch>[0]): string => {
      if (typeof input === "string") {
        return input;
      }
      return input instanceof URL ? input.href : input.url;
    };
    const stub = async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(resolveUrl(input));
      if (url.pathname.endsWith("/ingest")) {
        modes.push(url.searchParams.get("commit") ?? "");
        return new Response(JSON.stringify({ num_docs_for_processing: 1 }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };
    globalThis.fetch = Object.assign(stub, {
      preconnect: originalFetch.preconnect,
    });
    return modes;
  };

  const makeIndexer = () =>
    createCorpusIndexer<"caseLawDecision", typeof row>({
      family: "case_law",
      captureStep: "test",
      granularity: "document",
      generationProjectionIndexIds: (selected) => [selected.projectionIndexId],
      buildDocs: (selected) => [{ document_id: selected.id, text: "body" }],
      readCorpusText: async () => "body",
      selectMissing: async () => [row],
      selectStale: async () => [],
      fetchFulltext: async () => "body",
      markIndexedBatch: async (_tx, { rows }) =>
        new Set(rows.map((selected) => selected.id)),
      insertSucceededJobs: async () => undefined,
      recordJobs: async () => undefined,
      recordDeleteJobs: async () => undefined,
    });

  test("the incremental backfill waits for the commit", async () => {
    const modes = recordCommitModes();

    await makeIndexer().backfill(scopedDb, 1, GENERATION);

    expect(modes).toEqual([CORPUS_INDEX_COMMIT.waitFor]);
  });

  test("the fenced incremental backfill waits for the commit", async () => {
    const modes = recordCommitModes();

    await makeIndexer().backfillFenced(scopedDb, 1, GENERATION, fencedGuards);

    expect(modes).toEqual([CORPUS_INDEX_COMMIT.waitFor]);
  });

  test("a rebuild sends the mode its caller chose", async () => {
    // One entry point, two walks: the snapshot pages are bulk and the
    // pending queue drained alongside them is the live path, so the
    // caller states which it is.
    for (const commit of Object.values(CORPUS_INDEX_COMMIT)) {
      const modes = recordCommitModes();
      // oxlint-disable-next-line no-await-in-loop -- one walk per mode; the recorder is per-stub
      await makeIndexer().backfillRows(scopedDb, [row], GENERATION, {
        ...fencedGuards,
        commit,
      });
      expect(modes).toEqual([commit]);
    }
  });
});

describe("first-ever fenced appends", () => {
  const GENERATION = "case_law_v2";
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("a first-ever reservation appends without any delete round-trip", async () => {
    // The reservation persists before the external append, so revision 1
    // proves no earlier append under this generation can have left a copy.
    // A backlog drain is almost entirely first-ever rows; a delete per row
    // was its entire cost profile.
    const calls: { url: string }[] = [];
    const stub = async (input: Parameters<typeof fetch>[0]) => {
      let url: string;
      if (typeof input === "string") {
        url = input;
      } else if (input instanceof URL) {
        url = input.href;
      } else {
        url = input.url;
      }
      calls.push({ url });
      if (url.includes("/ingest")) {
        return new Response(JSON.stringify({ num_docs_for_processing: 1 }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };
    globalThis.fetch = Object.assign(stub, {
      preconnect: originalFetch.preconnect,
    });

    const row = {
      id: toSafeId<"caseLawDecision">("dec-first"),
      country: "CZ",
      textS3Key: null,
      astS3Key: null,
      contentHash: "hash-dec-first",
      indexedHash: null,
      indexedGeneration: null,
      // SAFETY: tests fabricate the branded token the adapters normally
      // select as `updated_at::text`.
      // eslint-disable-next-line typescript/no-unsafe-type-assertion
      updatedAtToken: "2026-01-01 00:00:00" as TimestampCasToken,
      projectionIndexId: corpusIndexId(GENERATION, "SK"),
    };
    const scopedDb: ScopedDb = async (callback) =>
      // SAFETY: this test's adapter ignores the transaction; the callback
      // boundary itself is what the indexer must cross before reporting success.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the fake transaction is deliberately inert
      await callback({} as Transaction);
    const indexer = createCorpusIndexer<"caseLawDecision", typeof row>({
      family: "case_law",
      captureStep: "test",
      granularity: "document",
      generationProjectionIndexIds: (selected) => [selected.projectionIndexId],
      buildDocs: (selected) => [{ document_id: selected.id, text: "body" }],
      readCorpusText: async () => "body",
      selectMissing: async () => [row],
      selectStale: async () => [],
      fetchFulltext: async () => "body",
      markIndexedBatch: async (_tx, { rows: markedRows }) =>
        new Set(markedRows.map((selected) => selected.id)),
      insertSucceededJobs: async () => undefined,
      recordJobs: async () => undefined,
      recordDeleteJobs: async () => undefined,
    });

    const outcome = await indexer.backfillRows(scopedDb, [row], GENERATION, {
      commit: CORPUS_INDEX_COMMIT.auto,
      beforeDatabaseMark: async () => undefined,
      beforeRemoteEffect: async ({ effect }) => await effect(),
      recoverRemoteEffectLeaseLoss: async () => await Promise.resolve(),
      reserveExternalAppend: async (_tx, { generation, rows: reservedRows }) =>
        new Map(
          reservedRows.map((selected) => [
            selected.id,
            {
              indexIds: [corpusIndexId(generation, selected.country)],
              revision: 1,
              mayHaveCopy: false,
            },
          ]),
        ),
    });

    expect(outcome).toEqual({ indexed: 1, refreshed: 0, unread: 0 });
    expect(calls.filter(({ url }) => url.includes("/delete-tasks"))).toEqual(
      [],
    );
    expect(calls.some(({ url }) => url.includes("/ingest"))).toBe(true);
  });

  // Reports back exactly as many documents as the request carried, so a test
  // that varies how many rows survive to the ingest does not also have to
  // restate the count the engine is expected to accept.
  const acceptEveryIngest = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url = requestUrl(input);
    if (url.includes("/delete-tasks")) {
      return new Response(JSON.stringify({ opstamp: 1 }), { status: 200 });
    }
    if (!url.includes("/ingest")) {
      return new Response(JSON.stringify({}), { status: 200 });
    }
    const body = typeof init?.body === "string" ? init.body : "";
    return new Response(
      JSON.stringify({
        num_docs_for_processing: body.split("\n").filter(Boolean).length,
      }),
      { status: 200 },
    );
  };

  // Shared by the three outcome-accounting tests below. Each varies exactly
  // one adapter behaviour, so the bucket a row lands in is the only thing
  // that differs between them.
  const outcomeRow = (id: string) => ({
    id: toSafeId<"caseLawDecision">(id),
    country: "CZ",
    textS3Key: null,
    astS3Key: null,
    contentHash: `hash-${id}`,
    indexedHash: null,
    indexedGeneration: null,
    // SAFETY: tests fabricate the branded token the adapters normally
    // select as `updated_at::text`.
    // eslint-disable-next-line typescript/no-unsafe-type-assertion
    updatedAtToken: "2026-01-01 00:00:00" as TimestampCasToken,
    projectionIndexId: corpusIndexId(GENERATION, "CZ"),
  });

  const outcomeScopedDb: ScopedDb = async (callback) =>
    // SAFETY: these tests' adapter ignores the transaction.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the fake transaction is deliberately inert
    await callback({} as Transaction);

  const outcomeGuards = {
    commit: CORPUS_INDEX_COMMIT.auto,
    beforeDatabaseMark: async () => undefined,
    beforeRemoteEffect: async <T>({ effect }: FencedRemoteEffect<T>) =>
      await effect(),
    recoverRemoteEffectLeaseLoss: async () => await Promise.resolve(),
  };

  const outcomeAdapterBase = {
    family: "case_law" as const,
    captureStep: "test",
    // Pinned outside the overrides below: it is the adapter union's
    // discriminator, so letting a test widen it would erase the branch.
    granularity: "document" as const,
    generationProjectionIndexIds: (selected: ReturnType<typeof outcomeRow>) => [
      selected.projectionIndexId,
    ],
    buildDocs: (selected: ReturnType<typeof outcomeRow>) => [
      { document_id: selected.id, text: "body" },
    ],
    readCorpusText: async () => "body",
    selectMissing: async () => [],
    selectStale: async () => [],
    fetchFulltext: async (
      _db: ScopedDb,
      _id: SafeId<"caseLawDecision">,
    ): Promise<string | null> => "body",
    markIndexedBatch: async (
      _tx: Transaction,
      { rows }: { rows: readonly ReturnType<typeof outcomeRow>[] },
    ) => new Set(rows.map((selected) => selected.id)),
    insertSucceededJobs: async () => undefined,
    recordJobs: async (
      _db: ScopedDb,
      _jobs: readonly CorpusJobInput<"caseLawDecision">[],
      _indexId: string,
    ): Promise<void> => undefined,
    recordDeleteJobs: async (): Promise<void> => undefined,
  };

  const outcomeIndexer = (
    overrides: Partial<Omit<typeof outcomeAdapterBase, "granularity">>,
  ) =>
    createCorpusIndexer<"caseLawDecision", ReturnType<typeof outcomeRow>>({
      ...outcomeAdapterBase,
      ...overrides,
    });

  // A caller comparing `indexed` against the rows it selected reads a lost
  // compare-and-set as a lost update. It is neither: the refreshed row is
  // queued for the next cycle and its unrecorded copies are deleted here.
  // Reporting the split is what lets the caller tell the two apart, and the
  // sum is what proves no row went unaccounted for.
  test("a lost compare-and-set is reported as refreshed, not as a missing row", async () => {
    globalThis.fetch = Object.assign(acceptEveryIngest, {
      preconnect: originalFetch.preconnect,
    });

    const settled = outcomeRow("dec-settled");
    const refreshed = outcomeRow("dec-refreshed");
    const indexer = outcomeIndexer({
      // The refreshed row's mark loses: another writer bumped it between
      // selection and this transaction.
      markIndexedBatch: async () => new Set([settled.id]),
    });

    const outcome = await indexer.backfillRows(
      outcomeScopedDb,
      [settled, refreshed],
      GENERATION,
      {
        ...outcomeGuards,
        reserveExternalAppend: async (
          _tx,
          { generation, rows: reservedRows },
        ) =>
          new Map(
            reservedRows.map((selected) => [
              selected.id,
              {
                indexIds: [corpusIndexId(generation, selected.country)],
                revision: 1,
                mayHaveCopy: false,
              },
            ]),
          ),
      },
    );

    expect(outcome).toEqual({ indexed: 1, refreshed: 1, unread: 0 });
    expect(outcome.indexed + outcome.refreshed + outcome.unread).toBe(2);
  });

  // The reservation is the earlier of the two places a concurrent refresh can
  // take a row out of the batch, and it drops the row before the external
  // append rather than after it. It lands in the same bucket, so the two sites
  // are covered separately or one of them can stop counting unnoticed.
  test("a row the append reservation drops is reported as refreshed", async () => {
    globalThis.fetch = Object.assign(acceptEveryIngest, {
      preconnect: originalFetch.preconnect,
    });

    const reserved = outcomeRow("dec-reserved");
    const dropped = outcomeRow("dec-dropped");
    const indexer = outcomeIndexer({
      markIndexedBatch: async (_tx, { rows: markedRows }) =>
        new Set(markedRows.map((selected) => selected.id)),
    });

    const outcome = await indexer.backfillRows(
      outcomeScopedDb,
      [reserved, dropped],
      GENERATION,
      {
        ...outcomeGuards,
        // Only one of the two rows gets an epoch: the other moved after the
        // batch read, so its old payload must not cross the append boundary.
        reserveExternalAppend: async (_tx, { generation }) =>
          new Map([
            [
              reserved.id,
              {
                indexIds: [corpusIndexId(generation, reserved.country)],
                revision: 1,
                mayHaveCopy: false,
              },
            ],
          ]),
      },
    );

    expect(outcome).toEqual({ indexed: 1, refreshed: 1, unread: 0 });
    expect(outcome.indexed + outcome.refreshed + outcome.unread).toBe(2);
  });

  // An unreadable corpus object is the one shortfall that is a real failure.
  // It is already recorded as a failed job, so it must be reported apart from
  // a refresh: the two want opposite responses from whoever reads the count.
  test("a row whose corpus text cannot be read is reported as unread", async () => {
    globalThis.fetch = Object.assign(acceptEveryIngest, {
      preconnect: originalFetch.preconnect,
    });

    const readable = outcomeRow("dec-readable");
    const unreadable = outcomeRow("dec-unreadable");
    const recorded: CorpusJobInput<"caseLawDecision">[] = [];
    const indexer = outcomeIndexer({
      fetchFulltext: async (_db, id) => {
        if (id === unreadable.id) {
          throw new Error("corpus object unavailable");
        }
        return "body";
      },
      markIndexedBatch: async (_tx, { rows: markedRows }) =>
        new Set(markedRows.map((selected) => selected.id)),
      recordJobs: async (_db, jobs) => {
        recorded.push(...jobs);
      },
    });

    const outcome = await indexer.backfillRows(
      outcomeScopedDb,
      [readable, unreadable],
      GENERATION,
      {
        ...outcomeGuards,
        reserveExternalAppend: async (
          _tx,
          { generation, rows: reservedRows },
        ) =>
          new Map(
            reservedRows.map((selected) => [
              selected.id,
              {
                indexIds: [corpusIndexId(generation, selected.country)],
                revision: 1,
                mayHaveCopy: false,
              },
            ]),
          ),
      },
    );

    expect(outcome).toEqual({ indexed: 1, refreshed: 0, unread: 1 });
    expect(outcome.indexed + outcome.refreshed + outcome.unread).toBe(2);
    // The audit row is what makes an unread shortfall actionable; without it
    // the row would be invisible rather than merely uncounted.
    expect(recorded).toMatchObject([
      { entityId: unreadable.id, operation: "index", status: "failed" },
    ]);
  });
});

/**
 * The engine plans every delete task against every split whose delete opstamp
 * is behind it, so the cost of N tasks is O(N x splits) and it is charged to
 * the janitor asynchronously, long after the calls that created them returned.
 * A per-row delete therefore looks free at the call site and is not: it is the
 * shape that stops the planner converging at all.
 *
 * The invariant is not "a converged batch does nothing" — a re-projection
 * legitimately re-deletes. It is that the number of remote delete tasks scales
 * with the indexes a batch touches, never with the rows it carries. Measuring
 * two batch sizes is what makes that a property rather than an example: the
 * per-row shape fails it for any pair of sizes.
 */
describe("delete-task amplification", () => {
  const GENERATION = "case_law_v2";
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  type DeleteCall = { url: string; query: string };

  const runBatch = async (
    rowCount: number,
  ): Promise<{ deletes: DeleteCall[]; indexed: number }> => {
    const deletes: DeleteCall[] = [];
    let nextDeleteOpstamp = 0;
    const stub = async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      let url: string;
      if (typeof input === "string") {
        url = input;
      } else if (input instanceof URL) {
        url = input.href;
      } else {
        url = input.url;
      }
      // The client always sends a serialized string body; anything else is a
      // test-harness mistake, not a case to coerce.
      const body = typeof init?.body === "string" ? init.body : "";
      if (url.includes("/delete-tasks")) {
        const parsed: unknown = JSON.parse(body.length > 0 ? body : "{}");
        const query =
          isRecord(parsed) && typeof parsed["query"] === "string"
            ? parsed["query"]
            : "";
        deletes.push({ url, query });
        nextDeleteOpstamp += 1;
        return new Response(JSON.stringify({ opstamp: nextDeleteOpstamp }), {
          status: 200,
        });
      }
      if (url.includes("/ingest")) {
        const sent = body.split("\n").filter((line) => line.length > 0).length;
        return new Response(JSON.stringify({ num_docs_for_processing: sent }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };
    globalThis.fetch = Object.assign(stub, {
      preconnect: originalFetch.preconnect,
    });

    // One jurisdiction, so every row's previous copy lives in the same index:
    // the batch touches exactly one index however many rows it carries.
    const indexId = corpusIndexId(GENERATION, "CZ");
    const rows = Array.from({ length: rowCount }, (_, seq) => ({
      id: toSafeId<"caseLawDecision">(`dec-${seq}`),
      country: "CZ",
      textS3Key: null,
      astS3Key: null,
      contentHash: `hash-${seq}`,
      indexedHash: `stale-${seq}`,
      indexedGeneration: indexId,
      // SAFETY: tests fabricate the branded token the adapters normally
      // select as `updated_at::text`.
      // eslint-disable-next-line typescript/no-unsafe-type-assertion
      updatedAtToken: "2026-01-01 00:00:00" as TimestampCasToken,
      projectionIndexId: indexId,
    }));
    const scopedDb: ScopedDb = async (callback) =>
      // SAFETY: this test's adapter ignores the transaction; the callback
      // boundary itself is what the indexer must cross before reporting success.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the fake transaction is deliberately inert
      await callback({} as Transaction);
    const indexer = createCorpusIndexer<"caseLawDecision", (typeof rows)[0]>({
      family: "case_law",
      captureStep: "test",
      granularity: "document",
      generationProjectionIndexIds: (selected) => [selected.projectionIndexId],
      buildDocs: (selected) => [{ document_id: selected.id, text: "body" }],
      readCorpusText: async () => "body",
      selectMissing: async () => rows,
      selectStale: async () => [],
      fetchFulltext: async () => "body",
      markIndexedBatch: async (_tx, { rows: markedRows }) =>
        new Set(markedRows.map((selected) => selected.id)),
      insertSucceededJobs: async () => undefined,
      recordJobs: async () => undefined,
      recordDeleteJobs: async () => undefined,
    });

    const { indexed } = await indexer.backfillRows(scopedDb, rows, GENERATION, {
      commit: CORPUS_INDEX_COMMIT.auto,
      beforeDatabaseMark: async () => undefined,
      beforeRemoteEffect: async ({ effect }) => await effect(),
      recoverRemoteEffectLeaseLoss: async () => await Promise.resolve(),
      // A committed copy exists, so the replay delete genuinely has to run.
      reserveExternalAppend: async (_tx, { rows: reservedRows }) =>
        new Map(
          reservedRows.map((selected) => [
            selected.id,
            { indexIds: [indexId], revision: 2, mayHaveCopy: true },
          ]),
        ),
    });
    return { deletes, indexed };
  };

  test("delete-task count does not grow with batch size", async () => {
    const small = await runBatch(4);
    const large = await runBatch(40);

    expect(small.indexed).toBe(4);
    expect(large.indexed).toBe(40);
    // The load-bearing assertion. Restore a per-row delete and this reads
    // 4 vs 40.
    expect(large.deletes).toHaveLength(small.deletes.length);
    expect(small.deletes).toHaveLength(1);
  });

  test("every row still reaches a delete query", async () => {
    const { deletes } = await runBatch(40);
    const queried = deletes.map(({ query }) => query).join(" ");

    for (let seq = 0; seq < 40; seq += 1) {
      expect(queried).toContain(`document_id:"dec-${seq}"`);
    }
  });

  test("an id that could alter the query is rejected, not escaped", () => {
    // The terms are OR-joined, so one id that breaks out of its quotes
    // changes what the whole task deletes. Ids come from `uuid` columns; one
    // that reaches here in another shape is a defect upstream.
    expect(() => corpusDocumentsDeleteQuery(['a" OR document_id:"b'])).toThrow(
      'corpus delete query received an unusable document id: a" OR document_id:"b',
    );
    expect(corpusDocumentsDeleteQuery(["a1b2-c3", "d4e5_f6"])).toBe(
      'document_id:"a1b2-c3" OR document_id:"d4e5_f6"',
    );
  });

  test("chunking bounds one task's query without dropping ids", () => {
    const ids = Array.from({ length: 300 }, (_, seq) => `id-${seq}`);

    const chunks = deleteQueryChunks(ids);

    // Every id lands in exactly one chunk, and no chunk outgrows the bound.
    expect(chunks.flat()).toEqual(ids);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(128);
    }
  });
});
