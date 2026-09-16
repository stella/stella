import { panic } from "better-result";
import { eq, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import { workspaces } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

export type EntityQueryScope =
  | { type: "matter"; workspaceId: SafeId<"workspace"> }
  | { type: "organization"; organizationId: SafeId<"organization"> };

/** RLS still decides which of the organization's matters the caller can read. */
export const entityQueryScopeCondition = (
  scope: EntityQueryScope,
  workspaceColumn: AnyPgColumn,
) => {
  switch (scope.type) {
    case "matter":
      return eq(workspaceColumn, scope.workspaceId);
    case "organization":
      return sql`EXISTS (
        SELECT 1 FROM ${workspaces}
        WHERE ${workspaces.id} = ${workspaceColumn}
          AND ${workspaces.organizationId} = ${scope.organizationId}
          AND ${workspaces.status} <> 'deleting'
      )`;
    default: {
      scope satisfies never;
      return panic(`Unhandled entity query scope: ${String(scope)}`);
    }
  }
};
