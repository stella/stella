import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import type { SafeId } from "@/api/lib/branded-types";
import { typedPgArray } from "@/api/lib/search/sql";

export type WorkspaceScopeArgs = {
  accessibleWorkspaceIds: readonly SafeId<"workspace">[];
  selectedWorkspaceIds: readonly SafeId<"workspace">[];
};

export const resolveWorkspaceScope = ({
  accessibleWorkspaceIds,
  selectedWorkspaceIds,
}: WorkspaceScopeArgs): readonly SafeId<"workspace">[] | null => {
  if (accessibleWorkspaceIds.length === 0) {
    return null;
  }
  if (selectedWorkspaceIds.length === 0) {
    return accessibleWorkspaceIds;
  }
  const accessSet = new Set(accessibleWorkspaceIds);
  const intersection = selectedWorkspaceIds.filter((id) => accessSet.has(id));
  return intersection.length > 0 ? intersection : null;
};

export const contactWorkspaceAccessSql = ({
  organizationId,
  ...scope
}: {
  organizationId: SafeId<"organization">;
} & WorkspaceScopeArgs): SQL => {
  const effective = resolveWorkspaceScope(scope);
  if (effective === null) {
    return sql`AND false`;
  }

  return sql`AND EXISTS (
        SELECT 1
        FROM workspaces w
        LEFT JOIN workspace_contacts wc
          ON wc.workspace_id = w.id
        WHERE w.id = ANY(${typedPgArray(effective, "uuid")})
          AND w.organization_id = ${organizationId}
          AND (
            w.client_id = csd.contact_id
            OR wc.contact_id = csd.contact_id
          )
      )`;
};
