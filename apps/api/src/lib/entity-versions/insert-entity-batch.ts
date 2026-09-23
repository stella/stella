import { inArray, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { entities, fields } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { insertInChunks } from "@/api/lib/db/bulk-write";
import {
  type EntityVersionValues,
  insertEntityVersions,
  type StampOrigin,
} from "@/api/lib/entity-versions/insert-entity-version";
import { sqlCaseFragment } from "@/api/lib/sql-case-expression";

export type CurrentVersionAssignment = {
  entityId: SafeId<"entity">;
  versionId: SafeId<"entityVersion">;
};

type InsertEntityBatchOptions = {
  tx: Transaction;
  /** Parents before children: a chunk may only reference earlier rows. */
  entityRows: readonly (typeof entities.$inferInsert)[];
  versionRows: readonly EntityVersionValues[];
  stampOrigin: StampOrigin;
  currentVersions: readonly CurrentVersionAssignment[];
  fieldRows: readonly (typeof fields.$inferInsert)[];
};

/**
 * Write a set of new entities with their versions and fields in a fixed
 * number of statements per chunk, instead of four per entity.
 *
 * An entity and its current version reference each other: the version row
 * needs the entity, and `current_version_id` needs the version. So entities go
 * in without a current version, then the versions, then one `CASE` update per
 * chunk points each entity at its current version, and the fields follow last.
 */
export const insertEntityBatch = async ({
  tx,
  entityRows,
  versionRows,
  stampOrigin,
  currentVersions,
  fieldRows,
}: InsertEntityBatchOptions): Promise<void> => {
  await insertInChunks(
    entityRows,
    async (batch) => await tx.insert(entities).values(batch),
  );
  await insertInChunks(
    versionRows,
    async (batch) =>
      await insertEntityVersions({ tx, values: batch, stampOrigin }),
  );
  await insertInChunks(
    currentVersions,
    async (batch) =>
      await tx
        .update(entities)
        .set({
          currentVersionId: sqlCaseFragment({
            branches: batch.map(
              ({ entityId, versionId }) =>
                sql`WHEN ${entities.id} = ${entityId} THEN ${versionId}::uuid`,
            ),
            // The WHERE clause restricts the update to the ids the branches
            // name, so the ELSE only ever renders; it never evaluates.
            fallback: sql`${entities.currentVersionId}`,
          }),
        })
        .where(
          inArray(
            entities.id,
            batch.map(({ entityId }) => entityId),
          ),
        ),
  );
  await insertInChunks(
    fieldRows,
    async (batch) => await tx.insert(fields).values(batch),
  );
};
