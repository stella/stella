/**
 * Fold the supplements a source stored as decisions, before supplements
 * existed, into the judgments they belong to.
 *
 * SAOS publishes the written reasons of a ruling as a judgment of its own,
 * and every one of them was stored as a decision row beside its ruling. Each
 * such row still holds the publisher's payload, so the fold needs no request:
 * the row's payload is re-parsed by the adapter, which now answers with a
 * supplement, and the supplement goes through `processSupplement`, the path a
 * crawl takes. Where a stored ruling is its judgment, the judgment is written
 * again with the reasons composed into its document and citations, and the
 * old row is absorbed; where none is, the row is written again as the
 * standalone reasons it is, typed as such, and the supplement waits parked
 * for its judgment.
 *
 * Checkpointing is the rows' own state: an absorbed row leaves the selection,
 * so a re-run resumes by asking again, and the keyset only steps a single run
 * past the rows it could not finish. A run stops on the first retryable
 * outcome and reports the row to resume after.
 */

import { panic, Result } from "better-result";
import { and, asc, eq, gt, inArray, isNotNull, isNull } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawDecisions } from "@/api/db/schema";
import type {
  SourceAdapter,
  StoredRawResultReader,
  StoredRawReparseRejection,
} from "@/api/handlers/case-law/ingestion/adapter";
import {
  allocateSourceObservationOrder,
  PROCESS_DECISION_STATUS,
  processSupplement,
} from "@/api/handlers/case-law/ingestion/pipeline";
import type { CaseLawCorpusDependencies } from "@/api/handlers/case-law/ingestion/pipeline";
import type { SafeId } from "@/api/lib/branded-types";
import { decisionAbsorptionSql } from "@/api/lib/case-law/decision-absorption";
import type { CaseLawSourceIngestionLease } from "@/api/lib/legal-search/case-law-source-ingestion-lease";

/** What folding one stored row came to. */
export const SUPPLEMENT_FOLD_OUTCOME = {
  /** Composed into its judgment; the row is absorbed. */
  MERGED: "merged",
  /** No stored ruling is its judgment; kept as standalone reasons. */
  STANDALONE: "standalone",
  /** Its judgment is redacted; the row is absorbed into it, unpublished. */
  WITHHELD: "withheld",
  /** The payload re-parses to a decision of its own, not a supplement. */
  NOT_A_SUPPLEMENT: "not-a-supplement",
  /** The adapter could not rebuild anything from the payload. */
  REJECTED: "rejected",
  /** The row names a payload object storage does not hold. */
  MISSING_PAYLOAD: "missing-payload",
  /** The pipeline asked for a retry; the run stops here. */
  RETRYABLE: "retryable",
} as const;

type SupplementFoldOutcome =
  (typeof SUPPLEMENT_FOLD_OUTCOME)[keyof typeof SUPPLEMENT_FOLD_OUTCOME];

type SupplementFoldRowReport = {
  id: SafeId<"caseLawDecision">;
  caseNumber: string;
  outcome: SupplementFoldOutcome;
  detail?: string | undefined;
  rejection?: StoredRawReparseRejection | undefined;
};

export type SupplementFoldReport = {
  visited: number;
  outcomes: Record<SupplementFoldOutcome, number>;
  /** Rows that were not merged, at most `SUPPLEMENT_FOLD_LISTED_ROWS`. */
  listed: SupplementFoldRowReport[];
  /** The last row this run finished; pass it back as `after` to resume. */
  resumeAfter: SafeId<"caseLawDecision"> | null;
  haltReason: string | null;
};

const SUPPLEMENT_FOLD_LISTED_ROWS = 50;

const emptyOutcomes = (): Record<SupplementFoldOutcome, number> => ({
  [SUPPLEMENT_FOLD_OUTCOME.MERGED]: 0,
  [SUPPLEMENT_FOLD_OUTCOME.STANDALONE]: 0,
  [SUPPLEMENT_FOLD_OUTCOME.WITHHELD]: 0,
  [SUPPLEMENT_FOLD_OUTCOME.NOT_A_SUPPLEMENT]: 0,
  [SUPPLEMENT_FOLD_OUTCOME.REJECTED]: 0,
  [SUPPLEMENT_FOLD_OUTCOME.MISSING_PAYLOAD]: 0,
  [SUPPLEMENT_FOLD_OUTCOME.RETRYABLE]: 0,
});

export type FoldStoredSupplementsOptions = {
  scopedDb: ScopedDb;
  sourceId: SafeId<"caseLawSource">;
  adapter: SourceAdapter;
  readStoredRaw: StoredRawResultReader;
  /** Held for the whole run: every write is ordered on the source's counter. */
  sourceLease: CaseLawSourceIngestionLease;
  /**
   * The decision types the rows to fold were stored under. A row of one of
   * these types whose payload is not a supplement is reported and left.
   */
  decisionTypes: readonly string[];
  /** Rows visited by this run, at most. */
  limit: number;
  pageSize: number;
  after?: SafeId<"caseLawDecision"> | null;
  /** Test seam; production writes through the configured corpus stores. */
  corpus?: CaseLawCorpusDependencies;
};

/**
 * Rows still stored under one of the types, with a payload to read, not
 * redacted, and not yet absorbed into a judgment.
 */
const selectFoldPage = async ({
  scopedDb,
  sourceId,
  decisionTypes,
  after,
  limit,
}: {
  scopedDb: ScopedDb;
  sourceId: SafeId<"caseLawSource">;
  decisionTypes: readonly string[];
  after: SafeId<"caseLawDecision"> | null;
  limit: number;
}) =>
  await scopedDb((tx) =>
    tx
      .select({
        id: caseLawDecisions.id,
        caseNumber: caseLawDecisions.caseNumber,
        sourceDocumentId: caseLawDecisions.sourceDocumentId,
        language: caseLawDecisions.language,
        court: caseLawDecisions.court,
        ecli: caseLawDecisions.ecli,
        decisionDate: caseLawDecisions.decisionDate,
        decisionType: caseLawDecisions.decisionType,
        sourceUrl: caseLawDecisions.sourceUrl,
        documentUrl: caseLawDecisions.documentUrl,
        metadata: caseLawDecisions.metadata,
        sourceRawS3Key: caseLawDecisions.sourceRawS3Key,
        sourceRawContentType: caseLawDecisions.sourceRawContentType,
      })
      .from(caseLawDecisions)
      .where(
        and(
          eq(caseLawDecisions.sourceId, sourceId),
          inArray(caseLawDecisions.decisionType, [...decisionTypes]),
          isNotNull(caseLawDecisions.sourceRawS3Key),
          isNull(caseLawDecisions.redactedAt),
          isNull(decisionAbsorptionSql(caseLawDecisions.metadata)),
          after === null ? undefined : gt(caseLawDecisions.id, after),
        ),
      )
      .orderBy(asc(caseLawDecisions.id))
      .limit(limit),
  );

type FoldRow = Awaited<ReturnType<typeof selectFoldPage>>[number];

export const foldStoredSupplements = async ({
  scopedDb,
  sourceId,
  adapter,
  readStoredRaw,
  sourceLease,
  decisionTypes,
  limit,
  pageSize,
  after = null,
  corpus,
}: FoldStoredSupplementsOptions): Promise<SupplementFoldReport> => {
  const reparseStoredRaw =
    adapter.reparseStoredRaw ??
    panic(
      `Adapter ${adapter.key} cannot re-parse a stored payload, so it has no supplements to fold`,
    );
  const report: SupplementFoldReport = {
    visited: 0,
    outcomes: emptyOutcomes(),
    listed: [],
    resumeAfter: null,
    haltReason: null,
  };
  const nextObservationOrder = async (): Promise<bigint> => {
    await sourceLease.beforeDatabaseMark();
    return await allocateSourceObservationOrder({
      leaseToken: sourceLease.leaseToken,
      scopedDb,
      sourceId,
    });
  };

  const foldRow = async (
    row: FoldRow & { sourceRawS3Key: string },
  ): Promise<SupplementFoldRowReport> => {
    const base = { id: row.id, caseNumber: row.caseNumber };
    const read = await readStoredRaw(row.sourceRawS3Key);
    if (Result.isError(read)) {
      return {
        ...base,
        outcome: SUPPLEMENT_FOLD_OUTCOME.RETRYABLE,
        detail: read.error.message,
      };
    }
    const raw = read.value;
    if (raw === null) {
      return {
        ...base,
        outcome: SUPPLEMENT_FOLD_OUTCOME.MISSING_PAYLOAD,
        detail: row.sourceRawS3Key,
      };
    }
    const reparsed = await reparseStoredRaw({
      raw,
      contentType: row.sourceRawContentType,
      caseNumber: row.caseNumber,
      sourceDocumentId: row.sourceDocumentId,
      language: row.language,
      court: row.court,
      ecli: row.ecli,
      decisionDate: row.decisionDate,
      decisionType: row.decisionType,
      sourceUrl: row.sourceUrl,
      documentUrl: row.documentUrl,
      metadata: row.metadata ?? {},
    });
    switch (reparsed.type) {
      case "rejected":
        return {
          ...base,
          outcome: SUPPLEMENT_FOLD_OUTCOME.REJECTED,
          rejection: reparsed.rejection,
          detail: reparsed.detail,
        };
      case "parsed":
        return { ...base, outcome: SUPPLEMENT_FOLD_OUTCOME.NOT_A_SUPPLEMENT };
      case "supplement":
        break;
      default: {
        reparsed satisfies never;
        return panic(`Unhandled reparse outcome: ${JSON.stringify(reparsed)}`);
      }
    }
    if (
      reparsed.supplement.document.sourceDocumentId !== row.sourceDocumentId
    ) {
      return {
        ...base,
        outcome: SUPPLEMENT_FOLD_OUTCOME.REJECTED,
        detail: `the payload names ${reparsed.supplement.document.sourceDocumentId}`,
      };
    }
    const placed = await processSupplement({
      // The bytes this run read: the standalone row keeps its pointer on the
      // same content-addressed object.
      supplement: {
        ...reparsed.supplement,
        document: {
          ...reparsed.supplement.document,
          sourceRawBytes: raw,
          sourceRawContentType:
            row.sourceRawContentType ??
            reparsed.supplement.document.sourceRawContentType,
        },
      },
      sourceId,
      scopedDb,
      observedAt: new Date(),
      nextObservationOrder,
      reparseStoredRaw,
      readStoredRaw,
      ...(corpus === undefined ? {} : { corpus }),
    });
    if (placed.status === PROCESS_DECISION_STATUS.RETRYABLE) {
      return {
        ...base,
        outcome: SUPPLEMENT_FOLD_OUTCOME.RETRYABLE,
        detail: placed.reason,
      };
    }
    const { disposition } = placed;
    switch (disposition.type) {
      case "merged":
        return {
          ...base,
          outcome: SUPPLEMENT_FOLD_OUTCOME.MERGED,
          detail: disposition.judgmentId,
        };
      case "standalone":
        return {
          ...base,
          outcome: SUPPLEMENT_FOLD_OUTCOME.STANDALONE,
          detail: disposition.reason,
        };
      case "withheld":
        return {
          ...base,
          outcome: SUPPLEMENT_FOLD_OUTCOME.WITHHELD,
          detail: disposition.judgmentId,
        };
      default: {
        disposition satisfies never;
        return panic(
          `Unhandled supplement disposition: ${JSON.stringify(disposition)}`,
        );
      }
    }
  };

  let cursor = after;
  while (report.visited < limit) {
    // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- a keyset page at a time; each row below writes its own judgment
    const page = await selectFoldPage({
      scopedDb,
      sourceId,
      decisionTypes,
      after: cursor,
      limit: Math.min(pageSize, limit - report.visited),
    });
    if (page.length === 0) {
      break;
    }
    for (const row of page) {
      const { sourceRawS3Key } = row;
      if (sourceRawS3Key === null) {
        continue;
      }
      const folded = await Result.tryPromise({
        try: async () => await foldRow({ ...row, sourceRawS3Key }),
        catch: (cause) => cause,
      });
      if (Result.isError(folded)) {
        // Says nothing about the row: hold the cursor behind it.
        report.haltReason = `${row.caseNumber} ${row.id} could not be folded: ${
          folded.error instanceof Error
            ? folded.error.message.slice(0, 300)
            : String(folded.error).slice(0, 300)
        }`;
        return report;
      }
      const rowReport = folded.value;
      report.visited += 1;
      report.outcomes[rowReport.outcome] += 1;
      if (
        rowReport.outcome !== SUPPLEMENT_FOLD_OUTCOME.MERGED &&
        report.listed.length < SUPPLEMENT_FOLD_LISTED_ROWS
      ) {
        report.listed.push(rowReport);
      }
      if (rowReport.outcome === SUPPLEMENT_FOLD_OUTCOME.RETRYABLE) {
        report.haltReason = `retryable outcome on ${row.caseNumber} ${row.id}: ${rowReport.detail ?? ""}`;
        return report;
      }
      cursor = row.id;
      report.resumeAfter = row.id;
    }
  }
  return report;
};
