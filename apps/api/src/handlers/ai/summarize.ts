import { generateText, Output } from "ai";
import { Result } from "better-result";
import { t } from "elysia";
import * as v from "valibot";

import { getModelForRole, requireAIAvailable } from "@/api/lib/ai-models";
import { strictOutputSchema } from "@/api/lib/ai-output-schema";
import { createAIAnalyticsCallbacks } from "@/api/lib/analytics/ai";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const TEXT_MAX_CHARS = 20_000;
const LANGUAGE_MAX_CHARS = 32;
const SUMMARIZE_TIMEOUT_MS = 60_000;
const SUMMARIZE_MAX_OUTPUT_TOKENS = 1024;

const summarizeBodySchema = t.Object({
  text: t.String({ minLength: 1, maxLength: TEXT_MAX_CHARS }),
  language: t.Optional(t.String({ maxLength: LANGUAGE_MAX_CHARS })),
});

const config = {
  permissions: { chat: ["create"] },
  body: summarizeBodySchema,
  // User-clicked from the Outlook add-in and latency-sensitive, so it
  // runs on the standard tier rather than the discounted flex queue.
  requiresUsage: {
    actionType: "chat",
    serviceTier: "standard",
    modelRole: "fast",
  },
} satisfies HandlerConfig;

const summarySchema = v.strictObject({
  summary: v.pipe(
    v.string(),
    v.description(
      "Plain-text summary of the email. 3-5 short bullet points, or one sentence for very short emails. No markdown fences.",
    ),
  ),
});

const SYSTEM_PROMPT = `You summarize an email for a busy professional.
Write 3 to 5 short plain-text bullet points covering the key topics, decisions, deadlines, and open questions. If the email is very short, return a single sentence instead. Honor the requested target language when one is given. Never invent facts, names, or citations that are not in the email.`;

const buildUserMessage = ({
  text,
  language,
}: {
  text: string;
  language: string | undefined;
}): string => {
  const trimmedLanguage = language?.trim();
  const languageLine = trimmedLanguage
    ? `Target language: ${trimmedLanguage}\n\n`
    : "";
  return `${languageLine}Email body:\n${text.trim()}`;
};

const summarizeEmail = createSafeRootHandler(
  config,
  async function* ({
    body,
    orgAIConfig,
    promptCachingEnabled,
    request,
    session,
    safeDb,
    user,
  }) {
    yield* requireAIAvailable(orgAIConfig);

    const aiAnalytics = createAIAnalyticsCallbacks({
      usageMetering: {
        actionType: "chat",
        organizationId: session.activeOrganizationId,
        safeDb,
        serviceTier: "standard",
        userId: user.id,
        workspaceId: null,
      },
      feature: "ai.summarize",
      modelRole: "fast",
      orgAIConfig,
      properties: { organization_id: session.activeOrganizationId },
      traceId: Bun.randomUUIDv7(),
    });

    const generation = await Result.tryPromise({
      try: async () =>
        await generateText({
          abortSignal: AbortSignal.any([
            request.signal,
            AbortSignal.timeout(SUMMARIZE_TIMEOUT_MS),
          ]),
          maxOutputTokens: SUMMARIZE_MAX_OUTPUT_TOKENS,
          model: getModelForRole("fast", orgAIConfig, {
            promptCachingEnabled,
            scopeKey: null,
            organizationId: session.activeOrganizationId,
            serviceTier: "standard",
          }),
          output: Output.object({ schema: strictOutputSchema(summarySchema) }),
          system: SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: buildUserMessage({
                text: body.text,
                language: body.language,
              }),
            },
          ],
          ...aiAnalytics.stepCallbacks,
        }),
      catch: (cause) => {
        aiAnalytics.captureError(cause);
        return new HandlerError({
          status: 502,
          message: "Could not summarize the email. Please try again.",
          cause,
        });
      },
    });
    if (Result.isError(generation)) {
      return Result.err(generation.error);
    }

    return Result.ok({ summary: generation.value.output.summary.trim() });
  },
);

export default summarizeEmail;
