import { panic } from "better-result";
import { sql } from "drizzle-orm";

import type { TransactionOf } from "@/api/db/scoped";
import { executedRows } from "@/api/lib/db/executed-rows";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";
import type { GatedTestDb } from "@/api/tests/gated-test-database";

import { LEGISLATION_GENERATION } from "./corpus-seed";

const PROJECTION_STATES = "corpus_index_projection_states";

/**
 * Eligibility, the applied revision and the recurrence check each read one
 * projection state of a candidate.
 */
export const PROJECTION_STATE_READS_PER_CANDIDATE = 3;

/**
 * Planner statistics for the projection states table in production's
 * proportions, where the case-law generations hold almost every row. The
 * planner multiplies the family's share by the generation's share, so a
 * legislation generation of a hundred thousand states is estimated at a few
 * rows, and a semi-join driven from the states table looks cheaper than one
 * lookup per candidate. Rolled back with the measuring transaction.
 */
export const applyProductionStateStatistics = async (
  tx: TransactionOf<GatedTestDb>,
) => {
  await tx.execute(sql`SELECT
    pg_restore_attribute_stats(
      'schemaname', 'public'::text, 'relname', ${PROJECTION_STATES}::text,
      'attname', 'family'::text, 'inherited', false,
      'most_common_vals', '{case_law,legislation}'::text,
      'most_common_freqs', '{0.995,0.005}'::real[]),
    pg_restore_attribute_stats(
      'schemaname', 'public'::text, 'relname', ${PROJECTION_STATES}::text,
      'attname', 'generation'::text, 'inherited', false,
      'most_common_vals', ${`{case_law_v1,${LEGISLATION_GENERATION}}`}::text,
      'most_common_freqs', '{0.995,0.005}'::real[])`);
};

const planRows = (explained: unknown): number => {
  const row = executedRows(explained).at(0);
  const plan: unknown = isRecord(row) ? row["QUERY PLAN"] : undefined;
  const root: unknown = isUnknownArray(plan) ? plan.at(0) : undefined;
  const rows =
    isRecord(root) && isRecord(root["Plan"])
      ? root["Plan"]["Plan Rows"]
      : undefined;
  return typeof rows === "number"
    ? rows
    : panic("Could not read the projection state estimate");
};

/** The planner's estimate of the generation's legislation states. */
export const estimatedGenerationStates = async (
  tx: TransactionOf<GatedTestDb>,
) =>
  planRows(
    await tx.execute(sql`EXPLAIN (FORMAT JSON) SELECT 1
      FROM corpus_index_projection_states
      WHERE family = 'legislation' AND generation = ${LEGISLATION_GENERATION}`),
  );

const count = (node: Record<string, unknown>, name: string) => {
  const value = node[name] ?? 0;
  return typeof value === "number"
    ? value
    : panic(`Plan node ${name} is not a number`);
};

/**
 * Projection state rows the plan visited: what each states scan returned or
 * filtered out, over all of its loops.
 */
export const projectionStateRowsVisited = (
  node: Record<string, unknown>,
): number => {
  const own =
    node["Relation Name"] === PROJECTION_STATES
      ? (count(node, "Actual Rows") +
          count(node, "Rows Removed by Filter") +
          count(node, "Rows Removed by Index Recheck")) *
        count(node, "Actual Loops")
      : 0;
  const children = node["Plans"] ?? [];
  if (!isUnknownArray(children) || !children.every(isRecord)) {
    return panic("Plan children are malformed");
  }
  return children.reduce(
    (sum, child) => sum + projectionStateRowsVisited(child),
    own,
  );
};
