import { Result } from "better-result";
import { and, asc, gt } from "drizzle-orm";
import { t } from "elysia";

import { timeTimers } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { ownedTimers, timerItem } from "@/api/lib/billing/time-timers";
import { tPaginationCursor, tPaginationLimit } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";
import { normalizeTenantPageLimit } from "@/api/lib/rate-limit/action-size-limits";
import { brandPersistedTimeTimerId } from "@/api/lib/safe-id-boundaries";

const listMyTimeTimers = createSafeRootHandler(
  {
    description:
      "List your running and paused timers in the active organization. Use each returned timer ID to update, pause, resume, confirm or discard it. Follow nextCursor to read the next page.",
    permissions: { timeEntry: ["read"] },
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
  async function* ({ safeDb, session, user, query }) {
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
          .select()
          .from(timeTimers)
          .where(
            and(
              ownedTimers({
                organizationId: session.activeOrganizationId,
                userId: user.id,
              }),
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
    return Result.ok({ ...page, items: page.items.map(timerItem) });
  },
);
export default listMyTimeTimers;
