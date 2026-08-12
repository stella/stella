/**
 * Taking a playbook's materialized columns down.
 *
 * A verdict column reads its ASK column through a dependency edge whose
 * reference is ON DELETE RESTRICT, and RESTRICT is checked per row at the
 * moment of the delete: it does not wait for a cascade that would remove the
 * referencing edge later in the same statement. So the two kinds cannot come
 * down together, and the ASK cannot come down first. Verdicts go in their own
 * statement, which cascades their edges away, and only then are the ASK columns
 * free.
 *
 * That ordering is the whole content of this module, and the reason it is a
 * module: every caller that removes a materialized pair has to get it right,
 * and a caller that gets it wrong fails only at runtime, against real data.
 */

import { and, eq, inArray } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { properties } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

export type DeletePlaybookColumnsArgs = {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  /** Verdict columns to drop. Deleted first; their dependency edges cascade. */
  verdictIds: readonly SafeId<"property">[];
  /** ASK columns to drop, once nothing reads them any more. */
  askIds: readonly SafeId<"property">[];
};

export const deletePlaybookColumns = async ({
  tx,
  workspaceId,
  verdictIds,
  askIds,
}: DeletePlaybookColumnsArgs): Promise<void> => {
  // audit: skip — callers audit the operation that decided the teardown; this
  // helper only owns the order the two statements run in.
  if (verdictIds.length > 0) {
    await tx
      .delete(properties)
      .where(
        and(
          eq(properties.workspaceId, workspaceId),
          inArray(properties.id, [...verdictIds]),
        ),
      );
  }
  if (askIds.length > 0) {
    await tx
      .delete(properties)
      .where(
        and(
          eq(properties.workspaceId, workspaceId),
          inArray(properties.id, [...askIds]),
        ),
      );
  }
};
