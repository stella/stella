import { generateText } from "ai";
import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { agentSkillResources, agentSkills } from "@/api/db/schema";
import { getModelForRole, requireAIAvailable } from "@/api/lib/ai-models";
import { createAIAnalyticsCallbacks } from "@/api/lib/analytics/ai";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

const REWRITE_PROMPT_MAX_CHARS = 2000;
const REWRITE_TIMEOUT_MS = 60_000;
const REWRITE_MAX_OUTPUT_TOKENS = 8192;

const rewriteSkillResourceParamsSchema = t.Object({
  skillId: tSafeId("agentSkill"),
});

const rewriteSkillResourceBodySchema = t.Object({
  path: t.String({ minLength: 1, maxLength: 512 }),
  prompt: t.String({ minLength: 1, maxLength: REWRITE_PROMPT_MAX_CHARS }),
});

const config = {
  permissions: { agentSkill: ["update"] },
  params: rewriteSkillResourceParamsSchema,
  body: rewriteSkillResourceBodySchema,
  requiresUsage: { actionType: "chat", modelRole: "fast" },
} satisfies HandlerConfig;

const rewriteSkillResource = createSafeRootHandler(
  config,
  async function* ({
    body,
    memberRole,
    orgAIConfig,
    promptCachingEnabled,
    params,
    safeDb,
    session,
    user,
  }) {
    yield* requireAIAvailable(orgAIConfig);

    const skillRows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: agentSkills.id,
            scope: agentSkills.scope,
            userId: agentSkills.userId,
            slug: agentSkills.slug,
          })
          .from(agentSkills)
          .where(
            and(
              eq(agentSkills.id, params.skillId),
              eq(agentSkills.organizationId, session.activeOrganizationId),
            ),
          )
          .limit(1),
      ),
    );
    const skill = skillRows.at(0);
    if (!skill) {
      return Result.err(
        new HandlerError({ status: 404, message: "Skill not found" }),
      );
    }

    if (
      skill.scope === "team" &&
      !["admin", "owner"].includes(memberRole.role)
    ) {
      return Result.err(
        new HandlerError({
          status: 403,
          message: "Only admins and owners can edit team skills",
        }),
      );
    }
    if (skill.scope === "private" && skill.userId !== user.id) {
      return Result.err(
        new HandlerError({ status: 403, message: "Forbidden" }),
      );
    }

    const resourceRows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            content: agentSkillResources.content,
            path: agentSkillResources.path,
          })
          .from(agentSkillResources)
          .where(
            and(
              eq(agentSkillResources.skillId, params.skillId),
              eq(agentSkillResources.path, body.path),
            ),
          )
          .limit(1),
      ),
    );
    const resource = resourceRows.at(0);
    if (!resource) {
      return Result.err(
        new HandlerError({ status: 404, message: "Resource not found" }),
      );
    }

    const aiAnalytics = createAIAnalyticsCallbacks({
      usageMetering: {
        actionType: "chat",
        organizationId: session.activeOrganizationId,
        safeDb,
        serviceTier: "standard",
        userId: user.id,
        workspaceId: null,
      },
      feature: "skills.rewrite_resource",
      modelRole: "fast",
      orgAIConfig,
      properties: { organization_id: session.activeOrganizationId },
      traceId: Bun.randomUUIDv7(),
    });

    const prompt = buildPrompt({
      path: resource.path,
      instruction: body.prompt.trim(),
      currentContent: resource.content,
    });

    const generation = await Result.tryPromise({
      try: async () =>
        await generateText({
          abortSignal: AbortSignal.timeout(REWRITE_TIMEOUT_MS),
          maxOutputTokens: REWRITE_MAX_OUTPUT_TOKENS,
          model: getModelForRole("fast", orgAIConfig, {
            promptCachingEnabled,
            scopeKey: null,
            organizationId: session.activeOrganizationId,
            serviceTier: "standard",
          }),
          prompt,
          ...aiAnalytics.stepCallbacks,
        }),
      catch: (cause) => {
        aiAnalytics.captureError(cause);
        return new HandlerError({
          status: 502,
          message: "Could not rewrite file. Please try again.",
          cause,
        });
      },
    });
    if (Result.isError(generation)) {
      return Result.err(generation.error);
    }

    const rewritten = stripFences(generation.value.text).trim();
    if (!rewritten) {
      return Result.err(
        new HandlerError({
          status: 502,
          message: "Rewrite was empty. Please try again.",
        }),
      );
    }
    if (rewritten.length > LIMITS.agentSkillResourceMaxChars) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Rewritten content exceeds the maximum size",
        }),
      );
    }

    return Result.ok({ content: rewritten, path: resource.path });
  },
);

const buildPrompt = ({
  path,
  instruction,
  currentContent,
}: {
  path: string;
  instruction: string;
  currentContent: string;
}): string => `You are rewriting a file inside a stella agent skill bundle.

Rewrite the file below according to the user's instruction. Return ONLY the new
file contents, no preamble, no explanations, no surrounding code fences. Keep the
same general shape (Markdown, plain text, etc.) unless the instruction says
otherwise.

File path: ${path}

Instruction:
${instruction}

Current content:
\`\`\`
${currentContent}
\`\`\``;

const stripFences = (raw: string): string => {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  const fencePattern = /^```(?:[a-zA-Z0-9_-]*)\n([\s\S]*?)\n```$/u;
  const fenceMatch = fencePattern.exec(trimmed);
  return fenceMatch?.at(1)?.trim() ?? trimmed;
};

export default rewriteSkillResource;
