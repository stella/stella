import type { RootDatabase, Transaction } from "@/api/db/root";
import { contacts } from "@/api/db/schema";
import { withOwnerOrganizationScope } from "@/api/lib/db/owner-organization-scope";
import { brandPersistedOrganizationId } from "@/api/lib/safe-id-boundaries";

type ContactInsert = typeof contacts.$inferInsert;

/**
 * Fixture contacts written the way owner-connection code writes them: one
 * organization-scoped owner transaction per organization the rows belong to.
 */
export const insertOwnerContacts = async (
  database: RootDatabase | Transaction,
  rows: readonly ContactInsert[],
): Promise<void> => {
  // The owner policy admits one organization per transaction.
  for (const [organizationId, organizationRows] of Map.groupBy(
    rows,
    (row) => row.organizationId,
  )) {
    await withOwnerOrganizationScope(
      database,
      brandPersistedOrganizationId(organizationId),
      async (tx) => {
        await tx.insert(contacts).values(organizationRows);
      },
    );
  }
};
