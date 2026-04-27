import { and, eq, gte, lte, sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db";
import { member, user } from "@/api/db/auth-schema";
import { timeEntries } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

import type { DateRangeQuery } from "./date-range-schema";

type HoursByUserHandlerProps = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  query: DateRangeQuery;
};

export const hoursByUserHandler = async ({
  scopedDb,
  workspaceId,
  organizationId,
  query,
}: HoursByUserHandlerProps) => {
  const conditions = [eq(timeEntries.workspaceId, workspaceId)];
  if (query.dateFrom) {
    conditions.push(gte(timeEntries.dateWorked, query.dateFrom));
  }
  if (query.dateTo) {
    conditions.push(lte(timeEntries.dateWorked, query.dateTo));
  }

  return await scopedDb((tx) => {
    const organizationMembers = tx
      .select({ userId: member.userId })
      .from(member)
      .where(eq(member.organizationId, organizationId))
      .groupBy(member.userId)
      .as("organization_members");

    return tx
      .select({
        userId: timeEntries.userId,
        userName: sql<string>`coalesce(${user.name}, 'Unknown')`,
        userImage: user.image,
        totalMinutes: sql<number>`coalesce(sum(${timeEntries.durationMinutes}), 0)::int`,
        count: sql<number>`count(*)::int`,
      })
      .from(timeEntries)
      .leftJoin(
        organizationMembers,
        eq(timeEntries.userId, organizationMembers.userId),
      )
      .leftJoin(user, eq(organizationMembers.userId, user.id))
      .where(and(...conditions))
      .groupBy(timeEntries.userId, user.name, user.image)
      .orderBy(sql`sum(${timeEntries.durationMinutes}) desc`)
      .limit(100);
  });
};
