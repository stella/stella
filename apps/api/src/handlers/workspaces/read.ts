import { count, desc, eq, inArray, max } from "drizzle-orm";

import { user } from "@/api/db/auth-schema";
import { entities } from "@/api/db/schema";
import { createRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
// oxlint-disable-next-line no-restricted-imports: brands DB-returned workspace PKs for map lookups
import { toSafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";

const config = {
  permissions: {
    workspace: ["read"],
  },
} satisfies HandlerConfig;

const readWorkspaces = createRootHandler(
  config,
  async ({ scopedDb, session }) => {
    const organizationId = session.activeOrganizationId;
    const { result, counts, contributorRows } = await scopedDb(async (tx) => {
      const allRows = await tx.query.workspaces.findMany({
        where: {
          organizationId: { eq: organizationId },
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

      const workspaceRows = allRows.filter((w) => w.status === "active");

      const wsIds = workspaceRows.map((w) => toSafeId<"workspace">(w.id));

      if (wsIds.length === 0) {
        return {
          result: workspaceRows,
          counts: [],
          contributorRows: [],
        };
      }

      const [entityCounts, contributors] = await Promise.all([
        tx
          .select({
            workspaceId: entities.workspaceId,
            count: count(),
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
            lastActivity: max(entities.updatedAt),
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
          .orderBy(entities.workspaceId, desc(max(entities.updatedAt))),
      ]);

      return {
        result: workspaceRows,
        counts: entityCounts,
        contributorRows: contributors,
      };
    });

    const countMap = new Map<string, number>(
      counts.map((c) => [c.workspaceId, c.count]),
    );

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

    const workspaces = result.map(({ status: _, ...w }) => ({
      ...w,
      entityCount: countMap.get(w.id) ?? 0,
      contributors: contributorMap.get(w.id) ?? [],
    }));

    return {
      workspaces,
      workspacesCountLimit: LIMITS.workspacesCount,
    };
  },
);

export default readWorkspaces;
