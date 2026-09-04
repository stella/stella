import { Result } from "better-result";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { t } from "elysia";

import type { TimeEntrySummary } from "@stll/api-contract/time-entry-types";

import { member, user } from "@/api/db/auth-schema";
import { timeEntries, workspaceMembers } from "@/api/db/schema";
import { canApproveTimeEntries } from "@/api/handlers/time-entries/authorization";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { addDays, parseIsoDateLocal } from "@stll/time";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

const MAX_SUMMARY_DAYS = 31;
const MAX_TEAM_SUMMARY_ROWS = LIMITS.workspaceMembersCount * MAX_SUMMARY_DAYS;

const okTimeEntrySummary = (summary: TimeEntrySummary) => Result.ok(summary);

const timeEntrySummaryQuerySchema = t.Object({
  dateFrom: t.String({ format: "date" }),
  dateTo: t.String({ format: "date" }),
  scope: t.Optional(
    t.Literal("team", {
      description:
        "Include a bounded per-member daily summary; requires time-entry approval access",
    }),
  ),
});

const readTimeEntrySummary = createSafeHandler(
  {
    description:
      "Summarize time in the current matter for a bounded date range; team scope requires time-entry approval access.",
    permissions: { timeEntry: ["read"] },
    mcp: { type: "capability", reason: "billing_admin" },
    access: "read",
    query: timeEntrySummaryQuerySchema,
  },
  async function* ({
    memberRole,
    query,
    safeDb,
    session,
    user: currentUser,
    workspaceId,
  }) {
    const from = parseIsoDateLocal(query.dateFrom);
    const to = parseIsoDateLocal(query.dateTo);

    if (!from || !to || to < from || to > addDays(from, MAX_SUMMARY_DAYS - 1)) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: `Summary range must contain between 1 and ${MAX_SUMMARY_DAYS} days`,
        }),
      );
    }

    if (query.scope === "team" && !canApproveTimeEntries(memberRole)) {
      return Result.err(
        new HandlerError({ status: 403, message: "Forbidden" }),
      );
    }

    if (query.scope === "team") {
      // Keep the viewer's aggregate independent from workspace_members. Firm
      // admins and owners can have workspace access through organization
      // permissions without a row in this matter's member list.
      const [viewerSummary] = yield* Result.await(
        safeDb((tx) =>
          tx
            .select({
              totalTeamMinutes: sql<number>`coalesce(sum(${timeEntries.durationMinutes}), 0)::int`,
              viewerTotalMinutes: sql<number>`coalesce(sum(${timeEntries.durationMinutes}) filter (where ${timeEntries.userId} = ${currentUser.id}), 0)::int`,
            })
            .from(timeEntries)
            .where(
              and(
                eq(timeEntries.workspaceId, workspaceId),
                gte(timeEntries.dateWorked, query.dateFrom),
                lte(timeEntries.dateWorked, query.dateTo),
              ),
            ),
        ),
      );

      const rows = yield* Result.await(
        safeDb((tx) =>
          tx
            .select({
              userId: workspaceMembers.userId,
              name: user.name,
              email: user.email,
              image: user.image,
              dateWorked: timeEntries.dateWorked,
              totalMinutes: sql<number>`coalesce(sum(${timeEntries.durationMinutes}), 0)::int`,
            })
            .from(workspaceMembers)
            .innerJoin(
              member,
              and(
                eq(member.userId, workspaceMembers.userId),
                eq(member.organizationId, session.activeOrganizationId),
              ),
            )
            .innerJoin(user, eq(user.id, member.userId))
            .leftJoin(
              timeEntries,
              and(
                eq(timeEntries.workspaceId, workspaceId),
                eq(timeEntries.userId, workspaceMembers.userId),
                gte(timeEntries.dateWorked, query.dateFrom),
                lte(timeEntries.dateWorked, query.dateTo),
              ),
            )
            .where(eq(workspaceMembers.workspaceId, workspaceId))
            .groupBy(
              workspaceMembers.userId,
              user.name,
              user.email,
              user.image,
              timeEntries.dateWorked,
            )
            .orderBy(user.name, workspaceMembers.userId, timeEntries.dateWorked)
            .limit(MAX_TEAM_SUMMARY_ROWS),
        ),
      );

      const membersById = new Map<
        string,
        {
          userId: string;
          name: string;
          email: string;
          image: string | null;
          daily: { dateWorked: string; totalMinutes: number }[];
        }
      >();
      for (const row of rows) {
        const teamMember = membersById.get(row.userId) ?? {
          userId: row.userId,
          name: row.name,
          email: row.email,
          image: row.image,
          daily: [],
        };
        if (row.dateWorked !== null) {
          teamMember.daily.push({
            dateWorked: row.dateWorked,
            totalMinutes: row.totalMinutes,
          });
        }
        membersById.set(row.userId, teamMember);
      }

      return okTimeEntrySummary({
        scope: "team",
        totalTeamMinutes: viewerSummary?.totalTeamMinutes ?? 0,
        viewerTotalMinutes: viewerSummary?.viewerTotalMinutes ?? 0,
        members: [...membersById.values()],
      });
    }

    const [summary] = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            entryCount: sql<number>`count(*)::int`,
            totalMinutes: sql<number>`coalesce(sum(${timeEntries.durationMinutes}), 0)::int`,
            billedMinutes: sql<number>`coalesce(sum(${timeEntries.billedMinutes}), 0)::int`,
          })
          .from(timeEntries)
          .where(
            and(
              eq(timeEntries.workspaceId, workspaceId),
              eq(timeEntries.userId, currentUser.id),
              gte(timeEntries.dateWorked, query.dateFrom),
              lte(timeEntries.dateWorked, query.dateTo),
            ),
          ),
      ),
    );

    return okTimeEntrySummary({
      scope: "personal",
      ...(summary ?? { entryCount: 0, totalMinutes: 0, billedMinutes: 0 }),
    });
  },
);

export default readTimeEntrySummary;
