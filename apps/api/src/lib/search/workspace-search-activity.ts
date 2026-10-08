import type { ScopedTransaction } from "@/api/db/safe-db";
import type { SafeId } from "@/api/lib/branded-types";
import { writeSearchBookkeeping } from "@/api/lib/db/recovery-bookkeeping/search";

// Projection maintenance is shared with workers that do not load request-time
// feature admission or the full API environment.
type SearchActivityDatabase = Pick<ScopedTransaction, "execute">;

export const syncWorkspaceSearchActivity = async (
  workspaceId: SafeId<"workspace">,
  db: SearchActivityDatabase,
): Promise<void> => {
  await writeSearchBookkeeping({
    type: "sync-workspace-activity",
    db,
    workspaceId,
  });
};
