// The one insert every graph edge writer runs: its column list, and the
// execution in the caller's transaction. The writers are split by the
// feature that owns the rows they read (`edge-writer.ts` for verification
// claims, `fact-source-edges.ts` for list Spots); the edge table is theirs
// in common.
//
// The table is named rather than imported: its schema module references the
// verification claims it links, and a list handler that writes a Spot's
// edge must not depend on the verification feature's tables. A test holds
// the name to the schema's.

import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { executedRows } from "@/api/lib/db/executed-rows";

export const GRAPH_EDGES_TABLE = "legal_graph_edges";

export const INSERT_EDGE = sql`INSERT INTO ${sql.identifier(GRAPH_EDGES_TABLE)} (
    workspace_id, kind, from_kind, from_claim_id, from_claim_run_id,
    from_entity_id, to_kind, to_entity_id, stance, source_id,
    provenance_reason, producer_kind, producer_id
  )`;

export type EdgeWriteTransaction = Pick<
  PgAsyncDatabase<PgQueryResultHKT>,
  "execute"
>;

/**
 * Run one derived edge insert in the caller's transaction, so the edges
 * commit with the act that asserts them. The act carries the audit
 * record; a derived edge adds none. Returns how many were new: zero on
 * a replay.
 */
export const executeEdgeInsert = async (
  tx: EdgeWriteTransaction,
  statement: SQL,
): Promise<number> => executedRows(await tx.execute(statement)).length;
