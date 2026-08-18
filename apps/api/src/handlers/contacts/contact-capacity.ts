import { sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { SafeId } from "@/api/lib/branded-types";

/**
 * Serialize every contact writer for one organization before checking the
 * organization-wide contact limit. The transaction-scoped lock is released
 * automatically on commit or rollback.
 */
export const lockContactCapacity = async (
  tx: Transaction,
  organizationId: SafeId<"organization">,
): Promise<void> => {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('contact_capacity'), hashtext(${organizationId}))`,
  );
};
