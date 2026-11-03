import { Result } from "better-result";
import { inArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import type { SafeId } from "@/api/lib/branded-types";
import { WORKSPACE_DELETION_RETAINED_STAGES } from "@/api/lib/organization-storage-teardown";
import { inOrder } from "@/api/lib/review-organization/in-order";

type MatterBillingScope =
  | { workspaceIds: readonly SafeId<"workspace">[] }
  | { organizationIds: readonly SafeId<"organization">[] };

/**
 * A matter row cannot be deleted while billing records name it
 * (`WORKSPACE_DELETION_RETAINED_TABLES`). Test cleanup that deletes matters
 * directly removes those records first, one statement per stage of
 * `WORKSPACE_DELETION_RETAINED_STAGES`, so no line still bills a record when
 * that record goes.
 */
export const deleteMatterBillingRecords = async (
  db: { execute: (query: SQL) => PromiseLike<unknown> },
  scope: MatterBillingScope,
): Promise<void> => {
  const deleted = await inOrder(
    WORKSPACE_DELETION_RETAINED_STAGES,
    async (stage) => {
      const removals = stage.map(
        (table, index) =>
          sql`${sql.identifier(`removed_${index}`)} AS (DELETE FROM ${table} WHERE ${
            "workspaceIds" in scope
              ? inArray(table.workspaceId, [...scope.workspaceIds])
              : inArray(table.organizationId, [...scope.organizationIds])
          })`,
      );
      await db.execute(sql`WITH ${sql.join(removals, sql`, `)} SELECT 1`);
      return Result.ok(undefined);
    },
  );
  deleted.unwrap("Billing cleanup reports no errors");
};
