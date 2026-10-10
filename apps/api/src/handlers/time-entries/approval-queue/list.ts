import { Result } from "better-result";
import { and, asc, eq, gt, gte, isNull, lte, ne, or } from "drizzle-orm";
import { t } from "elysia";

import { TIME_ENTRY_ACTIVITY_GROUP } from "@stll/api-contract";
import { parsePlainDate } from "@stll/time";

import { BILLING_STATUS, timeEntries, workspaces } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { canApproveTimeEntries } from "@/api/lib/billing/time-entry-authorization";
import {
  tPaginationCursor,
  tPaginationLimit,
  tSafeId,
  tUserId,
} from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isUuidPaginationCursorPart,
  isDateOnlyPaginationCursorPart,
} from "@/api/lib/pagination";
import type {
  UnprojectedColumns,
  UnbackedProjectionKeys,
} from "@/api/lib/projection-totality";
import { normalizeTenantPageLimit } from "@/api/lib/rate-limit/action-size-limits";
import {
  brandPersistedTimeEntryId,
  brandPersistedUserId,
} from "@/api/lib/safe-id-boundaries";
import { validateOrgUserId } from "@/api/lib/validated-org-user-id";

const queueColumns = {
  id: timeEntries.id,
  activityGroup: timeEntries.activityGroup,
  workspaceId: timeEntries.workspaceId,
  userId: timeEntries.userId,
  dateWorked: timeEntries.dateWorked,
  timezoneId: timeEntries.timezoneId,
  durationMinutes: timeEntries.durationMinutes,
  billedMinutes: timeEntries.billedMinutes,
  narrative: timeEntries.narrative,
  billable: timeEntries.billable,
  status: timeEntries.status,
  approverUserId: timeEntries.approverUserId,
  approvedByUserId: timeEntries.approvedByUserId,
  approvedAt: timeEntries.approvedAt,
  returnedAt: timeEntries.returnedAt,
  returnedByUserId: timeEntries.returnedByUserId,
  returnComment: timeEntries.returnComment,
};
// The queue omits pricing, source bookkeeping, and timer internals.
const QUEUE_OMITTED_COLUMNS = [
  "organizationId",
  "workItemId",
  "rateAtEntry",
  "currency",
  "narrativeLanguage",
  "invoiceNarrative",
  "noCharge",
  "source",
  "taskCode",
  "activityCode",
  "invoiceId",
  "invoiceAttachment",
  "splitGroupId",
  "timerStartedAt",
  "timerStoppedAt",
  "createdAt",
  "updatedAt",
] as const satisfies readonly (keyof typeof timeEntries.$inferSelect)[];
type MissingQueueColumn = UnprojectedColumns<
  typeof timeEntries.$inferSelect,
  typeof queueColumns,
  (typeof QUEUE_OMITTED_COLUMNS)[number]
>;
type ExtraQueueColumn = UnbackedProjectionKeys<
  typeof timeEntries.$inferSelect,
  typeof queueColumns,
  (typeof QUEUE_OMITTED_COLUMNS)[number]
>;
true satisfies MissingQueueColumn extends never ? true : never;
true satisfies ExtraQueueColumn extends never ? true : never;

const listApprovalQueue = createSafeRootHandler(
  {
    description:
      "List draft time entries awaiting the signed-in user's approval, including internal work and accessible client matters. Owners/admins also see drafts without an assigned approver. Optionally filter work dates (from/to, YYYY-MM-DD), timekeeper (member), and matter. Returns logged durationMinutes separately from adjusted billedMinutes and the last return comment. Follow nextCursor for the next bounded page.",
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
    query: t.Object({
      from: t.Optional(t.String({ format: "date" })),
      to: t.Optional(t.String({ format: "date" })),
      member: t.Optional(tUserId),
      matter: t.Optional(tSafeId("workspace")),
      cursor: t.Optional(tPaginationCursor()),
      limit: t.Optional(tPaginationLimit(LIMITS.timeEntriesPageSizeMax)),
    }),
  },
  async function* ({ query, safeDb, user, memberRole, session }) {
    if (
      (query.from && !parsePlainDate(query.from)) ||
      (query.to && !parsePlainDate(query.to)) ||
      (query.from && query.to && query.from > query.to)
    ) {
      return Result.err(
        new HandlerError({
          status: 400,
          code: "invalid_date_range",
          message: "Use valid dates with from no later than to",
          hint: "Supply dates in YYYY-MM-DD format.",
        }),
      );
    }
    const parts = query.cursor ? decodePaginationCursor(query.cursor) : null;
    const cursorDate = parts?.at(0);
    const cursorId = parts?.at(1);
    if (
      query.cursor &&
      (!isDateOnlyPaginationCursorPart(cursorDate) ||
        !isUuidPaginationCursorPart(cursorId))
    ) {
      return Result.err(
        new HandlerError({
          status: 400,
          code: "invalid_cursor",
          message: "Invalid approval queue cursor",
          hint: "Restart the list without a cursor.",
        }),
      );
    }
    const cursor =
      isDateOnlyPaginationCursorPart(cursorDate) &&
      isUuidPaginationCursorPart(cursorId)
        ? { dateWorked: cursorDate, id: brandPersistedTimeEntryId(cursorId) }
        : null;
    const memberId = query.member ? brandPersistedUserId(query.member) : null;
    const validatedMember = memberId
      ? yield* Result.await(
          safeDb(
            async (tx) =>
              await validateOrgUserId(
                tx,
                memberId,
                session.activeOrganizationId,
              ),
          ),
        )
      : null;
    if (memberId && !validatedMember) {
      return Result.err(
        new HandlerError({
          status: 404,
          code: "not_found",
          message: "Member not found",
          hint: "Use a member of the active organization.",
        }),
      );
    }
    const limit = normalizeTenantPageLimit(
      query.limit ?? LIMITS.timeEntriesPageSizeDefault,
    );
    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select(queueColumns)
          .from(timeEntries)
          .leftJoin(
            workspaces,
            and(
              eq(timeEntries.workspaceId, workspaces.id),
              eq(workspaces.organizationId, session.activeOrganizationId),
            ),
          )
          .where(
            and(
              eq(timeEntries.organizationId, session.activeOrganizationId),
              eq(timeEntries.status, BILLING_STATUS.DRAFT),
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
                  ne(workspaces.status, "deleting"),
                ),
              ),
              canApproveTimeEntries(memberRole)
                ? or(
                    eq(timeEntries.approverUserId, user.id),
                    isNull(timeEntries.approverUserId),
                  )
                : eq(timeEntries.approverUserId, user.id),
              query.from ? gte(timeEntries.dateWorked, query.from) : undefined,
              query.to ? lte(timeEntries.dateWorked, query.to) : undefined,
              validatedMember
                ? eq(timeEntries.userId, validatedMember)
                : undefined,
              query.matter
                ? eq(timeEntries.workspaceId, query.matter)
                : undefined,
              cursor
                ? or(
                    gt(timeEntries.dateWorked, cursor.dateWorked),
                    and(
                      eq(timeEntries.dateWorked, cursor.dateWorked),
                      gt(timeEntries.id, cursor.id),
                    ),
                  )
                : undefined,
            ),
          )
          .orderBy(asc(timeEntries.dateWorked), asc(timeEntries.id))
          .limit(limit + 1),
      ),
    );
    const page = createCursorPage({
      rows,
      limit,
      cursorForItem: ({ dateWorked, id }) =>
        encodePaginationCursor([dateWorked, id]),
    });
    return Result.ok({
      ...page,
      items: page.items.map(({ approvedAt, returnedAt, ...entry }) =>
        Object.assign(entry, {
          approvedAt: approvedAt?.toISOString() ?? null,
          returnedAt: returnedAt?.toISOString() ?? null,
        }),
      ),
    });
  },
);
export default listApprovalQueue;
