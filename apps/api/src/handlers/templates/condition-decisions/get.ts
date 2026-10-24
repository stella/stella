import { Result } from "better-result";
import { t } from "elysia";

import { resolveCaching } from "@/api/lib/ai-config";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import {
  memberAIAccessError,
  ownAIKeyRequiredError,
  storedAIConfigUnreadableError,
} from "@/api/lib/ai-config-response";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import {
  ACCOUNT_ACCESS,
  authorizeHandlerUsage,
  createSafeRootHandler,
} from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tJsonObject, tSafeId } from "@/api/lib/custom-schema";
import {
  createModelActionAdmitter,
  modelActionRefusal,
} from "@/api/lib/rate-limit/model-action-admission";
import {
  decideTemplateConditions as runTemplateDecisions,
  templateDecideConditionsLogic,
} from "@/api/lib/templates/template-decide-conditions";

const decideConditionsBodySchema = t.Object({
  values: tJsonObject,
});

const decideConditionsParamsSchema = t.Object({
  templateId: tSafeId("template"),
});

const config = {
  contract: "patch",
  contentDelivery: {
    type: "none",
    reason:
      "Processes template content and returns parsed data or saved-document metadata rather than stored-file bytes.",
  },
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

type CreateConditionPreviewHandlerOptions = {
  authorizeUsage?: typeof authorizeHandlerUsage;
  createAdmitter?: typeof createModelActionAdmitter;
  decideConditions?: typeof runTemplateDecisions;
};

export const createConditionPreviewHandler = ({
  authorizeUsage = authorizeHandlerUsage,
  createAdmitter = createModelActionAdmitter,
  decideConditions = runTemplateDecisions,
}: CreateConditionPreviewHandlerOptions) =>
  createSafeRootHandler(
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
      managedAIResidency,
    }) {
      const decided = yield* Result.await(
        templateDecideConditionsLogic({
          scopedDb,
          organizationId: session.activeOrganizationId,
          templateId: params.templateId,
          body,
          abortSignal: request.signal,
          runDecisions: async ({ fields, values, abortSignal }) => {
            if (orgAIConfigStatus === ORG_AI_CONFIG_STATUS.unreadable) {
              return Result.err(storedAIConfigUnreadableError(undefined));
            }
            if (orgAIConfigStatus === ORG_AI_CONFIG_STATUS.ownKeyRequired) {
              return Result.err(ownAIKeyRequiredError());
            }
            const accessError = memberAIAccessError(orgAIConfigStatus);
            if (accessError !== null) {
              return Result.err(accessError);
            }
            const authorization = await authorizeUsage({
              metering: { actionType: "chat", modelTask: "classify" },
              organizationId: session.activeOrganizationId,
              orgAIConfig,
              workspaceId: null,
              userId: user.id,
              safeDb,
            });
            if (Result.isError(authorization)) {
              return Result.err(authorization.error);
            }
            return await authorization.value.execute(async () => {
              const admit = createAdmitter({
                organizationId: session.activeOrganizationId,
                userId: user.id,
                organizationStateDb: scopedDb,
                actionKind: "templates.fill",
              });
              const admitted = await admit(
                async ({ signal, admission }) =>
                  await decideConditions({
                    fields,
                    values,
                    orgAIConfig,
                    skillContext: {
                      organizationId: session.activeOrganizationId,
                      userId: user.id,
                      safeDb,
                    },
                    abortSignal: AbortSignal.any([abortSignal, signal]),
                    generation: {
                      dataClass: "customer",
                      userId: user.id,
                      orgAIConfig,
                      managedAIResidency,
                      organizationId: session.activeOrganizationId,
                      admission,
                      tenantWorkspaceIds: [],
                      task: "classify",
                      serviceTier: "standard",
                      caching: resolveCaching({
                        promptCachingEnabled: false,
                        task: "classify",
                        scopeKey: params.templateId,
                      }),
                      prompt:
                        "Decide the template conditions from the supplied values.",
                      analytics: createTanStackAIAnalyticsCallbacks({
                        dataClass: "customer",
                        feature: "templates.preview-conditions",
                        modelTask: "classify",
                        orgAIConfig,
                        modelTier: admission.modelTier,
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
              return Result.isError(admitted)
                ? Result.err(modelActionRefusal(admitted.error))
                : Result.ok(admitted.value);
            });
          },
        }),
      );
      return Result.ok(decided);
    },
  );

export default createConditionPreviewHandler({});
