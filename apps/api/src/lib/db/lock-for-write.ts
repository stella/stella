import type { Transaction } from "@/api/db/root";
import type { SafeId } from "@/api/lib/branded-types";
import { withAggregateParentBatch } from "@/api/lib/db/aggregate-lock";

/**
 * Write locks follow organization -> workspace -> entity -> child rows.
 * Acquire the foreign-key parents before locking a source or replacing a
 * projection; lifecycle deletion owns those parents before cascading.
 */
type LockForWriteOptions = {
  organizationIds: readonly SafeId<"organization">[];
  workspaceIds?: readonly SafeId<"workspace">[];
};

/** Only returned parents remain live; omit sources whose parents disappeared. */
export const lockForWrite = async (
  tx: Pick<Transaction, "execute">,
  { organizationIds, workspaceIds = [] }: LockForWriteOptions,
) =>
  await withAggregateParentBatch({
    tx,
    organizationIds,
    workspaceIds,
    mode: "key share",
  });
