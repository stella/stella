import { Result } from "better-result";
import { and, asc, eq, gt, ne } from "drizzle-orm";
import { t } from "elysia";

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
import { brandPersistedTimeEntryId } from "@/api/lib/safe-id-boundaries";

const DELETING_WORKSPACE_STATUS = "deleting" as const;

const config = {
  description:
    "List the signed-in user's time entries for one work date across matters " +
    "in the active organization. Returns only matters the caller can still access, " +
    "with a cursor for the next page.",
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
    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
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
          })
          .from(workspaces)
          .innerJoin(
            timeEntries,
            and(
              eq(timeEntries.workspaceId, workspaces.id),
              eq(timeEntries.organizationId, workspaces.organizationId),
              eq(timeEntries.userId, user.id),
              eq(timeEntries.dateWorked, query.date),
              cursor ? gt(timeEntries.id, cursor) : undefined,
            ),
          )
          .where(
            and(
              eq(workspaces.organizationId, session.activeOrganizationId),
              ne(workspaces.status, DELETING_WORKSPACE_STATUS),
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
      items: page.items.map((row) => ({
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
      })),
    });
  },
);

export default listMyTimeEntries;
