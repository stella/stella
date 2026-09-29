import { Result } from "better-result";
import { and, asc, eq, gt } from "drizzle-orm";
import { t } from "elysia";

import { isOrganizationManagementRole } from "@stll/permissions";

import { timeTimers } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { tPaginationCursor, tPaginationLimit } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";
import { brandPersistedTimeTimerId } from "@/api/lib/safe-id-boundaries";

const listRunningMemberTimers = createSafeRootHandler(
  {
    description:
      "List running timers in the active organization as an organization owner or admin. Use the timer ID with time-timers.admin.stop to end it into its owner's draft entry. Follow nextCursor to read the next page.",
    permissions: { timeEntry: ["approve"] },
    access: "read",
    mcp: { type: "capability", reason: "billing_admin" },
    query: t.Object({
      limit: t.Optional(tPaginationLimit(LIMITS.timeEntriesPageSizeMax)),
      cursor: t.Optional(tPaginationCursor()),
    }),
  },
  async function* ({ safeDb, session, memberRole, query }) {
    if (!isOrganizationManagementRole(memberRole.role)) {
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
    const limit = query.limit ?? LIMITS.timeEntriesPageSizeDefault;
    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: timeTimers.id,
            ownerId: timeTimers.userId,
            matterId: timeTimers.workspaceId,
            startedAt: timeTimers.startedAt,
            accumulatedSeconds: timeTimers.accumulatedSeconds,
            lastResumedAt: timeTimers.lastResumedAt,
          })
          .from(timeTimers)
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
      items: page.items.map((row) => ({
        id: row.id,
        ownerId: row.ownerId,
        matterId: row.matterId,
        accumulatedSeconds: row.accumulatedSeconds,
        startedAt: row.startedAt.toISOString(),
        lastResumedAt: row.lastResumedAt?.toISOString() ?? null,
      })),
    });
  },
);
export default listRunningMemberTimers;
