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
 * caller with a single decision drains after it.
 *
 * The reopen reads the citations by their stored match key
 * (`citation-identifier-match-key.ts`) through an equality index. A citation
 * stored before that key existed is matched by its folded columns instead,
 * and only while such rows remain.
 */
import { panic, Result } from "better-result";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { isCaseLawJurisdiction } from "@stll/api-contract/case-law-jurisdictions";
import type { CaseLawJurisdiction } from "@stll/api-contract/case-law-jurisdictions";
import { sanitizeErrorAttributesForOutput } from "@stll/errors";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";
import type { DecisionIdentifierType } from "@stll/legal-ast/decision-identifier";

import { caseLawCitationArrivals, caseLawCitations } from "@/api/db/schema";
import { runCitationGraphTransaction } from "@/api/handlers/case-law/citation-graph-transaction";
import type { CitationGraphTransaction } from "@/api/handlers/case-law/citation-graph-transaction";
import { citationIdentifierMatchKeyPendingSql } from "@/api/handlers/case-law/citation-identifier-match-key";
import { citationResolutionPolicyRows } from "@/api/handlers/case-law/citation-jurisdiction-policy";
import {
  CITATION_ARRIVAL_SETTLE_CAP,
  NOTHING_REOPENED,
  reopenedOf,
  reopenForArrivalsSql,
  settleReopenedCitations,
} from "@/api/handlers/case-law/citation-resolution";
import type {
  ArrivingRow,
  CitationResolutionCounts,
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
import { brandPersistedCaseLawDecisionId } from "@/api/lib/safe-id-boundaries";
import { isRecord } from "@/api/lib/type-guards";

/** One identifier a stored decision holds, as the citation graph reads it. */
export type CitationArrival = {
  decisionId: SafeId<"caseLawDecision">;
  type: DecisionIdentifierType;
  /** The identifier's normalized value under `caseNumberMatchKey`. */
  matchKey: string;
  /** The decision's country, which decides whose citations it can answer. */
  jurisdiction: CaseLawJurisdiction;
  /** The decision's date; a citation older than it was never about it. */
  decisionDate: string | null;
};

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
 * Arrivals reopening as one statement, with the settle bound that keeps a
 * drain's cost independent of how often its decisions are cited: the bound
 * one decision write had, per decision, up to a ceiling for the drain.
 */
export const CITATION_ARRIVAL_DRAIN_SETTLE_CEILING = 5000;

const settleCapFor = (arrivals: readonly CitationArrival[]): number =>
  Math.min(
    CITATION_ARRIVAL_SETTLE_CAP *
      new Set(arrivals.map(({ decisionId }) => decisionId)).size,
    CITATION_ARRIVAL_DRAIN_SETTLE_CEILING,
  );

/** The citing countries whose citations a decision of `jurisdiction` can answer. */
const citingCountriesReaching = (jurisdiction: CaseLawJurisdiction): string[] =>
  citationResolutionPolicyRows().flatMap(
    ({ jurisdiction: citing, resolvesTo }) =>
      resolvesTo.includes(jurisdiction) ? [citing] : [],
  );

/**
 * Whether any citation still waits for its stored key. One probe of the
 * repair's partial index, which is empty once the repair has run.
 */
export const UNKEYED_CITATIONS_REMAIN_SQL = sql`
  SELECT EXISTS (
    SELECT 1
      FROM ${caseLawCitations}
     WHERE ${citationIdentifierMatchKeyPendingSql({
       identifierMatchKey: caseLawCitations.identifierMatchKey,
       normalizedIdentifierValue: caseLawCitations.normalizedIdentifierValue,
       citationKey: caseLawCitations.citationKey,
     })}
  ) AS remain`;

const unkeyedCitationsRemain = async (
  tx: CitationGraphTransaction,
): Promise<boolean> => {
  const row = executedRows(await tx.execute(UNKEYED_CITATIONS_REMAIN_SQL)).at(
    0,
  );
  return isRecord(row) && row["remain"] === true;
};

/** The arrivals as the statement reads them; an arrival nobody cites across is dropped. */
export const arrivingRowsOf = (
  arrivals: readonly CitationArrival[],
): ArrivingRow[] =>
  arrivals.flatMap((arrival) => {
    const citingCountries = citingCountriesReaching(arrival.jurisdiction);
    return citingCountries.length === 0
      ? []
      : [
          {
            decision_id: arrival.decisionId,
            type: arrival.type,
            match_key: arrival.matchKey,
            decision_date: arrival.decisionDate,
            citing_countries: citingCountries,
          },
        ];
  });

/**
 * Reopen every citation the arrivals can answer differently, in one
 * statement (`reopenForArrivalsSql`).
 *
 * Exactly the rows the per-decision reopen selected for each arrival, which
 * `citation-arrivals.db.test.ts` holds it to, read through indexes: the
 * stored key on the citation side, the identifiers' match-key index on the
 * holder side, and the cited-decision index from a holder to its citations.
 */
export const reopenCitationsForArrivals = async (
  tx: CitationGraphTransaction,
  arrivals: readonly CitationArrival[],
  cap: number = settleCapFor(arrivals),
): Promise<ReopenedCitations> => {
  const arriving = arrivingRowsOf(arrivals);
  if (arriving.length === 0) {
    return NOTHING_REOPENED;
  }
  // Rows stored before the key existed are matched by their folded columns
  // until the repair has keyed them; the arm is left out once none remain.
  const matchUnkeyed = await unkeyedCitationsRemain(tx);
  // audit: skip — reopens derived public case-law citation resolutions
  const result: unknown = await tx.execute(
    reopenForArrivalsSql({ arriving, matchUnkeyed, cap }),
  );
  return reopenedOf(result);
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

const IDENTIFIER_TYPES: ReadonlySet<string> = new Set(
  Object.values(DECISION_IDENTIFIER_TYPES),
);

const isDecisionIdentifierType = (
  value: unknown,
): value is DecisionIdentifierType =>
  typeof value === "string" && IDENTIFIER_TYPES.has(value);

const decodeArrival = (row: unknown): CitationArrival => {
  if (!isRecord(row)) {
    return panic("Invalid citation arrival row");
  }
  const decisionId = row["decision_id"];
  const type = row["identifier_type"];
  const matchKey = row["match_key"];
  const jurisdiction = row["jurisdiction"];
  const decisionDate = row["decision_date"];
  return typeof decisionId === "string" &&
    isDecisionIdentifierType(type) &&
    typeof matchKey === "string" &&
    typeof jurisdiction === "string" &&
    isCaseLawJurisdiction(jurisdiction) &&
    (typeof decisionDate === "string" || decisionDate === null)
    ? {
        decisionId: brandPersistedCaseLawDecisionId(decisionId),
        type,
        matchKey,
        jurisdiction,
        decisionDate,
      }
    : panic("Invalid citation arrival row");
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

/** Arrivals one drain takes; the next drain continues where it stopped. */
export const CITATION_ARRIVAL_DRAIN_LIMIT = 2000;

export type CitationArrivalDrain = {
  /** Arrivals taken from the queue. */
  drained: number;
  reopened: number;
  settled: CitationResolutionCounts | null;
};

const NOTHING_DRAINED: CitationArrivalDrain = {
  drained: 0,
  reopened: 0,
  settled: null,
};

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
 * Take up to `limit` arrivals, oldest first, reopen what they answer and
 * settle it, in one graph transaction that also deletes them. An empty queue
 * is read without the graph lock, so a caller with nothing enqueued does not
 * wait behind the graph.
 */
export const drainCitationArrivals = async <TTx extends GraphExecutor>(
  transact: GraphTransactionRunner<TTx>,
  { limit = CITATION_ARRIVAL_DRAIN_LIMIT }: { limit?: number } = {},
): Promise<CitationArrivalDrain> => {
  if (!(await arrivalsWaiting(transact))) {
    return NOTHING_DRAINED;
  }
  // Drains are serialized by the graph lock, so no two take the same rows.
  return await runCitationGraphTransaction(transact, async (tx) => {
    // audit: skip — derived public case-law citation queue, not a user action
    const taken: unknown = await tx.execute(sql`
      WITH picked AS (
        SELECT id
          FROM ${caseLawCitationArrivals}
         ORDER BY id
         LIMIT ${limit}
      )
      DELETE FROM ${caseLawCitationArrivals} arrival
       USING picked
       WHERE arrival.id = picked.id
      RETURNING arrival.decision_id::text AS decision_id,
                arrival.identifier_type,
                arrival.match_key,
                arrival.jurisdiction,
                arrival.decision_date::text AS decision_date
    `);
    const arrivals = executedRows(taken).map(decodeArrival);
    if (arrivals.length === 0) {
      return NOTHING_DRAINED;
    }
    const cap = settleCapFor(arrivals);
    const reopened = await reopenCitationsForArrivals(tx, arrivals, cap);
    return {
      drained: arrivals.length,
      reopened: reopened.reopened,
      settled: await settleReopenedCitations(tx, [reopened], cap),
    };
  });
};

/**
 * Drain after a write that already committed. A failed drain leaves its
 * arrivals queued for the next one, so it is reported, never raised: the
 * write it follows stands either way.
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
