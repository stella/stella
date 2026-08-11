import { Result, panic } from "better-result";
import {
  and,
  eq,
  inArray,
  isNull,
  max,
  notInArray,
  or,
  sql,
} from "drizzle-orm";

// `user` is joined via workspaceMembers, which carries workspace-scoped
// RLS (wsPolicies) and is itself filtered by wsIds derived from an
// organization-scoped workspaces query. The `member` table is not
// needed for scoping in this code path. The disable directive sits on
// the same line as the import so reordering imports cannot shift it.
import { user } from "@/api/db/auth-schema"; // oxlint-disable-line security-guards/no-unscoped-user-query -- joined via RLS-scoped workspaceMembers filtered by org-derived wsIds (see comment above)
import { entities, workspaceMembers } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { arrayOrEmpty } from "@/api/lib/array";
import { TASK_STATUS } from "@/api/lib/entity-constants";
import { LIMITS } from "@/api/lib/limits";
import { brandPersistedWorkspaceId } from "@/api/lib/safe-id-boundaries";

const config = {
  description: "List the matters you can access.",
  permissions: {
    workspace: ["read"],
  },
  mcp: { type: "tool", name: "list_matters" },
  access: "read",
} satisfies HandlerConfig;

const readWorkspaces = createSafeRootHandler(
  config,
  async function* ({ safeDb, session }) {
    const organizationId = session.activeOrganizationId;
    const { result, entityAggregates, memberRows } = yield* Result.await(
      safeDb(async (tx) => {
        const workspaceRows = await tx.query.workspaces.findMany({
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

        const wsIds = workspaceRows.map((w) => brandPersistedWorkspaceId(w.id));

        if (wsIds.length === 0) {
          return {
            result: workspaceRows,
            entityAggregates: [],
            memberRows: [],
          };
        }

        const closedStatuses = [TASK_STATUS.DONE, TASK_STATUS.CANCELLED];

        const openTaskCondition = and(
          eq(entities.kind, "task"),
          or(
            notInArray(entities.status, closedStatuses),
            isNull(entities.status),
          ),
        );

        const [aggregateRows, members] = await Promise.all([
          tx
            .select({
              workspaceId: entities.workspaceId,
              entityCount: sql<number>`count(*)::int`,
              openTaskCount: sql<number>`count(*) filter (where ${openTaskCondition})::int`,
              nextDeadline: sql<
                string | null
              >`min(${entities.dueDate}) filter (where ${openTaskCondition})`,
            })
            .from(entities)
            .where(inArray(entities.workspaceId, wsIds))
            .groupBy(entities.workspaceId),
          tx
            .select({
              workspaceId: workspaceMembers.workspaceId,
              userId: workspaceMembers.userId,
              userEmail: user.email,
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
              user.email,
              user.name,
              user.image,
            )
            // SAFETY: member rows fan out across the org's active workspaces; bounded by LIMITS.workspacesCount * LIMITS.workspaceMembersCount, and a single-workspace cap would truncate multi-workspace orgs.
            // eslint-disable-next-line require-query-limit/require-query-limit
            .orderBy(
              workspaceMembers.workspaceId,
              sql`${max(entities.updatedAt)} DESC NULLS LAST`,
              user.name,
            ),
        ]);

        return {
          result: workspaceRows,
          entityAggregates: aggregateRows,
          memberRows: members,
        };
      }),
    );

    const entityAggregateMap = new Map(
      entityAggregates.map((aggregate) => [aggregate.workspaceId, aggregate]),
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
      const entityAggregate = entityAggregateMap.get(workspace.id);
      const storedMembers = memberMap.get(workspace.id);
      const allMembers = arrayOrEmpty(storedMembers);
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
        entityCount: entityAggregate?.entityCount ?? 0,
        openTaskCount: entityAggregate?.openTaskCount ?? 0,
        nextDeadline: entityAggregate?.nextDeadline ?? null,
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
