import { and, eq } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { caseLawResearchTables } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

type ResearchTableAccess = {
  tx: Pick<Transaction, "select">;
  tableId: SafeId<"caseLawResearchTable">;
  organizationId: SafeId<"organization">;
};

/**
 * The table a request names, within the caller's organization, or null. Every
 * column and answer handler starts here so a table id from another
 * organization is a 404 before any child row is read or written.
 */
export const findResearchTable = async ({
  organizationId,
  tableId,
  tx,
}: ResearchTableAccess) => {
  const [table] = await tx
    .select({ id: caseLawResearchTables.id })
    .from(caseLawResearchTables)
    .where(
      and(
        eq(caseLawResearchTables.id, tableId),
        eq(caseLawResearchTables.organizationId, organizationId),
      ),
    )
    .limit(1);
  return table ?? null;
};

/** Every row edit bumps the table's `updatedAt`, so the list order follows. */
export const touchResearchTable = async ({
  organizationId,
  tableId,
  tx,
}: {
  tx: Pick<Transaction, "update">;
  tableId: SafeId<"caseLawResearchTable">;
  organizationId: SafeId<"organization">;
}): Promise<void> => {
  // audit: skip — bookkeeping on the parent row; every caller records the
  // table-level audit event for the actual change in the same transaction
  await tx
    .update(caseLawResearchTables)
    .set({ updatedAt: new Date() })
    .where(
      and(
        eq(caseLawResearchTables.id, tableId),
        eq(caseLawResearchTables.organizationId, organizationId),
      ),
    );
};
