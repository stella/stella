import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { agentSkillResources } from "@/api/db/schema";
import { loadManagedSkill } from "@/api/handlers/skills/managed-skill";
import { stripMarkdownFences } from "@/api/lib/agent-skills/markdown-fences";
import { resolveCaching } from "@/api/lib/ai-config";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { generateTanStackTextForRole } from "@/api/lib/tanstack-ai-generate";
import { requireTanStackAIAvailableForRole } from "@/api/lib/tanstack-ai-models";

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
  description:
    "Rewrite one file of an agent skill with the model, from a free-text " +
    "instruction and the file's current content. Returns the proposed " +
    "content without saving it: persist it with skills.resources.update. " +
    "Consumes AI usage.",
  permissions: { agentSkill: ["update"] },
  mcp: { type: "capability", reason: "agent_tool_authoring" },
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
    orgAIConfigStatus,
    params,
    promptCachingEnabled,
    safeDb,
    session,
    user,
  }) {
    yield* requireTanStackAIAvailableForRole({
      configStatus: orgAIConfigStatus,
      orgConfig: orgAIConfig,
      role: "fast",
    });

    yield* Result.await(
      loadManagedSkill({
        safeDb,
        skillId: params.skillId,
        organizationId: session.activeOrganizationId,
        memberRole,
        userId: user.id,
        action: "edit",
      }),
    );

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

    const aiAnalytics = createTanStackAIAnalyticsCallbacks({
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
        await generateTanStackTextForRole({
          abortSignal: AbortSignal.timeout(REWRITE_TIMEOUT_MS),
          finishPolicy: "require-complete",
          maxOutputTokens: REWRITE_MAX_OUTPUT_TOKENS,
          role: "fast",
          serviceTier: "standard",
          orgAIConfig,
          organizationId: session.activeOrganizationId,
          // Root-scoped handler: no workspace id is available here.
          tenantWorkspaceIds: [],
          analytics: aiAnalytics,
          caching: resolveCaching({
            promptCachingEnabled,
            role: "fast",
            scopeKey: `${session.activeOrganizationId}:skills:${params.skillId}:${resource.path}`,
          }),
          prompt,
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

    const rewritten = stripMarkdownFences(generation.value);
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

export default rewriteSkillResource;
