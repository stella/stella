/**
 * Read the documents that later affected each stored Czech regional-court
 * decision, and write them onto the row.
 *
 * The publisher states its decision graph twice. The outgoing half travels
 * inside the document payload the crawl already fetches, so it costs nothing.
 * The incoming half — `/api/finalDocChain/affectingDocs/{uuid}` — is one
 * request per decision and is the only surface naming the affecting
 * document's own id, which is what makes the edge resolvable without matching
 * court and docket text. A crawl that asked for it would double what a page
 * costs the publisher, so it is a pass of its own, bounded by a request
 * budget and run by an operator.
 *
 * Checkpointing is the row's own state rather than a cursor: a row whose
 * chain has been read carries `affectingDocs` in its metadata and leaves the
 * selection, so a run that stops anywhere resumes by asking the same question
 * again, and two runs that overlap each see what the other committed. An
 * empty chain is written as an empty list, which is the publisher saying
 * nothing affects the decision — not the same as never having asked.
 *
 * A later full observation of the same row (a re-walk of the tip window)
 * replaces the stored payload with the listing and document alone, so the
 * chain leaves that row and the next pass reads it again. That is the
 * checkpoint working, not drift: the state asked about is the row's, and a
 * row that no longer holds the part has not been asked since it lost it.
 */

import { panic, Result } from "better-result";
import type { UnhandledException } from "better-result";
import { and, asc, eq, gt, isNotNull, sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawDecisions } from "@/api/db/schema";
import {
  decodeSourceRawEnvelope,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
} from "@/api/handlers/case-law/ingestion/adapter";
import type {
  StoredRawReader,
  StoredRawReparseOutcome,
} from "@/api/handlers/case-law/ingestion/adapter";
import {
  CZ_REGIONAL_AFFECTING_DOCS_METADATA_KEY,
  czRegionalAdapter,
  czRegionalEnvelopeWithChain,
  fetchCzRegionalAffectingDocs,
} from "@/api/handlers/case-law/ingestion/adapters/cz-regional";
import { processDecision } from "@/api/handlers/case-law/ingestion/pipeline/decision";
import { allocateSourceObservationOrder } from "@/api/handlers/case-law/ingestion/pipeline/source-observation";
import { DECISION_REFRESH } from "@/api/handlers/case-law/ingestion/pipeline/types";
import type { SafeId } from "@/api/lib/branded-types";
import type { CaseLawSourceIngestionLease } from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import { logger } from "@/api/lib/observability/logger";

/**
 * Publisher requests one run may spend by default.
 *
 * The publisher states no daily ceiling, so this is a run length rather than
 * a share of one: enough that a pass is worth starting, small enough that an
 * operator reads the report before spending the next.
 */
const DEFAULT_REQUEST_BUDGET = 5000;

const DEFAULT_PAGE_SIZE = 100;

/** Why a run stopped. */
const BACKFILL_STOP_REASON = {
  /** Every selectable row has been asked about. */
  SOURCE_EXHAUSTED: "source-exhausted",
  /** The run spent its request budget. */
  BUDGET_SPENT: "budget-spent",
  /** The caller cancelled. */
  CANCELLED: "cancelled",
} as const;

type BackfillStopReason =
  (typeof BACKFILL_STOP_REASON)[keyof typeof BACKFILL_STOP_REASON];

export type CzRegionalChainBackfillReport = {
  stoppedBecause: BackfillStopReason;
  /** Rows whose chain was read and written back. */
  applied: number;
  /** Rows whose stored payload could not be read or re-parsed. */
  unreadable: number;
  /** Rows the publisher did not answer for; a later run asks again. */
  deferred: number;
  requestsSpent: number;
};

export type CzRegionalChainBackfillOptions = {
  scopedDb: ScopedDb;
  sourceId: SafeId<"caseLawSource">;
  /**
   * The source's ingestion lease. The run writes through the pipeline and
   * numbers its observations on the source's own counter, so it has to hold
   * what a crawl holds or the two could overwrite each other.
   */
  sourceLease: CaseLawSourceIngestionLease;
  /** Reads a stored payload out of object storage. */
  readStoredRaw: StoredRawReader;
  requestBudget?: number;
  pageSize?: number;
  signal?: AbortSignal;
  onProgress?: (report: CzRegionalChainBackfillReport) => void;
};

type BackfillRow = {
  id: SafeId<"caseLawDecision">;
  caseNumber: string;
  sourceDocumentId: string;
  language: string;
  court: string;
  ecli: string | null;
  decisionDate: string | null;
  decisionType: string | null;
  sourceUrl: string | null;
  documentUrl: string | null;
  metadata: Record<string, unknown> | null;
  sourceHash: string | null;
  sourceRawS3Key: string;
  sourceRawContentType: string | null;
};

type BackfillPageOptions = {
  after: SafeId<"caseLawDecision"> | null;
  limit: number;
};

/**
 * Rows nothing has asked the publisher about yet, as a reader bound to the
 * run's handle and source.
 *
 * A row without a stored envelope is out of scope: the chain is written into
 * that envelope, and rebuilding a row without one would mean fetching the
 * document again, which is the crawl's work and not this run's. So is a row
 * without the id the chain is addressed by.
 */
const backfillPageReader =
  (scopedDb: ScopedDb, sourceId: SafeId<"caseLawSource">) =>
  async ({ after, limit }: BackfillPageOptions): Promise<BackfillRow[]> => {
    const affectingDocs = sql<
      string | null
    >`${caseLawDecisions.metadata}->${CZ_REGIONAL_AFFECTING_DOCS_METADATA_KEY}`;
    const rows = await scopedDb((tx) =>
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
          sourceHash: caseLawDecisions.sourceHash,
          sourceRawS3Key: caseLawDecisions.sourceRawS3Key,
          sourceRawContentType: caseLawDecisions.sourceRawContentType,
        })
        .from(caseLawDecisions)
        .where(
          and(
            eq(caseLawDecisions.sourceId, sourceId),
            isNotNull(caseLawDecisions.sourceRawS3Key),
            isNotNull(caseLawDecisions.sourceDocumentId),
            eq(
              caseLawDecisions.sourceRawContentType,
              SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
            ),
            // Absent, not empty: an empty list is an answer already given.
            sql`${affectingDocs} is null`,
            after === null ? undefined : gt(caseLawDecisions.id, after),
          ),
        )
        .orderBy(asc(caseLawDecisions.id))
        .limit(limit),
    );

    return rows.flatMap((row) => {
      const { sourceDocumentId, sourceRawS3Key } = row;
      return sourceDocumentId === null || sourceRawS3Key === null
        ? []
        : [{ ...row, sourceDocumentId, sourceRawS3Key }];
    });
  };

/**
 * Walk the source, reading the chain for every decision that has not had one
 * read, and write each back through the ingestion pipeline.
 *
 * The pipeline is what makes the write replay-safe: it re-uploads the payload
 * with the chain in it and replaces the row in the transaction that writes
 * it, so a run that dies between the two leaves neither.
 */
export const runCzRegionalChainBackfill = async ({
  scopedDb,
  sourceId,
  sourceLease,
  readStoredRaw,
  requestBudget = DEFAULT_REQUEST_BUDGET,
  pageSize = DEFAULT_PAGE_SIZE,
  signal,
  onProgress,
}: CzRegionalChainBackfillOptions): Promise<
  Result<CzRegionalChainBackfillReport, UnhandledException>
> => {
  const report: CzRegionalChainBackfillReport = {
    stoppedBecause: BACKFILL_STOP_REASON.SOURCE_EXHAUSTED,
    applied: 0,
    unreadable: 0,
    deferred: 0,
    requestsSpent: 0,
  };

  const readPage = backfillPageReader(scopedDb, sourceId);

  const reparsedWithChain = async (
    row: BackfillRow,
    raw: string,
  ): Promise<StoredRawReparseOutcome> =>
    await (czRegionalAdapter.reparseStoredRaw?.({
      raw: new TextEncoder().encode(raw),
      contentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
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
    }) ??
      panic("The cz-regional adapter no longer re-parses a stored payload"));

  const writeRow = async (row: BackfillRow, chainRaw: string) => {
    const stored = await readStoredRaw(row.sourceRawS3Key);
    const parts =
      stored === null
        ? null
        : decodeSourceRawEnvelope(new TextDecoder().decode(stored));
    if (parts === null) {
      report.unreadable += 1;
      return;
    }
    const reparsed = await reparsedWithChain(
      row,
      czRegionalEnvelopeWithChain(parts, chainRaw),
    );
    if (reparsed.type !== "parsed") {
      logger.warn("case_law.ingestion.cz_regional_chain_unreadable", {
        sourceId,
        caseNumber: row.caseNumber,
        outcome: reparsed.type,
      });
      report.unreadable += 1;
      return;
    }

    await sourceLease.beforeDatabaseMark();
    await processDecision({
      input: {
        ...reparsed.result,
        // The stored hash covers what the crawl observed. Keeping it leaves
        // the crawl's dedup exactly where it was, so this run does not make
        // the next cycle re-fetch what it has just written.
        rawHash: row.sourceHash ?? reparsed.result.rawHash,
      },
      sourceId,
      scopedDb,
      observedAt: new Date(),
      observationOrder: await allocateSourceObservationOrder({
        leaseToken: sourceLease.leaseToken,
        scopedDb,
        sourceId,
      }),
      refresh: DECISION_REFRESH.ALWAYS,
    });
    report.applied += 1;
  };

  const applyRow = async (row: BackfillRow): Promise<void> => {
    const chain = await fetchCzRegionalAffectingDocs(
      row.sourceDocumentId,
      signal,
    );
    report.requestsSpent += 1;
    if (chain === null) {
      // The publisher was asked and did not answer. Nothing is written, so
      // the row stays selectable and a later run asks again.
      report.deferred += 1;
      return;
    }
    await writeRow(row, chain.raw);
  };

  let after: SafeId<"caseLawDecision"> | null = null;
  for (;;) {
    if (signal?.aborted) {
      report.stoppedBecause = BACKFILL_STOP_REASON.CANCELLED;
      return Result.ok(report);
    }
    if (report.requestsSpent >= requestBudget) {
      report.stoppedBecause = BACKFILL_STOP_REASON.BUDGET_SPENT;
      return Result.ok(report);
    }
    const page = await readPage({ after, limit: pageSize });
    if (page.length === 0) {
      return Result.ok(report);
    }
    for (const row of page) {
      if (report.requestsSpent >= requestBudget) {
        report.stoppedBecause = BACKFILL_STOP_REASON.BUDGET_SPENT;
        return Result.ok(report);
      }
      const applied = await Result.tryPromise(async () => await applyRow(row));
      if (Result.isError(applied)) {
        return applied;
      }
      after = row.id;
      onProgress?.({ ...report });
    }
  }
};
