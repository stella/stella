import type { Transaction } from "@/api/db/root";
import type { SearchProjectionKind } from "@/api/db/schema";
import { withAggregateLock } from "@/api/lib/db/aggregate-lock";

/** The exact durable dirty mark whose source snapshot a repair may publish. */
export type SearchProjectionRepairFence<
  Kind extends SearchProjectionKind = SearchProjectionKind,
> = {
  kind: Kind;
  revision: string;
  sourceId: string;
};

/**
 * Linearize projection publication with edits that replace a dirty mark.
 *
 * The lock remains held through the caller's projection transaction. An edit
 * that already replaced this revision makes the repair a no-op; an edit that
 * arrives after the lock waits, then leaves a newer revision queued after the
 * old projection commits.
 */
export const lockCurrentSearchProjectionRepair = async (
  tx: Transaction,
  fence: SearchProjectionRepairFence,
): Promise<boolean> => {
  const lock = await withAggregateLock({
    aggregate: "searchProjectionRepair",
    id: fence,
    mode: "update",
    tx,
  });
  return lock.status === "locked";
};
