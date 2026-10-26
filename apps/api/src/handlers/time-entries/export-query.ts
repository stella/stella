import { eq, gte, lte } from "drizzle-orm";
import * as v from "valibot";

import { TIME_ENTRY_ACTIVITY_GROUP } from "@stll/api-contract";
import { apiDateSchema } from "@stll/api-contract/api-date";
import type { Temporal } from "@stll/time";

import { timeEntryStatusSchema } from "@/api/db/billing-validators";
import type { ScopedDb } from "@/api/db/safe-db";
import { timeEntries } from "@/api/db/schema";
import {
  selectTimekeeperNames,
  timekeeperIdsOf,
} from "@/api/lib/billing/timekeeper-names";
import type { SafeId } from "@/api/lib/branded-types";
import { resourceIdSchema } from "@/api/lib/custom-schema";

export const timeEntryExportQuerySchema = v.object({
  dateFrom: v.optional(apiDateSchema),
  dateTo: v.optional(apiDateSchema),
  status: v.optional(timeEntryStatusSchema),
  workItemId: v.optional(resourceIdSchema("entity")),
});

export type TimeEntryExportHandlerProps = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  query: v.InferOutput<typeof timeEntryExportQuerySchema>;
  /** The instant whose organization day dates the export. */
  at?: Temporal.Instant;
};

type TimeEntryExportConditionsOptions = Pick<
  TimeEntryExportHandlerProps,
  "workspaceId" | "query"
>;

/** The matter scope plus the caller's date, status, and work-item filters. */
export const timeEntryExportConditions = ({
  workspaceId,
  query,
}: TimeEntryExportConditionsOptions) => {
  const conditions = [
    eq(timeEntries.workspaceId, workspaceId),
    eq(timeEntries.activityGroup, TIME_ENTRY_ACTIVITY_GROUP.CLIENT),
  ];

  if (query.dateFrom) {
    conditions.push(gte(timeEntries.dateWorked, query.dateFrom));
  }
  if (query.dateTo) {
    conditions.push(lte(timeEntries.dateWorked, query.dateTo));
  }
  if (query.status) {
    conditions.push(eq(timeEntries.status, query.status));
  }
  if (query.workItemId) {
    conditions.push(eq(timeEntries.workItemId, query.workItemId));
  }

  return conditions;
};

type LoadTimekeeperNamesOptions = Pick<
  TimeEntryExportHandlerProps,
  "scopedDb" | "organizationId"
> & {
  rows: readonly { userId: string | null }[];
};

/** Names of the organization members who logged `rows`, keyed by user id. */
export const loadTimekeeperNames = async ({
  scopedDb,
  organizationId,
  rows,
}: LoadTimekeeperNamesOptions) => {
  const userIds = timekeeperIdsOf(rows);
  const usersResult =
    userIds.size > 0
      ? await scopedDb(
          async (tx) =>
            await selectTimekeeperNames(tx, { organizationId, userIds }),
        )
      : [];

  return new Map(usersResult.map((u) => [u.id, u.name]));
};
