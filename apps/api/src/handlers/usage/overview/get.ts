import { Result } from "better-result";
import {
  and,
  count,
  desc,
  eq,
  gte,
  inArray,
  lt,
  max,
  sql,
  sum,
} from "drizzle-orm";

import { member, user } from "@/api/db/auth-schema";
import { USAGE_ACTION_TYPES, usageEvents } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

const OVERVIEW_DAYS = 30;
const TOP_USERS_LIMIT = 8;
const TOP_MODELS_LIMIT = 12;
const ACTIVE_USAGE_ACTION_TYPES = USAGE_ACTION_TYPES.filter(
  (actionType) => actionType !== "background",
);

const config = {
  description:
    "Read a bounded 30-day organization admin overview: active users, " +
    "AI-assisted activity, usage units, daily trend, model breakdown, top " +
    "users, and member count. Requires " +
    "organization-settings management access.",
  permissions: { organizationSettings: ["update"] },
  access: "read",
  mcp: { type: "capability", reason: "billing_admin" },
} satisfies HandlerConfig;

const getOverview = createSafeRootHandler(
  config,
  async function* ({ safeDb, session }) {
    const now = new Date();
    const from = new Date(now);
    from.setUTCDate(from.getUTCDate() - (OVERVIEW_DAYS - 1));
    from.setUTCHours(0, 0, 0, 0);

    const result = yield* Result.await(
      safeDb(async (tx) => {
        const eventWindow = and(
          eq(usageEvents.organizationId, session.activeOrganizationId),
          // oxlint-disable-next-line no-truncated-timestamp-comparison/no-truncated-timestamp-comparison -- clock-derived analytics window boundary, never round-tripped from persisted state
          gte(usageEvents.createdAt, from),
          lt(usageEvents.createdAt, now),
        );

        const summaryRows = await tx
          .select({
            actions: count(),
            units: sum(usageEvents.unitsConsumed).mapWith(Number),
            modelsUsed:
              sql<number>`count(distinct coalesce(${usageEvents.modelId}, ${usageEvents.modelRole}))`.mapWith(
                Number,
              ),
          })
          .from(usageEvents)
          .where(eventWindow);

        const day = sql<string>`to_char(${usageEvents.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;
        const daily = await tx
          .select({
            date: day,
            actions: count(),
          })
          .from(usageEvents)
          .where(eventWindow)
          .groupBy(day)
          .orderBy(day)
          .limit(OVERVIEW_DAYS);

        const modelUsage = await tx
          .select({
            modelId: usageEvents.modelId,
            modelRole: usageEvents.modelRole,
            isByok: usageEvents.isByok,
            actions: count(),
            units: sum(usageEvents.unitsConsumed).mapWith(Number),
          })
          .from(usageEvents)
          .where(eventWindow)
          .groupBy(
            usageEvents.modelId,
            usageEvents.modelRole,
            usageEvents.isByok,
          )
          .orderBy(desc(sum(usageEvents.unitsConsumed)), desc(count()))
          .limit(TOP_MODELS_LIMIT);

        const activeUserWindow = and(
          eventWindow,
          inArray(usageEvents.actionType, ACTIVE_USAGE_ACTION_TYPES),
        );
        const topUsers = await tx
          .select({
            userId: user.id,
            name: user.name,
            email: user.email,
            role: member.role,
            actions: count(),
            units: sum(usageEvents.unitsConsumed).mapWith(Number),
            models: sql<
              string[]
            >`coalesce(array_agg(distinct coalesce(${usageEvents.modelId}, ${usageEvents.modelRole}) order by coalesce(${usageEvents.modelId}, ${usageEvents.modelRole})), '{}')`,
            lastActiveAt: max(usageEvents.createdAt),
            activeUsers: sql<number>`count(*) over ()`.mapWith(Number),
          })
          .from(usageEvents)
          .innerJoin(
            member,
            and(
              eq(member.userId, usageEvents.userId),
              eq(member.organizationId, session.activeOrganizationId),
            ),
          )
          .innerJoin(user, eq(user.id, member.userId))
          .where(activeUserWindow)
          .groupBy(user.id, user.name, user.email, member.role)
          .orderBy(desc(sum(usageEvents.unitsConsumed)), user.id)
          .limit(TOP_USERS_LIMIT);

        const organizationRows = await tx
          .select({
            totalMembers: count(),
          })
          .from(member)
          .where(eq(member.organizationId, session.activeOrganizationId));

        const organization = organizationRows.at(0) ?? {
          totalMembers: 0,
        };
        const summary = summaryRows.at(0) ?? {
          actions: 0,
          units: 0,
          modelsUsed: 0,
        };

        return {
          period: {
            from: from.toISOString(),
            to: now.toISOString(),
            days: OVERVIEW_DAYS,
          },
          summary: {
            totalMembers: organization.totalMembers,
            activeUsers: topUsers.at(0)?.activeUsers ?? 0,
            actions: summary.actions,
            units: summary.units ?? 0,
            modelsUsed: summary.modelsUsed,
          },
          daily: daily.map((row) => ({
            date: row.date,
            actions: row.actions,
          })),
          modelUsage: modelUsage.map((row) => ({
            modelId: row.modelId,
            modelRole: row.modelRole,
            isByok: row.isByok,
            actions: row.actions,
            units: row.units ?? 0,
          })),
          topUsers: topUsers.map((row) => ({
            userId: row.userId,
            name: row.name,
            email: row.email,
            role: row.role,
            actions: row.actions,
            units: row.units ?? 0,
            models: row.models,
            lastActiveAt: row.lastActiveAt?.toISOString() ?? null,
          })),
        };
      }),
    );

    return Result.ok(result);
  },
);

export default getOverview;
