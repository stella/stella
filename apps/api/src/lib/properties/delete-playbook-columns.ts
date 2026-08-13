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

type DeletePlaybookPositionColumnsArgs = {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  playbookSourceId: string;
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

/**
 * Delete the storage pair behind one visible playbook result column.
 *
 * The table presents an ASK value and its verdict as one column, so deleting
 * that column must remove both rows. Resolve the pair by the position's stable
 * source id, then delegate to the dependency-safe ordering above.
 */
export const deletePlaybookPositionColumns = async ({
  tx,
  workspaceId,
  playbookSourceId,
}: DeletePlaybookPositionColumnsArgs): Promise<void> => {
  const rows = await tx
    .select({ id: properties.id, tool: properties.tool })
    .from(properties)
    .where(
      and(
        eq(properties.workspaceId, workspaceId),
        eq(properties.playbookSourceId, playbookSourceId),
      ),
    );

  const verdictIds: SafeId<"property">[] = [];
  const askIds: SafeId<"property">[] = [];
  for (const row of rows) {
    if (row.tool.type === "playbook-verdict") {
      verdictIds.push(row.id);
    } else {
      askIds.push(row.id);
    }
  }

  await deletePlaybookColumns({
    tx,
    workspaceId,
    verdictIds,
    askIds,
  });
};
