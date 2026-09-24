import { and, asc, eq, gt, ilike, inArray, or, sql } from "drizzle-orm";

import { user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { auditLogs } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { escapeLike } from "@/api/lib/escape-like";

import { visibleActivityCondition } from "./read-overview-activity.visibility";

// Actor identities for a matter's activity feed.
//
// Every actor id read here comes from audit rows already scoped to the
// authorized organization and workspace, and the feed keeps attributing work
// to an actor after their membership ends. A membership join would erase that
// attribution, so this module is listed in the user-query lint rule's
// `allowedFiles` instead. Keep it to identity reads keyed by audit actor ids.

const historicalActorId = () =>
  sql<string>`coalesce(${auditLogs.performerId}, ${auditLogs.userId})`;

type ReadOverviewActivityActorRowsOptions = {
  afterActorId: string | null;
  limit: number;
  organizationId: SafeId<"organization">;
  safeDb: SafeDb;
  search: string;
  workspaceId: SafeId<"workspace">;
};

export const readOverviewActivityActorRows = async ({
  afterActorId,
  limit,
  organizationId,
  safeDb,
  search,
  workspaceId,
}: ReadOverviewActivityActorRowsOptions) =>
  await safeDb(async (tx) => {
    const actorId = historicalActorId();
    const conditions = [
      eq(auditLogs.organizationId, organizationId),
      eq(auditLogs.workspaceId, workspaceId),
      eq(auditLogs.performerType, "user"),
      visibleActivityCondition(),
    ];
    if (afterActorId !== null) {
      conditions.push(gt(actorId, afterActorId));
    }
    const historicalActors = tx
      .selectDistinct({ id: actorId.as("actor_id") })
      .from(auditLogs)
      .where(and(...conditions))
      .as("historical_activity_actors");
    const identityCondition =
      search === ""
        ? sql`true`
        : (or(
            ilike(user.name, `%${escapeLike(search)}%`),
            ilike(user.email, `%${escapeLike(search)}%`),
          ) ?? sql`false`);

    return await tx
      .selectDistinct({
        deletedAt: user.deletedAt,
        email: user.email,
        id: historicalActors.id,
        image: user.image,
        name: user.name,
      })
      .from(historicalActors)
      // The actor ID comes from an organization-and-workspace-scoped audit
      // row, so attribution remains authorized after membership ends.
      .leftJoin(user, eq(user.id, historicalActors.id))
      .where(identityCondition)
      .orderBy(asc(historicalActors.id))
      .limit(limit + 1);
  });

/** Names, emails and avatars for the actor ids of one activity page. */
export const readActivityActorIdentities = async (
  tx: Transaction,
  actorIds: readonly string[],
) =>
  actorIds.length === 0
    ? []
    : await tx
        .selectDistinct({
          deletedAt: user.deletedAt,
          email: user.email,
          id: user.id,
          image: user.image,
          name: user.name,
        })
        .from(user)
        .where(inArray(user.id, [...actorIds]));
