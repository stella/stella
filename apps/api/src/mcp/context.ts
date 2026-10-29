import { panic, Result } from "better-result";

import type { getLawTextBlock, searchConsolidatedLegislation } from "@stll/boe";
import type { runEntityCheck } from "@stll/business-registries/entity-checks";
import type { PermissionInput } from "@stll/permissions";
import type { listSkillMetadata } from "@stll/skills";

import { rlsDb } from "@/api/db/root";
import type { SafeDb, SafeDbError, ScopedDb } from "@/api/db/safe-db";
import {
  createMembershipSafeDb,
  createMembershipScopedDb,
  createSafeDb,
  createScopedDb,
} from "@/api/db/scoped";
import type { readGatedDecisionCitationDigest } from "@/api/handlers/case-law/decisions/citation-digest";
import type { readGatedDecisionCitations } from "@/api/handlers/case-law/decisions/citation-passages";
import type { readCaseLawCoverageHandler } from "@/api/handlers/case-law/decisions/coverage";
import type {
  readGatedDecisionWithDocument,
  readsSharedPublicLawCorpus,
} from "@/api/handlers/case-law/decisions/get-deferred-document";
import type { readDecisionReaderSource } from "@/api/handlers/case-law/decisions/reader";
import type {
  listCaseLawProvisionDecisions,
  searchDecisionsHandler,
} from "@/api/handlers/case-law/decisions/search";
import type { resolveAnnotationTarget } from "@/api/handlers/legal-reader/annotations/document-blocks";
import type { admitLawRead } from "@/api/handlers/legal-resolve/admission";
import type { resolveDecision } from "@/api/handlers/legal-resolve/decision";
import type { resolveLawCitation } from "@/api/handlers/legal-resolve/law";
import type {
  resolveStatuteExpression,
  resolveStatuteWorkVersion,
} from "@/api/handlers/legislation/by-eli";
import type { readPublicLegislationHandler } from "@/api/handlers/legislation/get";
import type { readProvisionHistoryHandler } from "@/api/handlers/legislation/provision-history";
import type { readProvisionPreviewHandler } from "@/api/handlers/legislation/provision-preview";
import type { readLegislationProvisionVersions } from "@/api/handlers/legislation/provision-versions";
import type { searchLegislationHandler } from "@/api/handlers/legislation/search";
import type { listStatuteVersionsHandler } from "@/api/handlers/legislation/versions";
import type { configureTemplateFields } from "@/api/handlers/templates/configure-template-fields-service";
import type { readWorkspaceHandler } from "@/api/handlers/workspaces/get";
import type { readOverviewHandler } from "@/api/handlers/workspaces/read-overview";
import type { readWorkspaceContactsHandler } from "@/api/handlers/workspaces/workspace-contacts-read";
import type { readWorkspaceMembersHandler } from "@/api/handlers/workspaces/workspace-members-read";
import { resolveAgentAuditExecution } from "@/api/lib/agent-audit-principal";
import type {
  loadManagedAIResidency,
  loadOrgAIConfig,
  OrgAIConfigReader,
  OrgSettingsForAuth,
} from "@/api/lib/ai-config-loader";
import type { loadAnonymizationAllowlistCanonicalsByWorkspace } from "@/api/lib/anonymization-allowlist";
import type { loadAnonymizationGazetteerEntriesByWorkspace } from "@/api/lib/anonymization-blacklist";
import { createAuditRecorder } from "@/api/lib/audit-log";
import type { AuditExecutionContext, AuditRecorder } from "@/api/lib/audit-log";
import {
  featureAccessSnapshotFromAuthorization,
  resolveCredentialMemberAuthorization,
} from "@/api/lib/auth";
import type { AccessibleWorkspace } from "@/api/lib/auth/accessible-workspace";
import type { safeOutboundFetchBytes } from "@/api/lib/auth/authorized-outbound-fetch";
import { checkDemoAccountOperation } from "@/api/lib/auth/demo-account";
import type { ResolveCredentialMemberAuthorization } from "@/api/lib/auth/member-authorization";
import { checkReviewAccountOrganization } from "@/api/lib/auth/review-account";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import type { ThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import type { createTimeEntryHandler } from "@/api/lib/billing/time-entry-insert";
import type { SafeId } from "@/api/lib/branded-types";
import {
  availableRegistryHandlersForOrg,
  getOrganizationRegistryDispatch,
} from "@/api/lib/business-registries/credentials";
import type {
  BusinessRegistrySlug,
  executeRegistryLookup,
} from "@/api/lib/business-registries/dispatch";
import type { runSanctionsCheck } from "@/api/lib/business-registries/sanctions-check";
import type {
  readCaseLawProvisionScope,
  readProvisionWorkLinked,
} from "@/api/lib/case-law/provision-filter";
import type { CaseLawSearchGuidanceMode } from "@/api/lib/case-law/search-guidance-mode";
import type { loadLatestApprovedVersion } from "@/api/lib/document-review/approved-playbook-versions";
import type { createPlaybookTableRuns } from "@/api/lib/document-review/table-run-create";
import {
  type ReadOutcome,
  readPresent,
  readUnavailable,
} from "@/api/lib/errors/read-outcome";
import type { FeatureAccessSnapshot } from "@/api/lib/feature-access/policy";
import type { CorpusIndexQueryVariant } from "@/api/lib/legal-search/corpus-query-variant-policy";
import type { readVersionBlocks } from "@/api/lib/legal-search/legislation-version-blocks";
import { getDisabledNativeToolSlugsFromSettingsRow } from "@/api/lib/mcp-connectors/catalog-metadata";
import { isMemberRole } from "@/api/lib/member-roles";
import type { MemberRole } from "@/api/lib/member-roles";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import type { withMcpPublicReadAdmission } from "@/api/lib/rate-limit/mcp-public-read-admission";
import {
  brandActorSessionIdentity,
  brandPersistedWorkspaceId,
} from "@/api/lib/safe-id-boundaries";
import type { getSearchReader } from "@/api/lib/search/provider";
import type { createStoredTemplate } from "@/api/lib/templates/create-template";
import type {
  recordTemplateFill,
  recordTemplateUse,
} from "@/api/lib/templates/record-use";
import type { renameStoredTemplate } from "@/api/lib/templates/rename-template";
import type {
  decideTemplateConditions,
  templateDecideConditionsLogic,
} from "@/api/lib/templates/template-decide-conditions";
import type {
  describeStoredTemplate,
  fillStoredTemplateDocx,
  fillStoredTemplateWithText,
  fillStoredTemplateWithTextStrict,
} from "@/api/lib/templates/template-fill-service";
import type { writeStoredTemplate } from "@/api/lib/templates/write-template";
import {
  type OrgWebSearchKeyRow,
  resolveWebSearchProvidersResultFromOrgSettingsRow,
} from "@/api/lib/web-search/load-org-keys";
import type { WebSearchProvider } from "@/api/lib/web-search/types";
import type { withTimeout } from "@/api/lib/with-timeout";
import type { startWorkflow } from "@/api/lib/workflow-queue";
import type { materializePlaybookRun } from "@/api/lib/workflow/materialize-playbook-run";
import { readAuthorizedWorkspaces } from "@/api/lib/workspaces/authorized-workspace-ids";
import type { anonymizeTextFields } from "@/api/mcp/anonymization";
import type { McpCredentialType, McpSession } from "@/api/mcp/auth";
import type { consumeInvokeCapabilityRateLimit } from "@/api/mcp/capability-rate-limit";
import { McpOrganizationAccessError } from "@/api/mcp/errors";
import type { McpFeatureAccessBindings } from "@/api/mcp/feature-access";
import type {
  claimTemplatePersistenceRequest,
  fingerprintTemplatePersistenceRequest,
  persistFilledTemplateDocument,
  persistFilledTemplateVersion,
  recordTemplatePersistenceReceipt,
  releaseTemplatePersistenceClaim,
} from "@/api/mcp/template-persistence";
import { TOOL_CONFIRMATION } from "@/api/mcp/tool-confirmation";
import type { ToolConfirmation } from "@/api/mcp/tool-confirmation";
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

export type McpRequestDataAccess = Pick<
  McpOperationDatabaseScope,
  "safeDb" | "scopedDb"
>;

export type McpRequestContext = {
  /** Explicit seams used by focused MCP tests; production contexts leave these unset. */
  featureAccessSnapshot?: FeatureAccessSnapshot | undefined;
  testDependencies?: {
    admitPublicRead?: typeof withMcpPublicReadAdmission;
    featureAccessSnapshot?: FeatureAccessSnapshot | undefined;
    featureAccessBindings?: McpFeatureAccessBindings | undefined;
    /** Replaces the scoped `organization_settings` read, transaction included. */
    loadOrgSettingsForAuth?: (
      reader: OrgAIConfigReader,
    ) => Promise<OrgSettingsForAuth>;
    loadManagedAIResidency?: (
      organizationId: SafeId<"organization">,
    ) => ReturnType<typeof loadManagedAIResidency>;
    /** Replaces the scoped AI-config read, transaction included. */
    loadOrgAIConfig?: (
      reader: OrgAIConfigReader,
    ) => ReturnType<typeof loadOrgAIConfig>;
    configureTemplateFields?: typeof configureTemplateFields;
    consumeInvokeCapabilityRateLimit?: typeof consumeInvokeCapabilityRateLimit;
    isCapabilityFeatureEnabled?: (feature: string | undefined) => boolean;
    contextFidelityWaivers?: ReadonlyMap<string, string>;
    /** Replaces the shipped skill catalog, for a skill shape no shipped skill has yet. */
    listShippedSkillMetadata?: typeof listSkillMetadata;
    materializePlaybookRun?: typeof materializePlaybookRun;
    startWorkflow?: typeof startWorkflow;
    loadLatestApprovedVersion?: typeof loadLatestApprovedVersion;
    createPlaybookTableRuns?: typeof createPlaybookTableRuns;
    createTimeEntryHandler?: typeof createTimeEntryHandler;
    readCaseLawCoverageHandler?: typeof readCaseLawCoverageHandler;
    searchDecisionsHandler?: typeof searchDecisionsHandler;
    listCaseLawProvisionDecisions?: typeof listCaseLawProvisionDecisions;
    /** Reads a provision's citing set once per agent search. */
    readCaseLawProvisionScope?: (
      scope: Omit<Parameters<typeof readCaseLawProvisionScope>[1], "idSetMax">,
    ) => ReturnType<typeof readCaseLawProvisionScope>;
    /** Whether any recorded link names the provision's act. */
    readProvisionWorkLinked?: (
      scope: Parameters<typeof readProvisionWorkLinked>[1],
    ) => ReturnType<typeof readProvisionWorkLinked>;
    corpusIndexQueryVariant?: CorpusIndexQueryVariant;
    caseLawSearchGuidance?: CaseLawSearchGuidanceMode;
    /** Every court spelling one corpus country holds, for reading a court filter. */
    readCaseLawCourtNames?: (country: string) => Promise<readonly string[]>;
    readGatedDecisionCitations?: typeof readGatedDecisionCitations;
    readGatedDecisionCitationDigest?: typeof readGatedDecisionCitationDigest;
    admitLawRead?: typeof admitLawRead;
    resolveDecision?: typeof resolveDecision;
    resolveLawCitation?: typeof resolveLawCitation;
    readGatedDecisionWithDocument?: typeof readGatedDecisionWithDocument;
    readDecisionReaderSource?: typeof readDecisionReaderSource;
    readProvisionPreviewHandler?: typeof readProvisionPreviewHandler;
    readsSharedPublicLawCorpus?: typeof readsSharedPublicLawCorpus;
    searchLegislationHandler?: typeof searchLegislationHandler;
    resolveStatuteExpression?: typeof resolveStatuteExpression;
    resolveStatuteWorkVersion?: typeof resolveStatuteWorkVersion;
    readPublicLegislationHandler?: typeof readPublicLegislationHandler;
    listStatuteVersionsHandler?: typeof listStatuteVersionsHandler;
    readProvisionHistoryHandler?: typeof readProvisionHistoryHandler;
    readLegislationProvisionVersions?: typeof readLegislationProvisionVersions;
    readVersionBlocks?: typeof readVersionBlocks;
    resolveAnnotationTarget?: typeof resolveAnnotationTarget;
    readWorkspaceHandler?: typeof readWorkspaceHandler;
    readOverviewHandler?: typeof readOverviewHandler;
    readWorkspaceContactsHandler?: typeof readWorkspaceContactsHandler;
    readWorkspaceMembersHandler?: typeof readWorkspaceMembersHandler;
    getSearchReader?: typeof getSearchReader;
    describeStoredTemplate?: typeof describeStoredTemplate;
    executeRegistryLookup?: typeof executeRegistryLookup;
    runEntityCheck?: typeof runEntityCheck;
    runSanctionsCheck?: typeof runSanctionsCheck;
    searchConsolidatedLegislation?: typeof searchConsolidatedLegislation;
    getLawTextBlock?: typeof getLawTextBlock;
    withTimeout?: typeof withTimeout;
    anonymizeTextFields?: typeof anonymizeTextFields;
    loadAnonymizationAllowlistCanonicalsByWorkspace?: typeof loadAnonymizationAllowlistCanonicalsByWorkspace;
    loadAnonymizationGazetteerEntriesByWorkspace?: typeof loadAnonymizationGazetteerEntriesByWorkspace;
    templateDecideConditionsLogic?: typeof templateDecideConditionsLogic;
    decideTemplateConditions?: typeof decideTemplateConditions;
    fillStoredTemplateDocx?: typeof fillStoredTemplateDocx;
    fillStoredTemplateWithText?: typeof fillStoredTemplateWithText;
    fillStoredTemplateWithTextStrict?: typeof fillStoredTemplateWithTextStrict;
    createStoredTemplate?: typeof createStoredTemplate;
    renameStoredTemplate?: typeof renameStoredTemplate;
    writeStoredTemplate?: typeof writeStoredTemplate;
    safeOutboundFetchBytes?: typeof safeOutboundFetchBytes;
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
   * core's `authorizeWorkspace`, which 404s a workspace whose status the route
   * does not admit ("active" unless it admits archived matters).
   */
  accessibleWorkspaceStatusById: Map<string, AccessibleWorkspace["status"]>;
  /**
   * Every accessible (non-deleting) workspace with its status. The generic
   * capability path (capability executors) needs this to build the
   * `getAccessibleWorkspaces` resolver the safe-handler context carries; existing
   * tools resolve access through `accessibleWorkspaceIdSet` /
   * `accessibleWorkspaceStatusById` and do not read it.
   */
  accessibleWorkspaces: AccessibleWorkspace[];
  /** Resolved transport client IP used by shared gateway/REST abuse budgets. */
  clientIp?: string | null;
  credentialType?: "oauth" | "api-key" | "anonymous";
  clientId?: string | null;
  /** Credential classification copied from the authenticated MCP session. */
  sessionCredentialType?: McpCredentialType | undefined;
  /**
   * The credential's own permission set, when it carries one (machine API
   * keys). Authorization ANDs it with `memberRole` through
   * `hasEffectiveAuthority`; absent means the credential is bounded by its role
   * alone, which is the JWT bearer case.
   */
  credentialPermissions?: PermissionInput | undefined;
  /**
   * Who can confirm tools that need a person's go-ahead
   * (`mcp/tool-confirmation.ts`). Absent means the caller relays it.
   */
  toolConfirmation?: ToolConfirmation | undefined;
  /**
   * OAuth scopes granted to this session (the access token's `scope` claim).
   * capability executors gate each capability on its catalog scope against this
   * list; the session-authed chat projection has no OAuth scopes and passes an
   * empty list (it never dispatches the generic path).
   */
  grantedScopes: readonly string[];
  /**
   * Registry slugs this org may actually call (credential/deployment available
   * AND enabled for the org). The `lookup_business_registry` list projection narrows its
   * `registry` enum to these and drops the tool when empty, mirroring the
   * in-app chat tool so the MCP surface never advertises a registry the
   * call cannot execute. Read from organization settings and registry
   * credential availability on first use, at most once per request: only
   * discovery narrows by it, so a `tools/call` never pays the settings read and
   * credential decryption behind it.
   *
   * Absent (a synthetic/test context) or an unavailable read leaves the full
   * enum advertised, and the call-time gate stays the backstop. Neither is
   * the same as a present empty list, which means the org can reach no
   * registry and the tool is dropped.
   */
  loadEnabledRegistrySlugs?:
    (() => Promise<ReadOutcome<readonly BusinessRegistrySlug[]>>) | undefined;
  /**
   * The web search provider, loaded on first use within this request only, so
   * a call that does no web search never reads or decrypts the stored key.
   * An error means the settings read failed; an unavailable result names why
   * web search is off (not configured, turned off, or an unreadable key).
   */
  loadWebSearchProvider?:
    (() => Promise<Result<McpWebSearchAvailability, SafeDbError>>) | undefined;
  memberRole: MemberRole;
  billingAccess?: boolean;
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
    ((workspaceId: SafeId<"workspace">) => boolean) | undefined;
  /**
   * The originating gateway HTTP request. Present on the MCP transport path
   * (set by `resolveMcpSessionContext`); absent on the session-authed chat
   * projection, which never dispatches the generic capability path. Only
   * capability executors read it (to synthesize a safe-handler context).
   */
  request?: Request;
  recordAuditEvent: AuditRecorder;
  /**
   * Authority to reach a third-party service (a public register, the BOE API,
   * a court publisher). An MCP transport request holds one: the caller invoked
   * the tool directly. The chat script runner's context never does, so a read
   * a script calls cannot send to a third party; a handler that needs one is
   * declared with `withThirdPartyOutbound`.
   */
  thirdPartyOutboundPermit?: ThirdPartyOutboundPermit | undefined;
  userId: SafeId<"user">;
  userEmail: string;
};

/** Resources built with the caller context but kept outside its authority. */
export type McpRequestResources = McpRequestContext & {
  safeDb: SafeDb;
  scopedDb: ScopedDb;
};

/**
 * Bind a confirmed MCP call to the authenticated user's approval. Transport
 * contexts carry the request needed to rebuild the recorder; chat contexts
 * already receive a recorder whose approval was resolved by the chat gate.
 */
export const bindApprovedMcpAuditContext = <TContext extends McpRequestContext>(
  context: TContext,
): TContext => {
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
 * Enumerate the workspace metadata MCP's current access maps require, from
 * the authorized-workspace owner in the credential's scoped transaction.
 */
export const loadAccessibleMcpWorkspaces = async ({
  organizationId,
  scopedDb,
}: LoadAccessibleMcpWorkspacesOptions): Promise<AccessibleWorkspace[]> => {
  const outcome = await scopedDb(
    async (tx) => await readAuthorizedWorkspaces(tx, { organizationId }),
  );
  if (outcome.isErr()) {
    const { error } = outcome;
    throw error;
  }
  return outcome.value.workspaces;
};

export type McpWebSearchAvailability =
  | { status: "available"; provider: WebSearchProvider }
  | {
      status: "unavailable";
      reason: "not-configured" | "key-unreadable";
    };

const MCP_WEB_SEARCH_KEY_RESOLUTION_SINK = failureSink({
  event: "mcp.web_search.key_resolution_failed",
  expected: [],
});

export const resolveEnabledMcpWebSearchProvider = async ({
  disabledNativeToolSlugs,
  organizationId,
  row,
}: {
  disabledNativeToolSlugs: readonly string[] | undefined;
  organizationId: SafeId<"organization">;
  row: OrgWebSearchKeyRow | null | undefined;
}): Promise<McpWebSearchAvailability> => {
  if (disabledNativeToolSlugs?.includes("web-search")) {
    return { status: "unavailable", reason: "not-configured" };
  }
  const resolved = await resolveWebSearchProvidersResultFromOrgSettingsRow(
    organizationId,
    row,
  );
  if (resolved.isErr()) {
    observeFailure(resolved.error, {
      sink: MCP_WEB_SEARCH_KEY_RESOLUTION_SINK,
    });
    return { status: "unavailable", reason: "key-unreadable" };
  }
  if (resolved.value.webSearchProvider === null) {
    return { status: "unavailable", reason: "not-configured" };
  }
  return { status: "available", provider: resolved.value.webSearchProvider };
};

const credentialPermissionContext = (
  session: McpSession,
): Pick<McpRequestContext, "credentialPermissions"> =>
  session.credential?.type === "machine_api_key" ||
  session.credential?.type === "personal_api_key"
    ? { credentialPermissions: session.credential.permissions }
    : {};

export const providerFromMcpWebSearchAvailability = (
  availability: McpWebSearchAvailability,
): WebSearchProvider | null =>
  availability.status === "available" ? availability.provider : null;

/**
 * The web search provider one organization can use, from its settings row
 * (native tool overrides and the stored key) in one scoped read.
 */
const readMcpWebSearchProvider = async ({
  organizationId,
  safeDb,
}: {
  organizationId: SafeId<"organization">;
  safeDb: SafeDb;
}): Promise<Result<McpWebSearchAvailability, SafeDbError>> => {
  const settings = await safeDb((tx) =>
    tx.query.organizationSettings.findFirst({
      where: { organizationId: { eq: organizationId } },
      columns: {
        practiceJurisdictions: true,
        nativeToolOverrides: true,
        webSearchApiKeyEncrypted: true,
        webSearchApiKeyIv: true,
        urlFetchApiKeyEncrypted: true,
        urlFetchApiKeyIv: true,
      },
    }),
  );
  if (Result.isError(settings)) {
    return settings;
  }
  return Result.ok(
    await resolveEnabledMcpWebSearchProvider({
      disabledNativeToolSlugs: getDisabledNativeToolSlugsFromSettingsRow(
        settings.value ?? undefined,
      ),
      organizationId,
      row: settings.value,
    }),
  );
};

const resolveMcpWebHandoffIdentity = (session: McpSession) => {
  const credential = session.credential;
  if (credential?.type === "oauth_client") {
    return { credentialType: "oauth", clientId: credential.clientId } as const;
  }
  const credentialType =
    credential?.type === "machine_api_key" ||
    credential?.type === "personal_api_key"
      ? "api-key"
      : "anonymous";
  return { credentialType, clientId: null } as const;
};

const REGISTRY_NARROWING_SINK = failureSink({
  event: "mcp.registry_narrowing.read_failed",
  expected: [],
});

/**
 * The registries one organization can reach, from its settings and its stored
 * credentials, read in one scoped transaction.
 */
const readEnabledRegistrySlugs = async ({
  organizationId,
  safeDb,
}: {
  organizationId: SafeId<"organization">;
  safeDb: SafeDb;
}): Promise<ReadOutcome<readonly BusinessRegistrySlug[]>> => {
  const read = await safeDb(async (tx) => {
    const settings = await tx.query.organizationSettings.findFirst({
      where: { organizationId: { eq: organizationId } },
      columns: { practiceJurisdictions: true, nativeToolOverrides: true },
    });
    const dispatch = await getOrganizationRegistryDispatch({
      organizationId,
      // Same transaction: the credential read joins the settings read.
      scopedDb: async (run) => await run(tx),
    });
    return { dispatch, settings };
  });
  if (Result.isError(read)) {
    observeFailure(read.error, { sink: REGISTRY_NARROWING_SINK });
    return readUnavailable({ kind: "thrown", error: read.error });
  }
  const { dispatch, settings } = read.value;
  return readPresent(
    availableRegistryHandlersForOrg({
      disabledNativeToolSlugs: getDisabledNativeToolSlugsFromSettingsRow(
        settings ?? undefined,
      ),
      dispatch,
    }).map((handler) => handler.slug),
  );
};

export const resolveMcpSessionContext = async (
  session: McpSession,
  {
    clientIp = null,
    request,
    resolveAuthorization = resolveCredentialMemberAuthorization,
    checkAccountOperation = checkDemoAccountOperation,
    checkAccountOrganization = checkReviewAccountOrganization,
  }: {
    clientIp?: string | null;
    request: Request;
    resolveAuthorization?: ResolveCredentialMemberAuthorization;
    checkAccountOperation?: typeof checkDemoAccountOperation;
    checkAccountOrganization?: typeof checkReviewAccountOrganization;
  },
): Promise<McpRequestResources> => {
  const { organizationId, userId } = brandActorSessionIdentity({
    organizationId: session.organizationId,
    userId: session.userId,
  });
  const authorization = await resolveAuthorization({
    organizationId,
    userId,
  });
  if (!authorization) {
    throw new McpOrganizationAccessError({
      message: "User is not a member of this organization",
    });
  }
  const accountOperation = checkAccountOperation(authorization.email);
  const accountAccess = Result.isError(accountOperation)
    ? accountOperation
    : checkAccountOrganization({
        email: authorization.email,
        organizationId,
      });
  if (Result.isError(accountAccess)) {
    throw new McpOrganizationAccessError({
      message: accountAccess.error.message,
    });
  }
  // OAuth access tokens issued before the member_id claim existed carry none
  // and open on live membership alone. Remove this allowance (require the
  // claim on OAuth client tokens) once every such token has expired, i.e.
  // one maximum access-token lifetime after the claim shipped.
  if (
    session.memberId !== undefined &&
    session.memberId !== authorization.memberId
  ) {
    throw new McpOrganizationAccessError({
      message: "Token was issued for a previous membership",
    });
  }
  if (!isMemberRole(authorization.role)) {
    panic("User has an invalid member role");
  }
  const auditExecution = await resolveAgentAuditExecution({
    credential: session.credential,
    organizationId,
    userId,
  });
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
  // The membership read above already carries every feature-access fact, so
  // the snapshot is derived from it rather than read again.
  const featureAccessSnapshot = featureAccessSnapshotFromAuthorization({
    organizationId,
    userId,
    authorization,
  });

  // Read once, on first use within this request: settings and decrypted
  // registry credentials in one scoped transaction.
  let enabledRegistrySlugs:
    Promise<ReadOutcome<readonly BusinessRegistrySlug[]>> | undefined;
  const loadEnabledRegistrySlugs = async () => {
    enabledRegistrySlugs ??= readEnabledRegistrySlugs({
      organizationId,
      safeDb: requestDatabaseScope.safeDb,
    });
    return await enabledRegistrySlugs;
  };
  let webSearchAvailability:
    Promise<Result<McpWebSearchAvailability, SafeDbError>> | undefined;
  const loadWebSearchProvider = async () => {
    webSearchAvailability ??= readMcpWebSearchProvider({
      organizationId,
      safeDb: requestDatabaseScope.safeDb,
    });
    return await webSearchAvailability;
  };

  const webHandoffIdentity = resolveMcpWebHandoffIdentity(session);

  return {
    ...webHandoffIdentity,
    ...(auditExecution ? { auditExecution } : {}),
    accessibleWorkspaceIds: usableWorkspaceIds,
    accessibleWorkspaceIdSet: workspaceAccessBoundary.accessibleWorkspaceIdSet,
    accessibleWorkspaceStatusById: new Map(
      usableWorkspaces.map((workspace) => [workspace.id, workspace.status]),
    ),
    accessibleWorkspaces: usableWorkspaces,
    clientIp,
    ...(session.credential === undefined
      ? {}
      : { sessionCredentialType: session.credential.type }),
    createOperationDatabaseScope,
    featureAccessSnapshot,
    ...credentialPermissionContext(session),
    ...(session.credential?.type === "agent_run"
      ? { toolConfirmation: TOOL_CONFIRMATION.unavailable }
      : {}),
    loadEnabledRegistrySlugs,
    loadWebSearchProvider,
    grantedScopes: session.scopes,
    memberRole,
    billingAccess: authorization.billingAccess,
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
    thirdPartyOutboundPermit: grantThirdPartyOutboundPermit(),
    safeDb: requestDatabaseScope.safeDb,
    scopedDb: requestDatabaseScope.scopedDb,
    userId,
    userEmail: authorization.email,
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
