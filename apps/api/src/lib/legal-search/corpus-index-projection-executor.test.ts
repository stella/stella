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
