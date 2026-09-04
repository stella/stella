import { Result } from "better-result";
import { t } from "elysia";

import {
  buildSuggestPromptUserMessage,
  SUGGEST_PROMPT_SYSTEM_PROMPT,
} from "@/api/handlers/properties/suggest-prompt-message";
import { resolveCaching } from "@/api/lib/ai-config";
import {
  loadOrgAIConfig,
  loadPromptCachingPreference,
} from "@/api/lib/ai-config-loader";
import { aiHandlerError } from "@/api/lib/ai-error";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tDefaultVarchar } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { generateTanStackTextForRole } from "@/api/lib/tanstack-ai-generate";

const suggestableContentType = t.Union([
  t.Literal("text"),
  t.Literal("single-select"),
  t.Literal("multi-select"),
  t.Literal("date"),
  t.Literal("int"),
]);

const suggestPromptBodySchema = t.Object({
  name: tDefaultVarchar,
  contentType: suggestableContentType,
  options: t.Optional(
    t.Array(
      t.Object({
        value: t.String({ minLength: 1, maxLength: 1000 }),
      }),
    ),
  ),
  // Plain-text version of the user's current prompt. When non-empty,
  // the LLM is asked to refine it instead of starting from scratch.
  currentPrompt: t.Optional(t.String({ maxLength: 2000 })),
  instruction: t.String({ minLength: 1, maxLength: 2000 }),
});

const config = {
  description:
    "Draft or refine a column's extraction prompt with the model, from the " +
    "column name, value type, select options, a free-text instruction, and " +
    "optionally the prompt as it stands. Returns one single-line prompt of " +
    "at most 280 characters and stores nothing. Consumes AI usage.",
  permissions: { property: ["create"] },
  mcp: { type: "capability", reason: "workspace_schema" },
  body: suggestPromptBodySchema,
  requiresUsage: { actionType: "chat", modelRole: "fast" },
} satisfies HandlerConfig;

const SUGGEST_TIMEOUT_MS = 20_000;
const MAX_PROMPT_LENGTH = 280;

const QUOTE_CHARS = new Set(['"', "'", "“", "”", "‘", "’"]);

const stripWrappingQuotes = (input: string): string => {
  let start = 0;
  let end = input.length;
  while (start < end && QUOTE_CHARS.has(input[start] ?? "")) {
    start += 1;
  }
  while (end > start && QUOTE_CHARS.has(input[end - 1] ?? "")) {
    end -= 1;
  }
  return input.slice(start, end);
};

const sanitizeSuggestion = (raw: string): string => {
  const trimmed = stripWrappingQuotes(raw.trim())
    // Collapse any whitespace runs (incl. newlines) into single spaces so the
    // suggestion fits on one TipTap paragraph.
    .split(/\s+/u)
    .filter((part) => part.length > 0)
    .join(" ");

  if (trimmed.length <= MAX_PROMPT_LENGTH) {
    return trimmed;
  }
  return `${trimmed.slice(0, MAX_PROMPT_LENGTH - 1).trimEnd()}…`;
};

const suggestPrompt = createSafeHandler(
  config,
  // eslint-disable-next-line require-yield -- createSafeHandler mandates AsyncGenerator; no DB ops to Result.await
  async function* ({ session, request, body, safeDb, user, workspaceId }) {
    const trimmedName = body.name.trim();
    const instruction = body.instruction.trim();
    if (trimmedName.length === 0 || instruction.length === 0) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Column name and rewrite instruction are required",
        }),
      );
    }

    const [orgAIConfig, promptCachingEnabled] = await Promise.all([
      loadOrgAIConfig(session.activeOrganizationId),
      loadPromptCachingPreference(session.activeOrganizationId),
    ]);

    const aiAnalytics = createTanStackAIAnalyticsCallbacks({
      usageMetering: {
        actionType: "chat",
        organizationId: session.activeOrganizationId,
        safeDb,
        serviceTier: "standard",
        userId: user.id,
        workspaceId,
      },
      feature: "properties.suggest-prompt",
      modelRole: "fast",
      orgAIConfig,
      properties: {
        organization_id: session.activeOrganizationId,
        content_type: body.contentType,
      },
      traceId: Bun.randomUUIDv7(),
    });

    const userMessage = buildSuggestPromptUserMessage({
      name: trimmedName,
      contentType: body.contentType,
      options: body.options?.map((o) => o.value),
      currentPrompt: body.currentPrompt?.trim() || undefined,
      instruction,
    });

    const generateResult = await Result.tryPromise({
      try: async () => {
        const result = await generateTanStackTextForRole({
          finishPolicy: "require-complete",
          role: "fast",
          serviceTier: "standard",
          orgAIConfig,
          organizationId: session.activeOrganizationId,
          tenantWorkspaceIds: [workspaceId],
          analytics: aiAnalytics,
          caching: resolveCaching({
            promptCachingEnabled,
            role: "fast",
            scopeKey: null,
          }),
          system: SUGGEST_PROMPT_SYSTEM_PROMPT,
          messages: [{ role: "user", content: userMessage }],
          abortSignal: AbortSignal.any([
            request.signal,
            AbortSignal.timeout(SUGGEST_TIMEOUT_MS),
          ]),
        });
        return result;
      },
      catch: (error) => {
        aiAnalytics.captureError(error);
        return error;
      },
    });

    if (Result.isError(generateResult)) {
      return Result.err(
        aiHandlerError(generateResult.error, {
          status: 502,
          message: "Suggest prompt failed",
        }),
      );
    }

    const prompt = sanitizeSuggestion(generateResult.value);
    if (prompt.length === 0) {
      return Result.err(
        new HandlerError({ status: 502, message: "Empty suggestion" }),
      );
    }

    return Result.ok({ prompt });
  },
);

export default suggestPrompt;
