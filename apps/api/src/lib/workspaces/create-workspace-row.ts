import { sql } from "drizzle-orm";

import type { MatterVisibility } from "@stll/api-contract";

import { SETTING_WORKSPACE_IDS } from "@/api/db/rls";
import type { Transaction } from "@/api/db/root";
import type { SafeId } from "@/api/lib/branded-types";

type NewWorkspaceRow = {
  id: SafeId<"workspace">;
  clientId: string | null;
  name: string;
  reference: string;
  visibility: MatterVisibility;
  billingReference?: string | null;
  color?: string | null;
  leadUserId?: string | null;
};

/**
 * Create a matter in the scoped transaction through the database
 * (`stella_create_workspace`). The database takes the organization and the
 * creating member from the transaction settings, checks that the client and
 * the lead belong to that organization, and assigns the creator when the
 * access rule would not reach the new matter otherwise. A transaction scoped
 * to an explicit list of matters sees only that list, so the new matter joins
 * the list too.
 */
export const createWorkspaceInTransaction = async (
  tx: Pick<Transaction, "execute">,
  {
    id,
    clientId,
    name,
    reference,
    visibility,
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
      ${leadUserId},
      ${visibility}
    )`,
  );
  // The setting is a Postgres array literal: {id1,id2}.
  await tx.execute(
    sql`SELECT set_config(
      ${SETTING_WORKSPACE_IDS},
      array_append(
        current_setting(${SETTING_WORKSPACE_IDS}, true)::text[],
        ${id}
      )::text,
      true
    )`,
  );
};
