import { panic, Result } from "better-result";
import { and, asc, eq, gt, lte, ne, or } from "drizzle-orm";
import { t } from "elysia";

import { TIME_ENTRY_ACTIVITY_GROUP } from "@stll/api-contract";
import { parsePlainDate } from "@stll/time";

import { absences, timeEntries, workspaces } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
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
import {
  brandPersistedAbsenceId,
  brandPersistedTimeEntryId,
} from "@/api/lib/safe-id-boundaries";

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
  description:
    "List the signed-in user's client work, internal work, and approved absences for one local date " +
    "in the active organization. Client rows include an accessible matter; internal rows have no matter. " +
    "Absences report days (1 or 0.5), with no inferred minutes. Follow the mixed-source cursor for the next page.",
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

const ABSENCE_DAY_GROUP = "absence";
const DAY_TABLE = { ABSENCE: "absence", TIME_ENTRY: "time_entry" } as const;
const decodeCursor = (cursor: string) => {
  const parts = decodePaginationCursor(cursor);
  const id = parts?.at(0);
  const table = parts?.at(1);
  if (parts?.length !== 2 || !isUuidPaginationCursorPart(id)) {
    return null;
  }
  if (table !== DAY_TABLE.ABSENCE && table !== DAY_TABLE.TIME_ENTRY) {
    return null;
  }
  return { id, table };
};

const absenceDayColumns = {
  id: absences.id,
  kind: absences.kind,
  startDate: absences.startDate,
  endDate: absences.endDate,
  timezoneId: absences.timezoneId,
  coverage: absences.coverage,
  halfDaySegment: absences.halfDaySegment,
};
const UNPROJECTED_ABSENCE_DAY_COLUMNS = [
  // Tenant and owner are pinned by the request; only approved rows enter the day.
  "organizationId",
  "userId",
  "status",
  // Decisions and versioning belong to the absence management endpoints.
  "approverUserId",
  "decidedAt",
  "decisionComment",
  "version",
  "createdAt",
  "updatedAt",
] as const satisfies readonly (keyof typeof absences.$inferSelect)[];
type MissingAbsenceDayColumn = UnprojectedColumns<
  typeof absences.$inferSelect,
  typeof absenceDayColumns,
  (typeof UNPROJECTED_ABSENCE_DAY_COLUMNS)[number]
>;
type ExtraAbsenceDayColumn = UnbackedProjectionKeys<
  typeof absences.$inferSelect,
  typeof absenceDayColumns,
  (typeof UNPROJECTED_ABSENCE_DAY_COLUMNS)[number]
>;
true satisfies MissingAbsenceDayColumn extends never ? true : never;
true satisfies ExtraAbsenceDayColumn extends never ? true : never;

const toAbsenceDayItem = (
  row: Pick<typeof absences.$inferSelect, keyof typeof absenceDayColumns>,
  date: string,
) => {
  const common = {
    id: row.id,
    activityGroup: ABSENCE_DAY_GROUP,
    kind: row.kind,
    date,
    startDate: row.startDate,
    endDate: row.endDate,
    timezoneId: row.timezoneId,
  } as const;
  switch (row.coverage) {
    case "full":
      return { ...common, coverage: row.coverage, days: 1 } as const;
    case "half":
      if (!row.halfDaySegment) {
        return panic("Half-day absence is missing its segment");
      }
      return {
        ...common,
        coverage: row.coverage,
        halfDaySegment: row.halfDaySegment,
        days: 0.5,
      } as const;
    default:
      row.coverage satisfies never;
      return panic("Unknown absence coverage");
  }
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
    const rows = yield* Result.await(
      safeDb(async (tx) => {
        const workRows = await tx
          .select(myTimeEntryColumns)
          .from(timeEntries)
          .leftJoin(
            workspaces,
            and(
              eq(timeEntries.workspaceId, workspaces.id),
              eq(timeEntries.organizationId, workspaces.organizationId),
            ),
          )
          .where(
            and(
              eq(timeEntries.organizationId, session.activeOrganizationId),
              eq(timeEntries.userId, user.id),
              eq(timeEntries.dateWorked, query.date),
              cursor
                ? or(
                    gt(timeEntries.id, brandPersistedTimeEntryId(cursor.id)),
                    cursor.table === DAY_TABLE.ABSENCE
                      ? eq(timeEntries.id, brandPersistedTimeEntryId(cursor.id))
                      : undefined,
                  )
                : undefined,
              or(
                eq(
                  timeEntries.activityGroup,
                  TIME_ENTRY_ACTIVITY_GROUP.INTERNAL,
                ),
                and(
                  eq(
                    timeEntries.activityGroup,
                    TIME_ENTRY_ACTIVITY_GROUP.CLIENT,
                  ),
                  eq(workspaces.organizationId, session.activeOrganizationId),
                  ne(workspaces.status, DELETING_WORKSPACE_STATUS),
                ),
              ),
            ),
          )
          .orderBy(asc(timeEntries.id))
          .limit(limit + 1);
        const absenceRows = await tx
          .select(absenceDayColumns)
          .from(absences)
          .where(
            and(
              eq(absences.organizationId, session.activeOrganizationId),
              eq(absences.userId, user.id),
              eq(absences.status, "approved"),
              lte(absences.startDate, query.date),
              gt(absences.endDate, query.date),
              cursor
                ? gt(absences.id, brandPersistedAbsenceId(cursor.id))
                : undefined,
            ),
          )
          .orderBy(asc(absences.id))
          .limit(limit + 1);
        return [
          ...workRows.map(toMyTimeEntryItem),
          ...absenceRows.map((row) => toAbsenceDayItem(row, query.date)),
        ].toSorted((left, right) => {
          if (left.id < right.id) {return -1;}
          if (left.id > right.id) {return 1;}
          return (
            Number(left.activityGroup !== ABSENCE_DAY_GROUP) -
            Number(right.activityGroup !== ABSENCE_DAY_GROUP)
          );
        });
      }),
    );

    const page = createCursorPage({
      rows,
      limit,
      cursorForItem: ({ id, activityGroup }) =>
        encodePaginationCursor([
          id,
          activityGroup === ABSENCE_DAY_GROUP
            ? DAY_TABLE.ABSENCE
            : DAY_TABLE.TIME_ENTRY,
        ]),
    });
    return Result.ok({
      ...page,
      items: page.items,
    });
  },
);

export default listMyTimeEntries;
