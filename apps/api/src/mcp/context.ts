import { panic } from "better-result";

import { createSafeDb, createScopedDb } from "@/api/db";
import type { SafeDb, ScopedDb } from "@/api/db";
import { rlsDb } from "@/api/db/root";
import { createAuditRecorder } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { resolveMemberAccess } from "@/api/lib/auth";
import type { AccessibleWorkspace } from "@/api/lib/auth";
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
  /**
   * Status of every accessible (non-deleting) workspace, keyed by id. Write
   * tools gate on this to keep archived matters read-only, mirroring the HTTP
   * `validateWorkspaceAccess` macro which 404s a workspace whose status is not
   * "active".
   */
  accessibleWorkspaceStatusById: Map<string, AccessibleWorkspace["status"]>;
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

  const memberAccess = await resolveMemberAccess(userId, organizationId);

  if (!memberAccess) {
    throw new McpOrganizationAccessError({
      message: "User is not a member of this organization",
    });
  }

  if (!isMemberRole(memberAccess.role)) {
    panic("User has an invalid member role");
  }

  const memberRole = memberAccess.role;
  const accessibleWorkspaces = memberAccess.accessibleWorkspaces;
  // RLS receives all IDs regardless of status (matches the Elysia
  // auth path). Business-logic fields exclude deleting workspaces
  // so MCP tools don't surface content from sealed workspaces.
  const allWorkspaceIds = accessibleWorkspaces.map((workspace) =>
    brandPersistedWorkspaceId(workspace.id),
  );
  const usableWorkspaces = accessibleWorkspaces.filter(
    (w) => w.status !== "deleting",
  );
  const usableWorkspaceIds = usableWorkspaces.map((workspace) =>
    brandPersistedWorkspaceId(workspace.id),
  );

  return {
    accessibleWorkspaceIds: usableWorkspaceIds,
    accessibleWorkspaceIdSet: new Set(usableWorkspaceIds),
    accessibleWorkspaceStatusById: new Map(
      usableWorkspaces.map((workspace) => [workspace.id, workspace.status]),
    ),
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
