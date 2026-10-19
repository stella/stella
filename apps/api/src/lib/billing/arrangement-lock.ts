import { eq, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { billingArrangements } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

export const lockBillingArrangement = async (
  tx: Transaction,
  workspaceId: SafeId<"workspace">,
) => {
  // Same matter lock as timer/invoice guards; it also serializes first-row creation.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${workspaceId}))`);
  const rows = await tx
    .select()
    .from(billingArrangements)
    .where(eq(billingArrangements.workspaceId, workspaceId))
    .limit(1)
    .for("update");
  return rows.at(0);
};
