import { Result } from "better-result";
import { and, asc, eq, gt, gte, isNull, lte, ne, or } from "drizzle-orm";
import * as v from "valibot";

import { TIME_ENTRY_ACTIVITY_GROUP } from "@stll/api-contract";
import { apiDateSchema } from "@stll/api-contract/api-date";
import { numberFromString } from "@stll/api-contract/http-input";
import { BILLING_READ_PERMISSION } from "@stll/permissions";
import { parsePlainDate } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import { BILLING_STATUS, timeEntries, workspaces } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { timeEntryPageMoneyResponse } from "@/api/lib/billing/response-schemas";
import { canApproveTimeEntries } from "@/api/lib/billing/time-entry-authorization";
import {
  selectTimekeeperNames,
  timekeeperIdsOf,
} from "@/api/lib/billing/timekeeper-names";
import type { SafeId } from "@/api/lib/branded-types";
import {
  paginationCursorSchema,
  paginationLimitSchema,
  resourceIdSchema,
  userIdSchema,
} from "@/api/lib/custom-schema";
import { readBounded } from "@/api/lib/db/read-bounded";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isDateOnlyPaginationCursorPart,
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";
import { hasMemberPermission } from "@/api/lib/permission-authorization";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";
import { normalizeTenantPageLimit } from "@/api/lib/rate-limit/action-size-limits";
import {
  brandPersistedTimeEntryId,
  brandPersistedUserId,
} from "@/api/lib/safe-id-boundaries";
import {
  type ValidatedOrgUserId,
  validateOrgUserId,
} from "@/api/lib/validated-org-user-id";

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
  noCharge: timeEntries.noCharge,
  rateAtEntry: timeEntries.rateAtEntry,
  currency: timeEntries.currency,
  status: timeEntries.status,
  approverUserId: timeEntries.approverUserId,
  approvedByUserId: timeEntries.approvedByUserId,
  approvedAt: timeEntries.approvedAt,
  returnedAt: timeEntries.returnedAt,
  returnedByUserId: timeEntries.returnedByUserId,
  returnComment: timeEntries.returnComment,
};
// The queue omits source bookkeeping and timer internals.
const QUEUE_OMITTED_COLUMNS = [
  "organizationId",
  "workItemId",
  "narrativeLanguage",
  "invoiceNarrative",
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

type QueueScopeOptions = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  memberRole: AuthorizedMemberRole;
  from: string | undefined;
  to: string | undefined;
  member: ValidatedOrgUserId | null;
  matter: SafeId<"workspace"> | undefined;
};

/**
 * The entries waiting for this approver: submitted only, in a live matter or
 * internal, assigned to them (owners/admins also see unassigned ones), within
 * the optional filters. The page and its count share it.
 */
const queueScope = ({
  organizationId,
  userId,
  memberRole,
  from,
  to,
  member,
  matter,
}: QueueScopeOptions) =>
  and(
    eq(timeEntries.organizationId, organizationId),
    eq(timeEntries.status, BILLING_STATUS.SUBMITTED),
    or(
      eq(timeEntries.activityGroup, TIME_ENTRY_ACTIVITY_GROUP.INTERNAL),
      and(
        eq(timeEntries.activityGroup, TIME_ENTRY_ACTIVITY_GROUP.CLIENT),
        ne(workspaces.status, "deleting"),
      ),
    ),
    canApproveTimeEntries(memberRole)
      ? or(
          eq(timeEntries.approverUserId, userId),
          isNull(timeEntries.approverUserId),
        )
      : eq(timeEntries.approverUserId, userId),
    from ? gte(timeEntries.dateWorked, from) : undefined,
    to ? lte(timeEntries.dateWorked, to) : undefined,
    member ? eq(timeEntries.userId, member) : undefined,
    matter ? eq(timeEntries.workspaceId, matter) : undefined,
  );

type QueuePageOptions = {
  scope: ReturnType<typeof queueScope>;
  organizationId: SafeId<"organization">;
  cursor: { dateWorked: string; id: SafeId<"timeEntry"> } | null;
  limit: number;
};

const readQueuePage = async (
  tx: Transaction,
  { scope, organizationId, cursor, limit }: QueuePageOptions,
) => {
  const liveMatter = and(
    eq(timeEntries.workspaceId, workspaces.id),
    eq(workspaces.organizationId, organizationId),
  );
  const rows = await tx
    .select({ ...queueColumns, matterName: workspaces.name })
    .from(timeEntries)
    .leftJoin(workspaces, liveMatter)
    .where(
      and(
        scope,
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
    .limit(limit + 1);
  // Counted up to a ceiling, so a long backlog costs a bounded scan.
  const pending = await readBounded(
    tx
      .select({ id: timeEntries.id })
      .from(timeEntries)
      .leftJoin(workspaces, liveMatter)
      .where(scope),
    LIMITS.timeApprovalPendingCountMax,
  );
  const pendingCount =
    pending.type === "overflow" ? pending.cap : pending.rows.length;
  const page = createCursorPage({
    rows,
    limit,
    cursorForItem: ({ dateWorked, id }) =>
      encodePaginationCursor([dateWorked, id]),
  });
  const userIds = timekeeperIdsOf(page.items);
  const names =
    userIds.size > 0
      ? await selectTimekeeperNames(tx, { organizationId, userIds })
      : [];
  const nameById = new Map(names.map(({ id, name }) => [id, name]));
  return {
    ...page,
    pendingCount,
    items: page.items.map(({ approvedAt, returnedAt, ...entry }) =>
      Object.assign(entry, {
        timekeeperName:
          entry.userId === null ? null : (nameById.get(entry.userId) ?? null),
        approvedAt: approvedAt?.toISOString() ?? null,
        returnedAt: returnedAt?.toISOString() ?? null,
      }),
    ),
  };
};

const listApprovalQueue = createSafeRootHandler(
  {
    moneyResponse: timeEntryPageMoneyResponse,
    contract: "patch",
    description:
      "List submitted time entries awaiting the signed-in user's approval, including internal work and accessible client matters; drafts a timekeeper has not submitted never appear. Owners/admins also see entries without an assigned approver. Optionally filter work dates (from/to, YYYY-MM-DD), timekeeper (member), and matter. Each item carries the timekeeper's and matter's names, logged durationMinutes separately from adjusted billedMinutes, the rate, and the last return comment. pendingCount counts the matching entries up to 1000. Follow nextCursor for the next bounded page.",
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
      from: v.optional(apiDateSchema),
      to: v.optional(apiDateSchema),
      member: v.optional(userIdSchema),
      matter: v.optional(resourceIdSchema("workspace")),
      cursor: v.optional(paginationCursorSchema()),
      limit: v.optional(
        numberFromString(paginationLimitSchema(LIMITS.timeEntriesPageSizeMax)),
      ),
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
    const queue = yield* Result.await(
      safeDb(
        async (tx) =>
          await readQueuePage(tx, {
            scope: queueScope({
              organizationId: session.activeOrganizationId,
              userId: user.id,
              memberRole,
              from: query.from,
              to: query.to,
              member: validatedMember,
              matter: query.matter,
            }),
            organizationId: session.activeOrganizationId,
            cursor,
            limit,
          }),
      ),
    );
    return Result.ok({
      ...queue,
      items: queue.items.map((item) => ({
        ...item,
        rateAtEntry: hasMemberPermission(memberRole, BILLING_READ_PERMISSION)
          ? item.rateAtEntry
          : null,
      })),
    });
  },
);
export default listApprovalQueue;
