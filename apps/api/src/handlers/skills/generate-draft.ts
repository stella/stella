import { valibotSchema } from "@ai-sdk/valibot";
import { generateText, Output } from "ai";
import { Result } from "better-result";
import { t } from "elysia";
import * as v from "valibot";

import { getModelForRole, requireAIAvailable } from "@/api/lib/ai-models";
import { createAIAnalyticsCallbacks } from "@/api/lib/analytics/ai";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

const INTENT_MAX_CHARS = 2000;
const EXAMPLES_MAX_CHARS = 2000;
const FEEDBACK_MAX_CHARS = 2000;
const PREVIOUS_DRAFT_MAX_CHARS = LIMITS.agentSkillBodyMaxChars;
const PREVIOUS_RESOURCES_MAX = 24;
const PREVIOUS_RESOURCE_PATH_MAX = 256;
const PREVIOUS_RESOURCE_CONTENT_MAX = LIMITS.agentSkillResourceMaxChars;
const GENERATION_TIMEOUT_MS = 90_000;
const GENERATION_MAX_OUTPUT_TOKENS = 8192;
const AI_RESOURCES_MAX = 8;
const AI_RESOURCE_PATH_PATTERN =
  /^(references|prompts|knowledge)\/[a-z0-9][a-z0-9._-]*\.md$/u;

const previousResourceSchema = t.Object({
  path: t.String({ minLength: 1, maxLength: PREVIOUS_RESOURCE_PATH_MAX }),
  content: t.String({ maxLength: PREVIOUS_RESOURCE_CONTENT_MAX }),
});

const generateDraftBodySchema = t.Object({
  intent: t.String({ minLength: 1, maxLength: INTENT_MAX_CHARS }),
  examples: t.Optional(t.String({ maxLength: EXAMPLES_MAX_CHARS })),
  previousDraft: t.Optional(t.String({ maxLength: PREVIOUS_DRAFT_MAX_CHARS })),
  previousResources: t.Optional(
    t.Array(previousResourceSchema, { maxItems: PREVIOUS_RESOURCES_MAX }),
  ),
  feedback: t.Optional(t.String({ maxLength: FEEDBACK_MAX_CHARS })),
});

const config = {
  permissions: { agentSkill: ["create"] },
  body: generateDraftBodySchema,
} satisfies HandlerConfig;

const aiResourceSchema = v.strictObject({
  path: v.pipe(
    v.string(),
    v.description(
      "Relative path inside the skill folder. Must start with references/, prompts/, or knowledge/ and end in .md. Use lowercase letters, digits, hyphens, dots, or underscores.",
    ),
  ),
  content: v.pipe(
    v.string(),
    v.description("Full Markdown content for the file."),
  ),
});

const aiGenerationSchema = v.strictObject({
  markdown: v.pipe(
    v.string(),
    v.description(
      "Full SKILL.md including YAML frontmatter (name, description, optional version/license/compatibility) and the Markdown body. No surrounding code fences.",
    ),
  ),
  resources: v.pipe(
    v.array(aiResourceSchema),
    v.description(
      "Optional companion files for the skill folder. Return an empty array if no supporting files are needed.",
    ),
  ),
});

type GeneratedResource = { content: string; path: string };

const generateSkillDraft = createSafeRootHandler(
  config,
  async function* ({ body, orgAIConfig, promptCachingEnabled, session }) {
    yield* requireAIAvailable(orgAIConfig);

    const aiAnalytics = createAIAnalyticsCallbacks({
      feature: "skills.generate_draft",
      modelRole: "fast",
      orgAIConfig,
      properties: { organization_id: session.activeOrganizationId },
      traceId: Bun.randomUUIDv7(),
    });

    const prompt = buildPrompt(body);
    const generation = await Result.tryPromise({
      try: async () =>
        await generateText({
          abortSignal: AbortSignal.timeout(GENERATION_TIMEOUT_MS),
          maxOutputTokens: GENERATION_MAX_OUTPUT_TOKENS,
          model: getModelForRole("fast", orgAIConfig, {
            promptCachingEnabled,
            scopeKey: null,
            organizationId: session.activeOrganizationId,
          }),
          output: Output.object({ schema: valibotSchema(aiGenerationSchema) }),
          prompt,
          ...aiAnalytics.stepCallbacks,
        }),
      catch: (cause) => {
        aiAnalytics.captureError(cause);
        return new HandlerError({
          status: 502,
          message: "Could not generate skill draft. Please try again.",
          cause,
        });
      },
    });
    if (Result.isError(generation)) {
      return Result.err(generation.error);
    }

    const markdown = stripFences(generation.value.output.markdown).trim();
    if (!markdown) {
      return Result.err(
        new HandlerError({
          status: 502,
          message: "Skill draft was empty. Please try again.",
        }),
      );
    }

    const resources = sanitizeResources(generation.value.output.resources);

    return Result.ok({ markdown, resources });
  },
);

const sanitizeResources = (
  raw: readonly { content: string; path: string }[],
): GeneratedResource[] => {
  const seen = new Set<string>();
  const result: GeneratedResource[] = [];

  for (const item of raw) {
    if (result.length >= AI_RESOURCES_MAX) {
      break;
    }
    const path = item.path.trim();
    if (!AI_RESOURCE_PATH_PATTERN.test(path) || seen.has(path)) {
      continue;
    }
    const content = item.content;
    if (
      content.length === 0 ||
      content.length > PREVIOUS_RESOURCE_CONTENT_MAX
    ) {
      continue;
    }
    seen.add(path);
    result.push({ content, path });
  }

  return result;
};

const buildPrompt = ({
  intent,
  examples,
  previousDraft,
  previousResources,
  feedback,
}: {
  intent: string;
  examples?: string | undefined;
  previousDraft?: string | undefined;
  previousResources?: readonly { content: string; path: string }[] | undefined;
  feedback?: string | undefined;
}): string => {
  const sections = [
    `You are drafting a stella agent skill, returned as JSON matching the provided schema.

A skill bundle contains a SKILL.md file at the root and zero or more companion Markdown files under fixed subfolders. The bundle teaches an AI agent when to use the skill and how to follow it.

SKILL.md rules:
- YAML frontmatter delimited by lines containing only "---".
- Required: name (lowercase letters/digits/hyphens, max 64 chars, starts with a letter or digit) and description (one sentence, <= 300 chars, helps the AI decide when to trigger the skill).
- Optional: version (semver), license (SPDX id), compatibility.
- Body: clear, imperative Markdown for the agent. Cover when to use the skill, the steps to follow, and any constraints. Reference companion files by relative path when appropriate (e.g. "see knowledge/01-foundations.md").
- Keep the body under 2,000 words. No code fences around the whole file.

Companion files (the "resources" array):
- Each path must start with references/, prompts/, or knowledge/ and end in .md. Lowercase letters, digits, hyphens, dots, and underscores only. Examples: knowledge/01-foundations.md, prompts/draft-summary.prompt.md, references/checklists.md.
- knowledge/* — background material the agent reads (definitions, frameworks, examples).
- prompts/* — reusable prompts the agent can run for sub-tasks.
- references/* — checklists, lookup tables, format guides.
- Each file is plain Markdown. No frontmatter on companion files.
- Return at most ${AI_RESOURCES_MAX} files. Only include a file if it genuinely helps the skill; return an empty array if none are needed.
- Never invent legal facts, jurisdictions, citations, or company details. Stay generic unless the user supplied specifics.`,
    `User intent:\n${intent.trim()}`,
  ];

  const trimmedExamples = examples?.trim();
  if (trimmedExamples) {
    sections.push(`Example trigger phrases or scenarios:\n${trimmedExamples}`);
  }

  const trimmedPrevious = previousDraft?.trim();
  if (trimmedPrevious) {
    sections.push(
      `Previous SKILL.md to revise:\n\`\`\`\n${trimmedPrevious}\n\`\`\``,
    );
  }

  if (previousResources && previousResources.length > 0) {
    const formatted = previousResources
      .map(
        (resource) =>
          `### ${resource.path}\n\`\`\`\n${resource.content}\n\`\`\``,
      )
      .join("\n\n");
    sections.push(`Previous companion files:\n${formatted}`);
  }

  const trimmedFeedback = feedback?.trim();
  if (trimmedFeedback) {
    sections.push(`Revision feedback to apply:\n${trimmedFeedback}`);
  }

  sections.push(
    "Return the complete updated skill now, including all companion files.",
  );
  return sections.join("\n\n");
};

const stripFences = (raw: string): string => {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  const fencePattern = /^```(?:[a-zA-Z0-9_-]*)\n([\s\S]*?)\n```$/u;
  const fenceMatch = fencePattern.exec(trimmed);
  return fenceMatch?.at(1)?.trim() ?? trimmed;
};

export default generateSkillDraft;
