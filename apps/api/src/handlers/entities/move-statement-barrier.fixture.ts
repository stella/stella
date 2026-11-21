import { sql } from "drizzle-orm";

import { workspaces } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

// The race control removes synchronization while keeping the parent's real
// identity and visibility, which the aggregate owner validates after execution.
export const unlockedWorkspaceParentRead = (workspaceId: SafeId<"workspace">) =>
  sql`SELECT id FROM ${workspaces}
    WHERE ${workspaces.id} IN (${workspaceId})
    ORDER BY ${workspaces.id}::text COLLATE "C"`;
