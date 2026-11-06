import { panic } from "better-result";
import { sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { executedRows } from "@/api/lib/db/executed-rows";
import { isRecord } from "@/api/lib/type-guards";

/** An index the online migrator builds after deploy, by name and table. */
export type OnlineIndexName = { name: string; tableName: string };

/**
 * Whether every index in `indexes` exists in `public` and the planner may use
 * it: built (`indisvalid`) and maintained by writes (`indisready`). An index
 * the online migrator has not built yet, or whose concurrent build failed and
 * left it invalid, is not ready.
 *
 * A read whose bound depends on such an index checks it first, so it never
 * runs the plan the index exists to avoid while the build is still pending.
 */
export const readOnlineIndexesReady = async (
  tx: Pick<Transaction, "execute">,
  indexes: readonly OnlineIndexName[],
): Promise<boolean> => {
  if (indexes.length === 0) {
    return panic("An online index readiness read names no index");
  }
  const rows = executedRows(
    await tx.execute(sql`
      SELECT count(*)::int AS "usable"
      FROM pg_catalog.pg_class index_relation
      JOIN pg_catalog.pg_namespace index_namespace
        ON index_namespace.oid = index_relation.relnamespace
      JOIN pg_catalog.pg_index index_state
        ON index_state.indexrelid = index_relation.oid
      JOIN pg_catalog.pg_class table_relation
        ON table_relation.oid = index_state.indrelid
      JOIN (VALUES ${sql.join(
        indexes.map(
          ({ name, tableName }) => sql`(${name}::text, ${tableName}::text)`,
        ),
        sql`, `,
      )}) AS required(index_name, table_name)
        ON required.index_name = index_relation.relname
        AND required.table_name = table_relation.relname
      WHERE index_namespace.nspname = 'public'
        AND index_state.indisvalid
        AND index_state.indisready
    `),
  );
  const usable = rows.at(0);
  if (!isRecord(usable) || typeof usable["usable"] !== "number") {
    return panic("Online index readiness returned an invalid row");
  }
  return usable["usable"] === indexes.length;
};
