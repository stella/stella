import { sql } from "drizzle-orm";

import type { Transaction } from "@/api/db";
import type { SafeId } from "@/api/lib/branded-types";

export const lockWorkspacePropertyWrites = async (
  tx: Transaction,
  workspaceId: SafeId<"workspace">,
): Promise<void> => {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${workspaceId}))`);
};
