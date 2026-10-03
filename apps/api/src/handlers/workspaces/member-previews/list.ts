import { Result } from "better-result";
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { t } from "elysia";

import { member, user } from "@/api/db/auth-schema";
import { workspaceMembers, workspaces } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";
import {
  brandPersistedUserId,
  brandPersistedWorkspaceId,
} from "@/api/lib/safe-id-boundaries";

type WorkspaceMemberRow = typeof workspaceMembers.$inferSelect;
type UserRow = typeof user.$inferSelect;

const UNPROJECTED_WORKSPACE_MEMBER_COLUMNS = [
  // Membership row identity is not needed to display the user's avatar.
  "id",
  // Used to rank previews, but not displayed to the client.
  "createdAt",
] as const satisfies readonly (keyof WorkspaceMemberRow)[];

const WORKSPACE_MEMBER_PREVIEW_COLUMNS = {
  workspaceId: workspaceMembers.workspaceId,
  userId: workspaceMembers.userId,
} as const;

const UNPROJECTED_USER_PROFILE_COLUMNS = [
  // Identity is projected from workspaceMembers.userId, joined to user.id.
  "id",
  // Authentication state is not part of an avatar preview.
  "emailVerified",
  // Time formatting preferences are not used by avatar labels.
  "timezoneId",
  // Avatar labels use the canonical name, matching other matter-team surfaces.
  "preferredName",
  // Editor shortcut preferences are unrelated to team previews.
  "wordEditShortcut",
  // Keyboard rebindings belong to the user's settings.
  "userShortcuts",
  // Onboarding progress belongs to the signed-in user's session.
  "guideProgress",
  // Signup geography is not needed to identify a colleague.
  "detectedCountry",
  // Two-factor configuration is private authentication state.
  "twoFactorEnabled",
  // Account lifecycle metadata is not part of the display profile.
  "deletedAt",
  // Registration time is not displayed in avatar previews.
  "createdAt",
  // Profile modification time is not displayed in avatar previews.
  "updatedAt",
] as const satisfies readonly (keyof UserRow)[];

const USER_PROFILE_PREVIEW_COLUMNS = {
  name: user.name,
  email: user.email,
  image: user.image,
} as const;

type MissingProjectedWorkspaceMemberColumn = UnprojectedColumns<
  WorkspaceMemberRow,
  typeof WORKSPACE_MEMBER_PREVIEW_COLUMNS,
  (typeof UNPROJECTED_WORKSPACE_MEMBER_COLUMNS)[number]
>;
type UnexpectedProjectedWorkspaceMemberColumn = UnbackedProjectionKeys<
  WorkspaceMemberRow,
  typeof WORKSPACE_MEMBER_PREVIEW_COLUMNS,
  (typeof UNPROJECTED_WORKSPACE_MEMBER_COLUMNS)[number]
>;
type MissingProjectedUserProfileColumn = UnprojectedColumns<
  UserRow,
  typeof USER_PROFILE_PREVIEW_COLUMNS,
  (typeof UNPROJECTED_USER_PROFILE_COLUMNS)[number]
>;
type UnexpectedProjectedUserProfileColumn = UnbackedProjectionKeys<
  UserRow,
  typeof USER_PROFILE_PREVIEW_COLUMNS,
  (typeof UNPROJECTED_USER_PROFILE_COLUMNS)[number]
>;

true satisfies MissingProjectedWorkspaceMemberColumn extends never
  ? true
  : never;
true satisfies UnexpectedProjectedWorkspaceMemberColumn extends never
  ? true
  : never;
true satisfies MissingProjectedUserProfileColumn extends never ? true : never;
true satisfies UnexpectedProjectedUserProfileColumn extends never
  ? true
  : never;

const config = {
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
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
            ...WORKSPACE_MEMBER_PREVIEW_COLUMNS,
            ...USER_PROFILE_PREVIEW_COLUMNS,
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
