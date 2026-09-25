/**
 * Read the record card for decisions stored before this adapter fetched one.
 *
 * The card is where the Czech Constitutional Court states its rapporteur and
 * the judges who filed a separate opinion, beside the rest of its labelled
 * fields. Rows ingested before the adapter read it hold a stored payload with
 * the document but no card, so those fields are recoverable only by asking
 * the publisher again — once per decision that has one, because the run writes
 * the card into the row's stored payload and every later re-parse reads it
 * from there instead. The court's own answer that it holds no card is written
 * onto the row for the same reason, so only a request that said nothing at all
 * is ever repeated.
 *
 * Checkpointing is the row's own state rather than a cursor: a decision whose
 * card has been read says so in its metadata and leaves the selection, so a
 * run that stops anywhere resumes by asking the same question again, and two
 * runs that overlap each see what the other committed.
 *
 * Nálezy first. A separate opinion is filed against those, so the value of a
 * bounded run is front-loaded rather than spread evenly over the corpus.
 *
 * Not a migration: it spends publisher requests, so it is bounded per run by
 * a request budget and run as an operator job.
 */

import { panic, Result, TaggedError } from "better-result";
import { and, asc, eq, gt, isNotNull, or, sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawDecisions } from "@/api/db/schema";
import {
  encodeSourceRawEnvelope,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
} from "@/api/handlers/case-law/ingestion/adapter";
import type {
  StoredRawReader,
  StoredRawReparseOutcome,
} from "@/api/handlers/case-law/ingestion/adapter";
import {
  CZ_US_RECORD_CARD_METADATA_KEY,
  CZ_US_RECORD_CARD_STATE,
  czUsAdapter,
  fetchNalusRecordCard,
  openNalusSession,
} from "@/api/handlers/case-law/ingestion/adapters/cz-us";
import type { NalusSession } from "@/api/handlers/case-law/ingestion/adapters/cz-us";
import { NalusRateLimitedError } from "@/api/handlers/case-law/ingestion/adapters/cz-us-throttle";
import { NALUS_DAILY_REQUEST_LIMIT } from "@/api/handlers/case-law/ingestion/adapters/publisher-policy";
import { processDecision } from "@/api/handlers/case-law/ingestion/pipeline/decision";
import { allocateSourceObservationOrder } from "@/api/handlers/case-law/ingestion/pipeline/source-observation";
import { DECISION_REFRESH } from "@/api/handlers/case-law/ingestion/pipeline/types";
import type { SafeId } from "@/api/lib/branded-types";
import type { CaseLawSourceIngestionLease } from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import { decodeSourceRawEnvelope } from "@/api/lib/legal-search/ingestion-types";
import { logger } from "@/api/lib/observability/logger";

/** The decision type the court gives the rulings a dissent is filed against. */
const RULING_DECISION_TYPE = "nález";

/**
 * The two tiers this walks, in order: a tier is finished before the next one
 * starts. Each is keyed by decision id alone, because a keyset over one
 * stable column is what lets a row the run could not finish be stepped over
 * without the page restarting on it. What brings that row back is its own
 * unchanged state on the next run.
 */
const BACKFILL_TIER = {
  RULINGS: "rulings",
  REMAINING: "remaining",
} as const;

type BackfillTier = (typeof BACKFILL_TIER)[keyof typeof BACKFILL_TIER];

const BACKFILL_TIERS: readonly BackfillTier[] = [
  BACKFILL_TIER.RULINGS,
  BACKFILL_TIER.REMAINING,
];

/**
 * Publisher requests one run may spend by default: a fifth of what the court
 * allows an automated client in a day. The crawl draws on the same budget,
 * and a repair that starves it is not a repair.
 */
const DEFAULT_REQUEST_BUDGET = Math.floor(NALUS_DAILY_REQUEST_LIMIT / 5);

const DEFAULT_PAGE_SIZE = 100;

/** Why a run stopped. */
const BACKFILL_STOP_REASON = {
  /** Every selectable row in both tiers has been asked about. */
  SOURCE_EXHAUSTED: "source-exhausted",
  /** The run spent its request budget. */
  BUDGET_SPENT: "budget-spent",
  /** The publisher refused; no retry inside this run clears that. */
  PUBLISHER_LIMIT: "publisher-limit",
  /** The caller cancelled. */
  CANCELLED: "cancelled",
  /** Something outside the run's own outcomes failed; the counts are partial. */
  FAILED: "failed",
} as const;

type BackfillStopReason =
  (typeof BACKFILL_STOP_REASON)[keyof typeof BACKFILL_STOP_REASON];

export type CzUsJudgesBackfillReport = {
  stoppedBecause: BackfillStopReason;
  /** Rows whose card was read and written back. */
  applied: number;
  /** Rows the court states it holds no card for. */
  cardAbsent: number;
  /** Rows whose stored payload could not be read or re-parsed. */
  unreadable: number;
  /** Rows whose card the court could not serve; a later run asks again. */
  deferred: number;
  requestsSpent: number;
};

/**
 * A pass that stopped on something other than one of its own stop reasons.
 *
 * It carries the report the run had reached: the rows it applied are on the
 * corpus whether or not the pass finished, and an operator who cannot see
 * them cannot tell a first request that failed from a last one.
 */
export class CzUsJudgesBackfillError extends TaggedError(
  "CzUsJudgesBackfillError",
)<{
  message: string;
  report: CzUsJudgesBackfillReport;
  cause: unknown;
}> {}

export type CzUsJudgesBackfillOptions = {
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
  /** Opens the court session the card requires. */
  openSession?: (signal?: AbortSignal) => Promise<NalusSession>;
  requestBudget?: number;
  pageSize?: number;
  signal?: AbortSignal;
  onProgress?: (report: CzUsJudgesBackfillReport) => void;
};

type BackfillRow = {
  id: SafeId<"caseLawDecision">;
  caseNumber: string;
  sourceDocumentId: string | null;
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
  nalusRecordId: string;
};

type BackfillPageOptions = {
  tier: BackfillTier;
  after: SafeId<"caseLawDecision"> | null;
  limit: number;
};

/**
 * Rows of one tier the court has not answered about yet, as a reader bound to
 * the run's handle and source.
 *
 * Both are constant for the life of a run and only the cursor moves, so they
 * are closed over once rather than threaded through every page: the walk asks
 * for the next page, not for a query against a database.
 *
 * A row with no stored payload is out of scope: rebuilding it would mean
 * fetching the document again, which is the crawl's work and not this run's.
 * So is a row without the record id the card is addressed by.
 */
const backfillPageReader =
  (scopedDb: ScopedDb, sourceId: SafeId<"caseLawSource">) =>
  async ({
    tier,
    after,
    limit,
  }: BackfillPageOptions): Promise<BackfillRow[]> => {
    const recordCard = sql<
      string | null
    >`${caseLawDecisions.metadata}->>${CZ_US_RECORD_CARD_METADATA_KEY}`;
    const nalusRecordId = sql<
      string | null
    >`${caseLawDecisions.metadata}->>'nalusRecordId'`;
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
          nalusRecordId,
        })
        .from(caseLawDecisions)
        .where(
          and(
            eq(caseLawDecisions.sourceId, sourceId),
            isNotNull(caseLawDecisions.sourceRawS3Key),
            isNotNull(caseLawDecisions.sourceDocumentId),
            isNotNull(caseLawDecisions.sourceUrl),
            sql`${nalusRecordId} is not null`,
            // Nothing has asked the court about this row's card, or the answer
            // said nothing about it. `read` and `absent` are the two durable
            // answers and both leave the selection for good.
            or(
              sql`${recordCard} is null`,
              sql`${recordCard} = ''`,
              sql`${recordCard} = ${CZ_US_RECORD_CARD_STATE.UNAVAILABLE}`,
            ),
            tier === BACKFILL_TIER.RULINGS
              ? eq(caseLawDecisions.decisionType, RULING_DECISION_TYPE)
              : sql`${caseLawDecisions.decisionType} is distinct from ${RULING_DECISION_TYPE}`,
            after === null ? undefined : gt(caseLawDecisions.id, after),
          ),
        )
        .orderBy(asc(caseLawDecisions.id))
        .limit(limit),
    );

    return rows.flatMap((row) => {
      const { nalusRecordId: recordId, sourceRawS3Key } = row;
      return recordId === null || sourceRawS3Key === null
        ? []
        : [{ ...row, nalusRecordId: recordId, sourceRawS3Key }];
    });
  };

/**
 * The stored payload with the card added to it.
 *
 * A payload stored before the envelope holds the document alone, under its
 * own media type; it is read here and rewritten as an envelope, which is the
 * only form this adapter writes.
 */
const withRecordCard = (
  row: BackfillRow,
  stored: Uint8Array,
  cardHtml: string,
): string | null => {
  const raw = new TextDecoder().decode(stored);
  const parts =
    row.sourceRawContentType === SOURCE_RAW_ENVELOPE_CONTENT_TYPE
      ? decodeSourceRawEnvelope(raw)
      : { document: raw };
  return parts === null
    ? null
    : encodeSourceRawEnvelope({ ...parts, detail: cardHtml });
};

/**
 * The court's own answer that it holds no card, written onto the row.
 *
 * The checkpoint is the row's state, so an absence that is never written back
 * would be re-asked on every later run: one durable answer, one request, ever.
 * `jsonb_set` rather than a read-modify-write, so a crawl writing the same row
 * at the same time keeps its own keys.
 */
const markRecordCardAbsent = async (
  scopedDb: ScopedDb,
  decisionId: SafeId<"caseLawDecision">,
): Promise<void> => {
  await scopedDb(async (tx) => {
    // audit: skip — background case-law ingestion pipeline; public case-law data, not user actions
    await tx
      .update(caseLawDecisions)
      .set({
        metadata: sql`jsonb_set(coalesce(${caseLawDecisions.metadata}, '{}'::jsonb), ${`{${CZ_US_RECORD_CARD_METADATA_KEY}}`}::text[], ${JSON.stringify(
          CZ_US_RECORD_CARD_STATE.ABSENT,
        )}::text::jsonb, true)`,
      })
      .where(eq(caseLawDecisions.id, decisionId));
  });
};

const reparsedWithCard = async (
  row: BackfillRow,
  raw: string,
): Promise<StoredRawReparseOutcome> =>
  await (czUsAdapter.reparseStoredRaw?.({
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
  }) ?? panic("The cz-us adapter no longer re-parses a stored payload"));

/**
 * Walk the source, reading one record card for every decision that has not
 * had one read, and write each back through the ingestion pipeline.
 *
 * The pipeline is what makes the write replay-safe: it re-uploads the payload
 * with the card in it and replaces the decision's judges in the transaction
 * that writes the row, so a run that dies between the two leaves neither.
 */
export const runCzUsJudgesBackfill = async ({
  scopedDb,
  sourceId,
  sourceLease,
  readStoredRaw,
  openSession = openNalusSession,
  requestBudget = DEFAULT_REQUEST_BUDGET,
  pageSize = DEFAULT_PAGE_SIZE,
  signal,
  onProgress,
}: CzUsJudgesBackfillOptions): Promise<
  Result<CzUsJudgesBackfillReport, CzUsJudgesBackfillError>
> => {
  const report: CzUsJudgesBackfillReport = {
    stoppedBecause: BACKFILL_STOP_REASON.SOURCE_EXHAUSTED,
    applied: 0,
    cardAbsent: 0,
    unreadable: 0,
    deferred: 0,
    requestsSpent: 0,
  };

  const readPage = backfillPageReader(scopedDb, sourceId);

  // One session for the run: the card needs a court session, and opening one
  // per decision would double what the run costs the publisher. Opened on
  // first use, so a run with no budget and a run with no selectable row both
  // cost the publisher nothing.
  let session: NalusSession | null = null;
  const currentSession = async (): Promise<NalusSession> => {
    if (session === null) {
      session = await openSession(signal);
      report.requestsSpent += 1;
    }
    return session;
  };

  const writeRow = async (
    row: BackfillRow,
    cardHtml: string,
  ): Promise<void> => {
    const stored = await readStoredRaw(row.sourceRawS3Key);
    const raw = stored === null ? null : withRecordCard(row, stored, cardHtml);
    if (raw === null) {
      report.unreadable += 1;
      return;
    }
    const reparsed = await reparsedWithCard(row, raw);
    if (reparsed.type !== "parsed") {
      logger.warn("case_law.ingestion.cz_us_record_card_unreadable", {
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
        // The crawl's own hash covers the abstract and the judges, which the
        // re-parse's identity hash does not. Keeping the stored one leaves
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
    const card = await fetchNalusRecordCard(
      row.nalusRecordId,
      await currentSession(),
      signal,
    );
    report.requestsSpent += 1;

    switch (card.type) {
      case CZ_US_RECORD_CARD_STATE.READ:
        await writeRow(row, card.html);
        return;
      case CZ_US_RECORD_CARD_STATE.ABSENT:
        // The court states it holds no card for this record. Written onto the
        // row before the cursor moves, so the answer is spent once.
        await sourceLease.beforeDatabaseMark();
        await markRecordCardAbsent(scopedDb, row.id);
        report.cardAbsent += 1;
        return;
      case CZ_US_RECORD_CARD_STATE.UNAVAILABLE:
        // A lapsed session answers this way too, so the next row opens a new
        // one rather than spending the rest of the run on a dead cookie. The
        // open waits for that row's own budget check.
        session = null;
        report.deferred += 1;
        return;
      default:
        card satisfies never;
        return panic(`Unhandled record-card outcome: ${JSON.stringify(card)}`);
    }
  };

  for (const tier of BACKFILL_TIERS) {
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
      // db-await-in-loop: keyset page per iteration; the page is the batch
      const page = await readPage({ tier, after, limit: pageSize });
      if (page.length === 0) {
        break;
      }
      for (const row of page) {
        if (report.requestsSpent >= requestBudget) {
          report.stoppedBecause = BACKFILL_STOP_REASON.BUDGET_SPENT;
          return Result.ok(report);
        }
        const applied = await Result.tryPromise(
          // db-await-in-loop: each row is written after its own budgeted record-card request, through the decision pipeline under the source lease
          async () => await applyRow(row),
        );
        if (Result.isError(applied)) {
          if (applied.error.cause instanceof NalusRateLimitedError) {
            report.stoppedBecause = BACKFILL_STOP_REASON.PUBLISHER_LIMIT;
            return Result.ok(report);
          }
          report.stoppedBecause = BACKFILL_STOP_REASON.FAILED;
          return Result.err(
            new CzUsJudgesBackfillError({
              message: applied.error.message,
              report: { ...report },
              cause: applied.error,
            }),
          );
        }
        after = row.id;
        onProgress?.({ ...report });
      }
    }
  }

  return Result.ok(report);
};
