import { eq } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { schedulerJobs } from "@/api/db/schema";

/** Remove scheduler bookkeeping on the transaction that owns its lifecycle fence. */
export const removeSchedulerJob = async (
  id: string,
  db: Pick<Transaction, "delete">,
): Promise<void> => {
  // audit: skip - Derived scheduler bookkeeping; definition handlers audit their writes.
  // Orphan cleanup has no member actor.
  await db.delete(schedulerJobs).where(eq(schedulerJobs.id, id));
};
