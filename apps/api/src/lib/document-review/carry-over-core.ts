/**
 * What every review feature that re-runs over a document shares when it
 * carries a reviewer's work to the new run: which earlier run it carries
 * from, and the words it uses for what became of each reviewed item.
 *
 * List verification (`lists/verification/carry-over.ts`) and document review
 * (`document-review/decision-carry-over.ts`) each keep their own matcher and
 * writer, since a claim and a finding are compared differently; both find
 * the earlier run here and report through `CARRY_OUTCOMES`
 * (`carry-outcomes.ts`, free of database code so the schema can name it).
 * A second "previous completed run" query elsewhere is refused by the guard
 * in `carry-over-core.guard.test.ts`. It lives with document review, the
 * older of the two features, so `lib` gains no new top-level directory.
 */

import { and, desc, eq, ne } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type {
  AnyPgColumn,
  PgAsyncDatabase,
  PgQueryResultHKT,
  PgTable,
} from "drizzle-orm/pg-core";

import type { SafeId, SafeIdType } from "@/api/lib/branded-types";

/** The columns of a feature's run table the lookup reads. Every review run
 *  table names a document by its entity and file field. */
export type DocumentRunColumns<RunKind extends SafeIdType> = {
  table: PgTable;
  id: AnyPgColumn<{ data: SafeId<RunKind>; notNull: true }>;
  workspaceId: AnyPgColumn;
  entityId: AnyPgColumn;
  fileFieldId: AnyPgColumn;
  status: AnyPgColumn;
  createdAt: AnyPgColumn;
};

type PreviousCompletedRunArgs<RunKind extends SafeIdType> = {
  tx: Pick<PgAsyncDatabase<PgQueryResultHKT>, "select">;
  columns: DocumentRunColumns<RunKind>;
  run: {
    id: SafeId<RunKind>;
    workspaceId: SafeId<"workspace">;
    entityId: SafeId<"entity">;
    fileFieldId: SafeId<"field">;
  };
  /** What else the earlier run must share with this one (list
   *  verification: the same list). */
  sameAs?: SQL;
};

/**
 * The newest completed run of the same document (same entity, same file
 * field) other than `run`: the run a re-run carries its reviewer's work
 * from. A query, not a result, so a caller may await it or use it as a
 * subquery; it names at most one run.
 */
export const previousCompletedRunQuery = <RunKind extends SafeIdType>({
  tx,
  columns,
  run,
  sameAs,
}: PreviousCompletedRunArgs<RunKind>) =>
  tx
    .select({ id: columns.id })
    .from(columns.table)
    .where(
      and(
        eq(columns.workspaceId, run.workspaceId),
        eq(columns.entityId, run.entityId),
        eq(columns.fileFieldId, run.fileFieldId),
        eq(columns.status, "completed"),
        ne(columns.id, run.id),
        sameAs,
      ),
    )
    .orderBy(desc(columns.createdAt), desc(columns.id))
    .limit(1);
