import { panic } from "better-result";
import { eq } from "drizzle-orm";

import { rlsDb } from "@/api/db/root";
import { workspaces } from "@/api/db/schema";
import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  createMembershipSafeDb,
  createMembershipScopedDb,
} from "@/api/db/scoped";
import { createAuditRecorder } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { resolveMemberAuthorization } from "@/api/lib/auth";
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
import { createWorkspaceAccessBoundary } from "@/api/mcp/workspace-access-boundary";

export type McpOperationDatabaseScope = {
  /**
   * Add one workspace only when it belongs to the access map captured by this
   * MCP request. Returns false instead of minting scope for an unknown ID.
   */
  pinServerValidatedWorkspaceId: (workspaceId: SafeId<"workspace">) => boolean;
  safeDb: SafeDb;
  scopedDb: ScopedDb;
};

export type McpRequestContext = {
  accessibleWorkspaceIds: SafeId<"workspace">[];
  accessibleWorkspaceIdSet: ReadonlySet<string>;
  /**
   * Status of every accessible (non-deleting) workspace, keyed by id. Write
   * tools gate on this to keep archived matters read-only, mirroring the HTTP
   * `validateWorkspaceAccess` macro which 404s a workspace whose status is not
   * "active".
   */
  accessibleWorkspaceStatusById: Map<string, AccessibleWorkspace["status"]>;
  /**
   * Every accessible (non-deleting) workspace with its status. The generic
   * capability path (`invoke_capability`) needs this to build the
   * `getAccessibleWorkspaces` resolver the safe-handler context carries; existing
   * tools resolve access through `accessibleWorkspaceIdSet` /
   * `accessibleWorkspaceStatusById` and do not read it.
   */
  accessibleWorkspaces: AccessibleWorkspace[];
  /**
   * OAuth scopes granted to this session (the access token's `scope` claim).
   * `invoke_capability` gates each capability on its catalog scope against this
   * list; the session-authed chat projection has no OAuth scopes and passes an
   * empty list (it never dispatches the generic path).
   */
  grantedScopes: readonly string[];
  memberRole: MemberRole;
  organizationId: SafeId<"organization">;
  /**
   * Build an operation-local database scope whose private pinned-ID list can
   * grow only through its access-map-validating pin method. The generic
   * capability path uses this for its source/target authorization snapshot
   * without exposing a raw privilege-minting array.
   *
   * Session-authenticated chat projections do not dispatch generic
   * capabilities, so their synthetic contexts may omit this factory.
   */
  createOperationDatabaseScope?: (() => McpOperationDatabaseScope) | undefined;
  /** Pin one workspace only after an MCP access/status gate proves it. */
  pinServerValidatedWorkspaceId?:
    | ((workspaceId: SafeId<"workspace">) => boolean)
    | undefined;
  /**
   * The originating gateway HTTP request. Present on the MCP transport path
   * (set by `resolveMcpSessionContext`); absent on the session-authed chat
   * projection, which never dispatches the generic capability path. Only
   * `invoke_capability` reads it (to synthesize a safe-handler context).
   */
  request?: Request;
  recordAuditEvent: AuditRecorder;
  safeDb: SafeDb;
  scopedDb: ScopedDb;
  userId: SafeId<"user">;
};

type LoadAccessibleMcpWorkspacesOptions = {
  organizationId: SafeId<"organization">;
  scopedDb: ScopedDb;
};

/**
 * Enumerate the workspace metadata MCP's current access maps require. Keep the
 * organization predicate explicit even though RLS independently enforces it,
 * so the tenant index bounds the query before policy evaluation.
 */
export const loadAccessibleMcpWorkspaces = async ({
  organizationId,
  scopedDb,
}: LoadAccessibleMcpWorkspacesOptions): Promise<AccessibleWorkspace[]> =>
  await scopedDb(
    async (tx) =>
      await tx
        .select({ id: workspaces.id, status: workspaces.status })
        .from(workspaces)
        .where(eq(workspaces.organizationId, organizationId)),
  );

export const resolveMcpSessionContext = async (
  session: McpSession,
  { request }: { request: Request },
): Promise<McpRequestContext> => {
  const { organizationId, userId } = brandActorSessionIdentity({
    organizationId: session.organizationId,
    userId: session.userId,
  });

  const authorization = await resolveMemberAuthorization({
    organizationId,
    userId,
  });

  if (!authorization) {
    throw new McpOrganizationAccessError({
      message: "User is not a member of this organization",
    });
  }

  if (!isMemberRole(authorization.role)) {
    panic("User has an invalid member role");
  }

  const memberRole = authorization.role;
  const bootstrapScopedDb = createMembershipScopedDb(rlsDb, {
    organizationId,
    serverValidatedWorkspaceIds: [],
    userId,
  });
  const accessibleWorkspaces = await loadAccessibleMcpWorkspaces({
    organizationId,
    scopedDb: bootstrapScopedDb,
  });
  // Business-logic fields exclude deleting workspaces so MCP tools don't
  // surface content from sealed workspaces. RLS derives membership from the
  // organization/user transaction settings independently.
  const usableWorkspaces = accessibleWorkspaces.filter(
    (w) => w.status !== "deleting",
  );
  const usableWorkspaceIds = usableWorkspaces.map((workspace) =>
    brandPersistedWorkspaceId(workspace.id),
  );
  const workspaceAccessBoundary =
    createWorkspaceAccessBoundary(usableWorkspaceIds);
  const createOperationDatabaseScope = (): McpOperationDatabaseScope => {
    const serverValidatedWorkspaceIds: SafeId<"workspace">[] = [];
    const pinServerValidatedWorkspaceId =
      workspaceAccessBoundary.bindWorkspacePin((workspaceId) => {
        if (!serverValidatedWorkspaceIds.includes(workspaceId)) {
          serverValidatedWorkspaceIds.push(workspaceId);
        }
        return true;
      });
    const databaseIdentity = {
      organizationId,
      serverValidatedWorkspaceIds,
      userId,
    };
    return {
      pinServerValidatedWorkspaceId,
      safeDb: createMembershipSafeDb(rlsDb, databaseIdentity),
      scopedDb: createMembershipScopedDb(rlsDb, databaseIdentity),
    };
  };
  const requestDatabaseScope = createOperationDatabaseScope();

  return {
    accessibleWorkspaceIds: usableWorkspaceIds,
    accessibleWorkspaceIdSet: workspaceAccessBoundary.accessibleWorkspaceIdSet,
    accessibleWorkspaceStatusById: new Map(
      usableWorkspaces.map((workspace) => [workspace.id, workspace.status]),
    ),
    accessibleWorkspaces: usableWorkspaces,
    createOperationDatabaseScope,
    grantedScopes: session.scopes,
    memberRole,
    organizationId,
    request,
    recordAuditEvent: createAuditRecorder({
      organizationId,
      request,
      server: null,
      userId,
      workspaceId: null,
    }),
    pinServerValidatedWorkspaceId:
      requestDatabaseScope.pinServerValidatedWorkspaceId,
    safeDb: requestDatabaseScope.safeDb,
    scopedDb: requestDatabaseScope.scopedDb,
    userId,
  };
};

export const getAccessibleWorkspaceId = ({
  accessibleWorkspaceIdSet,
  workspaceId,
}: {
  accessibleWorkspaceIdSet: ReadonlySet<string>;
  workspaceId: string;
}) =>
  accessibleWorkspaceIdSet.has(workspaceId)
    ? brandPersistedWorkspaceId(workspaceId)
    : null;
