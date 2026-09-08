/**
 * The selection and the decision `repair-cz-ns-court.ts` runs, separated from
 * the script that runs them.
 *
 * An operator script is a module with a side effect at the top level, so
 * nothing can import it and nothing in CI ever executes its SQL. Keeping the
 * statements here, where a database test can execute them and a unit test can
 * exercise the decision, is what closes that gap.
 */

import { panic } from "better-result";
import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";

import type { SafeId } from "@/api/lib/branded-types";
import { czCourtFromEcli } from "@/api/lib/case-law/cz-ecli-courts";
import { brandPersistedCaseLawDecisionId } from "@/api/lib/safe-id-boundaries";
import { isRecord } from "@/api/lib/type-guards";

/** One stored decision, as the selection reads it. */
export type CzNsCourtRow = {
  id: SafeId<"caseLawDecision">;
  ecli: string;
  court: string;
};

/**
 * Rows of one adapter whose stored ECLI names a court other than the
 * publisher's own, newest id last.
 *
 * The publisher's own code is excluded in SQL rather than in the decision
 * below, because it is what makes this a bounded selection over a
 * multi-million-row table instead of a walk of every decision the source
 * holds. Everything the exclusion lets through is decided in TypeScript, off
 * the one map every Czech adapter resolves a court through.
 *
 * Keyset paging on the primary key, and not on the repair predicate: a
 * repaired row stops matching, but a row this run decides to leave alone does
 * not, and a self-consuming walk would read those again on every batch.
 */
export const selectCzNsForeignCourtRowsStatement = ({
  adapterKey,
  after,
  limit,
  publisherEcliCode,
}: {
  adapterKey: string;
  after: SafeId<"caseLawDecision"> | null;
  limit: number;
  publisherEcliCode: string;
}): SQL => sql`
  SELECT d.id, d.ecli, d.court
    FROM case_law_decisions d
    JOIN case_law_sources s ON s.id = d.source_id
   WHERE s.adapter_key = ${adapterKey}
     AND d.ecli IS NOT NULL
     AND d.ecli LIKE 'ECLI:CZ:%'
     AND d.ecli NOT LIKE ${`ECLI:CZ:${publisherEcliCode}:%`}
     ${after === null ? sql`` : sql`AND d.id > ${after}::uuid`}
   ORDER BY d.id
   LIMIT ${limit}
`;

export const CZ_NS_COURT_REPAIR_OUTCOMES = {
  /** The stored court is not what the decision's ECLI names. */
  REATTRIBUTED: "reattributed",
  /** The stored court already matches the ECLI. */
  HELD: "held",
  /** The ECLI names a court code the map does not know. */
  UNKNOWN_CODE: "unknown-code",
} as const;

export type CzNsCourtRepairOutcome =
  (typeof CZ_NS_COURT_REPAIR_OUTCOMES)[keyof typeof CZ_NS_COURT_REPAIR_OUTCOMES];

export type CzNsCourtRepair =
  | {
      outcome: typeof CZ_NS_COURT_REPAIR_OUTCOMES.REATTRIBUTED;
      id: SafeId<"caseLawDecision">;
      from: string;
      court: string;
    }
  | {
      outcome: typeof CZ_NS_COURT_REPAIR_OUTCOMES.HELD;
      id: SafeId<"caseLawDecision">;
    }
  | {
      outcome: typeof CZ_NS_COURT_REPAIR_OUTCOMES.UNKNOWN_CODE;
      id: SafeId<"caseLawDecision">;
      /** The court code the ECLI names, which this map cannot resolve. */
      code: string;
    };

/**
 * What one selected row's ECLI says its court should be.
 *
 * A code the map does not know is reported, never guessed at: this run cannot
 * name that court, and writing anything for it would put a value into the
 * corpus that no source states. The publisher's own crawl reports the same
 * code through `czDecisionCourt`, so the two paths raise one signal.
 */
export const decideCzNsCourtRepair = ({
  court,
  ecli,
  id,
}: CzNsCourtRow): CzNsCourtRepair => {
  const fromEcli = czCourtFromEcli(ecli);
  switch (fromEcli.type) {
    case "named":
      return fromEcli.court === court
        ? { outcome: CZ_NS_COURT_REPAIR_OUTCOMES.HELD, id }
        : {
            outcome: CZ_NS_COURT_REPAIR_OUTCOMES.REATTRIBUTED,
            id,
            from: court,
            court: fromEcli.court,
          };
    case "unknown-code":
      return {
        outcome: CZ_NS_COURT_REPAIR_OUTCOMES.UNKNOWN_CODE,
        id,
        code: fromEcli.code,
      };
    // The selection admits only rows whose ECLI is a Czech one, so this is a
    // row that changed under the walk rather than a shape to decide on.
    case "unstated":
      return { outcome: CZ_NS_COURT_REPAIR_OUTCOMES.HELD, id };
    default: {
      fromEcli satisfies never;
      return panic(`Unhandled Czech ECLI court: ${JSON.stringify(fromEcli)}`);
    }
  }
};

/**
 * Write one row's court, and the copy of it the row's metadata carries.
 *
 * Guarded on the court the selection read: the crawl keeps running, and a
 * decision it re-ingested in between already carries what the fixed adapter
 * derived. Overwriting that with this run's value would be a stale write, so
 * the statement returns nothing for such a row and the run counts it as
 * superseded rather than repaired.
 */
export const applyCzNsCourtRepairStatement = ({
  court,
  from,
  id,
}: {
  court: string;
  from: string;
  id: SafeId<"caseLawDecision">;
}): SQL => sql`
  UPDATE case_law_decisions AS d
     SET court = ${court},
         metadata = jsonb_set(
           COALESCE(d.metadata, '{}'::jsonb), '{court}', to_jsonb(${court}::text)
         )
   WHERE d.id = ${id}::uuid
     AND d.court = ${from}
  RETURNING d.id
`;

/** Rows from `execute` under either driver shape (bare array or `{ rows }`). */
export const executedRows = (result: unknown): unknown[] => {
  if (Array.isArray(result)) {
    return result;
  }
  if (isRecord(result) && Array.isArray(result["rows"])) {
    return result["rows"];
  }
  return [];
};

/** One selected row, from a driver result that is untyped by construction. */
export const parseCzNsCourtRow = (value: unknown): CzNsCourtRow => {
  if (
    !isRecord(value) ||
    typeof value["id"] !== "string" ||
    typeof value["ecli"] !== "string" ||
    typeof value["court"] !== "string"
  ) {
    return panic(`Unreadable cz-ns court row: ${JSON.stringify(value)}`);
  }
  return {
    id: brandPersistedCaseLawDecisionId(value["id"]),
    ecli: value["ecli"],
    court: value["court"],
  };
};
