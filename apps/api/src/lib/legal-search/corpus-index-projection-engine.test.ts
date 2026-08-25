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
  corpusIndexUnknownAppendBarrierAt,
  corpusProjectionRevisionsQuery,
  CORPUS_PROJECTION_DELETE_MAX_REVISIONS,
  CORPUS_PROJECTION_UNKNOWN_APPEND_MARGIN_MS,
} from "@/api/lib/legal-search/corpus-index-projection-engine";

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
    expect(result.error.stage).toBe("validation");
    expect(result.error.unattemptedRevisions).toEqual([FIRST_REVISION]);
  }
});

test("append failure reports the exact revisions with unknown outcomes", async () => {
  const result = await appendCorpusProjectionBatch({
    client: {
      ingestCommittedBatch: async () =>
        Result.err(new CorpusIndexError({ message: "response lost" })),
    },
    indexId: "case_law_v5_cs_sk",
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
    expect(result.error.committedRevisions).toEqual([]);
    expect(result.error.unknownRevisions).toEqual([
      FIRST_REVISION,
      SECOND_REVISION,
    ]);
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
