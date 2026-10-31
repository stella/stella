import { Result } from "better-result";

import {
  createSearchSummaryChatThread,
  refineSearchBodySchema,
  refineSearchQuery,
  searchSummaryChatBodySchema,
  summarizeSearchBodySchema,
  summarizeSearchResults,
} from "@/api/handlers/search/ai";
import searchFacets from "@/api/handlers/search/facets/list";
import searchPreviewEndpoint from "@/api/handlers/search/preview";
import searchResults from "@/api/handlers/search/results/list";
import { routes } from "@/api/http/route";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { storedAIConfigUnreadableError } from "@/api/lib/ai-config-response";
import {
  ACCOUNT_ACCESS,
  configuredModelAdmission,
  createSafeRootHandler,
} from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

const refineSearchEndpoint = createSafeRootHandler(
  {
    contract: "patch",
    permissions: { workspace: ["read"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    actionAdmission: { type: "handler", actionKind: "search.refine" },
    mcp: { type: "internal", reason: "search_ui" },
    body: refineSearchBodySchema,
    requiresUsage: { actionType: "chat", modelTask: "short-text" },
  } satisfies HandlerConfig,
  async function* ({
    body,
    modelAdmission,
    orgAIConfig,
    managedAIResidency,
    orgAIConfigStatus,
    promptCachingEnabled,
    safeDb,
    scopedDb,
    session,
    user,
  }) {
    if (orgAIConfigStatus === ORG_AI_CONFIG_STATUS.unreadable) {
      return Result.err(storedAIConfigUnreadableError());
    }

    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await refineSearchQuery({
            admission: configuredModelAdmission({ modelAdmission }),
            organizationId: session.activeOrganizationId,
            body,
            orgAIConfig,
            managedAIResidency,
            orgAIConfigStatus,
            promptCachingEnabled,
            safeDb,
            scopedDb,
            userId: user.id,
          }),
      ),
    );

    return Result.ok(response);
  },
);

const summarizeSearchEndpoint = createSafeRootHandler(
  {
    contract: "patch",
    permissions: { chat: ["create"], workspace: ["read"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    actionAdmission: { type: "handler", actionKind: "search.summarize" },
    mcp: { type: "internal", reason: "search_ui" },
    body: summarizeSearchBodySchema,
    requiresUsage: { actionType: "chat", modelTask: "short-text" },
  } satisfies HandlerConfig,
  async function* ({
    body,
    getActiveWorkspaceIds,
    modelAdmission,
    orgAIConfig,
    managedAIResidency,
    orgAIConfigStatus,
    promptCachingEnabled,
    safeDb,
    scopedDb,
    session,
    user,
  }) {
    if (orgAIConfigStatus === ORG_AI_CONFIG_STATUS.unreadable) {
      return Result.err(storedAIConfigUnreadableError());
    }

    const activeWorkspaceIds = yield* Result.await(
      Result.tryPromise(async () => await getActiveWorkspaceIds()),
    );
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await summarizeSearchResults({
            admission: configuredModelAdmission({ modelAdmission }),
            organizationId: session.activeOrganizationId,
            userId: user.id,
            accessibleWorkspaceIds: activeWorkspaceIds,
            body,
            orgAIConfig,
            managedAIResidency,
            orgAIConfigStatus,
            promptCachingEnabled,
            safeDb,
            scopedDb,
          }),
      ),
    );

    return Result.ok(response);
  },
);

const searchSummaryChatEndpoint = createSafeRootHandler(
  {
    contract: "patch",
    permissions: { chat: ["create"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: { type: "internal", reason: "search_ui" },
    body: searchSummaryChatBodySchema,
  } satisfies HandlerConfig,
  async function* ({
    body,
    featureAccessSnapshot,
    getActiveWorkspaceIds,
    safeDb,
    scopedDb,
    session,
    user,
    recordAuditEvent,
  }) {
    const activeWorkspaceIds = yield* Result.await(
      Result.tryPromise(async () => await getActiveWorkspaceIds()),
    );
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await createSearchSummaryChatThread({
            organizationId: session.activeOrganizationId,
            accessibleWorkspaceIds: activeWorkspaceIds,
            body,
            featureAccessSnapshot,
            safeDb,
            scopedDb,
            userId: user.id,
            recordAuditEvent,
          }),
      ),
    );

    return Result.ok(response);
  },
);

export const searchRoute = routes(
  {
    "/": { POST: searchResults },
    "/facets": { POST: searchFacets },
    "/preview": { POST: searchPreviewEndpoint },
    "/refine": { POST: refineSearchEndpoint },
    "/summary": { POST: summarizeSearchEndpoint },
    "/summary/chat": { POST: searchSummaryChatEndpoint },
  },
  { prefix: "/search" },
);
