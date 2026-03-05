import { eq, inArray, sql } from "drizzle-orm";

import { db } from "@/api/db";
import { user } from "@/api/db/auth-schema";
import { entities } from "@/api/db/schema";
// biome-ignore lint/style/noRestrictedImports: brands DB-returned workspace PKs for map lookups
import { toSafeId, type SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";

type ReadWorkspacesHandlerProps = {
  organizationId: SafeId<"organization">;
};

export const readWorkspacesHandler = async ({
  organizationId,
}: ReadWorkspacesHandlerProps) => {
  const result = await db.query.workspaces.findMany({
    where: {
      organizationId: { eq: organizationId },
      status: "active",
    },
    columns: {
      id: true,
      name: true,
      reference: true,
      clientId: true,
      color: true,
      status: true,
      lastActivityAt: true,
      createdAt: true,
    },
    with: {
      client: {
        columns: {
          id: true,
          displayName: true,
        },
      },
    },
    orderBy: {
      lastActivityAt: "desc",
    },
    limit: LIMITS.workspacesCount,
  });

  const workspaceIds = result.map((w) => toSafeId<"workspace">(w.id));

  const [counts, contributorRows] =
    workspaceIds.length > 0
      ? await Promise.all([
          db
            .select({
              workspaceId: entities.workspaceId,
              count: sql<number>`count(*)::int`,
            })
            .from(entities)
            .where(inArray(entities.workspaceId, workspaceIds))
            .groupBy(entities.workspaceId),
          db
            .select({
              workspaceId: entities.workspaceId,
              userId: entities.createdBy,
              userName: user.name,
              userImage: user.image,
              lastActivity: sql<string>`max(${entities.updatedAt})`,
            })
            .from(entities)
            .innerJoin(user, eq(entities.createdBy, user.id))
            .where(inArray(entities.workspaceId, workspaceIds))
            .groupBy(
              entities.workspaceId,
              entities.createdBy,
              user.name,
              user.image,
            )
            .orderBy(
              entities.workspaceId,
              sql`max(${entities.updatedAt}) desc`,
            ),
        ])
      : [[], []];

  const countMap = new Map(counts.map((c) => [c.workspaceId, c.count]));

  const contributorMap = new Map<SafeId<"workspace">, typeof contributorRows>();
  for (const row of contributorRows) {
    const list = contributorMap.get(row.workspaceId);
    if (list) {
      if (list.length < LIMITS.workspaceContributors) {
        list.push(row);
      }
    } else {
      contributorMap.set(row.workspaceId, [row]);
    }
  }

  const workspaces = result.map((w) => {
    const wsId = toSafeId<"workspace">(w.id);
    return {
      ...w,
      entityCount: countMap.get(wsId) ?? 0,
      contributors: contributorMap.get(wsId) ?? [],
    };
  });

  return { workspaces, workspacesCountLimit: LIMITS.workspacesCount };
};
