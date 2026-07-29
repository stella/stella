import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import type { SafeId } from "@/api/lib/branded-types";
import { typedPgArray } from "@/api/lib/search/sql";

type ChatThreadScopeArgs = {
  userId: SafeId<"user">;
  organizationId: SafeId<"organization">;
  accessibleWorkspaceIds: readonly SafeId<"workspace">[];
  selectedWorkspaceIds: readonly SafeId<"workspace">[];
};

// Chat threads are private to the calling user, and global search runs on
// the RLS-bypassing root connection. This predicate reproduces the
// chat-thread RLS scope (db/rls.ts) explicitly.
export const chatThreadScopeSql = ({
  userId,
  organizationId,
  accessibleWorkspaceIds,
  selectedWorkspaceIds,
}: ChatThreadScopeArgs): SQL => {
  const accessArray = typedPgArray(accessibleWorkspaceIds, "uuid");
  const selectedArray = typedPgArray(selectedWorkspaceIds, "uuid");
  const selectedFilter =
    selectedWorkspaceIds.length > 0
      ? sql`AND (
          t.workspace_id = ANY(${selectedArray})
          OR t.data_workspace_ids && ${selectedArray}
        )`
      : sql``;
  return sql`
    t.id = cst.thread_id
    AND t.user_id = ${userId}
    AND t.organization_id = ${organizationId}
    AND (t.workspace_id IS NULL OR t.workspace_id = ANY(${accessArray}))
    AND (
      cardinality(t.data_workspace_ids) = 0
      OR t.data_workspace_ids <@ ${accessArray}
    )
    ${selectedFilter}
  `;
};
