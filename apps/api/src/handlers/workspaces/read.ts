import { Result, panic } from "better-result";
import {
  and,
  count,
  eq,
  inArray,
  isNull,
  max,
  min,
  notInArray,
  or,
  sql,
} from "drizzle-orm";

// `user` is joined via workspaceMembers, which carries workspace-scoped
// RLS (wsPolicies) and is itself filtered by wsIds derived from an
// organization-scoped workspaces query. The `member` table is not
// needed for scoping in this code path. The disable directive sits on
// the same line as the import so reordering imports cannot shift it.
import { user } from "@/api/db/auth-schema"; // oxlint-disable-line security-guards/no-unscoped-user-query
import { entities, workspaceMembers } from "@/api/db/schema";
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
    const { result, counts, memberRows, taskCounts, deadlineRows } =
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
              leadUserId: true,
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
              memberRows: [],
              taskCounts: [],
              deadlineRows: [],
            };
          }

          const closedStatuses = [TASK_STATUS.DONE, TASK_STATUS.CANCELLED];

          const [entityCounts, members, openTaskRows, dueDateRows] =
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
                  workspaceId: workspaceMembers.workspaceId,
                  userId: workspaceMembers.userId,
                  userName: user.name,
                  userImage: user.image,
                  lastActivity: max(entities.updatedAt),
                })
                .from(workspaceMembers)
                .innerJoin(user, eq(user.id, workspaceMembers.userId))
                .leftJoin(
                  entities,
                  and(
                    eq(entities.workspaceId, workspaceMembers.workspaceId),
                    eq(entities.lastEditedBy, workspaceMembers.userId),
                  ),
                )
                .where(inArray(workspaceMembers.workspaceId, wsIds))
                .groupBy(
                  workspaceMembers.workspaceId,
                  workspaceMembers.userId,
                  user.name,
                  user.image,
                )
                .orderBy(
                  workspaceMembers.workspaceId,
                  sql`${max(entities.updatedAt)} DESC NULLS LAST`,
                  user.name,
                ),
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
            memberRows: members,
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

    const memberMap = new Map<string, typeof memberRows>();
    for (const row of memberRows) {
      const list = memberMap.get(row.workspaceId);
      if (list) {
        list.push(row);
      } else {
        memberMap.set(row.workspaceId, [row]);
      }
    }

    const workspaces = result.map((workspace) => {
      const { client } = workspace;
      if (workspace.clientId !== null && !client) {
        // Should be impossible: a non-null clientId is an FK that
        // resolves via the eager-loaded `client` relation.
        panic(`workspace ${workspace.id} has clientId set but no client row`);
      }
      const allMembers = memberMap.get(workspace.id) ?? [];
      const leadIdx = workspace.leadUserId
        ? allMembers.findIndex((m) => m.userId === workspace.leadUserId)
        : -1;
      // Pin the lead first; the rest stay in last-edit-desc order.
      const lead = leadIdx > 0 ? allMembers.at(leadIdx) : undefined;
      const orderedMembers = lead
        ? [
            lead,
            ...allMembers.slice(0, leadIdx),
            ...allMembers.slice(leadIdx + 1),
          ]
        : allMembers;
      return {
        id: workspace.id,
        name: workspace.name,
        reference: workspace.reference,
        clientId: workspace.clientId,
        color: workspace.color,
        leadUserId: workspace.leadUserId,
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
        members: orderedMembers,
      };
    });

    return Result.ok({
      workspaces,
      workspacesCountLimit: LIMITS.workspacesCount,
    });
  },
);

export default readWorkspaces;
