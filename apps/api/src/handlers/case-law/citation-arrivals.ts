/**
 * Identifiers arriving in the citation graph, and the citations they reopen.
 *
 * A stored decision changes the answer for citations that are not its own, in
 * both directions: it can satisfy citations that gave up on its key, and it
 * can make a key that had exactly one holder ambiguous, which retracts the
 * edges drawn to the earlier holder. Neither is discoverable from the citing
 * side, so the standing walk never revisits them; the arrival does.
 *
 * The decision write enqueues its arrivals (`enqueueCitationArrivals`) in its
 * own transaction. A drain (`drainCitationArrivals`) takes a bounded batch of
 * them, reopens every citation they can answer differently in one statement
 * and settles what it reopened, all in one graph transaction, and deletes the
 * arrivals it took in that same transaction. A drain that does not commit
 * leaves its arrivals for the next, so an arrival is never lost between the
 * write and its reopen. A page of decisions drains once, after the page; a
 * caller with a single decision drains after it. Neither is the only drain:
 * the standing walk (`tryResolveCitationBatch`) takes whatever they left
 * behind before each of its batches, so a failed drain, or a page that queued
 * more than one drain takes, never waits on a later decision write.
 *
 * The reopen reads the citations by their stored match key
 * (`citation-identifier-match-key.ts`) through an equality index. A citation
 * stored before that key existed is matched by its folded columns instead,
 * and only while such rows remain.
 */
import { Result } from "better-result";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import type { CaseLawJurisdiction } from "@stll/api-contract/case-law-jurisdictions";
import { sanitizeErrorAttributesForOutput } from "@stll/errors";
import type { DecisionIdentifierType } from "@stll/legal-ast/decision-identifier";

import { caseLawCitationArrivals } from "@/api/db/schema";
import { runCitationGraphTransaction } from "@/api/handlers/case-law/citation-graph-transaction";
import type { CitationGraphTransaction } from "@/api/handlers/case-law/citation-graph-transaction";
import {
  drainCitationArrivalsIn,
  NOTHING_DRAINED,
  reopenCitationsForArrivals,
} from "@/api/handlers/case-law/citation-resolution";
import type {
  CitationArrival,
  CitationArrivalDrain,
  ReopenedCitations,
} from "@/api/handlers/case-law/citation-resolution";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { caseNumberMatchKey } from "@/api/lib/case-law/case-number-match-key";
import { executedRows } from "@/api/lib/db/executed-rows";
import { errorSystemFields } from "@/api/lib/errors/utils";
import { handlerErrorContext } from "@/api/lib/observability/exception-context";
import { logger } from "@/api/lib/observability/logger";
import { pgErrorFields } from "@/api/lib/pg-error";
import { isRecord } from "@/api/lib/type-guards";

type DecisionIdentifiersArrival = {
  decisionId: SafeId<"caseLawDecision">;
  jurisdiction: CaseLawJurisdiction;
  decisionDate: string | null;
  identifiers: readonly {
    type: DecisionIdentifierType;
    normalizedValue: string;
  }[];
};

/** A decision's identifiers as arrivals, one per identity. */
export const citationArrivalsOf = ({
  decisionId,
  jurisdiction,
  decisionDate,
  identifiers,
}: DecisionIdentifiersArrival): CitationArrival[] => {
  const arrivals = new Map<string, CitationArrival>();
  for (const { type, normalizedValue } of identifiers) {
    const matchKey = caseNumberMatchKey(normalizedValue);
    arrivals.set(JSON.stringify([type, matchKey]), {
      decisionId,
      type,
      matchKey,
      jurisdiction,
      decisionDate,
    });
  }
  return [...arrivals.values()];
};

/**
 * Reopen the citations one decision's identifiers can answer differently, in
 * the caller's transaction. The single-decision form of the drain, for a
 * caller that reopens and settles inside its own write.
 */
export const reopenCitationsForDecisionIdentifiers = async (
  tx: CitationGraphTransaction,
  arrival: DecisionIdentifiersArrival,
): Promise<ReopenedCitations> =>
  await reopenCitationsForArrivals(tx, citationArrivalsOf(arrival));

/**
 * Record a decision write's arrivals, in the write's own transaction, for the
 * next drain. Nothing is reopened here: the write commits without touching a
 * citation it does not own.
 */
export const enqueueCitationArrivals = async (
  tx: CitationGraphTransaction,
  arrival: DecisionIdentifiersArrival,
): Promise<number> => {
  const arrivals = citationArrivalsOf(arrival);
  if (arrivals.length === 0) {
    return 0;
  }
  // audit: skip — derived public case-law citation queue, not a user action
  await tx.execute(sql`
    INSERT INTO ${caseLawCitationArrivals} (
      decision_id, identifier_type, match_key, jurisdiction, decision_date
    )
    SELECT a.decision_id, a.identifier_type, a.match_key, a.jurisdiction,
           a.decision_date
      FROM jsonb_to_recordset(${JSON.stringify(
        arrivals.map(
          ({ decisionId, type, matchKey, jurisdiction, decisionDate }) => ({
            decision_id: decisionId,
            identifier_type: type,
            match_key: matchKey,
            jurisdiction,
            decision_date: decisionDate,
          }),
        ),
      )}::text::jsonb) AS a(
        decision_id uuid,
        identifier_type varchar,
        match_key varchar,
        jurisdiction varchar,
        decision_date date
      )
  `);
  return arrivals.length;
};

/**
 * Who drains a decision write's arrivals: the decision itself after its
 * write, or the caller once after a page of them.
 */
export const CITATION_ARRIVAL_DRAIN_OWNER = {
  DECISION: "decision",
  PAGE: "page",
} as const;

export type CitationArrivalDrainOwner =
  (typeof CITATION_ARRIVAL_DRAIN_OWNER)[keyof typeof CITATION_ARRIVAL_DRAIN_OWNER];

type GraphExecutor = { execute: (query: SQL) => Promise<unknown> };

type GraphTransactionRunner<TTx extends GraphExecutor> = <T>(
  run: (tx: TTx) => Promise<T>,
) => Promise<T>;

const arrivalsWaiting = async <TTx extends GraphExecutor>(
  transact: GraphTransactionRunner<TTx>,
): Promise<boolean> =>
  await transact(async (tx) => {
    const result: unknown = await tx.execute(
      sql`SELECT EXISTS (SELECT 1 FROM ${caseLawCitationArrivals}) AS waiting`,
    );
    const row = executedRows(result).at(0);
    return isRecord(row) && row["waiting"] === true;
  });

/**
 * Take a bounded batch of arrivals, oldest first, reopen what they answer and
 * settle it, in one graph transaction that also deletes them
 * (`drainCitationArrivalsIn`). An empty queue is read without the graph lock,
 * so a caller with nothing enqueued does not wait behind the graph.
 */
export const drainCitationArrivals = async <TTx extends GraphExecutor>(
  transact: GraphTransactionRunner<TTx>,
  options: { limit?: number } = {},
): Promise<CitationArrivalDrain> => {
  if (!(await arrivalsWaiting(transact))) {
    return NOTHING_DRAINED;
  }
  return await runCitationGraphTransaction(
    transact,
    async (tx) => await drainCitationArrivalsIn(tx, options),
  );
};

/**
 * Drain after a write that already committed. A failed drain leaves its
 * arrivals queued for the next one, the next write's or the standing walk's,
 * so it is reported, never raised: the write it follows stands either way.
 */
export const drainCitationArrivalsAfterWrite = async <
  TTx extends GraphExecutor,
>(
  transact: GraphTransactionRunner<TTx>,
  {
    step,
    attributes,
  }: {
    /** The caller's stable failure key. */
    step: `${string}.${string}`;
    /** Identifies the work the drain followed, for the report. */
    attributes: Record<string, string>;
  },
): Promise<void> => {
  const drained = await Result.tryPromise({
    try: async () => await drainCitationArrivals(transact),
    catch: (cause) => cause,
  });
  if (Result.isOk(drained)) {
    return;
  }
  logger.error(
    "case_law.citation_arrivals.drain_failed",
    sanitizeErrorAttributesForOutput({
      ...attributes,
      ...errorSystemFields(drained.error),
      ...pgErrorFields(drained.error),
    }),
  );
  captureError(drained.error, handlerErrorContext(step, attributes));
};
