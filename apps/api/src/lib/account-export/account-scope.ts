import { sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { SafeId } from "@/api/lib/branded-types";

/**
 * Switches an account export transaction to the application role, scoped to
 * the account's own rows. Every account-owned statement of the export runs
 * after it.
 */
export const scopeTransactionToAccount = async (
  tx: Pick<Transaction, "execute">,
  userId: SafeId<"user">,
): Promise<void> => {
  await tx.execute(sql`SET LOCAL ROLE stella`);
  await tx.execute(sql`SELECT set_config('app.user_id', ${userId}, true)`);
};
