import { isNull, notInArray, or, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import type { SafeId } from "@/api/lib/branded-types";

// SQL NULL is outside every matter; do not let NOT IN turn it into unknown.
export const outsideRetainedMatters = (
  column: AnyPgColumn,
  retainedWorkspaceIds: readonly SafeId<"workspace">[],
) =>
  retainedWorkspaceIds.length === 0
    ? sql`true`
    : or(isNull(column), notInArray(column, [...retainedWorkspaceIds]));
