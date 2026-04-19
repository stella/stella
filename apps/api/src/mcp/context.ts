import { panic } from "better-result";
import { and, eq } from "drizzle-orm";

import { createSafeDb, createScopedDb } from "@/api/db";
import type { SafeDb, ScopedDb } from "@/api/db";
import { member } from "@/api/db/auth-schema";
import { db } from "@/api/db/root";
import { resolveAccessibleWorkspaces } from "@/api/lib/auth";
import type { MemberRole } from "@/api/lib/auth";
import type { SafeId } from "@/api/lib/branded-types";
import {
  brandActorSessionIdentity,
  brandPersistedWorkspaceId,
} from "@/api/lib/safe-id-boundaries";
import type { McpSession } from "@/api/mcp/auth";
import { McpOrganizationAccessError } from "@/api/mcp/errors";

export type McpRequestContext = {
  accessibleWorkspaceIds: SafeId<"workspace">[];
  accessibleWorkspaceIdSet: Set<string>;
  memberRole: MemberRole;
  organizationId: SafeId<"organization">;
  safeDb: SafeDb;
  scopedDb: ScopedDb;
  userId: SafeId<"user">;
};

const isMemberRole = (role: string): role is MemberRole => {
  switch (role) {
    case "owner":
    case "admin":
    case "member":
    case "intern":
    case "external":
      return true;
    default:
      return false;
  }
};

export const resolveMcpSessionContext = async (
  session: McpSession,
): Promise<McpRequestContext> => {
  const { organizationId, userId } = brandActorSessionIdentity({
    organizationId: session.organizationId,
    userId: session.userId,
  });

  const memberRow = await db
    .select({ role: member.role })
    .from(member)
    .where(
      and(
        eq(member.userId, session.userId),
        eq(member.organizationId, session.organizationId),
      ),
    )
    .then((rows) => rows.at(0));

  if (!memberRow) {
    throw new McpOrganizationAccessError({
      message: "User is not a member of this organization",
    });
  }

  if (!isMemberRole(memberRow.role)) {
    panic("User has an invalid member role");
  }

  const memberRole = memberRow.role;
  const accessibleWorkspaces = await resolveAccessibleWorkspaces(
    userId,
    organizationId,
    memberRole,
  );
  const accessibleWorkspaceIds = accessibleWorkspaces.map((workspace) =>
    brandPersistedWorkspaceId(workspace.id),
  );

  return {
    accessibleWorkspaceIds,
    accessibleWorkspaceIdSet: new Set(accessibleWorkspaceIds),
    memberRole,
    organizationId,
    safeDb: createSafeDb(db, accessibleWorkspaceIds, organizationId, userId),
    scopedDb: createScopedDb(
      db,
      accessibleWorkspaceIds,
      organizationId,
      userId,
    ),
    userId,
  };
};

export const getAccessibleWorkspaceId = ({
  accessibleWorkspaceIdSet,
  workspaceId,
}: {
  accessibleWorkspaceIdSet: Set<string>;
  workspaceId: string;
}) =>
  accessibleWorkspaceIdSet.has(workspaceId)
    ? brandPersistedWorkspaceId(workspaceId)
    : null;
