import { panic, Result } from "better-result";
import { and, asc, eq, gt, ne, sql } from "drizzle-orm";
import { t } from "elysia";

import { parsePlainDate } from "@stll/time";

import { timeDailyTargets, timeEntries, workspaces } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { leftTodayMinutes } from "@/api/lib/billing/daily-target";
import type { SafeId } from "@/api/lib/branded-types";
import { tPaginationCursor, tPaginationLimit } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";
import { brandPersistedTimeEntryId } from "@/api/lib/safe-id-boundaries";

const DELETING_WORKSPACE_STATUS = "deleting" as const;

const myTimeEntryColumns = {
  id: timeEntries.id,
  workspaceId: workspaces.id,
  workspaceName: workspaces.name,
  workspaceReference: workspaces.reference,
  dateWorked: timeEntries.dateWorked,
  durationMinutes: timeEntries.durationMinutes,
  billedMinutes: timeEntries.billedMinutes,
  narrative: timeEntries.narrative,
  billable: timeEntries.billable,
  status: timeEntries.status,
  source: timeEntries.source,
  timerStartedAt: timeEntries.timerStartedAt,
};

type MyTimeEntrySourceRow = typeof timeEntries.$inferSelect & {
  workspaceName: (typeof workspaces.$inferSelect)["name"];
  workspaceReference: (typeof workspaces.$inferSelect)["reference"];
};

const toMyTimeEntryItem = (
  row: Pick<MyTimeEntrySourceRow, keyof typeof myTimeEntryColumns>,
) => ({
  id: row.id,
  workspaceId: row.workspaceId,
  workspaceName: row.workspaceName,
  workspaceReference: row.workspaceReference,
  dateWorked: row.dateWorked,
  durationMinutes: row.durationMinutes,
  billedMinutes: row.billedMinutes,
  narrative: row.narrative,
  billable: row.billable,
  status: row.status,
  source: row.source,
  timerStartedAt: row.timerStartedAt?.toISOString() ?? null,
});

const UNPROJECTED_MY_TIME_ENTRY_COLUMNS = [
  // The request is scoped to the active organization and signed-in user.
  "organizationId",
  "userId",
  // The day view does not display work item, rate, or billing code details.
  "workItemId",
  "timezoneId",
  "rateAtEntry",
  "currency",
  "invoiceNarrative",
  // Language metadata is used by the editing form, not this read-only summary.
  "narrativeLanguage",
  "noCharge",
  "taskCode",
  "activityCode",
  // Invoice and split identifiers are internal billing links.
  "invoiceId",
  "splitGroupId",
  // Timer stop and audit timestamps are not used by the day view.
  "timerStoppedAt",
  "createdAt",
  "updatedAt",
] as const satisfies readonly (keyof MyTimeEntrySourceRow)[];

type MissingMyTimeEntryColumn = UnprojectedColumns<
  MyTimeEntrySourceRow,
  ReturnType<typeof toMyTimeEntryItem>,
  (typeof UNPROJECTED_MY_TIME_ENTRY_COLUMNS)[number]
>;
type UnexpectedMyTimeEntryColumn = UnbackedProjectionKeys<
  MyTimeEntrySourceRow,
  ReturnType<typeof toMyTimeEntryItem>,
  (typeof UNPROJECTED_MY_TIME_ENTRY_COLUMNS)[number]
>;

true satisfies MissingMyTimeEntryColumn extends never ? true : never;
true satisfies UnexpectedMyTimeEntryColumn extends never ? true : never;

const config = {
  description:
    "List the signed-in user's time entries for one work date across matters " +
    "in the active organization. Returns only matters the caller can still access, " +
    "with a cursor for the next page. Daily target and remaining minutes cover all " +
    "accessible entries for the date, independently of pagination; both are null when no target is set.",
  permissions: { timeEntry: ["read"] },
  mcp: { type: "capability", reason: "billing_admin" },
  access: "read",
  query: t.Object({
    date: t.String({
      format: "date",
      description: "Work date in YYYY-MM-DD format",
    }),
    limit: t.Optional(tPaginationLimit(LIMITS.timeEntriesPageSizeMax)),
    cursor: t.Optional(tPaginationCursor()),
  }),
} satisfies HandlerConfig;

const decodeCursor = (cursor: string): SafeId<"timeEntry"> | null => {
  const parts = decodePaginationCursor(cursor);
  const id = parts?.at(0);
  return isUuidPaginationCursorPart(id) ? brandPersistedTimeEntryId(id) : null;
};

const listMyTimeEntries = createSafeRootHandler(
  config,
  async function* ({ query, safeDb, session, user }) {
    if (parsePlainDate(query.date) === null) {
      return Result.err(
        new HandlerError({
          status: 400,
          code: "invalid_date_worked",
          message: "Date must be a valid calendar date",
          hint: "Use a calendar date in YYYY-MM-DD format.",
        }),
      );
    }
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    if (query.cursor && cursor === null) {
      return Result.err(
        new HandlerError({
          status: 400,
          code: "invalid_cursor",
          message: "Invalid cursor",
          hint: "Restart the list without a cursor.",
        }),
      );
    }

    const limit = query.limit ?? LIMITS.timeEntriesPageSizeDefault;
    const dayScope = and(
      eq(timeEntries.organizationId, session.activeOrganizationId),
      eq(timeEntries.userId, user.id),
      eq(timeEntries.dateWorked, query.date),
      eq(workspaces.organizationId, session.activeOrganizationId),
      ne(workspaces.status, DELETING_WORKSPACE_STATUS),
    );
    const day = yield* Result.await(
      safeDb(async (tx) => {
        const rows = await tx
          .select(myTimeEntryColumns)
          .from(timeEntries)
          .innerJoin(
            workspaces,
            and(
              eq(timeEntries.workspaceId, workspaces.id),
              eq(timeEntries.organizationId, workspaces.organizationId),
            ),
          )
          .where(and(dayScope, cursor ? gt(timeEntries.id, cursor) : undefined))
          .orderBy(asc(timeEntries.id))
          .limit(limit + 1);
        const summaries = await tx
          .select({
            loggedMinutes:
              sql<number>`coalesce(sum(${timeEntries.durationMinutes}), 0)`.mapWith(
                Number,
              ),
            dailyTargetMinutes: sql<number | null>`(
            SELECT ${timeDailyTargets.minutes} FROM ${timeDailyTargets}
            WHERE ${timeDailyTargets.organizationId} = ${session.activeOrganizationId}
              AND ${timeDailyTargets.userId} = ${user.id}
          )`,
          })
          .from(timeEntries)
          .innerJoin(
            workspaces,
            and(
              eq(timeEntries.workspaceId, workspaces.id),
              eq(timeEntries.organizationId, workspaces.organizationId),
            ),
          )
          .where(dayScope);
        const summary = summaries.at(0);
        if (summary === undefined) {
          return panic("Daily time aggregate returned no row");
        }
        return { rows, summary };
      }),
    );

    const page = createCursorPage({
      rows: day.rows,
      limit,
      cursorForItem: ({ id }) => encodePaginationCursor([id]),
    });
    return Result.ok({
      ...page,
      items: page.items.map(toMyTimeEntryItem),
      dailyTargetMinutes: day.summary.dailyTargetMinutes,
      leftTodayMinutes: leftTodayMinutes(
        day.summary.dailyTargetMinutes,
        day.summary.loggedMinutes,
      ),
    });
  },
);

export default listMyTimeEntries;
