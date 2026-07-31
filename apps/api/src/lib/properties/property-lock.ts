import { sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { SafeId } from "@/api/lib/branded-types";

// This advisory-lock domain (bare `hashtext(workspaceId)`, shared
// with the time-entries locks) is deliberately NOT unified with
// `lockWorkspacesForEntityCap`'s workspace-row `FOR UPDATE` lock
// (issue #1139). Property writes never insert rows counted against
// `LIMITS.entitiesCount`, and no entity-creating path takes this
// advisory lock, so the two domains never contend for the same
// resource in one transaction — there is no shared state to order
// against, and therefore no deadlock to reconcile.
export const lockWorkspacePropertyWrites = async (
  tx: Transaction,
  workspaceId: SafeId<"workspace">,
): Promise<void> => {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${workspaceId}))`);
};
