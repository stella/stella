import { panic, Result } from "better-result";
import { eq } from "drizzle-orm";

import type { getLawTextBlock, searchConsolidatedLegislation } from "@stll/boe";
import type { PermissionInput } from "@stll/permissions";

import { rlsDb } from "@/api/db/root";
import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { workspaces } from "@/api/db/schema";
import {
  createMembershipSafeDb,
  createMembershipScopedDb,
  createSafeDb,
  createScopedDb,
} from "@/api/db/scoped";
import type { readGatedDecisionWithDocument } from "@/api/handlers/case-law/decisions/get-deferred-document";
import type { searchDecisionsHandler } from "@/api/handlers/case-law/decisions/search";
import type { configureTemplateFields } from "@/api/handlers/templates/configure-template-fields-service";
import type { createTimeEntryHandler } from "@/api/handlers/time-entries/create";
import type { readWorkspaceHandler } from "@/api/handlers/workspaces/get";
import type { readOverviewHandler } from "@/api/handlers/workspaces/read-overview";
import type { readWorkspaceContactsHandler } from "@/api/handlers/workspaces/workspace-contacts-read";
import type { readWorkspaceMembersHandler } from "@/api/handlers/workspaces/workspace-members-read";
import { resolveAgentAuditExecution } from "@/api/lib/agent-audit-principal";
import type {
  loadOrgAIConfig,
  loadOrgSettingsForAuth,
} from "@/api/lib/ai-config-loader";
import type { loadAnonymizationAllowlistCanonicalsByWorkspace } from "@/api/lib/anonymization-allowlist";
import type { loadAnonymizationGazetteerEntriesByWorkspace } from "@/api/lib/anonymization-blacklist";
import { createAuditRecorder } from "@/api/lib/audit-log";
import type { AuditExecutionContext, AuditRecorder } from "@/api/lib/audit-log";
import { resolveMemberAuthorization } from "@/api/lib/auth";
import type { AccessibleWorkspace } from "@/api/lib/auth";
import type { SafeId } from "@/api/lib/branded-types";
import {
  enabledRegistryHandlersForOrg,
  type BusinessRegistrySlug,
  type executeRegistryLookup,
} from "@/api/lib/business-registries/dispatch";
import type { loadLatestApprovedVersion } from "@/api/lib/document-review/approved-playbook-versions";
import type { createPlaybookTableRuns } from "@/api/lib/document-review/table-run-create";
import { getDisabledNativeToolSlugsFromSettingsRow } from "@/api/lib/mcp-connectors/catalog-metadata";
import { isMemberRole } from "@/api/lib/member-roles";
import type { MemberRole } from "@/api/lib/member-roles";
import {
  brandActorSessionIdentity,
  brandPersistedWorkspaceId,
} from "@/api/lib/safe-id-boundaries";
import type { getSearchProvider } from "@/api/lib/search/provider";
import type { createStoredTemplate } from "@/api/lib/templates/create-template";
import type {
  recordTemplateFill,
  recordTemplateUse,
} from "@/api/lib/templates/record-use";
import type {
  describeStoredTemplate,
  fillStoredTemplateDocx,
  fillStoredTemplateWithText,
  fillStoredTemplateWithTextStrict,
} from "@/api/lib/templates/template-fill-service";
import type { withTimeout } from "@/api/lib/with-timeout";
import type { startWorkflow } from "@/api/lib/workflow-queue";
import type { materializePlaybookRun } from "@/api/lib/workflow/materialize-playbook-run";
import type { anonymizeTextFields } from "@/api/mcp/anonymization";
import type { McpSession } from "@/api/mcp/auth";
import type { consumeInvokeCapabilityRateLimit } from "@/api/mcp/capability-rate-limit";
import { McpOrganizationAccessError } from "@/api/mcp/errors";
import type {
  claimTemplatePersistenceRequest,
  fingerprintTemplatePersistenceRequest,
  persistFilledTemplateDocument,
  persistFilledTemplateVersion,
  recordTemplatePersistenceReceipt,
  releaseTemplatePersistenceClaim,
} from "@/api/mcp/template-persistence";
import { createWorkspaceAccessBoundary } from "@/api/mcp/workspace-access-boundary";
import { filterUsableMcpWorkspaces } from "@/api/mcp/workspace-session-scope";

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
  /** Explicit seams used by focused MCP tests; production contexts leave these unset. */
  testDependencies?: {
    loadOrgSettingsForAuth?: typeof loadOrgSettingsForAuth;
    loadOrgAIConfig?: typeof loadOrgAIConfig;
    configureTemplateFields?: typeof configureTemplateFields;
    consumeInvokeCapabilityRateLimit?: typeof consumeInvokeCapabilityRateLimit;
    isCapabilityFeatureEnabled?: (feature: string | undefined) => boolean;
    contextFidelityWaivers?: ReadonlyMap<string, string>;
    materializePlaybookRun?: typeof materializePlaybookRun;
    startWorkflow?: typeof startWorkflow;
    loadLatestApprovedVersion?: typeof loadLatestApprovedVersion;
    createPlaybookTableRuns?: typeof createPlaybookTableRuns;
    createTimeEntryHandler?: typeof createTimeEntryHandler;
    searchDecisionsHandler?: typeof searchDecisionsHandler;
    readGatedDecisionWithDocument?: typeof readGatedDecisionWithDocument;
    readWorkspaceHandler?: typeof readWorkspaceHandler;
    readOverviewHandler?: typeof readOverviewHandler;
    readWorkspaceContactsHandler?: typeof readWorkspaceContactsHandler;
    readWorkspaceMembersHandler?: typeof readWorkspaceMembersHandler;
    getSearchProvider?: typeof getSearchProvider;
    describeStoredTemplate?: typeof describeStoredTemplate;
    executeRegistryLookup?: typeof executeRegistryLookup;
    searchConsolidatedLegislation?: typeof searchConsolidatedLegislation;
    getLawTextBlock?: typeof getLawTextBlock;
    withTimeout?: typeof withTimeout;
    anonymizeTextFields?: typeof anonymizeTextFields;
    loadAnonymizationAllowlistCanonicalsByWorkspace?: typeof loadAnonymizationAllowlistCanonicalsByWorkspace;
    loadAnonymizationGazetteerEntriesByWorkspace?: typeof loadAnonymizationGazetteerEntriesByWorkspace;
    fillStoredTemplateDocx?: typeof fillStoredTemplateDocx;
    fillStoredTemplateWithText?: typeof fillStoredTemplateWithText;
    fillStoredTemplateWithTextStrict?: typeof fillStoredTemplateWithTextStrict;
    createStoredTemplate?: typeof createStoredTemplate;
    recordTemplateFill?: typeof recordTemplateFill;
    recordTemplateUse?: typeof recordTemplateUse;
    claimTemplatePersistenceRequest?: typeof claimTemplatePersistenceRequest;
    fingerprintTemplatePersistenceRequest?: typeof fingerprintTemplatePersistenceRequest;
    persistFilledTemplateDocument?: typeof persistFilledTemplateDocument;
    persistFilledTemplateVersion?: typeof persistFilledTemplateVersion;
    recordTemplatePersistenceReceipt?: typeof recordTemplatePersistenceReceipt;
    releaseTemplatePersistenceClaim?: typeof releaseTemplatePersistenceClaim;
  };
  auditExecution?: AuditExecutionContext;
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
  /** Resolved transport client IP used by shared gateway/REST abuse budgets. */
  clientIp?: string | null;
  /**
   * The credential's own permission set, when it carries one (machine API
   * keys). Authorization ANDs it with `memberRole` through
   * `hasEffectiveAuthority`; absent means the credential is bounded by its role
   * alone, which is the JWT bearer case.
   */
  credentialPermissions?: PermissionInput | undefined;
  /**
   * OAuth scopes granted to this session (the access token's `scope` claim).
   * `invoke_capability` gates each capability on its catalog scope against this
   * list; the session-authed chat projection has no OAuth scopes and passes an
   * empty list (it never dispatches the generic path).
   */
  grantedScopes: readonly string[];
  /**
   * Registry slugs this org may actually call (deployment-shipped AND enabled
   * for the org). The `lookup_business_registry` list projection narrows its
   * `registry` enum to these and drops the tool when empty, mirroring the
   * in-app chat tool so the MCP surface never advertises a registry the
   * call-time gate would 403. Computed once here from `organization_settings`.
   *
   * `undefined` means "not resolved" (a synthetic/test context, or a settings
   * read fault): the projection then leaves the full enum advertised and the
   * call-time gate stays the backstop. It is NOT the same as an empty array,
   * which means the org can reach no registry and the tool is dropped.
   */
  enabledRegistrySlugs?: readonly BusinessRegistrySlug[] | undefined;
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

/**
 * Bind a confirmed MCP call to the authenticated user's approval. Transport
 * contexts carry the request needed to rebuild the recorder; chat contexts
 * already receive a recorder whose approval was resolved by the chat gate.
 */
export const bindApprovedMcpAuditContext = (
  context: McpRequestContext,
): McpRequestContext => {
  if (context.request === undefined) {
    return context;
  }

  const currentExecution = context.auditExecution;
  const auditExecution: AuditExecutionContext = {
    performer: currentExecution?.performer ?? {
      id: context.userId,
      type: "user",
    },
    trigger: currentExecution?.trigger ?? { type: "direct" },
    ...(currentExecution?.runId === undefined
      ? {}
      : { runId: currentExecution.runId }),
    approval: {
      status: "approved",
      userId: context.userId,
    },
  };

  return {
    ...context,
    auditExecution,
    recordAuditEvent: createAuditRecorder({
      execution: auditExecution,
      organizationId: context.organizationId,
      request: context.request,
      server: null,
      userId: context.userId,
      workspaceId: null,
    }),
  };
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
  { clientIp = null, request }: { clientIp?: string | null; request: Request },
): Promise<McpRequestContext> => {
  const { organizationId, userId } = brandActorSessionIdentity({
    organizationId: session.organizationId,
    userId: session.userId,
  });
  const auditExecution = await resolveAgentAuditExecution({
    credential: session.credential,
    organizationId,
    userId,
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
  const usableWorkspaces = filterUsableMcpWorkspaces({
    accessibleWorkspaces,
    tokenWorkspaceIds: session.workspaceIds,
  });
  const usableWorkspaceIds = usableWorkspaces.map((workspace) =>
    brandPersistedWorkspaceId(workspace.id),
  );
  const workspaceAccessBoundary =
    createWorkspaceAccessBoundary(usableWorkspaceIds);
  const hasTokenWorkspaceAttenuation = session.workspaceIds !== undefined;
  const createOperationDatabaseScope = (): McpOperationDatabaseScope => {
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

    // A workspace_ids claim is a signed attenuation boundary, not just a
    // tool-discovery hint. After intersecting it with live authorization
    // above, carry that exact subset into RLS explicit mode so root/list
    // queries cannot see another workspace through ordinary membership.
    if (hasTokenWorkspaceAttenuation) {
      return {
        pinServerValidatedWorkspaceId,
        safeDb: createSafeDb(rlsDb, usableWorkspaceIds, organizationId, userId),
        scopedDb: createScopedDb(
          rlsDb,
          usableWorkspaceIds,
          organizationId,
          userId,
        ),
      };
    }

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

  // Resolve the org's reachable registries once, so the tools/list projection
  // can narrow the `lookup_business_registry` enum synchronously. On a read
  // fault, leave it unresolved (undefined) rather than dropping the tool.
  const settingsResult = await requestDatabaseScope.safeDb((tx) =>
    tx.query.organizationSettings.findFirst({
      where: { organizationId: { eq: organizationId } },
      columns: { practiceJurisdictions: true, nativeToolOverrides: true },
    }),
  );
  const enabledRegistrySlugs: readonly BusinessRegistrySlug[] | undefined =
    Result.isError(settingsResult)
      ? undefined
      : enabledRegistryHandlersForOrg(
          getDisabledNativeToolSlugsFromSettingsRow(
            settingsResult.value ?? undefined,
          ),
        ).map((handler) => handler.slug);

  return {
    ...(auditExecution ? { auditExecution } : {}),
    accessibleWorkspaceIds: usableWorkspaceIds,
    accessibleWorkspaceIdSet: workspaceAccessBoundary.accessibleWorkspaceIdSet,
    accessibleWorkspaceStatusById: new Map(
      usableWorkspaces.map((workspace) => [workspace.id, workspace.status]),
    ),
    accessibleWorkspaces: usableWorkspaces,
    clientIp,
    createOperationDatabaseScope,
    ...(session.credential?.type === "machine_api_key"
      ? { credentialPermissions: session.credential.permissions }
      : {}),
    enabledRegistrySlugs,
    grantedScopes: session.scopes,
    memberRole,
    organizationId,
    request,
    recordAuditEvent: createAuditRecorder({
      ...(auditExecution ? { execution: auditExecution } : {}),
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
