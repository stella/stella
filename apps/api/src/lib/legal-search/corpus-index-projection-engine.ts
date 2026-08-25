import { panic, Result, TaggedError } from "better-result";
import { Buffer } from "node:buffer";

import type { SafeId } from "@/api/lib/branded-types";
import { splitIngestRequests } from "@/api/lib/corpus-index/core";
import { isUuid } from "@/api/lib/custom-schema";
import {
  CORPUS_INDEX_INGEST_TIMEOUT_MS,
  type CorpusIndexError,
  type CorpusIndexClient,
  type CorpusIndexDeleteSettlement,
  type CorpusIndexDeleteTask,
} from "@/api/lib/legal-search/corpus-index-client";
import type { CorpusIndexManifest } from "@/api/lib/legal-search/corpus-index-manifest";
import { LIMITS } from "@/api/lib/limits";

type ProjectionRevision = SafeId<"corpusIndexProjectionIntent">;

export const CORPUS_PROJECTION_APPEND_MAX_REVISIONS = 512;
export const CORPUS_PROJECTION_APPEND_MAX_SINGLE_REVISION_BYTES =
  LIMITS.corpusPayloadMaxDecompressedBytes;
export const CORPUS_PROJECTION_DELETE_MAX_REVISIONS = 128;
export const CORPUS_PROJECTION_UNKNOWN_APPEND_MARGIN_MS = 5000;

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
    LIMITS.corpusIndexIngestMaxBytes,
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

type ProjectionRevisionOperationOptions = {
  client: CorpusProjectionDeleteClient;
  indexId: string;
  revisions: readonly ProjectionRevision[];
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
  return (
    CORPUS_INDEX_INGEST_TIMEOUT_MS +
    commitTimeoutSecs * 1000 +
    CORPUS_PROJECTION_UNKNOWN_APPEND_MARGIN_MS
  );
};
