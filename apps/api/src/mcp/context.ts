import { panic } from "better-result";
import { and, eq } from "drizzle-orm";

import { createSafeDb, createScopedDb } from "@/api/db";
import type { SafeDb, ScopedDb } from "@/api/db";
import { member } from "@/api/db/auth-schema";
import { rootDb, rlsDb } from "@/api/db/root";
import { createAuditRecorder } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { resolveAccessibleWorkspaces } from "@/api/lib/auth";
import type { SafeId } from "@/api/lib/branded-types";
import { isMemberRole } from "@/api/lib/member-roles";
import type { MemberRole } from "@/api/lib/member-roles";
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
  recordAuditEvent: AuditRecorder;
  safeDb: SafeDb;
  scopedDb: ScopedDb;
  userId: SafeId<"user">;
};

export const resolveMcpSessionContext = async (
  session: McpSession,
  { request }: { request: Request },
): Promise<McpRequestContext> => {
  const { organizationId, userId } = brandActorSessionIdentity({
    organizationId: session.organizationId,
    userId: session.userId,
  });

  const memberRow = await rootDb
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
  // RLS receives all IDs regardless of status (matches the Elysia
  // auth path). Business-logic fields exclude deleting workspaces
  // so MCP tools don't surface content from sealed workspaces.
  const allWorkspaceIds = accessibleWorkspaces.map((workspace) =>
    brandPersistedWorkspaceId(workspace.id),
  );
  const usableWorkspaceIds = accessibleWorkspaces
    .filter((w) => w.status !== "deleting")
    .map((workspace) => brandPersistedWorkspaceId(workspace.id));

  return {
    accessibleWorkspaceIds: usableWorkspaceIds,
    accessibleWorkspaceIdSet: new Set(usableWorkspaceIds),
    memberRole,
    organizationId,
    recordAuditEvent: createAuditRecorder({
      organizationId,
      request,
      server: null,
      userId,
      workspaceId: null,
    }),
    safeDb: createSafeDb(rlsDb, allWorkspaceIds, organizationId, userId),
    scopedDb: createScopedDb(rlsDb, allWorkspaceIds, organizationId, userId),
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
