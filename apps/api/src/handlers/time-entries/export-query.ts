import { eq, gte, lte } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import { timeEntryStatusSchema } from "@/api/db/billing-validators";
import type { ScopedDb } from "@/api/db/safe-db";
import { timeEntries } from "@/api/db/schema";
import {
  selectTimekeeperNames,
  timekeeperIdsOf,
} from "@/api/handlers/time-entries/timekeeper-names";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";

export const timeEntryExportQuerySchema = t.Object({
  dateFrom: t.Optional(t.String({ format: "date" })),
  dateTo: t.Optional(t.String({ format: "date" })),
  status: t.Optional(timeEntryStatusSchema),
  workItemId: t.Optional(tSafeId("entity")),
});

export type TimeEntryExportHandlerProps = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  query: Static<typeof timeEntryExportQuerySchema>;
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
  const conditions = [eq(timeEntries.workspaceId, workspaceId)];

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
