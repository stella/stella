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

type ProjectionRevision = SafeId<"corpusIndexProjectionIntent">;

export const CORPUS_PROJECTION_APPEND_MAX_REVISIONS = 512;
export const CORPUS_PROJECTION_APPEND_MAX_SINGLE_REVISION_BYTES =
  LIMITS.corpusPayloadMaxDecompressedBytes;
export const CORPUS_PROJECTION_DELETE_MAX_REVISIONS = 128;
export const CORPUS_PROJECTION_UNKNOWN_APPEND_MARGIN_MS = 5_000;

type CorpusProjectionAppendEntry = {
  revision: ProjectionRevision;
  documents: readonly Record<string, unknown>[];
};

type CorpusProjectionAppendClient = Pick<
  CorpusIndexClient,
  "ingestCommittedBatch"
>;

type AppendCorpusProjectionBatchOptions = {
  client: CorpusProjectionAppendClient;
  indexId: string;
  entries: readonly CorpusProjectionAppendEntry[];
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
  stage: "validation" | "append";
  committedRevisions: ProjectionRevision[];
  unknownRevisions: ProjectionRevision[];
  unattemptedRevisions: ProjectionRevision[];
  cause?: CorpusIndexError | undefined;
}> {}

const invalidAppend = (
  message: string,
  unattemptedRevisions: ProjectionRevision[],
): Result<never, CorpusProjectionAppendError> =>
  Result.err(
    new CorpusProjectionAppendError({
      message,
      stage: "validation",
      committedRevisions: [],
      unknownRevisions: [],
      unattemptedRevisions,
    }),
  );

export const appendCorpusProjectionBatch = async ({
  client,
  indexId,
  entries,
}: AppendCorpusProjectionBatchOptions): Promise<
  Result<CorpusProjectionAppendReceipt, CorpusProjectionAppendError>
> => {
  const revisions = entries.map(({ revision }) => revision);
  if (
    entries.length === 0 ||
    entries.length > CORPUS_PROJECTION_APPEND_MAX_REVISIONS
  ) {
    return invalidAppend(
      `corpus projection append requires 1-${CORPUS_PROJECTION_APPEND_MAX_REVISIONS} revisions`,
      revisions,
    );
  }

  const uniqueRevisions = new Set<ProjectionRevision>();
  let documentCount = 0;
  for (const entry of entries) {
    if (
      !isUuid(entry.revision) ||
      uniqueRevisions.has(entry.revision) ||
      entry.documents.length === 0
    ) {
      return invalidAppend(
        `corpus projection append received an invalid, duplicate, or empty revision: ${entry.revision}`,
        revisions,
      );
    }
    uniqueRevisions.add(entry.revision);
    documentCount += entry.documents.length;
    for (const document of entry.documents) {
      if (
        document["projection_revision"] !== entry.revision ||
        typeof document["document_id"] !== "string"
      ) {
        return invalidAppend(
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
      Buffer.byteLength(request.ndjson, "utf8") >
      CORPUS_PROJECTION_APPEND_MAX_SINGLE_REVISION_BYTES
    ) {
      return invalidAppend(
        "one corpus projection revision exceeds the append safety ceiling",
        revisions,
      );
    }
  }

  const committedRevisions: ProjectionRevision[] = [];
  for (const [requestIndex, request] of requests.entries()) {
    // oxlint-disable-next-line no-await-in-loop -- ordered committed requests bound search-engine pressure and make the returned prefix authoritative
    const ingested = await client.ingestCommittedBatch(indexId, request.ndjson);
    if (ingested.isErr()) {
      const unknownRevisions = request.entries.map(
        ({ row: { revision } }) => revision,
      );
      const unattemptedRevisions = requests
        .slice(requestIndex + 1)
        .flatMap(({ entries: laterEntries }) =>
          laterEntries.map(({ row: { revision } }) => revision),
        );
      return Result.err(
        new CorpusProjectionAppendError({
          message: "corpus projection append outcome is partially unknown",
          stage: "append",
          committedRevisions,
          unknownRevisions,
          unattemptedRevisions,
          cause: ingested.error,
        }),
      );
    }
    committedRevisions.push(
      ...request.entries.map(({ row: { revision } }) => revision),
    );
  }
  return Result.ok({
    revisionCount: entries.length,
    documentCount,
    requestCount: requests.length,
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

type CorpusProjectionDeleteClient = Pick<
  CorpusIndexClient,
  "deleteByQuery" | "readDeleteSettlement" | "search"
>;

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
  client: CorpusProjectionDeleteClient;
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

export const countCorpusProjectionRevisions = async ({
  client,
  indexId,
  revisions,
}: ProjectionRevisionOperationOptions): Promise<
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
  const commitTimeoutSecs =
    manifest.engine.indexConfig.indexing_settings.commit_timeout_secs;
  if (
    !Number.isFinite(appendStartedAt.getTime()) ||
    commitTimeoutSecs === undefined ||
    !Number.isSafeInteger(commitTimeoutSecs) ||
    commitTimeoutSecs <= 0
  ) {
    return panic("Corpus projection append barrier contract is invalid");
  }
  return new Date(
    appendStartedAt.getTime() +
      CORPUS_INDEX_INGEST_TIMEOUT_MS +
      commitTimeoutSecs * 1000 +
      CORPUS_PROJECTION_UNKNOWN_APPEND_MARGIN_MS,
  );
};
