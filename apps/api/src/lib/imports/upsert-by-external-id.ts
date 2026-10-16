import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { GetColumnData, SQL } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";

import type { Transaction } from "@/api/db/root";
import type { SafeId } from "@/api/lib/branded-types";
import { externalRefKey } from "@/api/lib/imports/external-ref";
import type { ExternalRef } from "@/api/lib/imports/external-ref";

/**
 * Building blocks for an import that converges when re-run: a row carrying
 * an external ref is written with `INSERT ... ON CONFLICT` against the
 * table's `<table>_org_external_uidx`, so the second run updates the row the
 * first created. The key leads with `organization_id`, so a ref can only
 * ever match a row of the importing organization; callers run these inside
 * their scoped transaction, where RLS bounds the same rows again.
 *
 * Callers write the INSERT against their concrete table, which keeps the
 * values and the refreshed columns fully typed:
 *
 *   const conflict = externalRefConflict(contacts);
 *   tx.insert(contacts)
 *     .values(rows)
 *     .onConflictDoUpdate({
 *       target: conflict.target,
 *       targetWhere: conflict.targetWhere,
 *       set: { displayName: excluded(contacts.displayName), ... },
 *     })
 *     .returning({ id: contacts.id, outcome: upsertOutcome });
 */

type ExternalRefTable = PgTable & {
  id: AnyPgColumn;
  organizationId: AnyPgColumn;
  externalSource: AnyPgColumn;
  externalId: AnyPgColumn;
};

/** The arbiter of an external-ref upsert: the partial unique index. */
export const externalRefConflict = (table: ExternalRefTable) => ({
  target: [table.organizationId, table.externalSource, table.externalId],
  targetWhere: isNotNull(table.externalId),
});

/** The incoming row's value for `column`, for an upsert's `set`. */
export const excluded = (column: AnyPgColumn): SQL =>
  sql`excluded.${sql.identifier(column.name)}`;

const UPSERT_OUTCOMES = ["created", "updated"] as const;
type UpsertOutcome = (typeof UPSERT_OUTCOMES)[number];

/**
 * Whether the upsert inserted or updated the returned row. An inserted
 * tuple has no deleting transaction yet (`xmax = 0`); the conflict update
 * stamps its own.
 */
export const upsertOutcome = sql<UpsertOutcome>`CASE WHEN xmax = 0 THEN 'created' ELSE 'updated' END`;

type ReadExternalRefIdsOptions<TTable extends ExternalRefTable> = {
  tx: Transaction;
  table: TTable;
  organizationId: SafeId<"organization">;
  refs: readonly ExternalRef[];
};

/**
 * Ids of the organization's rows that already carry one of `refs`, keyed by
 * `externalRefKey`. One indexed read for the whole batch, so a caller can
 * tell an update from a create before applying per-row rules (capacity,
 * duplicate checks) that only a create should consume.
 */
export const readExternalRefIds = async <TTable extends ExternalRefTable>({
  tx,
  table,
  organizationId,
  refs,
}: ReadExternalRefIdsOptions<TTable>): Promise<
  Map<string, GetColumnData<TTable["id"]>>
> => {
  const ids = new Map<string, GetColumnData<TTable["id"]>>();
  if (refs.length === 0) {
    return ids;
  }
  // The selected id keeps its concrete column type; FROM only needs the
  // table identity, without Drizzle's unresolved generic selection check.
  const queryTable: PgTable = table;
  const rows = await tx
    // The tuple IN predicate never matches a NULL ref, so both are text.
    .select({
      id: sql<GetColumnData<TTable["id"]>>`${table.id}`,
      source: sql<string>`${table.externalSource}`,
      externalId: sql<string>`${table.externalId}`,
    })
    .from(queryTable)
    .where(
      and(
        eq(table.organizationId, organizationId),
        sql`(${table.externalSource}, ${table.externalId}) IN (${sql.join(
          refs.map(({ source, id }) => sql`(${source}, ${id})`),
          sql`, `,
        )})`,
      ),
    );
  for (const row of rows) {
    ids.set(externalRefKey({ source: row.source, id: row.externalId }), row.id);
  }
  return ids;
};
