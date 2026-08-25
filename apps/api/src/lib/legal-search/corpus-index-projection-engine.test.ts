import { Result } from "better-result";
import { expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import {
  CORPUS_INDEX_INGEST_TIMEOUT_MS,
  CorpusIndexError,
} from "@/api/lib/legal-search/corpus-index-client";
import { CORPUS_INDEX_MANIFESTS } from "@/api/lib/legal-search/corpus-index-manifest";
import {
  appendCorpusProjectionBatch,
  censusCorpusProjectionRevisions,
  corpusIndexUnknownAppendBarrierAt,
  corpusProjectionRevisionsQuery,
  CORPUS_PROJECTION_DELETE_MAX_REVISIONS,
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
