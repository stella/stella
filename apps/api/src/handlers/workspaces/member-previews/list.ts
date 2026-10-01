import { Result } from "better-result";
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { t } from "elysia";

import { member, user } from "@/api/db/auth-schema";
import { workspaceMembers, workspaces } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";
import {
  brandPersistedUserId,
  brandPersistedWorkspaceId,
} from "@/api/lib/safe-id-boundaries";

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "internal", reason: "ui_navigation_state" },
  access: "read",
  query: t.Object({
    workspaceIds: t.Array(tSafeId("workspace"), {
      minItems: 1,
      maxItems: LIMITS.workspaceMemberPreviewBatchMax,
      uniqueItems: true,
    }),
  }),
} satisfies HandlerConfig;

const listWorkspaceMemberPreviews = createSafeRootHandler(
  config,
  async function* ({ query, safeDb, session, user: currentUser }) {
    const previews = yield* Result.await(
      safeDb(async (tx) => {
        const accessible = await tx
          .select({ workspaceId: workspaces.id })
          .from(workspaces)
          .where(
            and(
              inArray(workspaces.id, query.workspaceIds),
              eq(workspaces.organizationId, session.activeOrganizationId),
              inArray(workspaces.status, ["active", "archived"]),
            ),
          )
          .limit(LIMITS.workspaceMemberPreviewBatchMax);
        if (accessible.length === 0) {
          return [];
        }
        const ranked = tx
          .select({
            workspaceId: workspaceMembers.workspaceId,
            userId: workspaceMembers.userId,
            name: user.name,
            email: user.email,
            image: user.image,
            // Counts drive avatar overflow; this fixed-size projection is not a member list page.
            total:
              sql<number>`count(*) over (partition by ${workspaceMembers.workspaceId})::int`.as(
                "total",
              ),
            // Include the viewer if assigned, so clients can subtract them from the full count.
            rank: sql<number>`row_number() over (
              partition by ${workspaceMembers.workspaceId}
              order by (${workspaceMembers.userId} = ${currentUser.id}) desc,
                ${workspaceMembers.createdAt} desc, ${workspaceMembers.id} desc
            )`.as("rank"),
          })
          .from(workspaceMembers)
          .innerJoin(
            member,
            and(
              eq(member.userId, workspaceMembers.userId),
              eq(member.organizationId, session.activeOrganizationId),
            ),
          )
          .innerJoin(user, eq(user.id, workspaceMembers.userId))
          .where(
            inArray(
              workspaceMembers.workspaceId,
              accessible.map((row) => row.workspaceId),
            ),
          )
          .as("ranked_members");
        const rows = await tx
          .select({
            workspaceId: ranked.workspaceId,
            userId: ranked.userId,
            name: ranked.name,
            email: ranked.email,
            image: ranked.image,
            total: ranked.total,
          })
          .from(ranked)
          .where(lte(ranked.rank, LIMITS.workspaceMemberPreviewMembersMax))
          .orderBy(ranked.workspaceId, ranked.rank)
          .limit(
            LIMITS.workspaceMemberPreviewBatchMax *
              LIMITS.workspaceMemberPreviewMembersMax,
          );
        const byWorkspace = Map.groupBy(rows, (row) => row.workspaceId);
        return accessible.map((row) => {
          const workspaceId = brandPersistedWorkspaceId(row.workspaceId);
          const members = byWorkspace.get(workspaceId);
          return {
            workspaceId,
            total: members?.at(0)?.total ?? 0,
            members: members
              ? members.map((memberRow) => ({
                  userId: brandPersistedUserId(memberRow.userId),
                  name: memberRow.name,
                  email: memberRow.email,
                  image: memberRow.image,
                }))
              : [],
          };
        });
      }),
    );
    return Result.ok({ previews });
  },
);

export default listWorkspaceMemberPreviews;
