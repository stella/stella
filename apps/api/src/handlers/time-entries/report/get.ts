import { Result } from "better-result";
import { and, eq, gte, isNull, lte, ne, or, sql } from "drizzle-orm";

import { BILLING_STATUS, TIME_ENTRY_ACTIVITY_GROUP } from "@stll/api-contract";
import {
  TIME_ENTRY_REPORT_INTERNAL_ROW_ID,
  TIME_ENTRY_REPORT_NO_CLIENT_ROW_ID,
  TIME_ENTRY_REPORT_QUERY_SCHEMA,
  type TimeEntryReport,
  type TimeEntryReportMetrics,
} from "@stll/api-contract/time-entry-report";
import { parsePlainDate } from "@stll/time";

import { member, user as authUser } from "@/api/db/auth-schema";
import { contacts, timeEntries, workspaces } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { canApproveTimeEntries } from "@/api/lib/billing/time-entry-authorization";
import { readBounded } from "@/api/lib/db/read-bounded";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { hasMemberPermission } from "@/api/lib/permission-authorization";

const MAX_REPORT_DAYS = 366;
const MAX_REPORT_BUCKETS = 20_000;
// Row ids are inlined as SQL literals: the grouped expression must read the
// same in SELECT and GROUP BY, which bound parameters would not.
const INTERNAL_ROW = sql.raw(`'${TIME_ENTRY_REPORT_INTERNAL_ROW_ID}'`);
const NO_CLIENT_ROW = sql.raw(`'${TIME_ENTRY_REPORT_NO_CLIENT_ROW_ID}'`);
const BUCKETS = {
  day: sql<string>`${timeEntries.dateWorked}::text`,
  week: sql<string>`(${timeEntries.dateWorked} - (extract(isodow from ${timeEntries.dateWorked})::int - 1))::text`,
  month: sql<string>`(${timeEntries.dateWorked} - (extract(day from ${timeEntries.dateWorked})::int - 1))::text`,
};
const memberId = sql<string>`coalesce(${timeEntries.userId}::text, 'unassigned')`;
const matterId = sql<string>`coalesce(${timeEntries.workspaceId}::text, ${INTERNAL_ROW})`;
// Internal work has no matter; a matter without a client is client work and
// keeps its own row.
const clientId = sql<string>`case when ${timeEntries.workspaceId} is null then ${INTERNAL_ROW} else coalesce(${workspaces.clientId}::text, ${NO_CLIENT_ROW}) end`;

const getTimeReport = createSafeRootHandler(
  {
    contract: "patch",
    description:
      "Report recorded time by member, matter or client and calendar bucket, with the preceding equal-length period. Reads time entries only. Monetary values are minor currency units and require rate read permission. Ranges contain at most 366 days; reduce the range if the aggregate exceeds 20000 buckets.",
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
    query: TIME_ENTRY_REPORT_QUERY_SCHEMA,
  },
  async function* ({ query, safeDb, user, memberRole, session }) {
    const from = parsePlainDate(query.from);
    const to = parsePlainDate(query.to);
    if (
      !from ||
      !to ||
      from.until(to).days < 0 ||
      from.until(to).days >= MAX_REPORT_DAYS
    ) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Report range must contain between 1 and 366 days",
        }),
      );
    }
    const previousFrom = from
      .subtract({ days: from.until(to).days + 1 })
      .toString();
    const showAmounts = hasMemberPermission(memberRole, { rate: ["read"] });
    const organizationId = session.activeOrganizationId;
    const data = yield* Result.await(
      safeDb(async (tx) => {
        // RLS applies the same matter visibility as the approval queue. Internal
        // work has no workspace; a missing client matter must never count as internal.
        const scope = and(
          eq(timeEntries.organizationId, organizationId),
          gte(timeEntries.dateWorked, previousFrom),
          lte(timeEntries.dateWorked, query.to),
          or(
            eq(timeEntries.activityGroup, TIME_ENTRY_ACTIVITY_GROUP.INTERNAL),
            and(
              eq(timeEntries.activityGroup, TIME_ENTRY_ACTIVITY_GROUP.CLIENT),
              ne(workspaces.status, "deleting"),
            ),
          ),
          // Team aggregates need approval access, as in the matter time
          // summary; anyone else reports on their own time only.
          canApproveTimeEntries(memberRole)
            ? undefined
            : eq(timeEntries.userId, user.id),
        );
        const liveMatter = and(
          eq(timeEntries.workspaceId, workspaces.id),
          eq(workspaces.organizationId, organizationId),
        );
        const current =
          sql<boolean>`${timeEntries.dateWorked} >= ${query.from}`.as(
            "current",
          );
        const billable = and(
          eq(timeEntries.billable, true),
          eq(timeEntries.noCharge, false),
        );
        const summaries = await tx
          .select({
            current,
            recordedMinutes: sql<number>`coalesce(sum(${timeEntries.durationMinutes}), 0)::float8`,
            billableMinutes: sql<number>`coalesce(sum(${timeEntries.durationMinutes}) filter (where ${billable}), 0)::float8`,
            pendingEntries: sql<number>`count(*) filter (where ${timeEntries.status} in (${BILLING_STATUS.DRAFT}, ${BILLING_STATUS.SUBMITTED}))::int`,
            activeMembers: sql<number>`count(distinct ${timeEntries.userId})::int`,
          })
          .from(timeEntries)
          .leftJoin(workspaces, liveMatter)
          .where(scope)
          .groupBy(current);
        const amounts = showAmounts
          ? await tx
              .select({
                current,
                currency: timeEntries.currency,
                value: sql<number>`sum(round(${timeEntries.billedMinutes}::numeric * ${timeEntries.rateAtEntry} / 60))::float8`,
              })
              .from(timeEntries)
              .leftJoin(workspaces, liveMatter)
              .where(
                and(
                  scope,
                  billable,
                  eq(timeEntries.status, BILLING_STATUS.APPROVED),
                  isNull(timeEntries.invoiceId),
                ),
              )
              .groupBy(current, timeEntries.currency)
          : [];
        const metrics = (isCurrent: boolean): TimeEntryReportMetrics => {
          const summary = summaries.find((row) => row.current === isCurrent);
          return {
            recordedMinutes: summary?.recordedMinutes ?? 0,
            billableMinutes: summary?.billableMinutes ?? 0,
            pendingEntries: summary?.pendingEntries ?? 0,
            activeMembers: summary?.activeMembers ?? 0,
            unbilledValues: showAmounts
              ? amounts
                  .filter((row) => row.current === isCurrent)
                  .map(({ currency, value }) => ({ currency, value }))
              : null,
          };
        };
        const bucket = BUCKETS[query.bucket];
        const groups = {
          member: {
            id: memberId,
            name: authUser.name,
            columns: [memberId, timeEntries.userId, authUser.name],
          },
          matter: {
            id: matterId,
            name: workspaces.name,
            columns: [matterId, timeEntries.workspaceId, workspaces.name],
          },
          client: {
            id: clientId,
            name: contacts.displayName,
            columns: [clientId, contacts.displayName],
          },
        };
        const group = groups[query.groupBy];
        const readRows = async (children: boolean, cap: number) =>
          readBounded(
            tx
              .select({
                rowId: children
                  ? sql<string>`${memberId} || ':' || ${matterId}`
                  : group.id,
                rowName: children ? workspaces.name : group.name,
                memberId:
                  query.groupBy === "member"
                    ? timeEntries.userId
                    : sql<null>`null`,
                matterId:
                  children || query.groupBy === "matter"
                    ? timeEntries.workspaceId
                    : sql<null>`null`,
                parentId: children ? memberId : sql<null>`null`,
                bucket,
                minutes: sql<number>`sum(${timeEntries.durationMinutes})::float8`,
              })
              .from(timeEntries)
              .leftJoin(workspaces, liveMatter)
              .leftJoin(
                contacts,
                and(
                  eq(contacts.id, workspaces.clientId),
                  eq(contacts.organizationId, organizationId),
                ),
              )
              .leftJoin(
                member,
                and(
                  eq(member.userId, timeEntries.userId),
                  eq(member.organizationId, organizationId),
                ),
              )
              .leftJoin(authUser, eq(authUser.id, member.userId))
              .where(and(scope, gte(timeEntries.dateWorked, query.from)))
              .groupBy(
                bucket,
                ...(children
                  ? [
                      memberId,
                      timeEntries.userId,
                      matterId,
                      timeEntries.workspaceId,
                      workspaces.name,
                    ]
                  : group.columns),
              )
              .orderBy(bucket, children ? memberId : group.id),
            cap,
          );
        const parents = await readRows(false, MAX_REPORT_BUCKETS);
        if (parents.type === "overflow") {
          return null;
        }
        // One response holds at most MAX_REPORT_BUCKETS rows: matter rows
        // under members read only the budget the member rows leave.
        const children =
          query.groupBy === "member"
            ? await readRows(true, MAX_REPORT_BUCKETS - parents.rows.length)
            : null;
        if (children?.type === "overflow") {
          return null;
        }
        return {
          rows:
            children === null
              ? parents.rows
              : [...parents.rows, ...children.rows],
          summary: { current: metrics(true), previous: metrics(false) },
        } satisfies TimeEntryReport;
      }),
    );
    if (!data) {
      return Result.err(
        new HandlerError({
          status: 422,
          message: "Report has too many buckets; select a shorter range",
        }),
      );
    }
    return Result.ok(data);
  },
);
export default getTimeReport;
