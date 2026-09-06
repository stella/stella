import { panic, Result, TaggedError } from "better-result";
import { Buffer } from "node:buffer";

import type { SafeId } from "@/api/lib/branded-types";
import { splitIngestRequests } from "@/api/lib/corpus-index/core";
import { isUuid } from "@/api/lib/custom-schema";
import {
  CORPUS_INDEX_INGEST_TIMEOUT_MS,
  CorpusIndexError,
  type CorpusIndexClient,
  type CorpusIndexDeleteSettlement,
  type CorpusIndexDeleteTask,
} from "@/api/lib/legal-search/corpus-index-client";
import type { CorpusIndexManifest } from "@/api/lib/legal-search/corpus-index-manifest";
import { LIMITS } from "@/api/lib/limits";
import { brandValidatedCorpusIndexProjectionIntentId } from "@/api/lib/safe-id-boundaries";
import { isRecord } from "@/api/lib/type-guards";

type ProjectionRevision = SafeId<"corpusIndexProjectionIntent">;

export const CORPUS_PROJECTION_APPEND_MAX_REVISIONS = 512;
export const CORPUS_PROJECTION_APPEND_MAX_REQUEST_BYTES =
  LIMITS.corpusIndexIngestMaxBytes;
export const CORPUS_PROJECTION_APPEND_MAX_SINGLE_REVISION_BYTES =
  LIMITS.corpusPayloadMaxDecompressedBytes;
export const CORPUS_PROJECTION_DELETE_MAX_REVISIONS = 128;
export const CORPUS_PROJECTION_UNKNOWN_APPEND_MARGIN_MS = 5000;

/**
 * What an accepted append is allowed to mean for the store row behind it.
 *
 * `published` waits for the split, so a revision the store marks applied is
 * searchable the instant it is applied. `queued` returns on acceptance, so a
 * catch-up generation can keep more than one request in flight per commit
 * period instead of paying a wall-clock commit for each one, and its
 * documents stay invisible to search and to delete-by-query until the
 * engine's own commit timer fires.
 *
 * Nothing persists which mode wrote a revision, and nothing should: the mode
 * is a per-cycle choice, several cycles can append into one generation, and a
 * reader that guessed wrong would delete documents that are not there yet or
 * read absence as drift. Every observer of an accepted revision instead
 * fences on `corpusIndexAppendPublishDelayMs`, which holds for both modes:
 * a published append has already spent that delay inside the ingest call.
 */
export const CORPUS_PROJECTION_APPEND_COMMIT_MODE = {
  published: "published",
  queued: "queued",
} as const;

export type CorpusProjectionAppendCommitMode =
  (typeof CORPUS_PROJECTION_APPEND_COMMIT_MODE)[keyof typeof CORPUS_PROJECTION_APPEND_COMMIT_MODE];

export type CorpusProjectionAppendEntry = {
  revision: ProjectionRevision;
  documents: readonly Record<string, unknown>[];
};

export type CorpusProjectionAppendRequest = {
  entries: readonly CorpusProjectionAppendEntry[];
  ndjson: string;
};

type CorpusProjectionAppendClient = Pick<
  CorpusIndexClient,
  "ingestCommittedBatch"
>;

type AppendCorpusProjectionBatchOptions = {
  client: CorpusProjectionAppendClient;
  indexId: string;
  entries: readonly CorpusProjectionAppendEntry[];
  clock?: () => Date;
};

export type CorpusProjectionAppendReceipt = {
  revisionCount: number;
  documentCount: number;
  requestCount: number;
};

export class CorpusProjectionAppendError extends TaggedError(
  "CorpusProjectionAppendError",
)<{
  message: string;
  code:
    | "invalid_batch"
    | "invalid_revision"
    | "invalid_document"
    | "revision_too_large"
    | "append_unknown";
  stage: "validation" | "append";
  committedRevisions: ProjectionRevision[];
  unknownRevisions: ProjectionRevision[];
  unattemptedRevisions: ProjectionRevision[];
  unknownOutcomeObservedAt: Date | null;
  cause?: CorpusIndexError | undefined;
}> {}

const invalidAppend = (
  code: Exclude<CorpusProjectionAppendError["code"], "append_unknown">,
  message: string,
  unattemptedRevisions: ProjectionRevision[],
): Result<never, CorpusProjectionAppendError> =>
  Result.err(
    new CorpusProjectionAppendError({
      message,
      code,
      stage: "validation",
      committedRevisions: [],
      unknownRevisions: [],
      unattemptedRevisions,
      unknownOutcomeObservedAt: null,
    }),
  );

/**
 * Validate and byte-partition exact append attempts before any intent enters
 * `append_started`. A caller can then durably start only the next request;
 * later plans remain provably unattempted if that request fails or crashes.
 */
export const planCorpusProjectionAppendRequests = (
  entries: readonly CorpusProjectionAppendEntry[],
): Result<CorpusProjectionAppendRequest[], CorpusProjectionAppendError> => {
  const revisions = entries.map(({ revision }) => revision);
  if (
    entries.length === 0 ||
    entries.length > CORPUS_PROJECTION_APPEND_MAX_REVISIONS
  ) {
    return invalidAppend(
      "invalid_batch",
      `corpus projection append requires 1-${CORPUS_PROJECTION_APPEND_MAX_REVISIONS} revisions`,
      revisions,
    );
  }

  const uniqueRevisions = new Set<ProjectionRevision>();
  for (const entry of entries) {
    if (
      !isUuid(entry.revision) ||
      uniqueRevisions.has(entry.revision) ||
      entry.documents.length === 0
    ) {
      return invalidAppend(
        "invalid_revision",
        `corpus projection append received an invalid, duplicate, or empty revision: ${entry.revision}`,
        revisions,
      );
    }
    uniqueRevisions.add(entry.revision);
    for (const document of entry.documents) {
      if (
        document["projection_revision"] !== entry.revision ||
        typeof document["document_id"] !== "string"
      ) {
        return invalidAppend(
          "invalid_document",
          `corpus projection document does not belong to revision ${entry.revision}`,
          revisions,
        );
      }
    }
  }

  const requests = splitIngestRequests(
    entries.map((entry) => ({ row: entry, docs: [...entry.documents] })),
    CORPUS_PROJECTION_APPEND_MAX_REQUEST_BYTES,
  );
  for (const request of requests) {
    if (
      Buffer.byteLength(request.ndjson, "utf-8") >
      CORPUS_PROJECTION_APPEND_MAX_SINGLE_REVISION_BYTES
    ) {
      return invalidAppend(
        "revision_too_large",
        "one corpus projection revision exceeds the append safety ceiling",
        revisions,
      );
    }
  }
  return Result.ok(
    requests.map(({ entries: requestEntries, ndjson }) => ({
      entries: requestEntries.map(({ row }) => row),
      ndjson,
    })),
  );
};

export const appendCorpusProjectionBatch = async ({
  client,
  indexId,
  entries,
  clock = () => new Date(),
}: AppendCorpusProjectionBatchOptions): Promise<
  Result<CorpusProjectionAppendReceipt, CorpusProjectionAppendError>
> => {
  const planned = planCorpusProjectionAppendRequests(entries);
  if (planned.isErr()) {
    return Result.err(planned.error);
  }

  const documentCount = entries.reduce(
    (total, entry) => total + entry.documents.length,
    0,
  );
  const committedRevisions: ProjectionRevision[] = [];
  const appendRequestAt = async (
    requestIndex: number,
  ): Promise<Result<void, CorpusProjectionAppendError>> => {
    const request = planned.value.at(requestIndex);
    if (request === undefined) {
      return Result.ok(undefined);
    }
    const ingested = await client.ingestCommittedBatch(indexId, request.ndjson);
    if (ingested.isErr()) {
      const unknownOutcomeObservedAt = clock();
      const unknownRevisions = request.entries.map(({ revision }) => revision);
      const unattemptedRevisions = planned.value
        .slice(requestIndex + 1)
        .flatMap(({ entries: laterEntries }) =>
          laterEntries.map(({ revision }) => revision),
        );
      return Result.err(
        new CorpusProjectionAppendError({
          message: "corpus projection append outcome is partially unknown",
          code: "append_unknown",
          stage: "append",
          committedRevisions,
          unknownRevisions,
          unattemptedRevisions,
          unknownOutcomeObservedAt,
          cause: ingested.error,
        }),
      );
    }
    committedRevisions.push(...request.entries.map(({ revision }) => revision));
    return appendRequestAt(requestIndex + 1);
  };
  const appendResult = await appendRequestAt(0);
  if (appendResult.isErr()) {
    return Result.err(appendResult.error);
  }
  return Result.ok({
    revisionCount: entries.length,
    documentCount,
    requestCount: planned.value.length,
  });
};

export const corpusProjectionRevisionsQuery = (
  revisions: readonly ProjectionRevision[],
): string => {
  if (
    revisions.length === 0 ||
    revisions.length > CORPUS_PROJECTION_DELETE_MAX_REVISIONS
  ) {
    return panic(
      `corpus projection delete requires 1-${CORPUS_PROJECTION_DELETE_MAX_REVISIONS} revisions`,
    );
  }
  return revisions
    .map((revision) =>
      isUuid(revision)
        ? `projection_revision:"${revision}"`
        : panic(`invalid corpus projection revision: ${revision}`),
    )
    .join(" OR ");
};

type CorpusProjectionDeleteClient = Pick<CorpusIndexClient, "deleteByQuery">;

type ProjectionRevisionTarget = {
  indexId: string;
  revisions: readonly ProjectionRevision[];
};

type ProjectionRevisionOperationOptions = ProjectionRevisionTarget & {
  client: CorpusProjectionDeleteClient;
};

type ProjectionRevisionCensusOptions = ProjectionRevisionTarget & {
  client: Pick<CorpusIndexClient, "aggregate">;
};

const PROJECTION_REVISION_CENSUS_AGGREGATION = "projection_revisions";

type CorpusProjectionRevisionPresence = {
  revision: ProjectionRevision;
  documentCount: number;
};

type CorpusProjectionRevisionCensus = {
  present: CorpusProjectionRevisionPresence[];
  missing: ProjectionRevision[];
};

const malformedProjectionCensus = (message: string) =>
  Result.err(new CorpusIndexError({ message }));

/**
 * Read the exact presence of a bounded revision set. The query first narrows
 * the corpus to those raw revision terms, then a fast-field aggregation
 * returns one bucket per append attempt. `sum_other_doc_count` and the error
 * bound must both be zero: approximation is never accepted as a census.
 */
export const censusCorpusProjectionRevisions = async ({
  client,
  indexId,
  revisions,
}: ProjectionRevisionCensusOptions): Promise<
  Result<CorpusProjectionRevisionCensus, CorpusIndexError>
> => {
  const query = corpusProjectionRevisionsQuery(revisions);
  const aggregated = await client.aggregate({
    indexId,
    query,
    aggs: {
      [PROJECTION_REVISION_CENSUS_AGGREGATION]: {
        terms: {
          field: "projection_revision",
          size: revisions.length,
          shard_size: revisions.length,
          order: { _key: "asc" },
          show_term_doc_count_error: true,
        },
      },
    },
  });
  if (aggregated.isErr()) {
    return Result.err(aggregated.error);
  }
  const census = aggregated.value[PROJECTION_REVISION_CENSUS_AGGREGATION];
  if (!isRecord(census) || !Array.isArray(census["buckets"])) {
    return malformedProjectionCensus(
      "corpus projection revision census returned malformed buckets",
    );
  }
  if (
    census["sum_other_doc_count"] !== 0 ||
    census["doc_count_error_upper_bound"] !== 0
  ) {
    return malformedProjectionCensus(
      "corpus projection revision census returned an incomplete or approximate result",
    );
  }
  const requested = new Set(revisions);
  const seen = new Set<ProjectionRevision>();
  const present: CorpusProjectionRevisionPresence[] = [];
  for (const bucket of census["buckets"]) {
    if (!isRecord(bucket)) {
      return malformedProjectionCensus(
        "corpus projection revision census returned an invalid bucket",
      );
    }
    const bucketKey = bucket["key"];
    const revision =
      typeof bucketKey === "string"
        ? brandValidatedCorpusIndexProjectionIntentId(bucketKey)
        : null;
    if (
      revision === null ||
      !Number.isSafeInteger(bucket["doc_count"]) ||
      Number(bucket["doc_count"]) <= 0
    ) {
      return malformedProjectionCensus(
        "corpus projection revision census returned an invalid bucket",
      );
    }
    if (!requested.has(revision)) {
      return malformedProjectionCensus(
        "corpus projection revision census returned an unrequested bucket",
      );
    }
    if (seen.has(revision)) {
      return malformedProjectionCensus(
        "corpus projection revision census returned a duplicate bucket",
      );
    }
    seen.add(revision);
    present.push({
      revision,
      documentCount: Number(bucket["doc_count"]),
    });
  }
  return Result.ok({
    present,
    missing: revisions.filter((revision) => !seen.has(revision)),
  });
};

export const deleteCorpusProjectionRevisions = async ({
  client,
  indexId,
  revisions,
}: ProjectionRevisionOperationOptions): Promise<
  Result<CorpusIndexDeleteTask, CorpusIndexError>
> =>
  await client.deleteByQuery(
    indexId,
    corpusProjectionRevisionsQuery(revisions),
  );

type ReadCorpusProjectionDeleteSettlementOptions = {
  client: Pick<CorpusIndexClient, "readDeleteSettlement">;
  indexId: string;
  requiredOpstamp: number;
};

export const readCorpusProjectionDeleteSettlement = async ({
  client,
  indexId,
  requiredOpstamp,
}: ReadCorpusProjectionDeleteSettlementOptions): Promise<
  Result<CorpusIndexDeleteSettlement, CorpusIndexError>
> => await client.readDeleteSettlement(indexId, requiredOpstamp);

type CountCorpusProjectionRevisionsOptions = {
  client: Pick<CorpusIndexClient, "search">;
  indexId: string;
  revisions: readonly ProjectionRevision[];
};

export const countCorpusProjectionRevisions = async ({
  client,
  indexId,
  revisions,
}: CountCorpusProjectionRevisionsOptions): Promise<
  Result<number, CorpusIndexError>
> => {
  const searched = await client.search({
    indexId,
    query: corpusProjectionRevisionsQuery(revisions),
    maxHits: 0,
  });
  return searched.map(({ numHits }) => numHits);
};

export const corpusIndexUnknownAppendBarrierAt = (
  appendStartedAt: Date,
  manifest: CorpusIndexManifest,
): Date => {
  if (!Number.isFinite(appendStartedAt.getTime())) {
    return panic("Corpus projection append barrier contract is invalid");
  }
  return new Date(
    appendStartedAt.getTime() +
      corpusIndexUnknownAppendBarrierDelayMs(manifest),
  );
};

export const corpusIndexUnknownAppendBarrierDelayMs = (
  manifest: CorpusIndexManifest,
): number =>
  CORPUS_INDEX_INGEST_TIMEOUT_MS + corpusIndexAppendPublishDelayMs(manifest);

/**
 * Milliseconds after the engine accepts an append when its documents are
 * guaranteed observable: committed by the engine's own commit timer and
 * published as a split. Under `published` the ingest call has already spent
 * this delay; under `queued` the caller still owes all of it, so search,
 * census, convergence, and delete-by-query all fence on it.
 */
export const corpusIndexAppendPublishDelayMs = (
  manifest: CorpusIndexManifest,
): number => {
  const commitTimeoutSecs =
    manifest.engine.indexConfig.indexing_settings.commit_timeout_secs;
  if (
    commitTimeoutSecs === undefined ||
    !Number.isSafeInteger(commitTimeoutSecs) ||
    commitTimeoutSecs <= 0
  ) {
    return panic("Corpus projection append barrier contract is invalid");
  }
  return commitTimeoutSecs * 1000 + CORPUS_PROJECTION_UNKNOWN_APPEND_MARGIN_MS;
};
