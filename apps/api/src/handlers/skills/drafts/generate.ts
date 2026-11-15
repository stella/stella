import { Result } from "better-result";
import * as v from "valibot";

import {
  aiGenerationSchema,
  buildSkillDraftPrompt,
  RESOURCE_FOLDER_LIST,
  sanitizeDraftResources,
} from "@/api/lib/agent-skills/draft-prompt";
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

const INTENT_MAX_CHARS = 2000;
const EXAMPLES_MAX_CHARS = 2000;
const FEEDBACK_MAX_CHARS = 2000;
const PREVIOUS_DRAFT_MAX_CHARS = LIMITS.agentSkillBodyMaxChars;
const PREVIOUS_RESOURCES_MAX = 24;
const PREVIOUS_RESOURCE_PATH_MAX = 256;
// Resources pass through the model whole: previous ones in the prompt,
// generated ones in its answer.
const RESOURCE_CONTENT_MAX = LIMITS.agentSkillResourceModelContextMaxChars;
const GENERATION_TIMEOUT_MS = 90_000;
const GENERATION_MAX_OUTPUT_TOKENS = 8192;

const previousResourceSchema = v.object({
  path: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(PREVIOUS_RESOURCE_PATH_MAX),
  ),
  content: v.pipe(v.string(), v.maxLength(RESOURCE_CONTENT_MAX)),
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

    const prompt = buildSkillDraftPrompt(body);
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

    const resources = sanitizeDraftResources(generation.value.resources);

    return Result.ok({ markdown, resources });
  },
);

export default generateSkillDraft;
