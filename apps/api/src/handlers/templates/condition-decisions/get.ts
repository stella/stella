import { Result } from "better-result";
import { t } from "elysia";

import { resolveCaching } from "@/api/lib/ai-config";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import {
  memberAssignmentRequiredError,
  storedAIConfigUnreadableError,
} from "@/api/lib/ai-config-response";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import {
  ACCOUNT_ACCESS,
  configuredModelAdmission,
  createSafeRootHandler,
} from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tJsonObject, tSafeId } from "@/api/lib/custom-schema";
import { templateDecideConditionsLogic } from "@/api/lib/templates/template-decide-conditions";

const decideConditionsBodySchema = t.Object({
  values: tJsonObject,
});

const decideConditionsParamsSchema = t.Object({
  templateId: tSafeId("template"),
});

const config = {
  contentDelivery: {
    type: "none",
    reason:
      "Processes template content and returns parsed data or saved-document metadata rather than stored-file bytes.",
  },
  actionAdmission: { type: "handler", actionKind: "templates.fill" },
  requiresUsage: { actionType: "chat", modelRole: "fast" },
  description:
    "Decide every AI boolean condition of a stored template from current values, " +
    "using the decision model and its generative fallback. Returns the deciding " +
    "source or an undecided reason. Supplied boolean values win. Nothing is " +
    "filled or written. Uses stored clause links; per-fill clauseOverrides " +
    "are not included. Consumes AI usage.",
  // Same grant as the fill routes: the answers are what a fill of this
  // template would decide, and reaching them spends the org's decision model.
  permissions: { template: ["use"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "read",
  mcp: { type: "tool", name: "preview_template_conditions" },
  params: decideConditionsParamsSchema,
  body: decideConditionsBodySchema,
} satisfies HandlerConfig;

const decideTemplateConditions = createSafeRootHandler(
  config,
  async function* ({
    scopedDb,
    safeDb,
    user,
    session,
    params,
    body,
    orgAIConfig,
    orgAIConfigStatus,
    request,
    modelAdmission,
    managedAIResidency,
  }) {
    if (orgAIConfigStatus === ORG_AI_CONFIG_STATUS.unreadable) {
      return Result.err(storedAIConfigUnreadableError(undefined));
    }
    if (orgAIConfigStatus === ORG_AI_CONFIG_STATUS.memberAssignmentRequired) {
      return Result.err(memberAssignmentRequiredError());
    }

    const decided = yield* Result.await(
      templateDecideConditionsLogic({
        scopedDb,
        organizationId: session.activeOrganizationId,
        templateId: params.templateId,
        body,
        orgAIConfig,
        abortSignal: request.signal,
        generation: {
          dataClass: "customer",
          orgAIConfig,
          managedAIResidency,
          organizationId: session.activeOrganizationId,
          admission: configuredModelAdmission({ modelAdmission }),
          tenantWorkspaceIds: [],
          role: "fast",
          serviceTier: "standard",
          caching: resolveCaching({
            promptCachingEnabled: false,
            role: "fast",
            scopeKey: params.templateId,
          }),
          prompt: "Decide the template conditions from the supplied values.",
          analytics: createTanStackAIAnalyticsCallbacks({
            dataClass: "customer",
            feature: "templates.preview-conditions",
            modelRole: "fast",
            orgAIConfig,
            organizationId: session.activeOrganizationId,
            traceId: Bun.randomUUIDv7(),
            usageMetering: {
              actionType: "chat",
              organizationId: session.activeOrganizationId,
              safeDb,
              serviceTier: "standard",
              userId: user.id,
              workspaceId: null,
            },
          }),
        },
        usageMetering: {
          actionType: "chat",
          organizationId: session.activeOrganizationId,
          safeDb,
          serviceTier: "standard",
          userId: user.id,
          workspaceId: null,
          callId: Bun.randomUUIDv7(),
        },
      }),
    );
    return Result.ok(decided);
  },
);

export default decideTemplateConditions;
