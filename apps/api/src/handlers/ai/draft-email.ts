import { Result } from "better-result";
import { t } from "elysia";
import * as v from "valibot";

import { resolveCaching } from "@/api/lib/ai-config";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { generateTanStackObjectForRole } from "@/api/lib/tanstack-ai-generate";

const INTENT_MAX_CHARS = 2000;
const ORIGINAL_SUBJECT_MAX_CHARS = 500;
const ORIGINAL_BODY_MAX_CHARS = 20_000;
const ORIGINAL_FROM_MAX_CHARS = 320;
const LANGUAGE_MAX_CHARS = 32;
const DRAFT_TIMEOUT_MS = 60_000;
const DRAFT_MAX_OUTPUT_TOKENS = 2048;

const draftEmailBodySchema = t.Object({
  intent: t.String({ minLength: 1, maxLength: INTENT_MAX_CHARS }),
  originalSubject: t.Optional(
    t.String({ maxLength: ORIGINAL_SUBJECT_MAX_CHARS }),
  ),
  originalBody: t.String({ maxLength: ORIGINAL_BODY_MAX_CHARS }),
  originalFrom: t.Optional(t.String({ maxLength: ORIGINAL_FROM_MAX_CHARS })),
  language: t.Optional(t.String({ maxLength: LANGUAGE_MAX_CHARS })),
});

const config = {
  permissions: { chat: ["create"] },
  mcp: { type: "internal", reason: "native_tool_ui" },
  access: "write",
  body: draftEmailBodySchema,
  // User-clicked from the Outlook add-in and latency-sensitive, so it
  // runs on the standard tier rather than the discounted flex queue.
  requiresUsage: {
    actionType: "chat",
    serviceTier: "standard",
    modelRole: "chat",
  },
} satisfies HandlerConfig;

const draftSchema = v.strictObject({
  draft: v.pipe(
    v.string(),
    v.description(
      "Plain-text reply body only. No subject line, no signature block, no surrounding quotes or markdown fences.",
    ),
  ),
});

const SYSTEM_PROMPT = `You draft a professional reply to an email given the user's intent.
Match the tone and register of the original message. Keep the reply concise. Return ONLY the reply body: no subject line, no signature block. Honor the requested target language when one is given. Never invent facts, names, citations, or commitments that are not in the user's intent.`;

const buildUserMessage = ({
  intent,
  originalSubject,
  originalBody,
  originalFrom,
  language,
}: {
  intent: string;
  originalSubject: string | undefined;
  originalBody: string;
  originalFrom: string | undefined;
  language: string | undefined;
}): string => {
  const sections: string[] = [];

  const trimmedLanguage = language?.trim();
  if (trimmedLanguage) {
    sections.push(`Target language: ${trimmedLanguage}`);
  }

  sections.push(`Reply intent:\n${intent.trim()}`);

  const trimmedFrom = originalFrom?.trim();
  if (trimmedFrom) {
    sections.push(`Original sender: ${trimmedFrom}`);
  }

  const trimmedSubject = originalSubject?.trim();
  if (trimmedSubject) {
    sections.push(`Original subject: ${trimmedSubject}`);
  }

  sections.push(`Original message:\n${originalBody.trim()}`);
  sections.push("Write the reply body:");

  return sections.join("\n\n");
};

const draftEmail = createSafeRootHandler(
  config,
  // eslint-disable-next-line require-yield -- createSafeRootHandler requires an AsyncGenerator; this handler has no safeDb Result to yield.
  async function* ({
    body,
    orgAIConfig,
    promptCachingEnabled,
    request,
    session,
    safeDb,
    user,
  }) {
    const aiAnalytics = createTanStackAIAnalyticsCallbacks({
      usageMetering: {
        actionType: "chat",
        organizationId: session.activeOrganizationId,
        safeDb,
        serviceTier: "standard",
        userId: user.id,
        workspaceId: null,
      },
      feature: "ai.draft_email",
      modelRole: "chat",
      orgAIConfig,
      properties: { organization_id: session.activeOrganizationId },
      traceId: Bun.randomUUIDv7(),
    });

    const generation = await Result.tryPromise({
      try: async () =>
        await generateTanStackObjectForRole({
          abortSignal: AbortSignal.any([
            request.signal,
            AbortSignal.timeout(DRAFT_TIMEOUT_MS),
          ]),
          analytics: aiAnalytics,
          caching: resolveCaching({
            promptCachingEnabled,
            role: "chat",
            scopeKey: null,
          }),
          maxOutputTokens: DRAFT_MAX_OUTPUT_TOKENS,
          organizationId: session.activeOrganizationId,
          orgAIConfig,
          outputSchema: draftSchema,
          role: "chat",
          serviceTier: "standard",
          system: SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: buildUserMessage({
                intent: body.intent,
                originalSubject: body.originalSubject,
                originalBody: body.originalBody,
                originalFrom: body.originalFrom,
                language: body.language,
              }),
            },
          ],
        }),
      catch: (cause) => {
        aiAnalytics.captureError(cause);
        return new HandlerError({
          status: 502,
          message: "Could not draft the email. Please try again.",
          cause,
        });
      },
    });
    if (Result.isError(generation)) {
      return Result.err(generation.error);
    }

    return Result.ok({ draft: generation.value.draft.trim() });
  },
);

export default draftEmail;
