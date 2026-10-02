import { sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { SafeId } from "@/api/lib/branded-types";

/**
 * Serialize every change to a matter's rate tables and their rate lines.
 *
 * A table's currency, its default flag and the rates under it are checked and
 * written as a set: a currency change validates every rate and then restates
 * it, and the default flag is read before it is cleared or its table removed.
 * Row locks cannot cover a line that does not exist yet, so each writer takes
 * this lock first, before it reads anything it will decide on.
 */
export const lockMatterRates = async (
  tx: Transaction,
  workspaceId: SafeId<"workspace">,
) => {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${workspaceId}))`);
};
