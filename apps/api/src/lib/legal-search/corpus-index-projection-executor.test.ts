import { Result } from "better-result";
import { expect, test } from "bun:test";

import { PayloadBudgetError } from "@/api/lib/compression";
import {
  CORPUS_PROJECTION_APPEND_COMMIT_MODE,
  CORPUS_PROJECTION_APPEND_MAX_REQUEST_BYTES,
} from "@/api/lib/legal-search/corpus-index-projection-engine";
import {
  advanceCorpusProjectionAppendTails,
  classifyCorpusProjectionPayloadReadFailure,
  ingestCorpusProjectionRequest,
} from "@/api/lib/legal-search/corpus-index-projection-executor";
import { S3ObjectBudgetError } from "@/api/lib/s3";

test("payload budget failures block on the first read", () => {
  expect(
    classifyCorpusProjectionPayloadReadFailure(
      new PayloadBudgetError({ message: "payload too large" }),
    ),
  ).toEqual({
    kind: "revision_too_large",
    message: "projection payload exceeds the transfer or decode ceiling",
  });
});

test("whole-object transfer ceilings block on the first read", () => {
  expect(
    classifyCorpusProjectionPayloadReadFailure(
      new S3ObjectBudgetError({
        message: "object too large",
        key: "corpus/object.zst",
        declaredBytes: 2,
        maxBytes: 1,
      }),
    ),
  ).toEqual({
    kind: "revision_too_large",
    message: "projection payload exceeds the transfer or decode ceiling",
  });
});

test("transient payload failures remain retryable", () => {
  expect(
    classifyCorpusProjectionPayloadReadFailure(new Error("socket closed")),
  ).toEqual({
    kind: "payload_unavailable",
    message: "projection payload read failed before append",
  });
});

test("append tails coalesce serialized revisions across read windows", () => {
  const tails = new Map();
  const first = advanceCorpusProjectionAppendTails({
    tails,
    entries: [
      {
        indexId: "case_law_v5_cs_sk",
        ndjson: "cs-1",
        ndjsonBytes: 5,
        leaseExpiresAtMs: 300_000,
      },
    ],
    mode: "buffer",
    nowMs: 0,
  });
  expect(first.flush).toEqual([]);

  const second = advanceCorpusProjectionAppendTails({
    tails: first.tails,
    entries: [
      {
        indexId: "case_law_v5_cs_sk",
        ndjson: "cs-2",
        ndjsonBytes: 5,
        leaseExpiresAtMs: 300_000,
      },
    ],
    mode: "flush-all",
    nowMs: 1,
  });
  expect(second.flush.at(0)?.entries.map(({ ndjson }) => ndjson)).toEqual([
    "cs-1",
    "cs-2",
  ]);
  expect(second.flush.at(0)?.ndjsonBytes).toBe(10);
  expect(second.flush.at(0)?.earliestLeaseExpiresAtMs).toBe(300_000);
  expect(second.tails.size).toBe(0);
});

test("append tails flush before their earliest lease deadline", () => {
  const result = advanceCorpusProjectionAppendTails({
    tails: new Map(),
    entries: [
      {
        indexId: "case_law_v5_cs_sk",
        ndjson: "cs-1",
        ndjsonBytes: 5,
        leaseExpiresAtMs: 1000,
      },
    ],
    mode: "buffer",
    nowMs: 999,
  });
  expect(result.flush).toHaveLength(1);
  expect(result.tails.size).toBe(0);
});

test("append tails flush before crossing the physical request budget", () => {
  const result = advanceCorpusProjectionAppendTails({
    tails: new Map(),
    entries: [
      {
        indexId: "case_law_v5_cs_sk",
        ndjson: "cs-1",
        ndjsonBytes: CORPUS_PROJECTION_APPEND_MAX_REQUEST_BYTES - 1,
        leaseExpiresAtMs: 300_000,
      },
      {
        indexId: "case_law_v5_cs_sk",
        ndjson: "cs-2",
        ndjsonBytes: 2,
        leaseExpiresAtMs: 300_000,
      },
    ],
    mode: "buffer",
    nowMs: 0,
  });
  expect(result.flush).toHaveLength(1);
  expect(result.flush.at(0)?.entries.map(({ ndjson }) => ndjson)).toEqual([
    "cs-1",
  ]);
  expect(
    result.tails.get("case_law_v5_cs_sk")?.entries.map(({ ndjson }) => ndjson),
  ).toEqual(["cs-2"]);
});

test("the commit mode picks the ingest the request runs through", async () => {
  const calls: string[] = [];
  const client = {
    ingestCommittedBatch: async () => {
      calls.push(CORPUS_PROJECTION_APPEND_COMMIT_MODE.published);
      return Result.ok(undefined);
    },
    ingestQueuedBatch: async () => {
      calls.push(CORPUS_PROJECTION_APPEND_COMMIT_MODE.queued);
      return Result.ok(undefined);
    },
  };

  for (const commitMode of Object.values(
    CORPUS_PROJECTION_APPEND_COMMIT_MODE,
  )) {
    expect(
      (
        await ingestCorpusProjectionRequest(client, {
          commitMode,
          indexId: "case_law_v5_cs_sk",
          ndjson: '{"document_id":"a"}',
        })
      ).isOk(),
    ).toBe(true);
  }

  expect(calls).toEqual(Object.values(CORPUS_PROJECTION_APPEND_COMMIT_MODE));
});

/**
 * The payload pool hands revisions to the tails one at a time, where the read
 * window handed over up to a window at once. Every physical index has to see
 * the same revisions, in the same order, packed into the same requests: the
 * appended bytes are the contract, and batching is not part of it.
 */
test("append requests do not depend on how many revisions arrive at once", () => {
  const entryBytes = Math.floor(CORPUS_PROJECTION_APPEND_MAX_REQUEST_BYTES / 4);
  const entries = Array.from({ length: 40 }, (_unused, index) => ({
    indexId: index % 3 === 0 ? "case_law_v5_cs_sk" : "case_law_v6_cs_sk",
    ndjson: `revision-${index}`,
    ndjsonBytes: entryBytes,
    leaseExpiresAtMs: 600_000,
  }));

  const requestsPerIndex = (batchSize: number): Map<string, string[][]> => {
    let tails = new Map<
      string,
      {
        indexId: string;
        entries: (typeof entries)[number][];
        ndjsonBytes: number;
        earliestLeaseExpiresAtMs: number;
      }
    >();
    const requests = new Map<string, string[][]>();
    const record = (
      flush: { indexId: string; entries: (typeof entries)[number][] }[],
    ): void => {
      for (const tail of flush) {
        const perIndex = requests.get(tail.indexId) ?? [];
        perIndex.push(tail.entries.map(({ ndjson }) => ndjson));
        requests.set(tail.indexId, perIndex);
      }
    };
    for (let start = 0; start < entries.length; start += batchSize) {
      const advanced = advanceCorpusProjectionAppendTails({
        tails,
        entries: entries.slice(start, start + batchSize),
        mode: "buffer",
        nowMs: 0,
      });
      tails = advanced.tails;
      record(advanced.flush);
    }
    record(
      advanceCorpusProjectionAppendTails({
        tails,
        entries: [],
        mode: "flush-all",
        nowMs: 0,
      }).flush,
    );
    return requests;
  };

  const streamed = requestsPerIndex(1);
  expect(streamed.size).toBe(2);
  expect([...streamed.values()].every((perIndex) => perIndex.length > 1)).toBe(
    true,
  );
  expect(streamed).toEqual(requestsPerIndex(32));
});
