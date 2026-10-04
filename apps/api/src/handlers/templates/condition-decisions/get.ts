import { Result } from "better-result";
import { t } from "elysia";

import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import {
  memberAssignmentRequiredError,
  storedAIConfigUnreadableError,
} from "@/api/lib/ai-config-response";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
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
  description:
    "Ask the organization's decision model about every AI-decided boolean " +
    "condition of a stored template, given the values entered so far, and " +
    "return what it decided with its probability and confidence. Nothing is " +
    "filled and no document is produced; the generative model is never " +
    "called, so a condition the decision model leaves undecided is reported " +
    "as such (the fill itself still falls back to the generative model). " +
    "values is an object mapping each field path to its value. Uses stored " +
    "clause links only; per-fill clauseOverrides are not included in this preview.",
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
  }) {
    // The decision model never falls through to the instance provider here,
    // so only the statuses that refuse every key source apply.
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
        // Preview has no spend reservation. Only the org's own credential may
        // run here until the decision model has a matching usage preflight.
        ...(orgAIConfig?.decision ? {} : { client: null }),
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
