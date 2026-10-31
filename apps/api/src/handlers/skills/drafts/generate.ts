import { Result } from "better-result";
import * as v from "valibot";

import { SKILL_RESOURCE_FOLDERS } from "@stll/skills/format";

import { stripMarkdownFences } from "@/api/lib/agent-skills/markdown-fences";
import { resolveCaching } from "@/api/lib/ai-config";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { storedAIConfigUnreadableError } from "@/api/lib/ai-config-response";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import {
  ACCOUNT_ACCESS,
  configuredModelAdmission,
  createSafeRootHandler,
} from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { generateTanStackObjectForTask } from "@/api/lib/tanstack-ai-generate";
import { requireTanStackAIAvailableForTask } from "@/api/lib/tanstack-ai-models";

import { isAiResourcePath } from "../ai-resource-path";

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
const RESOURCE_FOLDER_LIST = [...SKILL_RESOURCE_FOLDERS]
  .map((folder) => `${folder}/`)
  .join(", ");

const previousResourceSchema = v.object({
  path: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(PREVIOUS_RESOURCE_PATH_MAX),
  ),
  content: v.pipe(v.string(), v.maxLength(PREVIOUS_RESOURCE_CONTENT_MAX)),
});

const generateDraftBodySchema = v.object({
  intent: v.pipe(v.string(), v.minLength(1), v.maxLength(INTENT_MAX_CHARS)),
  examples: v.optional(v.pipe(v.string(), v.maxLength(EXAMPLES_MAX_CHARS))),
  previousDraft: v.optional(
    v.pipe(v.string(), v.maxLength(PREVIOUS_DRAFT_MAX_CHARS)),
  ),
  previousResources: v.optional(
    v.pipe(
      v.array(previousResourceSchema),
      v.maxLength(PREVIOUS_RESOURCES_MAX),
    ),
  ),
  feedback: v.optional(v.pipe(v.string(), v.maxLength(FEEDBACK_MAX_CHARS))),
});

const config = {
  contract: "patch",
  actionAdmission: { type: "handler", actionKind: "skills.generate-draft" },
  description:
    "Draft a skill bundle with the model: returns SKILL.md markdown plus up " +
    `to eight companion files under ${RESOURCE_FOLDER_LIST}. ` +
    "Pass intent, optionally examples, and, to revise an existing draft, " +
    "previousDraft with previousResources and feedback. Nothing is stored: " +
    "pass the result to skills.create and the resource endpoints to keep it. " +
    "Consumes AI usage.",
  permissions: { agentSkill: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    reason: "agent_tool_authoring",
    consumesServices: true,
  },
  body: generateDraftBodySchema,
  // Queued / "flex" tier — the draft generator is asynchronous from
  // the user's perspective and tolerates higher latency, so we
  // charge the discounted rate.
  requiresUsage: {
    actionType: "chat",
    serviceTier: "flex",
    modelTask: "short-text",
  },
} satisfies HandlerConfig;

const aiResourceSchema = v.strictObject({
  path: v.pipe(
    v.string(),
    v.description(
      `Relative path inside the skill folder. Must start with one of ${RESOURCE_FOLDER_LIST} and end in .md. Subfolders are allowed to organise material (e.g. references/cz/act-110.md). Use lowercase letters, digits, hyphens, dots, or underscores in each segment.`,
    ),
  ),
  content: v.pipe(
    v.string(),
    v.description("Full Markdown content for the file."),
  ),
});

/** Read by the structured-output role contract test. @public */
export const aiGenerationSchema = v.strictObject({
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
  async function* ({
    modelAdmission,
    body,
    orgAIConfig,
    managedAIResidency,
    orgAIConfigStatus,
    promptCachingEnabled,
    safeDb,
    session,
    user,
  }) {
    if (orgAIConfigStatus === ORG_AI_CONFIG_STATUS.unreadable) {
      return Result.err(storedAIConfigUnreadableError());
    }

    yield* requireTanStackAIAvailableForTask({
      dataClass: "customer",
      configStatus: orgAIConfigStatus,
      orgConfig: orgAIConfig,
      task: "short-text",
    });

    const aiAnalytics = createTanStackAIAnalyticsCallbacks({
      dataClass: "customer",
      usageMetering: {
        actionType: "chat",
        organizationId: session.activeOrganizationId,
        safeDb,
        serviceTier: "flex",
        userId: user.id,
        workspaceId: null,
      },
      feature: "skills.generate_draft",
      modelTask: "short-text",
      orgAIConfig,
      modelTier: configuredModelAdmission({ modelAdmission }).modelTier,
      properties: { organization_id: session.activeOrganizationId },
      traceId: Bun.randomUUIDv7(),
    });

    const prompt = buildPrompt(body);
    const generation = await Result.tryPromise({
      try: async () =>
        await generateTanStackObjectForTask({
          userId: user.id,
          dataClass: "customer",
          admission: configuredModelAdmission({ modelAdmission }),
          deadlineMs: GENERATION_TIMEOUT_MS,
          maxOutputTokens: GENERATION_MAX_OUTPUT_TOKENS,
          task: "short-text",
          serviceTier: "flex",
          orgAIConfig,
          managedAIResidency,
          organizationId: session.activeOrganizationId,
          // Root-scoped handler: no workspace id is available here.
          tenantWorkspaceIds: [],
          analytics: aiAnalytics,
          caching: resolveCaching({
            promptCachingEnabled,
            task: "short-text",
            scopeKey: `${session.activeOrganizationId}:skills:draft`,
          }),
          outputSchema: aiGenerationSchema,
          prompt,
        }),
      catch: (cause) => {
        aiAnalytics.captureError(cause);
        return new HandlerError({
          status: 502,
          code: "internal_error",
          message: "Could not generate skill draft. Please try again.",
          cause,
        });
      },
    });
    if (Result.isError(generation)) {
      return Result.err(generation.error);
    }

    const markdown = stripMarkdownFences(generation.value.markdown);
    if (!markdown) {
      return Result.err(
        new HandlerError({
          status: 502,
          code: "internal_error",
          message: "Skill draft was empty. Please try again.",
        }),
      );
    }

    const resources = sanitizeResources(generation.value.resources);

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
    if (!isAiResourcePath(path) || seen.has(path)) {
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
- Body: clear, imperative Markdown for the agent. Cover when to use the skill, the steps to follow, and any constraints. Reference companion files by relative path when appropriate (e.g. "see references/01-foundations.md").
- Keep the body under 2,000 words. No code fences around the whole file.

Companion files (the "resources" array):
- Each path must start with one of ${RESOURCE_FOLDER_LIST} and end in .md. Lowercase letters, digits, hyphens, dots, and underscores only. Subfolders are allowed to organise material by topic, jurisdiction, or source type. Examples: references/01-foundations.md, references/draft-summary.prompt.md, references/checklists.md, references/cz/act-110.md, references/case-law/supreme.md.
- scripts/* — Markdown instructions for helper scripts.
- assets/* — supporting text assets.
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

export default generateSkillDraft;
