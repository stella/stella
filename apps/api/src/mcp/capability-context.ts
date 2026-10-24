import { panic } from "better-result";

import { createResponseSet } from "@/api/http/context";
import type { HandlerContext } from "@/api/http/context";
import type { RawHeaders } from "@/api/http/route-input";
import { status } from "@/api/http/status";
import { loadOrgSettingsForAuth } from "@/api/lib/ai-config-loader";
import { createAuditRecorder } from "@/api/lib/audit-log";
import type {
  AuditRecorderFactory,
  MemberCaller,
  WorkspaceCaller,
} from "@/api/lib/auth/member-caller";
import type { SafeId } from "@/api/lib/branded-types";
import { capabilityRoute } from "@/api/lib/capability-route";
import type { McpRequestContext } from "@/api/mcp/context";
import { mcpMemberAuthority } from "@/api/mcp/effective-authority";
import { bindWorkspaceRecorder } from "@/api/mcp/tool-utils";

/**
 * What a capability's handler is given through MCP: the context a route
 * handler sees, built from the gateway request and the decoded input, plus the
 * member (and matter) the MCP session proved. These are the types a REST
 * request produces, so a handler cannot rely on a field one transport omits.
 * The response `set` is a fresh one the capability executors never read: a
 * handler that answers through headers is refused before it runs (see the
 * context-fidelity waivers).
 */
export type CapabilityHandlerContext = HandlerContext<
  unknown,
  unknown,
  unknown,
  RawHeaders
> &
  MemberCaller &
  Partial<WorkspaceCaller>;

const recorderFactory =
  (
    context: McpRequestContext,
    request: Request,
    defaultWorkspaceId: SafeId<"workspace"> | null,
  ): AuditRecorderFactory =>
  (opts) => {
    const execution = opts?.execution ?? context.auditExecution;
    return createAuditRecorder({
      ...(execution === undefined ? {} : { execution }),
      organizationId: context.organizationId,
      userId: context.userId,
      request,
      server: null,
      workspaceId:
        opts && "workspaceId" in opts
          ? (opts.workspaceId ?? null)
          : defaultWorkspaceId,
    });
  };

/**
 * The member an MCP session proved, in the shape a browser session proves
 * one. Identity and databases are rebound to an operation-local authorization
 * snapshot, the member role carries the credential's own permission set
 * (`mcpMemberAuthority`), and the org AI config is loaded on an actual invoke
 * only (one indexed `organization_settings` read).
 */
const mcpMemberCaller = async (
  context: McpRequestContext,
  request: Request,
): Promise<MemberCaller> => {
  // Executable gateway contexts must provide an operation-local scope. The
  // session-authenticated chat projection omits it because that surface never
  // dispatches generic capabilities; reaching this path without one is an
  // internal wiring error, not a reason to fall back to revocation-unstable DB
  // handles.
  const operationDatabaseScope = context.createOperationDatabaseScope?.();
  if (!operationDatabaseScope) {
    panic("Executable MCP context is missing an operation database scope");
  }
  const featureAccessSnapshot =
    context.testDependencies?.featureAccessSnapshot ??
    context.featureAccessSnapshot;
  const reader = {
    organizationId: context.organizationId,
    userId: context.userId,
  };
  const {
    orgAIConfig,
    orgAIConfigStatus,
    promptCachingEnabled,
    managedAIResidency,
  } = await (context.testDependencies?.loadOrgSettingsForAuth?.(reader) ??
    operationDatabaseScope.scopedDb(
      async (tx) => await loadOrgSettingsForAuth(tx, reader),
    ));

  return {
    user: { id: context.userId, email: context.userEmail },
    session: { id: null, activeOrganizationId: context.organizationId },
    ...(featureAccessSnapshot === undefined ? {} : { featureAccessSnapshot }),
    scopedDb: operationDatabaseScope.scopedDb,
    safeDb: operationDatabaseScope.safeDb,
    getActiveWorkspaceIds: async () =>
      await Promise.resolve(context.accessibleWorkspaceIds),
    getAccessibleWorkspaces: async () =>
      await Promise.resolve(context.accessibleWorkspaces),
    getWorkspaceAccess: async (workspaceId) => {
      const workspaceStatus =
        context.accessibleWorkspaceStatusById.get(workspaceId);
      if (
        workspaceStatus &&
        !operationDatabaseScope.pinServerValidatedWorkspaceId(workspaceId)
      ) {
        panic("Capability target was not present in the MCP access map");
      }
      return await Promise.resolve(
        workspaceStatus ? { id: workspaceId, status: workspaceStatus } : null,
      );
    },
    pinServerValidatedWorkspaceId:
      operationDatabaseScope.pinServerValidatedWorkspaceId,
    // The credential's attenuation travels with the role, so every check the
    // handler makes spends only what this credential was granted.
    memberRole: mcpMemberAuthority(context),
    orgAIConfig,
    orgAIConfigStatus,
    promptCachingEnabled,
    managedAIResidency,
    recordAuditEvent: context.recordAuditEvent,
    createAuditRecorder: recorderFactory(context, request, null),
  };
};

/**
 * The context an enumerated capability's handler runs with. `workspaceId` is
 * set only for workspace-kind capabilities, after the executor proved the
 * matter is one this session may use; its audit recorder defaults to that
 * matter, as a REST workspace route's does.
 */
export const capabilityHandlerContext = async ({
  capabilityId,
  context,
  input,
  request,
  workspaceId,
}: {
  capabilityId: string;
  context: McpRequestContext;
  input: { body: unknown; params: unknown; query: unknown };
  request: Request;
  workspaceId: SafeId<"workspace"> | undefined;
}): Promise<CapabilityHandlerContext> => {
  const member = await mcpMemberCaller(context, request);
  if (
    workspaceId !== undefined &&
    !member.pinServerValidatedWorkspaceId(workspaceId)
  ) {
    panic("Capability workspace was not present in the MCP access map");
  }
  const workspace: WorkspaceCaller | undefined =
    workspaceId === undefined
      ? undefined
      : {
          workspaceId,
          recordAuditEvent: bindWorkspaceRecorder(context, workspaceId),
          createAuditRecorder: recorderFactory(context, request, workspaceId),
        };

  return {
    request,
    server: null,
    path: new URL(request.url).pathname,
    route: capabilityRoute(capabilityId),
    routeEntry: undefined,
    set: createResponseSet(),
    params: input.params,
    query: input.query,
    body: input.body,
    headers: {},
    status,
    ...member,
    ...workspace,
  };
};
