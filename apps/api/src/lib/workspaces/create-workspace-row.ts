import { sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { SafeId } from "@/api/lib/branded-types";

type NewWorkspaceRow = {
  id: SafeId<"workspace">;
  clientId: string | null;
  name: string;
  reference: string;
  billingReference?: string | null;
  color?: string | null;
  leadUserId?: string | null;
};

/**
 * Create a matter in the scoped transaction through the database
 * (`stella_create_workspace`). The database takes the organization and the
 * creating member from the transaction settings, checks that the client and
 * the lead belong to that organization, and assigns the creator when the
 * access rule would not reach the new matter otherwise. The matter is then
 * reachable for the rest of the transaction without naming it in the
 * transaction's explicit workspace ids.
 */
export const createWorkspaceInTransaction = async (
  tx: Pick<Transaction, "execute">,
  {
    id,
    clientId,
    name,
    reference,
    billingReference = null,
    color = null,
    leadUserId = null,
  }: NewWorkspaceRow,
): Promise<void> => {
  await tx.execute(
    sql`SELECT public.stella_create_workspace(
      ${id}::uuid,
      ${clientId}::uuid,
      ${name},
      ${reference},
      ${billingReference},
      ${color},
      ${leadUserId}
    )`,
  );
};
