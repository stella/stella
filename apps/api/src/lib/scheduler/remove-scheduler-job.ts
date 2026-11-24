import { eq } from "drizzle-orm";

import { schedulerJobs } from "@/api/db/schema";
import type { Transaction } from "@/api/db/types";

/** Remove scheduler bookkeeping on the transaction that owns its lifecycle fence. */
export const removeSchedulerJob = async (
  id: string,
  db: Pick<Transaction, "delete">,
): Promise<void> => {
  // audit: skip - Derived scheduler bookkeeping; definition handlers audit their writes.
  // Orphan cleanup has no member actor.
  await db.delete(schedulerJobs).where(eq(schedulerJobs.id, id));
};
