import { panic, Result } from "better-result";
import { and, asc, eq } from "drizzle-orm";
import * as v from "valibot";

import { AI_FAILURE_CODES } from "@stll/api-contract";
import { classifyFailure } from "@stll/errors";

import { abortableTx } from "@/api/db/safe-db";
import { agentSkillProposals, agentSkillResources } from "@/api/db/schema";
import { skillRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { aiRevisionSchema } from "@/api/handlers/skills/proposals/from-comments/create";
import { loadVisibleSkill } from "@/api/lib/agent-skills/access";
import { stripMarkdownFences } from "@/api/lib/agent-skills/markdown-fences";
import { requireEditableSkillOrigin } from "@/api/lib/agent-skills/origin";
import {
  loadLatestSkillRevision,
  lockSkillForAnchor,
} from "@/api/lib/agent-skills/revisions";
import { checkSkillPackage } from "@/api/lib/agent-skills/skill-package-check";
import { resolveCaching } from "@/api/lib/ai-config";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { storedAIConfigUnreadableError } from "@/api/lib/ai-config-response";
import {
  generateArtefact,
  readUnsourcedArtefact,
} from "@/api/lib/ai-generation/provenance";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import {
  ACCOUNT_ACCESS,
  configuredModelAdmission,
  createSafeRootHandler,
} from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { readCursorPage } from "@/api/lib/db/read-bounded";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { generateTanStackObjectForTask } from "@/api/lib/tanstack-ai-generate";
import { requireTanStackAIAvailableForTask } from "@/api/lib/tanstack-ai-models";

import { preservesFrontmatter } from "../frontmatter-guard";

const GENERATOR =
  "apps/api/src/handlers/skills/proposals/suggest-improvements/create.ts";
const FOCUS_MAX_CHARS = 2000;
const SUMMARY_MAX_CHARS = 600;
const GENERATION_TIMEOUT_MS = 90_000;
const GENERATION_MAX_OUTPUT_TOKENS = 8192;

const config = {
  contract: "patch",
  actionAdmission: {
    type: "handler",
    actionKind: "skills.suggest-improvements",
  },
  description:
    "Review an agent skill's instructions and context file structure, then " +
    "create a draft change proposal with concrete improvements to SKILL.md. " +
    "The live skill is untouched until a manager accepts the proposal. " +
    "Bundled skills are refused. Consumes AI usage.",
  permissions: { agentSkill: ["propose"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  realtime: skillRealtimeUpdates,
  access: "write",
  mcp: {
    type: "capability",
    reason: "agent_tool_authoring",
    consumesServices: true,
  },
  params: v.object({ skillId: resourceIdSchema("agentSkill") }),
  body: v.object({
    focus: v.optional(
      v.pipe(
        v.string(),
        v.maxLength(FOCUS_MAX_CHARS),
        v.description(
          "Optional focus area for improvements (e.g. clarity, edge cases, structure).",
        ),
      ),
    ),
  }),
  requiresUsage: {
    actionType: "chat",
    serviceTier: "flex",
    modelTask: "short-text",
  },
  aggregateMutation: {
    type: "independent",
    reason:
      "Creates one new draft proposal row referencing an existing skill revision; does not mutate the skill or existing proposals.",
  },
} satisfies HandlerConfig;

const suggestSkillImprovements = createSafeRootHandler(
  config,
  async function* ({
    body,
    managedAIResidency,
    modelAdmission,
    orgAIConfig,
    orgAIConfigStatus,
    params,
    promptCachingEnabled,
    recordAuditEvent,
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

    const sourceResult = yield* Result.await(
      abortableTx(safeDb, async (tx) => {
        const skill = await loadVisibleSkill(tx, {
          skillId: params.skillId,
          organizationId: session.activeOrganizationId,
        });
        const editableOrigin = requireEditableSkillOrigin(skill.origin);
        if (Result.isError(editableOrigin)) {
          return Result.err(editableOrigin.error);
        }
        await lockSkillForAnchor(tx, params.skillId);
        const revision = await loadLatestSkillRevision(tx, {
          skillId: params.skillId,
          organizationId: session.activeOrganizationId,
        });
        if (!revision) {
          return panic("agent skill has no revision");
        }
        const resourcesPage = await readCursorPage(
          tx
            .select({
              content: agentSkillResources.content,
              path: agentSkillResources.path,
            })
            .from(agentSkillResources)
            .where(
              and(
                eq(agentSkillResources.skillId, params.skillId),
                eq(
                  agentSkillResources.organizationId,
                  session.activeOrganizationId,
                ),
              ),
            )
            .orderBy(asc(agentSkillResources.path)),
          {
            limit: LIMITS.agentSkillResourcesPerSkill,
            cursorForItem: (row) => row.path,
          },
        );
        const resources = resourcesPage.items;
        return Result.ok({ resources, revision });
      }),
    );
    if (Result.isError(sourceResult)) {
      return Result.err(sourceResult.error);
    }
    const source = sourceResult.value;
    const packageCheck = checkSkillPackage({
      resources: source.resources.map((entry) => ({
        content: entry.content,
        path: entry.path,
        type: "text" as const,
      })),
      skillMd: source.revision.body,
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
      feature: "skills.suggest_improvements",
      modelTask: "short-text",
      orgAIConfig,
      modelTier: configuredModelAdmission({ modelAdmission }).modelTier,
      properties: { organization_id: session.activeOrganizationId },
      traceId: Bun.randomUUIDv7(),
    });

    const generation = await Result.tryPromise({
      try: async () =>
        await generateArtefact({
          generator: GENERATOR,
          sources: { decisionIds: [], inputs: [] },
          generate: async () =>
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
              tenantWorkspaceIds: [],
              analytics: aiAnalytics,
              caching: resolveCaching({
                promptCachingEnabled,
                task: "short-text",
                scopeKey: `${session.activeOrganizationId}:skills:${params.skillId}:suggest`,
              }),
              outputSchema: aiRevisionSchema,
              prompt: buildPrompt({
                currentBody: source.revision.body,
                diagnostics: packageCheck.diagnostics.map((d) => d.message),
                focus: body.focus,
                missingReferences: packageCheck.missingReferences,
                resourcePaths: source.resources.map((r) => r.path),
              }),
            }),
        }),
      catch: (cause) => {
        aiAnalytics.captureError(cause);
        return classifyFailure(
          new HandlerError({
            status: 502,
            code: AI_FAILURE_CODES.provider_unavailable,
            message: "Could not suggest improvements. Please try again.",
            cause,
          }),
          "upstream_unavailable",
        );
      },
    });
    if (Result.isError(generation)) {
      return Result.err(generation.error);
    }
    if (Result.isError(generation.value)) {
      return Result.err(
        classifyFailure(
          new HandlerError({
            status: 502,
            code: AI_FAILURE_CODES.provider_unavailable,
            message: "Could not suggest improvements. Please try again.",
            cause: generation.value.error,
          }),
          "upstream_unavailable",
        ),
      );
    }
    const generated = readUnsourcedArtefact(generation.value.value);

    const validated = validateSuggestedMarkdown({
      original: source.revision.body,
      raw: generated.markdown,
    });
    if (Result.isError(validated)) {
      return Result.err(validated.error);
    }
    const markdown = validated.value;
    const summary = buildSummary(generated.summary);

    const created = yield* Result.await(
      abortableTx(safeDb, async (tx) => {
        const [row] = await tx
          .insert(agentSkillProposals)
          .values({
            organizationId: session.activeOrganizationId,
            skillId: params.skillId,
            baseRevisionId: source.revision.id,
            body: markdown,
            summary,
            status: "draft",
            authorId: user.id,
          })
          .returning({ id: agentSkillProposals.id });
        if (!row) {
          return panic("insert into agent_skill_proposals returned no row");
        }
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.CREATE,
          resourceType: AUDIT_RESOURCE_TYPE.AGENT_SKILL_PROPOSAL,
          resourceId: row.id,
          changes: { status: { old: null, new: "draft" } },
          metadata: {
            skillId: params.skillId,
            source: "suggest_improvements",
          },
        });
        return row;
      }),
    );

    return Result.ok({ id: created.id, summary });
  },
);

const validateSuggestedMarkdown = ({
  original,
  raw,
}: {
  original: string;
  raw: string;
}): Result<string, HandlerError> => {
  const markdown = stripMarkdownFences(raw);
  if (!markdown) {
    return Result.err(
      classifyFailure(
        new HandlerError({
          status: 502,
          code: AI_FAILURE_CODES.empty_completion,
          message: "The suggested skill revision was empty. Please try again.",
        }),
        "model_output_invalid",
      ),
    );
  }
  if (markdown.length > LIMITS.agentSkillBodyMaxChars) {
    return Result.err(
      classifyFailure(
        new HandlerError({
          status: 502,
          code: AI_FAILURE_CODES.output_invalid,
          message: "The suggested skill revision exceeds the maximum size.",
        }),
        "model_output_invalid",
      ),
    );
  }
  if (!preservesFrontmatter({ original, revised: markdown })) {
    return Result.err(
      classifyFailure(
        new HandlerError({
          status: 502,
          code: AI_FAILURE_CODES.output_invalid,
          message:
            "The suggested skill revision dropped or altered its frontmatter. Please try again.",
        }),
        "model_output_invalid",
      ),
    );
  }
  return Result.ok(markdown);
};

const buildSummary = (generated: string): string => {
  const prefix = "Suggested improvements: ";
  const trimmed = generated.trim();
  const room = Math.max(0, SUMMARY_MAX_CHARS - prefix.length);
  return trimmed.length === 0
    ? "Suggested improvements to instructions."
    : `${prefix}${trimmed.slice(0, room)}`;
};

const buildPrompt = ({
  currentBody,
  diagnostics,
  focus,
  missingReferences,
  resourcePaths,
}: {
  currentBody: string;
  diagnostics: readonly string[];
  focus: string | undefined;
  missingReferences: readonly string[];
  resourcePaths: readonly string[];
}): string => {
  const sections = [
    "You are refining an agent skill's SKILL.md instructions for a legal AI workspace.",
    "Improve clarity, actionability, structure, edge-case handling, and how the instructions guide the assistant to use any attached context files.",
    "Preserve the skill's language, domain intent, and exact YAML frontmatter block unchanged.",
    "Do not invent facts, citations, or files that do not exist.",
    "Keep edits tight and purposeful so the diff is easy for a human reviewer to inspect and accept.",
  ];
  if (resourcePaths.length > 0) {
    sections.push(
      `Available context files in this skill:\n${resourcePaths.map((p) => `- ${p}`).join("\n")}`,
    );
  }
  if (diagnostics.length > 0) {
    sections.push(
      `Package validation issues to fix where possible:\n${diagnostics.map((d) => `- ${d}`).join("\n")}`,
    );
  }
  if (missingReferences.length > 0) {
    sections.push(
      `Referenced paths that do not exist in the skill bundle:\n${missingReferences.map((m) => `- ${m}`).join("\n")}`,
    );
  }
  if (focus !== undefined && focus.trim().length > 0) {
    sections.push(`Author's focus request:\n${focus.trim()}`);
  }
  sections.push(`Current SKILL.md:\n${currentBody}`);
  return sections.join("\n\n");
};

export default suggestSkillImprovements;
