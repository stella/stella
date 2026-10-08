import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import type { SafeId } from "@/api/lib/branded-types";

// Projection maintenance is shared with workers that do not load request-time
// feature admission or the full API environment.
type SearchActivityDatabase = {
  execute: (query: SQL) => Promise<unknown>;
};

export const syncWorkspaceSearchActivity = async (
  workspaceId: SafeId<"workspace">,
  db: SearchActivityDatabase = rootDb,
): Promise<void> => {
  // audit: skip - refreshes a derived timestamp from already-audited workspace activity.
  await db.execute(sql`
    UPDATE workspace_search_documents wsd
    SET updated_at = w.last_activity_at
    FROM workspaces w
    WHERE w.id = ${workspaceId}
      AND wsd.workspace_id = w.id
      AND wsd.updated_at < w.last_activity_at
  `);
};
