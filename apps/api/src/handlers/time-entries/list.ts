import { Result } from "better-result";
import { and, asc, eq, gt, gte, isNotNull, lte, or } from "drizzle-orm";
import { t } from "elysia";

import {
  timeEntrySourceSchema,
  timeEntryStatusSchema,
} from "@/api/db/billing-validators";
import { timeEntries } from "@/api/db/schema";
import { canApproveTimeEntries } from "@/api/handlers/time-entries/authorization";
import { timeEntryReadColumns } from "@/api/handlers/time-entries/time-entry-columns";
import {
  selectTimekeeperNames,
  timekeeperIdsOf,
} from "@/api/handlers/time-entries/timekeeper-names";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import {
  tPaginationCursor,
  tSafeId,
  tUserId,
  withDescription,
} from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isDateOnlyPaginationCursorPart,
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";
import {
  brandPersistedTimeEntryId,
  brandPersistedUserId,
} from "@/api/lib/safe-id-boundaries";
import { validateOrgUserId } from "@/api/lib/validated-org-user-id";

type TimeEntryRow = typeof timeEntries.$inferSelect;

// Columns intentionally not sent to the client.
const UNPROJECTED_TIME_ENTRY_LIST_COLUMNS = [
  // Tenant scope, implied by the caller's active organization.
  "organizationId",
  // The route is already scoped to one workspace via params.workspaceId.
  "workspaceId",
  // Invoicing and split bookkeeping; the list reports billing through
  // `status`, and a split entry reads as an ordinary entry.
  "invoiceId",
  "splitGroupId",
] as const satisfies readonly (keyof TimeEntryRow)[];

// The query below selects exactly `timeEntryReadColumns`, so its keys are the
// columns this list projects.
type TimeEntryListItem = typeof timeEntryReadColumns;

// Totality guard, bidirectional: every schema column must be projected onto
// the response or explicitly excused above, and the projection cannot carry
// a field that traces back to no real column.
type MissingProjectedTimeEntryListColumn = UnprojectedColumns<
  TimeEntryRow,
  TimeEntryListItem,
  (typeof UNPROJECTED_TIME_ENTRY_LIST_COLUMNS)[number]
>;
type UnexpectedProjectedTimeEntryListColumn = UnbackedProjectionKeys<
  TimeEntryRow,
  TimeEntryListItem,
  (typeof UNPROJECTED_TIME_ENTRY_LIST_COLUMNS)[number]
>;

true satisfies MissingProjectedTimeEntryListColumn extends never ? true : never;
true satisfies UnexpectedProjectedTimeEntryListColumn extends never
  ? true
  : never;

const readTimeEntriesQuerySchema = t.Object({
  limit: t.Optional(
    t.Integer({
      minimum: 1,
      maximum: LIMITS.timeEntriesPageSizeMax,
      description: "Max entries to return",
    }),
  ),
  cursor: t.Optional(tPaginationCursor()),
  userId: t.Optional(
    withDescription(tUserId, "List only entries recorded by this user"),
  ),
  scope: t.Optional(
    t.Literal("me", {
      description: "List only entries recorded by the signed-in user",
    }),
  ),
  workItemId: t.Optional(
    tSafeId("entity", {
      description:
        "List only entries carrying this optional document, folder, or task context",
    }),
  ),
  dateFrom: t.Optional(
    t.String({
      format: "date",
      description:
        "List only entries worked on or after this ISO date (YYYY-MM-DD)",
    }),
  ),
  dateTo: t.Optional(
    t.String({
      format: "date",
      description:
        "List only entries worked on or before this ISO date (YYYY-MM-DD)",
    }),
  ),
  status: t.Optional(
    withDescription(
      timeEntryStatusSchema,
      "List only entries with this status",
    ),
  ),
  source: t.Optional(timeEntrySourceSchema),
  billable: t.Optional(t.BooleanString()),
  hasActiveTimer: t.Optional(t.BooleanString()),
});

type TimeEntryCursor = {
  dateWorked: string;
  id: SafeId<"timeEntry">;
};

const decodeTimeEntryCursor = (cursor: string): TimeEntryCursor | null => {
  const parts = decodePaginationCursor(cursor);
  const dateWorked = parts?.at(0);
  const id = parts?.at(1);

  if (
    !isDateOnlyPaginationCursorPart(dateWorked) ||
    !isUuidPaginationCursorPart(id)
  ) {
    return null;
  }

  return { dateWorked, id: brandPersistedTimeEntryId(id) };
};

const readTimeEntries = createSafeHandler(
  {
    description:
      "List time entries in a matter, optionally filtered by workItemId " +
      "(the document, folder, or task providing context), userId or scope=me, " +
      "a date-worked range (dateFrom/dateTo, ISO YYYY-MM-DD), and status. Returns each " +
      "entry's id, entity, user, date, minutes, rate (minor currency " +
      "units), currency, narrative, and status.",
    permissions: { timeEntry: ["read"] },
    mcp: { type: "tool", name: "list_time_entries" },
    access: "read",
    query: readTimeEntriesQuerySchema,
  },
  async function* ({
    memberRole,
    safeDb,
    session,
    user: currentUser,
    workspaceId,
    query,
  }) {
    const limit = query.limit ?? LIMITS.timeEntriesPageSizeDefault;
    const canReviewMatterEntries = canApproveTimeEntries(memberRole);

    const conditions = [eq(timeEntries.workspaceId, workspaceId)];

    const requestedUserId = query.userId;
    if (query.scope === "me" && requestedUserId) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "scope and userId cannot be combined",
        }),
      );
    }

    if (query.scope === "me") {
      conditions.push(eq(timeEntries.userId, currentUser.id));
    } else if (requestedUserId) {
      if (!canReviewMatterEntries && requestedUserId !== currentUser.id) {
        return Result.err(
          new HandlerError({ status: 403, message: "Forbidden" }),
        );
      }

      const validatedUserId = yield* Result.await(
        safeDb(
          async (tx) =>
            await validateOrgUserId(
              tx,
              brandPersistedUserId(requestedUserId),
              session.activeOrganizationId,
            ),
        ),
      );
      if (!validatedUserId) {
        return Result.err(
          new HandlerError({ status: 404, message: "User not found" }),
        );
      }
      conditions.push(eq(timeEntries.userId, validatedUserId));
    } else if (!canReviewMatterEntries) {
      conditions.push(eq(timeEntries.userId, currentUser.id));
    }

    if (query.workItemId) {
      conditions.push(eq(timeEntries.workItemId, query.workItemId));
    }
    if (query.dateFrom) {
      conditions.push(gte(timeEntries.dateWorked, query.dateFrom));
    }
    if (query.dateTo) {
      conditions.push(lte(timeEntries.dateWorked, query.dateTo));
    }
    if (query.status) {
      conditions.push(eq(timeEntries.status, query.status));
    }
    if (query.source) {
      conditions.push(eq(timeEntries.source, query.source));
    }
    if (query.billable !== undefined) {
      conditions.push(eq(timeEntries.billable, query.billable));
    }
    if (query.hasActiveTimer) {
      conditions.push(isNotNull(timeEntries.timerStartedAt));
    }
    if (query.cursor) {
      const cursor = decodeTimeEntryCursor(query.cursor);

      if (!cursor) {
        return Result.err(
          new HandlerError({ status: 400, message: "Invalid cursor" }),
        );
      }

      const cursorCondition = or(
        gt(timeEntries.dateWorked, cursor.dateWorked),
        and(
          eq(timeEntries.dateWorked, cursor.dateWorked),
          gt(timeEntries.id, cursor.id),
        ),
      );

      if (cursorCondition) {
        conditions.push(cursorCondition);
      }
    }

    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select(timeEntryReadColumns)
          .from(timeEntries)
          .where(and(...conditions))
          .orderBy(asc(timeEntries.dateWorked), asc(timeEntries.id))
          .limit(limit + 1),
      ),
    );

    const page = createCursorPage({
      rows,
      limit,
      cursorForItem: (item) =>
        encodePaginationCursor([item.dateWorked, item.id]),
    });

    // Batch-fetch user names
    const userIds = timekeeperIdsOf(page.items);
    const usersResult =
      userIds.size > 0
        ? yield* Result.await(
            safeDb(
              async (tx) =>
                await selectTimekeeperNames(tx, {
                  organizationId: session.activeOrganizationId,
                  userIds,
                }),
            ),
          )
        : [];

    const userMap = new Map(usersResult.map((u) => [u.id, u.name]));

    return Result.ok({
      ...page,
      items: page.items.map((row) => ({
        id: row.id,
        userId: row.userId,
        workItemId: row.workItemId,
        dateWorked: row.dateWorked,
        timezoneId: row.timezoneId,
        durationMinutes: row.durationMinutes,
        billedMinutes: row.billedMinutes,
        rateAtEntry: row.rateAtEntry,
        currency: row.currency,
        narrative: row.narrative,
        invoiceNarrative: row.invoiceNarrative,
        billable: row.billable,
        noCharge: row.noCharge,
        status: row.status,
        source: row.source,
        taskCode: row.taskCode,
        activityCode: row.activityCode,
        userName: row.userId ? (userMap.get(row.userId) ?? null) : null,
        timerStartedAt: row.timerStartedAt?.toISOString() ?? null,
        timerStoppedAt: row.timerStoppedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt?.toISOString() ?? null,
      })),
    });
  },
);

export default readTimeEntries;
