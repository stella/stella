import { generateText } from "ai";
import { Result } from "better-result";
import { t } from "elysia";

import {
  loadOrgAIConfig,
  loadPromptCachingPreference,
} from "@/api/lib/ai-config-loader";
import { aiHandlerError } from "@/api/lib/ai-error";
import { getModelForRole } from "@/api/lib/ai-models";
import { createAIAnalyticsCallbacks } from "@/api/lib/analytics/ai";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tDefaultVarchar } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

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
});

const config = {
  permissions: { property: ["create"] },
  body: suggestPromptBodySchema,
} satisfies HandlerConfig;

const SUGGEST_TIMEOUT_MS = 20_000;
const MAX_PROMPT_LENGTH = 280;

const SYSTEM_PROMPT = `You write extraction prompts for a legal-document AI tool.
Given a column name (and optionally the user's current prompt draft), produce
ONE direct, imperative sentence telling the AI what to extract from the
document. Rules:
- Output the prompt only. No preamble, no quotes, no markdown.
- Single sentence, plain text, ends with a period.
- If the user supplied a current draft, REFINE it: keep their intent and
  vocabulary, fix grammar, tighten wording, and align with the result type.
  Do not invent constraints they didn't ask for.
- If no draft, write a fresh prompt grounded in the column name.
- Match the result type:
  - text → ask for the value as a short string.
  - int → ask for a number.
  - date → ask for a date in ISO 8601 (YYYY-MM-DD).
  - single-select → ask the AI to choose exactly one of the listed options.
  - multi-select → ask for all matching options from the list.
- Reference the document implicitly when natural ("from the contract").
- Stay under 280 characters.`;

const buildUserMessage = ({
  name,
  contentType,
  options,
  currentPrompt,
}: {
  name: string;
  contentType: string;
  options: string[] | undefined;
  currentPrompt: string | undefined;
}): string => {
  const lines = [`Column name: ${name}`, `Result type: ${contentType}`];
  if (options && options.length > 0) {
    lines.push(`Allowed options: ${options.join(", ")}`);
  }
  if (currentPrompt && currentPrompt.length > 0) {
    lines.push(`Current draft (refine, don't replace): ${currentPrompt}`);
  }
  lines.push("Write the extraction prompt:");
  return lines.join("\n");
};

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
  // `createSafeHandler` requires an AsyncGenerator. No DB ops to yield* over.
  // eslint-disable-next-line require-yield
  async function* ({ session, request, body }) {
    const trimmedName = body.name.trim();
    if (trimmedName.length === 0) {
      return Result.err(
        new HandlerError({ status: 400, message: "Column name is required" }),
      );
    }

    const [orgAIConfig, promptCachingEnabled] = await Promise.all([
      loadOrgAIConfig(session.activeOrganizationId),
      loadPromptCachingPreference(session.activeOrganizationId),
    ]);

    const aiAnalytics = createAIAnalyticsCallbacks({
      feature: "properties.suggest-prompt",
      modelRole: "fast",
      orgAIConfig,
      properties: {
        organization_id: session.activeOrganizationId,
        content_type: body.contentType,
      },
      traceId: Bun.randomUUIDv7(),
    });

    const userMessage = buildUserMessage({
      name: trimmedName,
      contentType: body.contentType,
      options: body.options?.map((o) => o.value),
      currentPrompt: body.currentPrompt?.trim() || undefined,
    });

    const generateResult = await Result.tryPromise({
      try: async () => {
        const result = await generateText({
          model: getModelForRole("fast", orgAIConfig, {
            promptCachingEnabled,
            scopeKey: null,
            organizationId: session.activeOrganizationId,
          }),
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: userMessage }],
          abortSignal: AbortSignal.any([
            request.signal,
            AbortSignal.timeout(SUGGEST_TIMEOUT_MS),
          ]),
          ...aiAnalytics.stepCallbacks,
        });
        return result.text;
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
