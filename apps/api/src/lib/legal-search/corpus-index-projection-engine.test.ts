import { Result } from "better-result";
import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";

import { toSafeId } from "@/api/lib/branded-types";
import {
  CORPUS_INDEX_INGEST_TIMEOUT_MS,
  CORPUS_INDEX_ENGINE_INGEST_MAX_BYTES,
  CorpusIndexError,
} from "@/api/lib/legal-search/corpus-index-client";
import { CORPUS_INDEX_MANIFESTS } from "@/api/lib/legal-search/corpus-index-manifest";
import {
  appendCorpusProjectionBatch,
  censusCorpusProjectionRevisions,
  corpusIndexUnknownAppendBarrierAt,
  corpusProjectionRevisionsQuery,
  CORPUS_PROJECTION_DELETE_MAX_REVISIONS,
  CORPUS_PROJECTION_APPEND_MAX_REQUEST_BYTES,
  CORPUS_PROJECTION_APPEND_MAX_REVISION_BYTES,
  CORPUS_PROJECTION_APPEND_MAX_SINGLE_REVISION_BYTES,
  CORPUS_PROJECTION_UNKNOWN_APPEND_MARGIN_MS,
  planCorpusProjectionAppendRequests,
} from "@/api/lib/legal-search/corpus-index-projection-engine";
import { LIMITS } from "@/api/lib/limits";

const FIRST_REVISION = toSafeId<"corpusIndexProjectionIntent">(
  "0198e331-e578-7000-8000-000000000001",
);
const SECOND_REVISION = toSafeId<"corpusIndexProjectionIntent">(
  "0198e331-e578-7000-8000-000000000002",
);

test("request budget stays below the single-revision ingest cap", () => {
  expect(CORPUS_PROJECTION_APPEND_MAX_SINGLE_REVISION_BYTES).toBe(
    CORPUS_INDEX_ENGINE_INGEST_MAX_BYTES - 512 * 1024,
  );
  expect(LIMITS.corpusIndexIngestMaxBytes).toBeLessThanOrEqual(
    CORPUS_PROJECTION_APPEND_MAX_SINGLE_REVISION_BYTES,
  );
});

const largeRevisionEntry = (revision: typeof FIRST_REVISION) => ({
  revision,
  documents: Array.from({ length: 12 }, (_, seq) => ({
    document_id: `0198e331-e578-7000-8000-${String(seq + 10).padStart(12, "0")}`,
    projection_revision: revision,
    seq,
    text: "x".repeat(1_000_000),
  })),
});

test("projection deletes select exact unique append attempts", () => {
  expect(
    corpusProjectionRevisionsQuery([FIRST_REVISION, SECOND_REVISION]),
  ).toBe(
    `projection_revision:"${FIRST_REVISION}" OR projection_revision:"${SECOND_REVISION}"`,
  );
  expect(() =>
    corpusProjectionRevisionsQuery([
      toSafeId<"corpusIndexProjectionIntent">('bad" OR document_id:"all'),
    ]),
  ).toThrow("invalid corpus projection revision");
  expect(() => corpusProjectionRevisionsQuery([])).toThrow(
    `requires 1-${CORPUS_PROJECTION_DELETE_MAX_REVISIONS} revisions`,
  );
});

test("revision census reports exact present and missing attempts", async () => {
  const result = await censusCorpusProjectionRevisions({
    client: {
      aggregate: async ({ aggs, ...input }) => {
        expect(input).toMatchObject({
          indexId: "case_law_v5_cs_sk",
          query: `projection_revision:"${FIRST_REVISION}" OR projection_revision:"${SECOND_REVISION}"`,
        });
        expect(aggs).toEqual({
          projection_revisions: {
            terms: {
              field: "projection_revision",
              order: { _key: "asc" },
              shard_size: 2,
              show_term_doc_count_error: true,
              size: 2,
            },
          },
        });
        return Result.ok({
          projection_revisions: {
            buckets: [{ key: FIRST_REVISION, doc_count: 4 }],
            doc_count_error_upper_bound: 0,
            sum_other_doc_count: 0,
          },
        });
      },
    },
    indexId: "case_law_v5_cs_sk",
    revisions: [FIRST_REVISION, SECOND_REVISION],
  });

  expect(result).toEqual(
    Result.ok({
      present: [{ revision: FIRST_REVISION, documentCount: 4 }],
      missing: [SECOND_REVISION],
    }),
  );
});

test("revision census fails closed on approximate buckets", async () => {
  const result = await censusCorpusProjectionRevisions({
    client: {
      aggregate: async () =>
        Result.ok({
          projection_revisions: {
            buckets: [{ key: FIRST_REVISION, doc_count: 1 }],
            doc_count_error_upper_bound: 1,
            sum_other_doc_count: 0,
          },
        }),
    },
    indexId: "case_law_v5_cs_sk",
    revisions: [FIRST_REVISION],
  });

  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.message).toContain("approximate");
  }
});

test("committed appends preserve row boundaries and exact revision ownership", async () => {
  const requests: string[] = [];
  const client = {
    ingestCommittedBatch: async (_indexId: string, ndjson: string) => {
      requests.push(ndjson);
      return Result.ok(undefined);
    },
  };
  const result = await appendCorpusProjectionBatch({
    client,
    indexId: "case_law_v5_cs_sk",
    entries: [
      {
        revision: FIRST_REVISION,
        documents: [
          {
            document_id: "0198e331-e578-7000-8000-000000000011",
            projection_revision: FIRST_REVISION,
          },
          {
            document_id: "0198e331-e578-7000-8000-000000000011",
            projection_revision: FIRST_REVISION,
          },
        ],
      },
      {
        revision: SECOND_REVISION,
        documents: [
          {
            document_id: "0198e331-e578-7000-8000-000000000012",
            projection_revision: SECOND_REVISION,
          },
        ],
      },
    ],
  });

  expect(result).toEqual(
    Result.ok({ revisionCount: 2, documentCount: 3, requestCount: 1 }),
  );
  expect(requests).toHaveLength(1);
  expect(requests.at(0)?.split("\n")).toHaveLength(3);
});

test("append requests are byte-planned before any external effect", () => {
  const largeText = "x".repeat(
    Math.floor(LIMITS.corpusIndexIngestMaxBytes * 0.6),
  );
  const planned = planCorpusProjectionAppendRequests([
    {
      revision: FIRST_REVISION,
      documents: [
        {
          document_id: "0198e331-e578-7000-8000-000000000011",
          projection_revision: FIRST_REVISION,
          text: largeText,
        },
      ],
    },
    {
      revision: SECOND_REVISION,
      documents: [
        {
          document_id: "0198e331-e578-7000-8000-000000000012",
          projection_revision: SECOND_REVISION,
          text: largeText,
        },
      ],
    },
  ]);

  expect(planned.isOk()).toBe(true);
  if (planned.isOk()) {
    expect(
      planned.value.map(({ entries }) =>
        entries.map(({ revision }) => revision),
      ),
    ).toEqual([[FIRST_REVISION], [SECOND_REVISION]]);
  }
});

test("single-document cap admits exactly 9.5 MiB and rejects the next byte", () => {
  const base = {
    document_id: "0198e331-e578-7000-8000-000000000011",
    projection_revision: FIRST_REVISION,
    text: "",
  };
  const overhead = Buffer.byteLength(JSON.stringify(base), "utf-8");
  const text = "x".repeat(
    CORPUS_PROJECTION_APPEND_MAX_SINGLE_REVISION_BYTES - overhead,
  );
  const atCap = planCorpusProjectionAppendRequests([
    {
      revision: FIRST_REVISION,
      documents: [{ ...base, text }],
    },
  ]);
  expect(atCap.isOk()).toBe(true);
  if (atCap.isOk()) {
    expect(atCap.value).toHaveLength(1);
    expect(Buffer.byteLength(atCap.value[0]?.ndjson ?? "", "utf-8")).toBe(
      CORPUS_PROJECTION_APPEND_MAX_SINGLE_REVISION_BYTES,
    );
  }
  const overCap = planCorpusProjectionAppendRequests([
    {
      revision: FIRST_REVISION,
      documents: [{ ...base, text: `${text}x` }],
    },
  ]);
  expect(overCap.isErr()).toBe(true);
  if (overCap.isErr()) {
    expect(overCap.error.code).toBe("revision_too_large");
  }
});

test("multi-document requests stay within 8 MiB around a large singleton", () => {
  const documents = [
    {
      document_id: "0198e331-e578-7000-8000-000000000011",
      projection_revision: FIRST_REVISION,
      text: "x".repeat(LIMITS.corpusIndexIngestMaxBytes),
    },
    {
      document_id: "0198e331-e578-7000-8000-000000000012",
      projection_revision: FIRST_REVISION,
      text: "small",
    },
  ];
  const planned = planCorpusProjectionAppendRequests([
    { revision: FIRST_REVISION, documents },
  ]);
  expect(planned.isOk()).toBe(true);
  if (planned.isOk()) {
    expect(planned.value).toHaveLength(2);
    expect(
      Buffer.byteLength(planned.value[0]?.ndjson ?? "", "utf-8"),
    ).toBeGreaterThan(CORPUS_PROJECTION_APPEND_MAX_REQUEST_BYTES);
    expect(
      Buffer.byteLength(planned.value[1]?.ndjson ?? "", "utf-8"),
    ).toBeLessThanOrEqual(CORPUS_PROJECTION_APPEND_MAX_REQUEST_BYTES);
  }
});

test("one revision is split into requests under both byte ceilings", () => {
  const entry = largeRevisionEntry(FIRST_REVISION);
  const planned = planCorpusProjectionAppendRequests([entry]);

  expect(planned.isOk()).toBe(true);
  if (planned.isOk()) {
    expect(planned.value.length).toBeGreaterThan(1);
    const requestBytes = planned.value.map(({ ndjson }) =>
      Buffer.byteLength(ndjson, "utf-8"),
    );
    expect(
      requestBytes.every(
        (bytes) => bytes <= CORPUS_PROJECTION_APPEND_MAX_REQUEST_BYTES,
      ),
    ).toBe(true);
    const revisionBytes = entry.documents.reduce(
      (total, document) =>
        total + Buffer.byteLength(JSON.stringify(document), "utf-8") + 1,
      0,
    );
    expect(revisionBytes).toBeGreaterThan(
      CORPUS_PROJECTION_APPEND_MAX_SINGLE_REVISION_BYTES,
    );
    expect(revisionBytes).toBeLessThanOrEqual(
      CORPUS_PROJECTION_APPEND_MAX_REVISION_BYTES,
    );
    expect(
      planned.value.flatMap(({ entries }) =>
        entries.map(({ revision }) => revision),
      ),
    ).toEqual(
      Array.from({ length: planned.value.length }, () => FIRST_REVISION),
    );
    expect(
      planned.value.flatMap(({ ndjson }) =>
        ndjson.split("\n").map((line) => JSON.parse(line).seq),
      ),
    ).toEqual(entry.documents.map(({ seq }) => seq));
  }
});

test("append rejects a document carrying another attempt revision", async () => {
  const result = await appendCorpusProjectionBatch({
    client: {
      ingestCommittedBatch: async () =>
        Result.err(new CorpusIndexError({ message: "must not be called" })),
    },
    indexId: "case_law_v5_cs_sk",
    entries: [
      {
        revision: FIRST_REVISION,
        documents: [
          {
            document_id: "0198e331-e578-7000-8000-000000000011",
            projection_revision: SECOND_REVISION,
          },
        ],
      },
    ],
  });

  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.message).toContain("does not belong to revision");
    expect(result.error.code).toBe("invalid_document");
    expect(result.error.stage).toBe("validation");
    expect(result.error.unattemptedRevisions).toEqual([FIRST_REVISION]);
  }
});

test("append failure reports the exact revisions with unknown outcomes", async () => {
  const unknownOutcomeObservedAt = new Date("2026-08-25T12:00:00.000Z");
  let appendReturned = false;
  const result = await appendCorpusProjectionBatch({
    client: {
      ingestCommittedBatch: async () => {
        appendReturned = true;
        return Result.err(new CorpusIndexError({ message: "response lost" }));
      },
    },
    indexId: "case_law_v5_cs_sk",
    clock: () => {
      expect(appendReturned).toBe(true);
      return unknownOutcomeObservedAt;
    },
    entries: [
      {
        revision: FIRST_REVISION,
        documents: [
          {
            document_id: "0198e331-e578-7000-8000-000000000011",
            projection_revision: FIRST_REVISION,
          },
        ],
      },
      {
        revision: SECOND_REVISION,
        documents: [
          {
            document_id: "0198e331-e578-7000-8000-000000000012",
            projection_revision: SECOND_REVISION,
          },
        ],
      },
    ],
  });

  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.stage).toBe("append");
    expect(result.error.code).toBe("append_unknown");
    expect(result.error.committedRevisions).toEqual([]);
    expect(result.error.unknownRevisions).toEqual([
      FIRST_REVISION,
      SECOND_REVISION,
    ]);
    expect(result.error.unattemptedRevisions).toEqual([]);
    expect(result.error.unknownOutcomeObservedAt).toEqual(
      unknownOutcomeObservedAt,
    );
  }
});

test("a later part failure leaves an earlier accepted revision unknown", async () => {
  let requestCount = 0;
  const result = await appendCorpusProjectionBatch({
    client: {
      ingestCommittedBatch: async () => {
        requestCount += 1;
        return requestCount === 1
          ? Result.ok(undefined)
          : Result.err(new CorpusIndexError({ message: "second part failed" }));
      },
    },
    indexId: "case_law_v5_cs_sk",
    clock: () => new Date("2026-08-25T12:00:00.000Z"),
    entries: [largeRevisionEntry(FIRST_REVISION)],
  });

  expect(requestCount).toBeGreaterThan(1);
  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.stage).toBe("append");
    expect(result.error.code).toBe("append_unknown");
    expect(result.error.committedRevisions).toEqual([]);
    expect(result.error.unknownRevisions).toEqual([FIRST_REVISION]);
    expect(result.error.unattemptedRevisions).toEqual([]);
  }
});

test("unknown append cleanup waits beyond both request and engine windows", () => {
  const startedAt = new Date("2026-08-25T12:00:00.000Z");
  const commitTimeoutMs =
    (CORPUS_INDEX_MANIFESTS.case_law_v5.engine.indexConfig.indexing_settings
      .commit_timeout_secs ?? 0) * 1000;
  expect(
    corpusIndexUnknownAppendBarrierAt(
      startedAt,
      CORPUS_INDEX_MANIFESTS.case_law_v5,
    ).getTime(),
  ).toBe(
    startedAt.getTime() +
      CORPUS_INDEX_INGEST_TIMEOUT_MS +
      commitTimeoutMs +
      CORPUS_PROJECTION_UNKNOWN_APPEND_MARGIN_MS,
  );
});
