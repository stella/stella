import { sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { SafeId } from "@/api/lib/branded-types";

export const hasCurrentTimerMatterAccess = async ({
  organizationId,
  tx,
  userId,
  workspaceId,
}: {
  organizationId: SafeId<"organization">;
  tx: Transaction;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
}): Promise<boolean> => {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${workspaceId}))`);
  const [access] = await tx.execute(sql<{ hasAccess: boolean }>`
    SELECT true AS "hasAccess"
    FROM workspaces AS workspace
    INNER JOIN member AS organization_member
      ON organization_member.organization_id = workspace.organization_id
      AND organization_member.user_id = ${userId}
    WHERE workspace.id = ${workspaceId}
      AND workspace.organization_id = ${organizationId}
      AND workspace.status = 'active'
      AND CASE
        WHEN organization_member.role IN ('owner', 'admin') AND workspace.client_id IS NOT NULL THEN true
        ELSE EXISTS (
          SELECT 1 FROM workspace_members AS workspace_member
          WHERE workspace_member.workspace_id = workspace.id
            AND workspace_member.user_id = ${userId}
          FOR SHARE
        )
      END
    LIMIT 1
    FOR SHARE OF workspace, organization_member
  `);
  return access?.["hasAccess"] === true;
};
