import { panic } from "better-result";
import { eq, getTableColumns, isNull } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import type { SafeId } from "@/api/lib/branded-types";

/** Select one record table's organization-level or matter-level rows. */
export const dataExportRecordScope = (
  table: PgTable,
  workspaceId: SafeId<"workspace"> | null,
): SQL => {
  const workspaceColumn = Object.values(getTableColumns(table)).find(
    (column) => column.name === "workspace_id",
  );
  if (workspaceColumn === undefined) {
    return panic("Data export scope requires a workspace_id column");
  }
  if (workspaceId === null) {
    if (workspaceColumn.notNull) {
      return panic("Data export null-matter scope requires a nullable column");
    }
    return isNull(workspaceColumn);
  }
  return eq(workspaceColumn, workspaceId);
};
