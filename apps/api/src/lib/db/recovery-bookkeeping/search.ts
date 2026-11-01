import { sql } from "drizzle-orm";

import { withOrgScope } from "@/api/db/org-scope";
import type { OrgScope } from "@/api/db/org-scope";
import type { ScopedTransaction } from "@/api/db/safe-db";
import type { SafeId } from "@/api/lib/branded-types";
import { createWorkspaceSearchActivityActor } from "@/api/lib/db/workspace-search-activity-actor";

type SearchBookkeepingOperation = {
  type: "sync-workspace-activity";
  db: ScopedTransaction;
  scope: OrgScope;
  workspaceId: SafeId<"workspace">;
};

export const writeSearchBookkeeping = async (
  operation: SearchBookkeepingOperation,
): Promise<void> => {
  // audit: skip — derived search timestamp refresh from already-audited source activity. Pure recovery bookkeeping; no user/customer data or auth/permission change.
  const actor = createWorkspaceSearchActivityActor();
  await withOrgScope({
    tx: operation.db,
    scope: operation.scope,
    actor,
    fn: async (tx) => {
      await tx.execute(sql`
    UPDATE workspace_search_documents wsd
    SET updated_at = w.last_activity_at
    FROM workspaces w
    WHERE w.id = ${operation.workspaceId}
      AND wsd.workspace_id = w.id
      AND wsd.updated_at < w.last_activity_at
  `);
    },
  });
};
