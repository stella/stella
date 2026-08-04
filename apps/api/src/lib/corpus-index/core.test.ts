import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { toSafeId } from "@/api/lib/branded-types";
import type { CorpusJobInput } from "@/api/lib/corpus-index/core";
import {
  createCorpusIndexer,
  settleAll,
  settleAllCleanup,
  settleBoth,
  splitIngestRequests,
} from "@/api/lib/corpus-index/core";
import type { TimestampCasToken } from "@/api/lib/db/timestamp-cas";
import { corpusIndexId } from "@/api/lib/legal-search/index-naming";

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
    });
    globalThis.fetch = Object.assign(
      async () => new Response(JSON.stringify({}), { status: 200 }),
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
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        const url = input instanceof Request ? input.url : String(input);
        events.push(url.includes("/ingest") ? "ingest" : "remote");
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
      // eslint-disable-next-line node/callback-return, typescript/no-unsafe-type-assertion -- inert transaction boundary for ordering test
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
      return new Response(JSON.stringify({}), { status: 200 });
    };
    globalThis.fetch = Object.assign(stub, {
      preconnect: originalFetch.preconnect,
    });
    const scopedDb: ScopedDb = async (callback) =>
      // SAFETY: this invariant observes transaction boundaries only.
      // oxlint-disable-next-line node/callback-return, typescript/no-unsafe-type-assertion -- deliberately inert transaction
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
      // oxlint-disable-next-line node/callback-return, typescript/no-unsafe-type-assertion -- the fake transaction is deliberately inert
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
    });

    let guardedEffects = 0;
    let guardedMarks = 0;
    const indexed = await indexer.backfillRows(scopedDb, [row], GENERATION, {
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
            },
          ]),
        ),
    });

    expect(indexed).toBe(1);
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
              },
            ]),
          ),
      }),
    ).toBe(1);
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
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
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
      // oxlint-disable-next-line node/callback-return, typescript/no-unsafe-type-assertion -- the fake transaction is deliberately inert
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
    });

    const indexed = await indexer.backfillRows(scopedDb, [row], GENERATION, {
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
            },
          ]),
        ),
    });

    expect(indexed).toBe(1);
    expect(calls.filter(({ url }) => url.includes("/delete-tasks"))).toEqual(
      [],
    );
    expect(calls.some(({ url }) => url.includes("/ingest"))).toBe(true);
  });
});
