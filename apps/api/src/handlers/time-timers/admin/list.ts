import { Result } from "better-result";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { t } from "elysia";

import { timeTimers, workspaces } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { tPaginationCursor, tPaginationLimit } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";
import { hasManagementPermission } from "@/api/lib/permission-authorization";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";
import { normalizeTenantPageLimit } from "@/api/lib/rate-limit/action-size-limits";
import { brandPersistedTimeTimerId } from "@/api/lib/safe-id-boundaries";

const ADMIN_TIMER_COLUMNS = {
  id: timeTimers.id,
  ownerId: timeTimers.userId,
  matterId: workspaces.id,
  startedAt: timeTimers.startedAt,
  accumulatedSeconds: timeTimers.accumulatedSeconds,
  lastResumedAt: timeTimers.lastResumedAt,
};
type TimerRow = typeof timeTimers.$inferSelect;
type AdminTimerProjectionSource = Omit<TimerRow, "userId" | "workspaceId"> & {
  ownerId: TimerRow["userId"];
  matterId: TimerRow["workspaceId"];
};
type AdminTimerItemSource = Pick<
  AdminTimerProjectionSource,
  keyof typeof ADMIN_TIMER_COLUMNS
>;
const adminTimerItem = (row: AdminTimerItemSource) => ({
  id: row.id,
  ownerId: row.ownerId,
  matterId: row.matterId,
  accumulatedSeconds: row.accumulatedSeconds,
  startedAt: row.startedAt.toISOString(),
  lastResumedAt: row.lastResumedAt?.toISOString() ?? null,
});
const UNPROJECTED_ADMIN_TIMER_COLUMNS = [
  // The active organization already scopes every row.
  "organizationId",
  // Listing running clocks needs no owner narrative.
  "description",
  // Migration linkage remains internal to completion.
  "legacyTimeEntryId",
  // This endpoint returns only running timers.
  "state",
  // Elapsed-time fields describe the clock; persistence timestamps add no action.
  "createdAt",
  "updatedAt",
] as const satisfies readonly (keyof AdminTimerProjectionSource)[];
type MissingAdminTimerColumn = UnprojectedColumns<
  AdminTimerProjectionSource,
  ReturnType<typeof adminTimerItem>,
  (typeof UNPROJECTED_ADMIN_TIMER_COLUMNS)[number]
>;
type UnexpectedAdminTimerColumn = UnbackedProjectionKeys<
  AdminTimerProjectionSource,
  ReturnType<typeof adminTimerItem>,
  (typeof UNPROJECTED_ADMIN_TIMER_COLUMNS)[number]
>;
true satisfies MissingAdminTimerColumn extends never ? true : never;
true satisfies UnexpectedAdminTimerColumn extends never ? true : never;

const listRunningMemberTimers = createSafeRootHandler(
  {
    description:
      "List running timers in the active organization as an organization owner or admin. Use the timer ID with time-timers.admin.stop to end it into its owner's draft entry. Follow nextCursor to read the next page.",
    permissions: { timeEntry: ["approve"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    featureAccess: { featureId: "time-billing", type: "required" },
    access: "read",
    mcp: {
      type: "capability",
      readClass: "tenant",
      reason: "billing_admin",
      consumesServices: false,
    },
    query: t.Object({
      limit: t.Optional(tPaginationLimit(LIMITS.timeEntriesPageSizeMax)),
      cursor: t.Optional(tPaginationCursor()),
    }),
  },
  async function* ({ safeDb, session, user, memberRole, query }) {
    if (!hasManagementPermission(memberRole, { timeEntry: ["approve"] })) {
      return Result.err(
        new HandlerError({
          status: 403,
          code: "timer_admin_required",
          message:
            "Only organization owners and admins can list members' running timers",
          hint: "List your own timers instead.",
        }),
      );
    }
    const cursor = query.cursor
      ? decodePaginationCursor(query.cursor)?.at(0)
      : undefined;
    if (query.cursor && !isUuidPaginationCursorPart(cursor)) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Invalid cursor",
          hint: "List timers again without a cursor.",
        }),
      );
    }
    const limit = normalizeTenantPageLimit(
      query.limit ?? LIMITS.timeEntriesPageSizeDefault,
    );
    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select(ADMIN_TIMER_COLUMNS)
          .from(timeTimers)
          .leftJoin(
            workspaces,
            and(
              eq(workspaces.id, timeTimers.workspaceId),
              eq(workspaces.organizationId, session.activeOrganizationId),
              eq(workspaces.status, "active"),
              sql`CASE WHEN ${workspaces.clientId} IS NOT NULL THEN true
                ELSE EXISTS (
                  SELECT 1 FROM workspace_members AS workspace_member
                  WHERE workspace_member.workspace_id = ${workspaces.id}
                    AND workspace_member.user_id = ${user.id}
                ) END`,
            ),
          )
          .where(
            and(
              eq(timeTimers.organizationId, session.activeOrganizationId),
              eq(timeTimers.state, "running"),
              isUuidPaginationCursorPart(cursor)
                ? gt(timeTimers.id, brandPersistedTimeTimerId(cursor))
                : undefined,
            ),
          )
          .orderBy(asc(timeTimers.id))
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
      items: page.items.map(adminTimerItem),
    });
  },
);
export default listRunningMemberTimers;
