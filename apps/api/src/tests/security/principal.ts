/**
 * Shared principal builders for security tests.
 *
 * Security tests must construct MCP and HTTP caller contexts through the same
 * production authorization and RLS database builders that serve live traffic
 * (`resolveMemberAuthorization`, `featureAccessSnapshotFromAuthorization`,
 * `createMcpOperationDatabases`, `loadAccessibleMcpWorkspaces`,
 * `filterUsableMcpWorkspaces`, `createWorkspaceAccessBoundary`), rather than
 * assembling partial contexts with `asTestRaw<AuthorizedMcpRequestContext>` or
 * pairing a membership-scoped database with a narrowed workspace list.
 */

import { panic } from "better-result";

import type { Transaction } from "@/api/db/root";
import { TRANSACTION_DEADLINE } from "@/api/db/scoped";
import type { RlsDatabase } from "@/api/db/scoped";
import type { AuditRecorder } from "@/api/lib/audit-log";
import {
  featureAccessSnapshotFromAuthorization,
  resolveMemberAuthorization,
} from "@/api/lib/auth";
import type { AccessibleWorkspace } from "@/api/lib/auth/accessible-workspace";
import type { SafeId } from "@/api/lib/branded-types";
import type { FeatureAccessSnapshot } from "@/api/lib/feature-access/policy";
import { isMemberRole } from "@/api/lib/member-roles";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { MCP_ALL_RESOURCE_SCOPES } from "@/api/mcp/constants";
import type { McpOAuthScope } from "@/api/mcp/constants";
import {
  createMcpOperationDatabases,
  loadAccessibleMcpWorkspaces,
} from "@/api/mcp/context";
import type { McpRequestResources } from "@/api/mcp/context";
import { TOOL_CONFIRMATION } from "@/api/mcp/tool-confirmation";
import type { ToolConfirmation } from "@/api/mcp/tool-confirmation";
import { createWorkspaceAccessBoundary } from "@/api/mcp/workspace-access-boundary";
import { filterUsableMcpWorkspaces } from "@/api/mcp/workspace-session-scope";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import type {
  BaseTestHandlerContext,
  TestHandlerContextOverrides,
} from "@/api/tests/helpers/handler-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const noopAuditRecorder: AuditRecorder = async () => {
  await Promise.resolve();
};

const adaptTestRlsDb = (db: TestDatabase): RlsDatabase<Transaction> =>
  // SAFETY: PGlite implements the same Drizzle query and transaction APIs as
  // the production postgres-js client, and `createTestDb` marks it as RLS-ready.
  asTestRaw<RlsDatabase<Transaction>>(db);

export type McpSecurityPrincipalOptions = {
  db: TestDatabase;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  /**
   * Optional workspace attenuation claim. When defined, `createMcpOperationDatabases`
   * switches Postgres RLS into `explicit` mode (mirroring `resolveMcpSessionContext`).
   */
  tokenWorkspaceIds?: readonly SafeId<"workspace">[];
  grantedScopes?: readonly McpOAuthScope[];
  toolConfirmation?: ToolConfirmation;
  request?: Request;
  recordAuditEvent?: AuditRecorder;
};

/**
 * Build a live MCP request principal (`McpRequestResources`) backed by Postgres
 * membership resolution and `createMcpOperationDatabases`.
 */
export const buildMcpSecurityPrincipal = async ({
  db,
  organizationId,
  userId,
  tokenWorkspaceIds,
  grantedScopes = MCP_ALL_RESOURCE_SCOPES,
  toolConfirmation = TOOL_CONFIRMATION.caller,
  request,
  recordAuditEvent = noopAuditRecorder,
}: McpSecurityPrincipalOptions): Promise<McpRequestResources> => {
  const authorization = await resolveMemberAuthorization(
    {
      authentication: { kind: "credential" },
      organizationId,
      userId,
    },
    db,
  );
  if (!authorization || authorization.userDeleted) {
    return panic(
      `Security principal ${userId} is not an active member of organization ${organizationId}`,
    );
  }
  if (!isMemberRole(authorization.role)) {
    return panic(
      `Security principal ${userId} has invalid member role: ${authorization.role}`,
    );
  }

  const rlsDatabase = adaptTestRlsDb(db);
  const bootstrapScope = createMcpOperationDatabases(rlsDatabase, {
    deadline: TRANSACTION_DEADLINE.request,
    organizationId,
    serverValidatedWorkspaceIds: [],
    tokenWorkspaceIds: undefined,
    userId,
  });
  const accessibleWorkspaces = await loadAccessibleMcpWorkspaces({
    organizationId,
    scopedDb: bootstrapScope.scopedDb,
  });
  const usableWorkspaces = filterUsableMcpWorkspaces({
    accessibleWorkspaces,
    tokenWorkspaceIds,
  });
  const usableWorkspaceIds = usableWorkspaces.map((workspace) => workspace.id);
  const workspaceAccessBoundary =
    createWorkspaceAccessBoundary(usableWorkspaceIds);
  const hasTokenWorkspaceAttenuation = tokenWorkspaceIds !== undefined;

  const createOperationDatabaseScope = () => {
    const serverValidatedWorkspaceIds: SafeId<"workspace">[] = [];
    const pinServerValidatedWorkspaceId =
      workspaceAccessBoundary.bindWorkspacePin((workspaceId) => {
        if (
          !hasTokenWorkspaceAttenuation &&
          !serverValidatedWorkspaceIds.includes(workspaceId)
        ) {
          serverValidatedWorkspaceIds.push(workspaceId);
        }
        return true;
      });
    return {
      pinServerValidatedWorkspaceId,
      ...createMcpOperationDatabases(rlsDatabase, {
        deadline: TRANSACTION_DEADLINE.request,
        organizationId,
        serverValidatedWorkspaceIds,
        tokenWorkspaceIds: hasTokenWorkspaceAttenuation
          ? usableWorkspaceIds
          : undefined,
        userId,
      }),
    };
  };

  const requestDatabaseScope = createOperationDatabaseScope();
  const featureAccessSnapshot = featureAccessSnapshotFromAuthorization({
    organizationId,
    userId,
    authorization,
  });

  return {
    accessibleWorkspaceIds: usableWorkspaceIds,
    accessibleWorkspaceIdSet: workspaceAccessBoundary.accessibleWorkspaceIdSet,
    accessibleWorkspaceStatusById: new Map(
      usableWorkspaces.map((workspace) => [workspace.id, workspace.status]),
    ),
    accessibleWorkspaces: usableWorkspaces,
    billingAccess: authorization.billingAccess,
    createOperationDatabaseScope,
    featureAccessSnapshot,
    grantedScopes,
    memberRole: authorization.role,
    organizationId,
    pinServerValidatedWorkspaceId:
      requestDatabaseScope.pinServerValidatedWorkspaceId,
    recordAuditEvent,
    ...(request === undefined ? {} : { request }),
    safeDb: requestDatabaseScope.safeDb,
    scopedDb: requestDatabaseScope.scopedDb,
    toolConfirmation,
    userId,
    userEmail: authorization.email,
  };
};

export type HttpSecurityPrincipalOptions = {
  db: TestDatabase;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  workspaceId?: SafeId<"workspace">;
  audit?: TestHandlerContextOverrides["audit"];
  overrides?: Omit<
    TestHandlerContextOverrides,
    | "audit"
    | "safeDb"
    | "scopedDb"
    | "memberRole"
    | "session"
    | "user"
    | "getAccessibleWorkspaces"
    | "getActiveWorkspaceIds"
    | "getWorkspaceAccess"
    | "pinServerValidatedWorkspaceId"
  >;
};

export type HttpSecurityPrincipalContext = BaseTestHandlerContext & {
  featureAccessSnapshot: FeatureAccessSnapshot;
};

/**
 * Build an HTTP safe-handler context backed by `resolveMemberAuthorization`,
 * `featureAccessSnapshotFromAuthorization`, and `createMcpOperationDatabases`.
 */
export const buildHttpSecurityPrincipal = async ({
  db,
  organizationId,
  userId,
  workspaceId,
  audit = noopAuditRecorder,
  overrides,
}: HttpSecurityPrincipalOptions): Promise<HttpSecurityPrincipalContext> => {
  const authorization = await resolveMemberAuthorization(
    {
      authentication: { kind: "credential" },
      organizationId,
      userId,
      ...(workspaceId === undefined ? {} : { workspaceId }),
    },
    db,
  );
  if (!authorization || authorization.userDeleted) {
    return panic(
      `Security principal ${userId} is not an active member of organization ${organizationId}`,
    );
  }
  if (!isMemberRole(authorization.role)) {
    return panic(
      `Security principal ${userId} has invalid member role: ${authorization.role}`,
    );
  }

  const rlsDatabase = adaptTestRlsDb(db);
  const serverValidatedWorkspaceIds: SafeId<"workspace">[] =
    authorization.workspace ? [authorization.workspace.id] : [];
  const validatedWorkspaceIdSet = new Set<string>(serverValidatedWorkspaceIds);

  const { safeDb, scopedDb } = createMcpOperationDatabases(rlsDatabase, {
    deadline: TRANSACTION_DEADLINE.request,
    organizationId,
    serverValidatedWorkspaceIds,
    tokenWorkspaceIds: undefined,
    userId,
  });

  let accessibleWorkspacesPromise: Promise<AccessibleWorkspace[]> | null = null;
  const getAccessibleWorkspaces = async (): Promise<AccessibleWorkspace[]> => {
    accessibleWorkspacesPromise ??= loadAccessibleMcpWorkspaces({
      organizationId,
      scopedDb,
    }).then((items) => {
      for (const item of items) {
        validatedWorkspaceIdSet.add(item.id);
      }
      return items;
    });
    return await accessibleWorkspacesPromise;
  };

  const getActiveWorkspaceIds = async (): Promise<SafeId<"workspace">[]> => {
    const workspaces = await getAccessibleWorkspaces();
    return workspaces
      .filter((item) => item.status === "active")
      .map((item) => item.id);
  };

  const getWorkspaceAccess = async (
    targetWorkspaceId: SafeId<"workspace">,
  ): Promise<AccessibleWorkspace | null> => {
    const workspaces = await getAccessibleWorkspaces();
    return workspaces.find((item) => item.id === targetWorkspaceId) ?? null;
  };

  const pinServerValidatedWorkspaceId = (
    targetWorkspaceId: SafeId<"workspace">,
  ): boolean => {
    if (!validatedWorkspaceIdSet.has(targetWorkspaceId)) {
      return false;
    }
    if (!serverValidatedWorkspaceIds.includes(targetWorkspaceId)) {
      serverValidatedWorkspaceIds.push(targetWorkspaceId);
    }
    return true;
  };

  const featureAccessSnapshot = featureAccessSnapshotFromAuthorization({
    organizationId,
    userId,
    authorization,
  });

  return createTestHandlerContext<HttpSecurityPrincipalContext>({
    ...overrides,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    audit,
    featureAccessSnapshot,
    safeDb,
    scopedDb,
    memberRole: sessionMemberRole(
      authorization.role,
      authorization.billingAccess,
    ),
    session: { activeOrganizationId: organizationId },
    user: { id: userId, email: authorization.email },
    getAccessibleWorkspaces,
    getActiveWorkspaceIds,
    getWorkspaceAccess,
    pinServerValidatedWorkspaceId,
  });
};
