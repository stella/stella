import { panic, Result } from "better-result";
import { and, asc, eq, gt, gte, lte, ne, or, sql } from "drizzle-orm";
import * as v from "valibot";

import { TIME_ENTRY_ACTIVITY_GROUP } from "@stll/api-contract";
import { API_CALENDAR_DATE_CHECK } from "@stll/api-contract/api-date";
import { numberFromString } from "@stll/api-contract/http-input";
import { parsePlainDate } from "@stll/time";

import { timeDailyTargets, timeEntries, workspaces } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { leftTodayMinutes } from "@/api/lib/billing/daily-target";
import type { SafeId } from "@/api/lib/branded-types";
import {
  paginationCursorSchema,
  paginationLimitSchema,
} from "@/api/lib/custom-schema";
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
import { normalizeTenantPageLimit } from "@/api/lib/rate-limit/action-size-limits";
import { brandPersistedTimeEntryId } from "@/api/lib/safe-id-boundaries";

const DELETING_WORKSPACE_STATUS = "deleting" as const;

const myTimeEntryColumns = {
  id: timeEntries.id,
  activityGroup: timeEntries.activityGroup,
  workspaceId: timeEntries.workspaceId,
  workspaceName: workspaces.name,
  workspaceReference: workspaces.reference,
  dateWorked: timeEntries.dateWorked,
  durationMinutes: timeEntries.durationMinutes,
  billedMinutes: timeEntries.billedMinutes,
  narrative: timeEntries.narrative,
  narrativeLanguage: timeEntries.narrativeLanguage,
  billable: timeEntries.billable,
  status: timeEntries.status,
  source: timeEntries.source,
  timerStartedAt: timeEntries.timerStartedAt,
};

type MyTimeEntrySourceRow = typeof timeEntries.$inferSelect & {
  workspaceName: (typeof workspaces.$inferSelect)["name"] | null;
  workspaceReference: (typeof workspaces.$inferSelect)["reference"] | null;
};

const toMyTimeEntryItem = (
  row: Pick<MyTimeEntrySourceRow, keyof typeof myTimeEntryColumns>,
) => {
  const common = {
    id: row.id,
    dateWorked: row.dateWorked,
    durationMinutes: row.durationMinutes,
    billedMinutes: row.billedMinutes,
    narrative: row.narrative,
    narrativeLanguage: row.narrativeLanguage,
    billable: row.billable,
    status: row.status,
    source: row.source,
    timerStartedAt: row.timerStartedAt?.toISOString() ?? null,
  };
  switch (row.activityGroup) {
    case TIME_ENTRY_ACTIVITY_GROUP.CLIENT:
      if (
        !row.workspaceId ||
        row.workspaceName === null ||
        row.workspaceReference === null
      ) {
        return panic("Client time entry is missing its authorized matter");
      }
      return {
        ...common,
        activityGroup: row.activityGroup,
        workspaceId: row.workspaceId,
        workspaceName: row.workspaceName,
        workspaceReference: row.workspaceReference,
      };
    case TIME_ENTRY_ACTIVITY_GROUP.INTERNAL:
      return {
        ...common,
        activityGroup: row.activityGroup,
        workspaceId: null,
        workspaceName: null,
        workspaceReference: null,
      };
    default:
      row.activityGroup satisfies never;
      return panic("Unknown time entry activity group");
  }
};

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
  "noCharge",
  "taskCode",
  "activityCode",
  // Invoice and split identifiers are internal billing links.
  "invoiceId",
  "invoiceAttachment",
  "splitGroupId",
  // Timer stop and audit timestamps are not used by the day view.
  "timerStoppedAt",
  "createdAt",
  "updatedAt",
  // Approval metadata is exposed by the approval queue.
  "approverUserId",
  "approvedByUserId",
  "approvedAt",
  "returnedByUserId",
  "returnedAt",
  "returnComment",
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
  contract: "patch",
  description:
    "List the signed-in user's client and internal time entries for one work date, or for date " +
    "through endDate (at most seven days), in the active organization. Client rows include an accessible matter; internal rows have no matter. " +
    "Follow the cursor for the next page. Logged minutes, daily target and remaining minutes cover all " +
    "accessible entries for the dates, independently of pagination, and days gives logged and billable minutes per work date that has entries. " +
    "Logged minutes sum client and internal durations; target and remaining minutes are null when no target is set.",
  permissions: { timeEntry: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  featureAccess: { featureId: "time-billing", type: "required" },
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "billing_admin",
    consumesServices: false,
  },
  access: "read",
  query: v.object({
    date: v.pipe(
      v.string(),
      v.isoDate(),
      API_CALENDAR_DATE_CHECK,
      v.description("Work date in YYYY-MM-DD format"),
    ),
    endDate: v.optional(
      v.pipe(
        v.string(),
        v.isoDate(),
        API_CALENDAR_DATE_CHECK,
        v.description(
          "Last work date in YYYY-MM-DD format, on or after date and at most six days later; defaults to date",
        ),
      ),
    ),
    limit: v.optional(
      numberFromString(paginationLimitSchema(LIMITS.timeEntriesPageSizeMax)),
    ),
    cursor: v.optional(paginationCursorSchema()),
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
    const startDate = parsePlainDate(query.date);
    const endDate = parsePlainDate(query.endDate ?? query.date);
    const rangeDays =
      startDate === null || endDate === null
        ? null
        : startDate.until(endDate, { largestUnit: "days" }).days + 1;
    if (
      rangeDays === null ||
      rangeDays < 1 ||
      rangeDays > LIMITS.timeRangeDaysMax
    ) {
      return Result.err(
        new HandlerError({
          status: 400,
          code: "invalid_date_worked",
          message: `Work dates must be valid and span 1 to ${LIMITS.timeRangeDaysMax} days`,
          hint: "Use YYYY-MM-DD dates, with endDate on or after date and at most six days later.",
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

    const limit = normalizeTenantPageLimit(
      query.limit ?? LIMITS.timeEntriesPageSizeDefault,
    );
    const dayScope = and(
      eq(timeEntries.organizationId, session.activeOrganizationId),
      eq(timeEntries.userId, user.id),
      gte(timeEntries.dateWorked, query.date),
      lte(timeEntries.dateWorked, query.endDate ?? query.date),
      or(
        eq(timeEntries.activityGroup, TIME_ENTRY_ACTIVITY_GROUP.INTERNAL),
        and(
          eq(timeEntries.activityGroup, TIME_ENTRY_ACTIVITY_GROUP.CLIENT),
          eq(workspaces.organizationId, session.activeOrganizationId),
          ne(workspaces.status, DELETING_WORKSPACE_STATUS),
        ),
      ),
    );
    const day = yield* Result.await(
      safeDb(async (tx) => {
        const rows = await tx
          .select(myTimeEntryColumns)
          .from(timeEntries)
          .leftJoin(
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
          .leftJoin(
            workspaces,
            and(
              eq(timeEntries.workspaceId, workspaces.id),
              eq(timeEntries.organizationId, workspaces.organizationId),
            ),
          )
          .where(dayScope);
        const days = await tx
          .select({
            dateWorked: timeEntries.dateWorked,
            loggedMinutes:
              sql<number>`coalesce(sum(${timeEntries.durationMinutes}), 0)`.mapWith(
                Number,
              ),
            billableMinutes:
              sql<number>`coalesce(sum(${timeEntries.durationMinutes}) FILTER (WHERE ${timeEntries.billable}), 0)`.mapWith(
                Number,
              ),
          })
          .from(timeEntries)
          .leftJoin(
            workspaces,
            and(
              eq(timeEntries.workspaceId, workspaces.id),
              eq(timeEntries.organizationId, workspaces.organizationId),
            ),
          )
          .where(dayScope)
          .groupBy(timeEntries.dateWorked)
          .orderBy(asc(timeEntries.dateWorked))
          .limit(LIMITS.timeRangeDaysMax);
        const summary = summaries.at(0);
        if (summary === undefined) {
          return panic("Daily time aggregate returned no row");
        }
        return { rows, summary, days };
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
      days: day.days,
      loggedTodayMinutes: day.summary.loggedMinutes,
      dailyTargetMinutes: day.summary.dailyTargetMinutes,
      leftTodayMinutes: leftTodayMinutes(
        day.summary.dailyTargetMinutes,
        day.summary.loggedMinutes,
      ),
    });
  },
);

export default listMyTimeEntries;
