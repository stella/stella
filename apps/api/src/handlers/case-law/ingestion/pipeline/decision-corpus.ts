import { Result } from "better-result";
import { and, eq, isNull, sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  CASE_LAW_CORPUS_MIRROR_STATUS,
  caseLawDecisions,
} from "@/api/db/schema";
import { settleCaseLawCorpusMirrorTx } from "@/api/handlers/case-law/ingestion/pipeline/corpus-mirror";
import { withSourceRawRetry } from "@/api/handlers/case-law/ingestion/pipeline/decision-raw";
import type { DecisionRowWrite } from "@/api/handlers/case-law/ingestion/pipeline/decision-row-context";
import type { CaseLawCorpusDependencies } from "@/api/handlers/case-law/ingestion/pipeline/dependencies";
import { processResultForCorpusOutcome } from "@/api/handlers/case-law/ingestion/pipeline/outcomes";
import type { ProcessResult } from "@/api/handlers/case-law/ingestion/pipeline/outcomes";
import { pgPayloadCarriesDocument } from "@/api/handlers/case-law/stored-payload";
import { settleReservedCaseLawCorpusUpload } from "@/api/lib/legal-search/case-law-corpus-upload-intents";
import { synchronizeLockedCorpusProjectionDesiredStateTx } from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import { openCorpusPackBatch } from "@/api/lib/legal-search/corpus-pack-batch";
import type { CorpusPackBatch } from "@/api/lib/legal-search/corpus-pack-batch";
import { storedCorpusWrite } from "@/api/lib/legal-search/corpus-storage";

type EnqueueCorpusMirrorOptions = {
  scopedDb: ScopedDb;
  write: DecisionRowWrite;
  corpus: CaseLawCorpusDependencies;
  corpusBatch: CorpusPackBatch | undefined;
};

/**
 * Queue the decision's payload for the corpus pack, when the plan mirrors
 * it there. A decision with no batch of its own is flushed here, and its
 * outcome answered; one in a caller's batch answers null and is settled
 * when the caller flushes.
 */
export const enqueueCorpusMirror = async ({
  scopedDb,
  write,
  corpus,
  corpusBatch,
}: EnqueueCorpusMirrorOptions): Promise<ProcessResult | null> => {
  const {
    decisionId,
    existing,
    result,
    observationOrder,
    shape: { preservesExistingDetail },
    plan: { corpusPayload, corpusPlan, mirrorCarriesDocument },
    rawArtifact: { s3UploadFailed },
  } = write;
  if (
    corpusPlan.type === "postgres-mirrored" ||
    corpusPlan.type === "object-storage"
  ) {
    // The sourceHash this call just persisted: corpus-key and retry
    // updates only apply while the row still carries it. The upload helper
    // holds the same row fence as redaction across the bounded object write.
    const persistedSourceHash =
      preservesExistingDetail || s3UploadFailed
        ? (existing?.sourceHash ?? null)
        : result.rawHash;
    {
      const ownerPredicate = and(
        eq(caseLawDecisions.id, decisionId),
        sql`${caseLawDecisions.sourceHash} IS NOT DISTINCT FROM ${persistedSourceHash}`,
        eq(caseLawDecisions.sourceObservationOrder, observationOrder),
        eq(
          caseLawDecisions.corpusMirrorStatus,
          CASE_LAW_CORPUS_MIRROR_STATUS.PENDING,
        ),
        isNull(caseLawDecisions.redactedAt),
        mirrorCarriesDocument
          ? undefined
          : sql`NOT ${pgPayloadCarriesDocument}`,
      );
      // The payloads join the batch's pack rather than being PUT here. The
      // settlement below runs once that pack is durable, under the same row
      // fence redaction takes.
      const batch =
        corpusBatch ??
        openCorpusPackBatch({ scopedDb, transfer: corpus.transfer });
      batch.enqueue({
        decisionId,
        jurisdiction: corpusPayload.jurisdiction,
        payload: corpusPayload,
        // From the pre-write snapshot: the row update above moved the mirror
        // to pending, but a settled record in that snapshot still proves
        // those payloads were confirmed, so an identical one need not be
        // written again.
        stored: existing === undefined ? null : storedCorpusWrite(existing),
        settle: async ({ intentId, written }) => {
          const upload = await settleReservedCaseLawCorpusUpload({
            apply: async ({ projectionLock, tx, written: settled }) => {
              const applied = await settleCaseLawCorpusMirrorTx({
                decisionId,
                persistedSourceHash,
                observationOrder,
                mirrorCarriesDocument,
                mode: corpus.mode,
                tx,
                written: settled,
              });
              if (!applied) {
                return { type: "superseded" };
              }
              if (projectionLock !== null) {
                await synchronizeLockedCorpusProjectionDesiredStateTx(tx, {
                  lock: projectionLock,
                  subject: { family: "case_law", entityId: decisionId },
                });
              }
              return { type: "applied" };
            },
            decisionId,
            intentId,
            preflight: async (tx) =>
              Boolean(
                (
                  await tx
                    .select({ id: caseLawDecisions.id })
                    .from(caseLawDecisions)
                    .where(ownerPredicate)
                    .limit(1)
                ).at(0),
              ),
            scopedDb,
            written,
          });
          if (upload.type === "redacted-or-missing") {
            return { type: "redacted-or-missing" };
          }
          if (
            upload.type === "intent-reclaimed" ||
            upload.type === "superseded"
          ) {
            const winner = await scopedDb((tx) =>
              tx.query.caseLawDecisions.findFirst({
                where: { id: { eq: decisionId } },
                columns: { corpusMirrorStatus: true, redactedAt: true },
              }),
            );
            if (winner?.redactedAt || !winner) {
              return { type: "redacted-or-missing" };
            }
            if (
              winner.corpusMirrorStatus ===
              CASE_LAW_CORPUS_MIRROR_STATUS.PENDING
            ) {
              return { type: "retry" };
            }
          }
          return { type: "settled" };
        },
      });
      if (corpusBatch === undefined) {
        // Nobody else will flush this batch, so this decision is its own:
        // one transfer, one member set, the same path a page takes.
        const flushed = await batch.flush();
        return withSourceRawRetry(
          s3UploadFailed,
          processResultForCorpusOutcome(
            Result.isError(flushed)
              ? { type: "failed", error: flushed.error }
              : flushed.value.get(decisionId),
            {
              decisionId,
              caseNumber: result.caseNumber,
              country: result.country,
            },
          ),
        );
      }
    }
  }
  return null;
};
