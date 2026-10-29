import { Result } from "better-result";
import * as v from "valibot";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";
import { CHAT_PROMPT_IMPROVEMENT_STRATEGIES } from "@stll/api-contract/chat";

import { buildPromptImprovementModelInput } from "@/api/handlers/chat/improve-prompt-instructions";
import { resolveCaching } from "@/api/lib/ai-config";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { storedAIConfigUnreadableError } from "@/api/lib/ai-config-response";
import { aiHandlerError } from "@/api/lib/ai-error";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import {
  ACCOUNT_ACCESS,
  configuredModelAdmission,
  createSafeRootHandler,
} from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { generateTanStackTextForTask } from "@/api/lib/tanstack-ai-generate";

const config = {
  contract: "patch",
  actionAdmission: { type: "handler", actionKind: "chat.improve-prompt" },
  permissions: { chat: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "assistant_chat" },
  body: v.object({
    prompt: v.pipe(v.string(), v.minLength(1), v.maxLength(12_000)),
    strategy: v.picklist(CHAT_PROMPT_IMPROVEMENT_STRATEGIES),
    sendMode: v.union([
      v.literal(CHAT_SEND_MODE.anonymized),
      v.literal(CHAT_SEND_MODE.rawOverride),
    ]),
  }),
  requiresUsage: { actionType: "chat", modelTask: "short-text" },
} satisfies HandlerConfig;

const IMPROVE_PROMPT_TIMEOUT_MS = 20_000;
const IMPROVE_PROMPT_MAX_OUTPUT_TOKENS = 4096;

const improvePrompt = createSafeRootHandler(
  config,
  async function* ({
    orgAIConfigStatus,
    actionSignal,
    body,
    orgAIConfig,
    managedAIResidency,
    modelAdmission,
    promptCachingEnabled,
    request,
    safeDb,
    session,
    user,
  }) {
    if (orgAIConfigStatus === ORG_AI_CONFIG_STATUS.unreadable) {
      return Result.err(storedAIConfigUnreadableError(undefined));
    }

    if (body.sendMode === CHAT_SEND_MODE.anonymized) {
      return Result.err(
        new HandlerError({
          status: 403,
          message: "Prompt improvement is unavailable in anonymized mode",
        }),
      );
    }

    const prompt = body.prompt.trim();
    if (prompt.length === 0) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Prompt is required",
        }),
      );
    }

    const aiAnalytics = createTanStackAIAnalyticsCallbacks({
      dataClass: "customer",
      usageMetering: {
        actionType: "chat",
        organizationId: session.activeOrganizationId,
        safeDb,
        serviceTier: "standard",
        userId: user.id,
        workspaceId: null,
      },
      feature: "chat.improve_prompt",
      modelTask: "short-text",
      orgAIConfig,
      modelTier: configuredModelAdmission({ modelAdmission }).modelTier,
      properties: { organization_id: session.activeOrganizationId },
      traceId: Bun.randomUUIDv7(),
    });

    const improvedPrompt = (yield* Result.await(
      Result.tryPromise({
        try: async () => {
          const modelInput = buildPromptImprovementModelInput(
            prompt,
            body.strategy,
          );
          return await generateTanStackTextForTask({
            userId: user.id,
            dataClass: "customer",
            abortSignal: actionSignal ?? request.signal,
            deadlineMs: IMPROVE_PROMPT_TIMEOUT_MS,
            analytics: aiAnalytics,
            caching: resolveCaching({
              promptCachingEnabled,
              task: "short-text",
              scopeKey: null,
            }),
            finishPolicy: "require-complete",
            messages: modelInput.messages,
            maxOutputTokens: IMPROVE_PROMPT_MAX_OUTPUT_TOKENS,
            organizationId: session.activeOrganizationId,
            admission: configuredModelAdmission({ modelAdmission }),
            orgAIConfig,
            managedAIResidency,
            task: "short-text",
            serviceTier: "standard",
            system: modelInput.system,
            systemPromptOrigin: "server-built",
            // Prompt improvement is thread-less and workspace-less: the
            // handler holds no workspace scope, so there is no tenant set to
            // guard against without an extra accessible-workspaces query on
            // an interactive path.
            tenantWorkspaceIds: [],
          });
        },
        catch: (error) => {
          aiAnalytics.captureError(error);
          return aiHandlerError(error, {
            status: 502,
            message: "Improve prompt failed",
          });
        },
      }),
    )).trim();
    if (improvedPrompt.length === 0) {
      return Result.err(
        new HandlerError({
          status: 502,
          code: "internal_error",
          message: "Empty improved prompt",
        }),
      );
    }

    return Result.ok({ prompt: improvedPrompt });
  },
);

export default improvePrompt;
