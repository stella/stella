import { panic } from "better-result";
import { sql } from "drizzle-orm";

import { CLIENT_MATTER_ADMIN_ROLES } from "@stll/permissions";

import type { Transaction } from "@/api/db/root";
import type { SafeId } from "@/api/lib/branded-types";
import { executedRows } from "@/api/lib/db/executed-rows";
import { isRecord } from "@/api/lib/type-guards";

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
  const rows = executedRows(
    await tx.execute(sql`
    SELECT true AS "hasAccess"
    FROM workspaces AS workspace
    INNER JOIN member AS organization_member
      ON organization_member.organization_id = workspace.organization_id
      AND organization_member.user_id = ${userId}
    WHERE workspace.id = ${workspaceId}
      AND workspace.organization_id = ${organizationId}
      AND workspace.status = 'active'
      AND CASE
        WHEN organization_member.role IN (${sql.join(
          CLIENT_MATTER_ADMIN_ROLES.map((role) => sql`${role}`),
          sql`, `,
        )}) AND workspace.client_id IS NOT NULL THEN true
        ELSE EXISTS (
          SELECT 1 FROM workspace_members AS workspace_member
          WHERE workspace_member.workspace_id = workspace.id
            AND workspace_member.user_id = ${userId}
          FOR SHARE
        )
      END
    LIMIT 1
    FOR SHARE OF workspace, organization_member
  `),
  );
  const access = rows.at(0);
  if (access === undefined) {
    return false;
  }
  if (!isRecord(access) || access["hasAccess"] !== true) {
    return panic("Invalid timer matter access result");
  }
  return true;
};
