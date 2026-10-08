import { panic } from "better-result";
import { eq, sql } from "drizzle-orm";

import type { ScopedTransaction } from "@/api/db/safe-db";
import type { searchDocuments } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

type SearchBookkeepingOperation =
  | {
      type: "remove-entity";
      db: Pick<ScopedTransaction, "delete">;
      table: typeof searchDocuments;
      entityId: SafeId<"entity">;
    }
  | {
      type: "sync-workspace-activity";
      db: Pick<ScopedTransaction, "execute">;
      workspaceId: SafeId<"workspace">;
    };

export const writeSearchBookkeeping = async (
  operation: SearchBookkeepingOperation,
): Promise<void> => {
  // audit: skip — derived search projection removal and timestamp refresh from already-audited source activity.
  switch (operation.type) {
    case "remove-entity":
      await operation.db
        .delete(operation.table)
        .where(eq(operation.table.entityId, operation.entityId));
      return;
    case "sync-workspace-activity":
      await operation.db.execute(sql`
        UPDATE workspace_search_documents wsd
        SET updated_at = w.last_activity_at
        FROM workspaces w
        WHERE w.id = ${operation.workspaceId}
          AND wsd.workspace_id = w.id
          AND wsd.updated_at < w.last_activity_at
      `);
      return;
    default:
      operation satisfies never;
      return panic("Unknown search bookkeeping operation");
  }
};
