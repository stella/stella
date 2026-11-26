import { and, eq, gte, lte, or } from "drizzle-orm";

import { TIME_ENTRY_ACTIVITY_GROUP } from "@stll/api-contract";

import { timeEntries, workspaces } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { visibleWorkspaceSql } from "@/api/lib/workspaces/visible-workspace-sql";

/** Joins a time entry to its matter in the same organization. */
export const timeEntryMatterJoin = () =>
  and(
    eq(timeEntries.workspaceId, workspaces.id),
    eq(timeEntries.organizationId, workspaces.organizationId),
  );

type OwnTimeEntriesScopeOptions = {
  organizationId: SafeId<"organization">;
  userId: string;
  /** First work date, `YYYY-MM-DD`: the member's calendar day the entry
   * records, never a UTC instant. */
  date: string;
  /** Last work date, inclusive. */
  endDate: string;
};

/**
 * The member's own time entries worked on `date` through `endDate`, as every
 * reader of their own time counts them: internal time, and client time on a
 * matter of the organization that is still readable. The read joins
 * `workspaces` with {@link timeEntryMatterJoin}.
 */
export const ownTimeEntriesScope = ({
  organizationId,
  userId,
  date,
  endDate,
}: OwnTimeEntriesScopeOptions) =>
  and(
    eq(timeEntries.organizationId, organizationId),
    eq(timeEntries.userId, userId),
    gte(timeEntries.dateWorked, date),
    lte(timeEntries.dateWorked, endDate),
    or(
      eq(timeEntries.activityGroup, TIME_ENTRY_ACTIVITY_GROUP.INTERNAL),
      and(
        eq(timeEntries.activityGroup, TIME_ENTRY_ACTIVITY_GROUP.CLIENT),
        eq(workspaces.organizationId, organizationId),
        visibleWorkspaceSql(),
      ),
    ),
  );
