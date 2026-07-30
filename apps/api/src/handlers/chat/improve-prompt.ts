import { Result } from "better-result";
import { t } from "elysia";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";

import { resolveCaching } from "@/api/lib/ai-config";
import { aiHandlerError } from "@/api/lib/ai-error";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { generateTanStackTextForRole } from "@/api/lib/tanstack-ai-generate";

const IMPROVE_PROMPT_SYSTEM = `You improve prompts for a legal-workspace AI assistant.
Rewrite the user's draft so it is clearer, more specific, and easier to act on while preserving the user's intent, facts, language, and level of formality.

Rules:
- Return only the improved prompt. No preamble, commentary, quotation marks, or markdown fences.
- Write in the same language as the draft.
- Keep all names, dates, citations, defined terms, constraints, and requested output formats intact.
- Do not invent facts, legal authorities, assumptions, or requirements.
- Prefer direct instructions and make the desired outcome explicit.
- Keep a short draft concise. Use paragraphs or bullets only when they materially improve a longer request.`;

const config = {
  permissions: { chat: ["create"] },
  mcp: { type: "internal", reason: "assistant_chat" },
  body: t.Object({
    prompt: t.String({ minLength: 1, maxLength: 12_000 }),
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
        new HandlerError({ status: 400, message: "Prompt is required" }),
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
        try: async () =>
          await generateTanStackTextForRole({
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
            messages: [{ role: "user", content: prompt }],
            maxOutputTokens: IMPROVE_PROMPT_MAX_OUTPUT_TOKENS,
            organizationId: session.activeOrganizationId,
            orgAIConfig,
            role: "fast",
            serviceTier: "standard",
            system: IMPROVE_PROMPT_SYSTEM,
          }),
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
