import { Result } from "better-result";
import { t } from "elysia";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";
import { CHAT_PROMPT_IMPROVEMENT_STRATEGIES } from "@stll/api-contract/chat";

import { buildPromptImprovementModelInput } from "@/api/handlers/chat/improve-prompt-instructions";
import { resolveCaching } from "@/api/lib/ai-config";
import { aiHandlerError } from "@/api/lib/ai-error";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { generateTanStackTextForRole } from "@/api/lib/tanstack-ai-generate";

const config = {
  permissions: { chat: ["create"] },
  mcp: { type: "internal", reason: "assistant_chat" },
  body: t.Object({
    prompt: t.String({ minLength: 1, maxLength: 12_000 }),
    strategy: t.UnionEnum(CHAT_PROMPT_IMPROVEMENT_STRATEGIES),
    sendMode: t.Union([
      t.Literal(CHAT_SEND_MODE.anonymized),
      t.Literal(CHAT_SEND_MODE.rawOverride),
    ]),
  }),
  requiresUsage: { actionType: "chat", modelRole: "fast" },
} satisfies HandlerConfig;

const IMPROVE_PROMPT_TIMEOUT_MS = 20_000;
const IMPROVE_PROMPT_MAX_OUTPUT_TOKENS = 4096;

const improvePrompt = createSafeRootHandler(
  config,
  async function* ({
    body,
    orgAIConfig,
    promptCachingEnabled,
    request,
    safeDb,
    session,
    user,
  }) {
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
      usageMetering: {
        actionType: "chat",
        organizationId: session.activeOrganizationId,
        safeDb,
        serviceTier: "standard",
        userId: user.id,
        workspaceId: null,
      },
      feature: "chat.improve_prompt",
      modelRole: "fast",
      orgAIConfig,
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
          return await generateTanStackTextForRole({
            abortSignal: AbortSignal.any([
              request.signal,
              AbortSignal.timeout(IMPROVE_PROMPT_TIMEOUT_MS),
            ]),
            analytics: aiAnalytics,
            caching: resolveCaching({
              promptCachingEnabled,
              role: "fast",
              scopeKey: null,
            }),
            finishPolicy: "require-complete",
            messages: modelInput.messages,
            maxOutputTokens: IMPROVE_PROMPT_MAX_OUTPUT_TOKENS,
            organizationId: session.activeOrganizationId,
            orgAIConfig,
            role: "fast",
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
        new HandlerError({ status: 502, message: "Empty improved prompt" }),
      );
    }

    return Result.ok({ prompt: improvedPrompt });
  },
);

export default improvePrompt;
