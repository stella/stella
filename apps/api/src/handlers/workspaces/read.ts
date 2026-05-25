import { Result, panic } from "better-result";
import {
  and,
  count,
  desc,
  eq,
  inArray,
  isNull,
  max,
  min,
  notInArray,
  or,
} from "drizzle-orm";

import { member, user } from "@/api/db/auth-schema";
import { entities } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { TASK_STATUS } from "@/api/lib/entity-constants";
import { LIMITS } from "@/api/lib/limits";
import { brandPersistedWorkspaceId } from "@/api/lib/safe-id-boundaries";

const config = {
  permissions: {
    workspace: ["read"],
  },
} satisfies HandlerConfig;

const readWorkspaces = createSafeRootHandler(
  config,
  async function* ({ safeDb, session }) {
    const organizationId = session.activeOrganizationId;
    const { result, counts, contributorRows, taskCounts, deadlineRows } =
      yield* Result.await(
        safeDb(async (tx) => {
          const allRows = await tx.query.workspaces.findMany({
            where: {
              organizationId: { eq: organizationId },
              status: { eq: "active" },
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
                with: {
                  responsibleAttorney: {
                    columns: { name: true },
                  },
                },
              },
            },
            orderBy: {
              lastActivityAt: "desc",
            },
            limit: LIMITS.workspacesCount,
          });

          const workspaceRows = allRows.filter((w) => w.status === "active");

          const wsIds = workspaceRows.map((w) =>
            brandPersistedWorkspaceId(w.id),
          );

          if (wsIds.length === 0) {
            return {
              result: workspaceRows,
              counts: [],
              contributorRows: [],
              taskCounts: [],
              deadlineRows: [],
            };
          }

          const closedStatuses = [TASK_STATUS.DONE, TASK_STATUS.CANCELLED];

          const [entityCounts, contributors, openTaskRows, dueDateRows] =
            await Promise.all([
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
                .innerJoin(
                  member,
                  and(
                    eq(entities.createdBy, member.userId),
                    eq(member.organizationId, organizationId),
                  ),
                )
                .innerJoin(user, eq(member.userId, user.id))
                .where(inArray(entities.workspaceId, wsIds))
                .groupBy(
                  entities.workspaceId,
                  entities.createdBy,
                  user.name,
                  user.image,
                )
                .orderBy(entities.workspaceId, desc(max(entities.updatedAt))),
              tx
                .select({
                  workspaceId: entities.workspaceId,
                  count: count(),
                })
                .from(entities)
                .where(
                  and(
                    inArray(entities.workspaceId, wsIds),
                    eq(entities.kind, "task"),
                    or(
                      notInArray(entities.status, closedStatuses),
                      isNull(entities.status),
                    ),
                  ),
                )
                .groupBy(entities.workspaceId),
              tx
                .select({
                  workspaceId: entities.workspaceId,
                  deadline: min(entities.dueDate),
                })
                .from(entities)
                .where(
                  and(
                    inArray(entities.workspaceId, wsIds),
                    eq(entities.kind, "task"),
                    or(
                      notInArray(entities.status, closedStatuses),
                      isNull(entities.status),
                    ),
                  ),
                )
                .groupBy(entities.workspaceId),
            ]);

          return {
            result: workspaceRows,
            counts: entityCounts,
            contributorRows: contributors,
            taskCounts: openTaskRows,
            deadlineRows: dueDateRows,
          };
        }),
      );

    const countMap = new Map<string, number>(
      counts.map((c) => [c.workspaceId, c.count]),
    );

    const openTaskMap = new Map<string, number>(
      taskCounts.map((c) => [c.workspaceId, c.count]),
    );

    const deadlineMap = new Map<string, string | null>(
      deadlineRows.map((d) => [d.workspaceId, d.deadline]),
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

    const workspaces = result.map((workspace) => {
      const { client } = workspace;
      if (workspace.clientId !== null && !client) {
        // Should be impossible: a non-null clientId is an FK that
        // resolves via the eager-loaded `client` relation.
        panic(`workspace ${workspace.id} has clientId set but no client row`);
      }
      return {
        id: workspace.id,
        name: workspace.name,
        reference: workspace.reference,
        clientId: workspace.clientId,
        color: workspace.color,
        lastActivityAt: workspace.lastActivityAt,
        createdAt: workspace.createdAt,
        client: client
          ? {
              id: client.id,
              displayName: client.displayName,
              responsibleAttorneyName: client.responsibleAttorney?.name ?? null,
            }
          : null,
        entityCount: countMap.get(workspace.id) ?? 0,
        openTaskCount: openTaskMap.get(workspace.id) ?? 0,
        nextDeadline: deadlineMap.get(workspace.id) ?? null,
        contributors: contributorMap.get(workspace.id) ?? [],
      };
    });

    return Result.ok({
      workspaces,
      workspacesCountLimit: LIMITS.workspacesCount,
    });
  },
);

export default readWorkspaces;
