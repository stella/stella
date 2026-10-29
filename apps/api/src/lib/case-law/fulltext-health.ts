import { panic } from "better-result";
import { asc, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import { eligibleDecisionTextSql } from "@/api/lib/case-law/fulltext-eligibility-sql";
import { executedRows } from "@/api/lib/db/executed-rows";
import {
  ADAPTER_KEYS,
  IMPORT_SOURCE_KEYS,
} from "@/api/lib/legal-search/ingestion-constants";
import { isRecord } from "@/api/lib/type-guards";

import { fulltextPolicyForSource } from "./fulltext-source-policy";

const SOURCE_COUNT_LIMIT =
  Object.values(ADAPTER_KEYS).length + Object.values(IMPORT_SOURCE_KEYS).length;

export type DecisionTextSourceHealth = {
  source: string;
  missingState: boolean;
  failedThreshold: number;
  failed: { type: "exact" | "at-least"; count: number };
};

/** Two index probes per source in one statement, with no corpus-sized aggregation. */
export const caseLawFulltextHealthQuery = (
  sources: readonly { id: string; source: string; failedThreshold: number }[],
) => {
  if (sources.length === 0 || sources.length > SOURCE_COUNT_LIMIT) {
    return panic(
      "Full-text health query requires a bounded nonempty source catalog",
    );
  }
  const values = sources.map(
    ({ id, source, failedThreshold }) =>
      sql`(${id}::uuid, ${source}::text, ${failedThreshold}::int)`,
  );
  const decisions = caseLawDecisions;
  return sql`
    SELECT catalog.source, catalog.failed_threshold,
      EXISTS (
        SELECT ${decisions.id} FROM ${decisions}
        WHERE ${decisions.sourceId} = catalog.id
          AND ${eligibleDecisionTextSql(decisions)}
          AND ${decisions.textState} IS NULL
        ORDER BY ${decisions.id}
        LIMIT 1
      ) AS missing_state,
      failed.count AS failed_count
    FROM (VALUES ${sql.join(values, sql`, `)}) AS catalog(id, source, failed_threshold)
    CROSS JOIN LATERAL (
      SELECT count(*)::int AS count FROM (
        SELECT ${decisions.id} FROM ${decisions}
        WHERE ${decisions.sourceId} = catalog.id
          AND ${eligibleDecisionTextSql(decisions)}
          AND ${decisions.textState} ->> 'status' = 'fetch_failed'
        ORDER BY ${decisions.id}
        LIMIT catalog.failed_threshold + 1
      ) AS bounded_failures
    ) AS failed
  `;
};

/** The catalog is fixed by registrations, including disabled and imported held corpora. */
export const readCaseLawFulltextHealthTx = async (
  tx: Transaction,
): Promise<DecisionTextSourceHealth[]> => {
  const catalog = await tx
    .select({ id: caseLawSources.id, source: caseLawSources.adapterKey })
    .from(caseLawSources)
    .orderBy(asc(caseLawSources.id))
    .limit(SOURCE_COUNT_LIMIT + 1);
  // Validate every returned key first: unknown sources must not silently disappear.
  const sources = catalog.map(({ id, source }) => ({
    id,
    source,
    failedThreshold: fulltextPolicyForSource(source).failedThreshold,
  }));
  if (sources.length > SOURCE_COUNT_LIMIT) {
    return panic("Case-law source catalog exceeds its registered bound");
  }
  if (sources.length === 0) {
    return [];
  }
  const rows = executedRows(
    await tx.execute(caseLawFulltextHealthQuery(sources)),
  );
  if (rows.length !== sources.length) {
    return panic("Full-text health query lost a source");
  }
  return rows.map((row) => {
    if (
      !isRecord(row) ||
      typeof row["source"] !== "string" ||
      typeof row["missing_state"] !== "boolean" ||
      typeof row["failed_count"] !== "number" ||
      typeof row["failed_threshold"] !== "number"
    ) {
      return panic("Malformed full-text health query result");
    }
    const count = row["failed_count"];
    const threshold = fulltextPolicyForSource(row["source"]).failedThreshold;
    if (
      row["failed_threshold"] !== threshold ||
      !Number.isInteger(count) ||
      count < 0 ||
      count > threshold + 1
    ) {
      return panic("Full-text health query exceeded its source bound");
    }
    return {
      source: row["source"],
      missingState: row["missing_state"],
      failedThreshold: threshold,
      failed: { type: count > threshold ? "at-least" : "exact", count },
    };
  });
};

export const decisionTextHealthBreached = (
  health: readonly DecisionTextSourceHealth[],
): boolean =>
  health.some(
    ({ missingState, failed, failedThreshold }) =>
      missingState || failed.count > failedThreshold,
  );
