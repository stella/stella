import { panic, Result } from "better-result";
import { and, asc, eq, gt, ne, or } from "drizzle-orm";
import { t } from "elysia";

import { TIME_ENTRY_ACTIVITY_GROUP } from "@stll/api-contract";
import { parsePlainDate } from "@stll/time";

import { timeEntries, workspaces } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
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
  description:
    "List the signed-in user's client and internal time entries for one work date " +
    "in the active organization. Client rows include an accessible matter; internal rows have no matter. " +
    "Follow the cursor for the next page.",
  permissions: { timeEntry: ["read"] },
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "billing_admin",
    consumesServices: false,
  },
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

    const limit = normalizeTenantPageLimit(
      query.limit ?? LIMITS.timeEntriesPageSizeDefault,
    );
    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
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
              cursor ? gt(timeEntries.id, cursor) : undefined,
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
          .limit(limit + 1),
      ),
    );

    const page = createCursorPage({
      rows,
      limit,
      cursorForItem: ({ id }) => encodePaginationCursor([id]),
    });
    return Result.ok({
      ...page,
      items: page.items.map(toMyTimeEntryItem),
    });
  },
);

export default listMyTimeEntries;
