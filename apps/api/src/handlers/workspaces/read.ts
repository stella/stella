import { eq, inArray, sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db";
import { user } from "@/api/db/auth-schema";
import { entities } from "@/api/db/schema";
// oxlint-disable-next-line no-restricted-imports: brands DB-returned workspace PKs for map lookups
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";

type ReadWorkspacesHandlerProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
};

export const readWorkspacesHandler = async ({
  scopedDb,
  organizationId,
}: ReadWorkspacesHandlerProps) => {
  const { result, counts, contributorRows } = await scopedDb(async (tx) => {
    const workspaceRows = await tx.query.workspaces.findMany({
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

    const wsIds = workspaceRows.map((w) => toSafeId<"workspace">(w.id));

    if (wsIds.length === 0) {
      return {
        result: workspaceRows,
        counts: [] as { workspaceId: string; count: number }[],
        contributorRows: [] as {
          workspaceId: string;
          userId: string | null;
          userName: string | null;
          userImage: string | null;
          lastActivity: string;
        }[],
      };
    }

    const [entityCounts, contributors] = await Promise.all([
      tx
        .select({
          workspaceId: entities.workspaceId,
          count: sql<number>`count(*)::int`,
        })
        .from(entities)
        .where(inArray(entities.workspaceId, wsIds))
        .groupBy(entities.workspaceId),
      tx
        .select({
          workspaceId: entities.workspaceId,
          userId: entities.createdBy,
          userName: user.name,
          userImage: user.image,
          lastActivity: sql<string>`max(${entities.updatedAt})`,
        })
        .from(entities)
        .innerJoin(user, eq(entities.createdBy, user.id))
        .where(inArray(entities.workspaceId, wsIds))
        .groupBy(
          entities.workspaceId,
          entities.createdBy,
          user.name,
          user.image,
        )
        .orderBy(entities.workspaceId, sql`max(${entities.updatedAt}) desc`),
    ]);

    return {
      result: workspaceRows,
      counts: entityCounts,
      contributorRows: contributors,
    };
  });

  const countMap = new Map(counts.map((c) => [c.workspaceId, c.count]));

  const contributorMap = new Map<string, typeof contributorRows>();
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

  const workspaces = result.map((w) => ({
    ...w,
    entityCount: countMap.get(w.id) ?? 0,
    contributors: contributorMap.get(w.id) ?? [],
  }));

  return { workspaces, workspacesCountLimit: LIMITS.workspacesCount };
};
