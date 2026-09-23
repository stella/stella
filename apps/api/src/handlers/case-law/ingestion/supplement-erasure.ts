/**
 * Erasure of a decision whose text a judgment also holds as a supplement.
 *
 * Written reasons merged into their ruling live twice: as the reasons' own
 * row (absorbed, but still the row an erasure names) and inside the ruling's
 * composed document, citations and index entry. Redacting the row removes
 * the supplement record (`erasure.ts`), so every later write of the ruling
 * composes without it; this module makes that write happen now.
 *
 * Each holder is first withheld: its document is taken back through the
 * corpus stores, the citations extracted from it are dropped, and it is
 * marked as holding no document, which is what the repair lane re-asks the
 * publisher for. It is then rebuilt from its own stored payload under the
 * source's ingestion lease, which composes the supplements that remain.
 * Should the payload not be readable, or the lease not be free in time, the
 * holder stays withheld until the repair lane or a later run rebuilds it:
 * the erased text is never left public.
 *
 * Which judgments hold the erased row is read from their own record of what
 * they composed, so a run that stopped part way finds them again.
 */

import { Result } from "better-result";
import { and, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";

import { mapWithConcurrency } from "@stll/concurrency";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawCitations,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import { lockCitationGraph } from "@/api/handlers/case-law/citation-resolution";
import { redactCaseLawDecision } from "@/api/handlers/case-law/erasure";
import type { RedactCaseLawDecisionOutcome } from "@/api/handlers/case-law/erasure";
import type {
  SourceAdapter,
  StoredRawResultReader,
} from "@/api/handlers/case-law/ingestion/adapter";
import { getAdapter } from "@/api/handlers/case-law/ingestion/adapters/adapter-registry";
import {
  allocateSourceObservationOrder,
  DECISION_REFRESH,
  PROCESS_DECISION_STATUS,
  processDecision,
  readStoredRawFromS3,
  rebuildStoredJudgment,
} from "@/api/handlers/case-law/ingestion/pipeline";
import { acquireReplayLease } from "@/api/handlers/case-law/ingestion/replay";
import { DOCUMENT_SUPPLEMENTS_METADATA_KEY } from "@/api/handlers/case-law/ingestion/supplement-composition";
import { withdrawCaseLawDecisionDocument } from "@/api/handlers/case-law/withdraw-document";
import type { SafeId } from "@/api/lib/branded-types";
import type { DatabaseError } from "@/api/lib/errors/tagged-errors";
import { acquireCaseLawSourceIngestionLease } from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import { metadataMarkedListingOnly } from "@/api/lib/legal-search/partial-observation-sql";

/** How long a run waits for a crawl to release the source's lease. */
const HOLDER_LEASE_WAIT_MS = 2 * 60 * 1000;

/** What became of one judgment that held the erased text. */
export type ErasedSupplementHolderOutcome =
  /** Rebuilt from its own payload without the erased supplement. */
  | { type: "recomposed"; judgmentId: SafeId<"caseLawDecision"> }
  /**
   * Its document is taken back and it awaits a rebuild by the repair lane
   * or a later run: the payload could not be read, or the lease was busy.
   */
  | { type: "withheld"; judgmentId: SafeId<"caseLawDecision">; reason: string }
  /** A corpus object still holds its document: run the erasure again. */
  | { type: "withhold-incomplete"; judgmentId: SafeId<"caseLawDecision"> };

export type RedactWithSupplementHoldersOutcome = {
  redaction: RedactCaseLawDecisionOutcome;
  holders: ErasedSupplementHolderOutcome[];
};

type RedactWithSupplementHoldersOptions = {
  decisionId: SafeId<"caseLawDecision">;
  scopedDb: ScopedDb;
  /** Test seam; production reads the documents bucket. */
  readStoredRaw?: StoredRawResultReader;
  /** Test seam; how long to wait for the source's ingestion lease. */
  leaseWaitMs?: number;
  /** Test seam; production rebuilds through the source's own adapter. */
  reparseStoredRaw?: NonNullable<SourceAdapter["reparseStoredRaw"]>;
};

/** Live judgments whose composed document still holds the given row. */
const selectHolders = async (
  scopedDb: ScopedDb,
  decisionId: SafeId<"caseLawDecision">,
): Promise<
  { id: SafeId<"caseLawDecision">; sourceId: SafeId<"caseLawSource"> }[]
> =>
  await scopedDb(async (tx) => {
    const erased = (
      await tx
        .select({
          sourceId: caseLawDecisions.sourceId,
          sourceDocumentId: caseLawDecisions.sourceDocumentId,
          caseNumber: caseLawDecisions.caseNumber,
        })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.id, decisionId))
        .limit(1)
    ).at(0);
    if (
      erased?.sourceDocumentId === undefined ||
      erased.sourceDocumentId === null
    ) {
      return [];
    }
    const composed = JSON.stringify([
      { sourceDocumentId: erased.sourceDocumentId },
    ]);
    return await tx
      .select({ id: caseLawDecisions.id, sourceId: caseLawDecisions.sourceId })
      .from(caseLawDecisions)
      .where(
        and(
          eq(caseLawDecisions.sourceId, erased.sourceId),
          eq(caseLawDecisions.caseNumber, erased.caseNumber),
          ne(caseLawDecisions.id, decisionId),
          isNull(caseLawDecisions.redactedAt),
          sql`${caseLawDecisions.metadata} -> ${DOCUMENT_SUPPLEMENTS_METADATA_KEY} @> ${composed}::text::jsonb`,
        ),
      );
  });

/**
 * Take a holder's document back and mark it as holding none, so nothing it
 * held is served and the repair lane asks for it again.
 */
const withholdHolder = async (
  scopedDb: ScopedDb,
  judgmentId: SafeId<"caseLawDecision">,
): Promise<Result<"withheld" | "incomplete", DatabaseError>> => {
  const withdrawn = await withdrawCaseLawDecisionDocument({
    decisionId: judgmentId,
    reason: `a supplement composed into decision ${judgmentId} was erased`,
    scopedDb,
  });
  if (Result.isError(withdrawn)) {
    return withdrawn;
  }
  if (withdrawn.value.type === "corpus-objects-remain") {
    return Result.ok("incomplete");
  }
  await scopedDb(async (tx) => {
    // The resolver takes the graph lock before citation rows; so does this.
    await lockCitationGraph(tx);
    // audit: skip — GDPR redaction; recorded in case_law_index_jobs by the erasure
    await tx
      .delete(caseLawCitations)
      .where(eq(caseLawCitations.citingDecisionId, judgmentId));
    // audit: skip — GDPR redaction; recorded in case_law_index_jobs by the erasure
    await tx
      .update(caseLawDecisions)
      .set({
        metadata: metadataMarkedListingOnly(caseLawDecisions.metadata),
        updatedAt: new Date(),
      })
      .where(eq(caseLawDecisions.id, judgmentId));
  });
  return Result.ok("withheld");
};

/** Rebuild a withheld holder from its own payload under the source's lease. */
const recomposeHolder = async ({
  scopedDb,
  judgmentId,
  sourceId,
  readStoredRaw,
  leaseWaitMs,
  reparseOverride,
  erasedId,
}: {
  scopedDb: ScopedDb;
  /** The erased row the judgment must no longer compose. */
  erasedId: SafeId<"caseLawDecision">;
  judgmentId: SafeId<"caseLawDecision">;
  sourceId: SafeId<"caseLawSource">;
  readStoredRaw: StoredRawResultReader;
  leaseWaitMs: number;
  reparseOverride: NonNullable<SourceAdapter["reparseStoredRaw"]> | undefined;
}): Promise<{ type: "recomposed" } | { type: "withheld"; reason: string }> => {
  const source = (
    await scopedDb((tx) =>
      tx
        .select({ adapterKey: caseLawSources.adapterKey })
        .from(caseLawSources)
        .where(eq(caseLawSources.id, sourceId))
        .limit(1),
    )
  ).at(0);
  const reparseStoredRaw =
    reparseOverride ??
    (source === undefined
      ? undefined
      : getAdapter(source.adapterKey)?.reparseStoredRaw);
  if (reparseStoredRaw === undefined) {
    return {
      type: "withheld",
      reason: "its adapter cannot rebuild a stored payload",
    };
  }
  const acquisition = await acquireReplayLease({
    acquire: async () =>
      await acquireCaseLawSourceIngestionLease({ scopedDb, sourceId }),
    waitBudgetMs: leaseWaitMs,
  });
  if (acquisition.type === "unavailable") {
    return { type: "withheld", reason: "the source's ingestion lease is held" };
  }
  const { lease } = acquisition;
  const rebuiltAndWritten = await Result.tryPromise({
    try: async () => {
      const rebuilt = await rebuildStoredJudgment({
        judgmentId,
        scopedDb,
        reparseStoredRaw,
        readStoredRaw,
      });
      if (rebuilt.type === "unreadable") {
        return { type: "withheld" as const, reason: rebuilt.detail };
      }
      if (rebuilt.type === "read-failed") {
        return { type: "withheld" as const, reason: rebuilt.error.message };
      }
      await lease.beforeDatabaseMark();
      const written = await processDecision({
        input: rebuilt.result,
        sourceId,
        scopedDb,
        observedAt: new Date(),
        observationOrder: await allocateSourceObservationOrder({
          leaseToken: lease.leaseToken,
          scopedDb,
          sourceId,
        }),
        refresh: DECISION_REFRESH.ALWAYS,
      });
      if (written.status !== PROCESS_DECISION_STATUS.COMPLETE) {
        return {
          type: "withheld" as const,
          reason: `retryable: ${written.reason}`,
        };
      }
      // A write can complete without landing (a newer observation owns the
      // row); only a document that no longer composes the erased row counts.
      const landed = await scopedDb(async (tx) =>
        (
          await tx
            .select({ id: caseLawDecisions.id })
            .from(caseLawDecisions)
            .where(
              and(
                eq(caseLawDecisions.id, judgmentId),
                isNotNull(caseLawDecisions.fulltext),
              ),
            )
            .limit(1)
        ).at(0),
      );
      const stillHolds = (await selectHolders(scopedDb, erasedId)).some(
        ({ id }) => id === judgmentId,
      );
      return landed !== undefined && !stillHolds
        ? { type: "recomposed" as const }
        : {
            type: "withheld" as const,
            reason: "the rebuild did not replace its document",
          };
    },
    catch: (cause) => cause,
  });
  await lease.release();
  if (Result.isError(rebuiltAndWritten)) {
    return {
      type: "withheld",
      reason:
        rebuiltAndWritten.error instanceof Error
          ? rebuiltAndWritten.error.message
          : "the rebuild failed",
    };
  }
  return rebuiltAndWritten.value;
};

/**
 * Redact a decision, then take the erased text out of every judgment that
 * composed it as a supplement. See the module comment.
 */
export const redactCaseLawDecisionWithSupplementHolders = async ({
  decisionId,
  scopedDb,
  readStoredRaw = readStoredRawFromS3,
  leaseWaitMs = HOLDER_LEASE_WAIT_MS,
  reparseStoredRaw,
}: RedactWithSupplementHoldersOptions): Promise<
  Result<RedactWithSupplementHoldersOutcome, DatabaseError>
> => {
  const redaction = await redactCaseLawDecision({ decisionId, scopedDb });
  if (Result.isError(redaction)) {
    return redaction;
  }
  if (redaction.value.type === "not-found") {
    return Result.ok({ redaction: redaction.value, holders: [] });
  }
  // One at a time: each takes the citation graph lock and the source lease.
  const settled = await mapWithConcurrency({
    items: await selectHolders(scopedDb, decisionId),
    limit: 1,
    operation: async (
      holder,
    ): Promise<Result<ErasedSupplementHolderOutcome, DatabaseError>> => {
      const withheld = await withholdHolder(scopedDb, holder.id);
      if (Result.isError(withheld)) {
        return withheld;
      }
      if (withheld.value === "incomplete") {
        return Result.ok({
          type: "withhold-incomplete",
          judgmentId: holder.id,
        });
      }
      const recomposed = await recomposeHolder({
        scopedDb,
        judgmentId: holder.id,
        sourceId: holder.sourceId,
        readStoredRaw,
        leaseWaitMs,
        reparseOverride: reparseStoredRaw,
        erasedId: decisionId,
      });
      return Result.ok(
        recomposed.type === "recomposed"
          ? { type: "recomposed", judgmentId: holder.id }
          : {
              type: "withheld",
              judgmentId: holder.id,
              reason: recomposed.reason,
            },
      );
    },
  });
  const failed = settled.find((outcome) => Result.isError(outcome));
  if (failed !== undefined && Result.isError(failed)) {
    return failed;
  }
  return Result.ok({
    redaction: redaction.value,
    holders: settled.flatMap((outcome) =>
      Result.isOk(outcome) ? [outcome.value] : [],
    ),
  });
};
