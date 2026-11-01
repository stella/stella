import { eq } from "drizzle-orm";

import { proveOrgScope } from "@/api/db/org-scope";
import type { ScopedTransaction } from "@/api/db/safe-db";
import { workspaces } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { writeSearchBookkeeping } from "@/api/lib/db/recovery-bookkeeping/search";

// Projection maintenance is shared with workers that do not load request-time
// feature admission or the full API environment.
type SearchActivityDatabase = ScopedTransaction;

export const syncWorkspaceSearchActivity = async (
  workspaceId: SafeId<"workspace">,
  db: SearchActivityDatabase,
): Promise<void> => {
  const scope = await proveOrgScope(db, {
    table: "workspaces",
    where: eq(workspaces.id, workspaceId),
  });
  if (scope.isErr()) {
    return;
  }
  await writeSearchBookkeeping({
    type: "sync-workspace-activity",
    db,
    scope: scope.value,
    workspaceId,
  });
};
