import { count, eq, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { contacts } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";

export const lockContactCapacity = async (
  tx: Transaction,
  organizationId: SafeId<"organization">,
): Promise<void> => {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('contact_capacity'), hashtext(${organizationId}))`,
  );
};

export const hasContactCapacity = async ({
  tx,
  organizationId,
  incomingCount,
  capacityLocked = false,
}: {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  incomingCount: number;
  capacityLocked?: boolean;
}): Promise<boolean> => {
  if (!capacityLocked) {
    await lockContactCapacity(tx, organizationId);
  }

  const [row] = await tx
    .select({ total: count() })
    .from(contacts)
    .where(eq(contacts.organizationId, organizationId));

  return (row?.total ?? 0) + incomingCount <= LIMITS.contactsCount;
};
