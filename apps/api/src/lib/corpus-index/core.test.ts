import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { ScopedDb } from "@/api/db/safe-db";
import { toSafeId } from "@/api/lib/branded-types";
import type { CorpusJobInput } from "@/api/lib/corpus-index/core";
import {
  createCorpusIndexer,
  settleBoth,
  splitIngestRequests,
} from "@/api/lib/corpus-index/core";
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
    updatedAt: new Date("2026-01-01T00:00:00Z"),
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
      buildDocs: (row) => [{ document_id: row.id, text: "body" }],
      readCorpusText: async () => "body",
      selectMissing: async () => [czRow, skRow],
      selectStale: async () => [],
      fetchFulltext: async () => "body",
      markIndexed: async () => true,
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
});
