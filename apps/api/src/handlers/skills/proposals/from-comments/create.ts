import { panic, Result } from "better-result";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { t } from "elysia";
import * as v from "valibot";

import { abortableTx } from "@/api/db/safe-db";
import { agentSkillComments, agentSkillProposals } from "@/api/db/schema";
import { loadVisibleSkill } from "@/api/lib/agent-skills/access";
import { stripMarkdownFences } from "@/api/lib/agent-skills/markdown-fences";
import { requireEditableSkillOrigin } from "@/api/lib/agent-skills/origin";
import { loadLatestSkillRevision } from "@/api/lib/agent-skills/revisions";
import { resolveCaching } from "@/api/lib/ai-config";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { generateTanStackObjectForRole } from "@/api/lib/tanstack-ai-generate";
import { requireTanStackAIAvailableForRole } from "@/api/lib/tanstack-ai-models";

import { preservesFrontmatter } from "../frontmatter-guard";

const COMMENTS_MAX = 50;
const INSTRUCTIONS_MAX_CHARS = 2000;
const SUMMARY_MAX_CHARS = 600;
const GENERATION_TIMEOUT_MS = 90_000;
const GENERATION_MAX_OUTPUT_TOKENS = 8192;

const fromCommentsParamsSchema = t.Object({
  skillId: tSafeId("agentSkill"),
});

const fromCommentsBodySchema = t.Object({
  commentIds: t.Optional(
    t.Array(tSafeId("agentSkillComment"), {
      minItems: 1,
      maxItems: COMMENTS_MAX,
      description:
        "Comments to apply. Omit to apply every unresolved comment written against the skill's newest revision.",
    }),
  ),
  instructions: t.Optional(
    t.String({
      maxLength: INSTRUCTIONS_MAX_CHARS,
      description:
        "Extra guidance for the revision, applied on top of the comments.",
    }),
  ),
});

const config = {
  description:
    "Turn reviewer comments on an agent skill into a draft change proposal: " +
    "the model rewrites SKILL.md so each comment is addressed, and the result " +
    "is stored as a draft branched from the skill's newest revision. Pass " +
    "commentIds to apply specific comments, or omit it to apply every " +
    "unresolved comment on that revision. The skill itself is untouched until " +
    "someone with edit rights accepts the proposal, the comments stay " +
    "unresolved, and bundled skills are refused. Consumes AI usage.",
  permissions: { agentSkill: ["propose"] },
  access: "write",
  mcp: { type: "capability", reason: "agent_tool_authoring" },
  params: fromCommentsParamsSchema,
  body: fromCommentsBodySchema,
  // Queued / "flex" tier — applying a comment batch is asynchronous from the
  // user's perspective and tolerates higher latency, so we charge the
  // discounted rate.
  requiresUsage: {
    actionType: "chat",
    serviceTier: "flex",
    modelRole: "fast",
  },
} satisfies HandlerConfig;

const aiRevisionSchema = v.strictObject({
  markdown: v.pipe(
    v.string(),
    v.description(
      "The full revised SKILL.md, frontmatter included and unchanged. No surrounding code fences.",
    ),
  ),
  summary: v.pipe(
    v.string(),
    v.description(
      `One paragraph, at most ${SUMMARY_MAX_CHARS} characters, describing what changed.`,
    ),
  ),
});

type AppliedComment = {
  anchorText: string;
  body: string;
  id: SafeId<"agentSkillComment">;
  rangeEnd: number;
  rangeStart: number;
};

const createProposalFromComments = createSafeRootHandler(
  config,
  async function* ({
    body,
    orgAIConfig,
    orgAIConfigStatus,
    params,
    promptCachingEnabled,
    recordAuditEvent,
    safeDb,
    session,
    user,
  }) {
    yield* requireTanStackAIAvailableForRole({
      configStatus: orgAIConfigStatus,
      orgConfig: orgAIConfig,
      role: "fast",
    });

    const source = yield* Result.await(
      abortableTx(safeDb, async (tx) => {
        const skill = await loadVisibleSkill(tx, {
          skillId: params.skillId,
          organizationId: session.activeOrganizationId,
        });

        const editableOrigin = requireEditableSkillOrigin(skill.origin);
        if (Result.isError(editableOrigin)) {
          throw editableOrigin.error;
        }

        const revision = await loadLatestSkillRevision(tx, {
          skillId: params.skillId,
          organizationId: session.activeOrganizationId,
          lock: "share",
        });
        if (!revision) {
          panic("agent skill has no revision");
        }

        const scoped = and(
          eq(agentSkillComments.skillId, params.skillId),
          eq(agentSkillComments.organizationId, session.activeOrganizationId),
        );
        const comments = await tx
          .select({
            id: agentSkillComments.id,
            rangeStart: agentSkillComments.rangeStart,
            rangeEnd: agentSkillComments.rangeEnd,
            anchorText: agentSkillComments.anchorText,
            body: agentSkillComments.body,
          })
          .from(agentSkillComments)
          .where(
            body.commentIds
              ? and(scoped, inArray(agentSkillComments.id, body.commentIds))
              : and(
                  scoped,
                  eq(agentSkillComments.revisionId, revision.id),
                  isNull(agentSkillComments.proposalId),
                  isNull(agentSkillComments.resolvedAt),
                ),
          )
          .orderBy(
            asc(agentSkillComments.createdAt),
            asc(agentSkillComments.id),
          )
          .limit(COMMENTS_MAX);

        // An id the caller named but cannot see (another skill, another org)
        // must not be silently dropped from the batch it asked for.
        if (
          body.commentIds &&
          comments.length !== new Set(body.commentIds).size
        ) {
          throw new HandlerError({
            status: 404,
            message: "Comment not found",
          });
        }
        if (comments.length === 0) {
          throw new HandlerError({
            status: 400,
            message: "No comments to apply",
          });
        }

        return { comments, revision };
      }),
    );

    const aiAnalytics = createTanStackAIAnalyticsCallbacks({
      usageMetering: {
        actionType: "chat",
        organizationId: session.activeOrganizationId,
        safeDb,
        serviceTier: "flex",
        userId: user.id,
        workspaceId: null,
      },
      feature: "skills.apply_comments",
      modelRole: "fast",
      orgAIConfig,
      properties: { organization_id: session.activeOrganizationId },
      traceId: Bun.randomUUIDv7(),
    });

    const generation = await Result.tryPromise({
      try: async () =>
        await generateTanStackObjectForRole({
          abortSignal: AbortSignal.timeout(GENERATION_TIMEOUT_MS),
          maxOutputTokens: GENERATION_MAX_OUTPUT_TOKENS,
          role: "fast",
          serviceTier: "flex",
          orgAIConfig,
          organizationId: session.activeOrganizationId,
          // Root-scoped handler: no workspace id is available here.
          tenantWorkspaceIds: [],
          analytics: aiAnalytics,
          caching: resolveCaching({
            promptCachingEnabled,
            role: "fast",
            scopeKey: `${session.activeOrganizationId}:skills:${params.skillId}:comments`,
          }),
          outputSchema: aiRevisionSchema,
          prompt: buildPrompt({
            comments: source.comments,
            currentBody: source.revision.body,
            instructions: body.instructions,
          }),
        }),
      catch: (cause) => {
        aiAnalytics.captureError(cause);
        return new HandlerError({
          status: 502,
          message: "Could not apply the comments. Please try again.",
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
          message: "The revised skill was empty. Please try again.",
        }),
      );
    }
    if (markdown.length > LIMITS.agentSkillBodyMaxChars) {
      return Result.err(
        new HandlerError({
          status: 502,
          message: "The revised skill exceeds the maximum size.",
        }),
      );
    }
    if (
      !preservesFrontmatter({
        original: source.revision.body,
        revised: markdown,
      })
    ) {
      return Result.err(
        new HandlerError({
          status: 502,
          message:
            "The revised skill dropped or altered its frontmatter. Please try again.",
        }),
      );
    }

    const summary = buildSummary({
      applied: source.comments.length,
      generated: generation.value.summary,
    });
    const commentIds = source.comments.map((comment) => comment.id);

    const created = yield* Result.await(
      abortableTx(safeDb, async (tx) => {
        const rows = await tx
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

        const row = rows.at(0);
        if (!row) {
          throw new HandlerError({
            status: 500,
            message: "Could not create proposal",
          });
        }

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.CREATE,
          resourceType: AUDIT_RESOURCE_TYPE.AGENT_SKILL_PROPOSAL,
          resourceId: row.id,
          changes: {
            status: { old: null, new: "draft" },
          },
          metadata: {
            skillId: params.skillId,
            commentIds,
          },
        });

        return row;
      }),
    );

    return Result.ok({ id: created.id, summary });
  },
);

const buildSummary = ({
  applied,
  generated,
}: {
  applied: number;
  generated: string;
}): string => {
  const prefix = `Applied ${applied} ${applied === 1 ? "comment" : "comments"}: `;
  const trimmed = generated.trim();
  const room = Math.max(0, SUMMARY_MAX_CHARS - prefix.length);
  return trimmed ? `${prefix}${trimmed.slice(0, room)}` : prefix.trimEnd();
};

const buildPrompt = ({
  comments,
  currentBody,
  instructions,
}: {
  comments: readonly AppliedComment[];
  currentBody: string;
  instructions: string | undefined;
}): string => {
  const numbered = comments
    .map(
      (comment, index) =>
        `${index + 1}. Quoted text (characters ${comment.rangeStart}-${comment.rangeEnd}):\n\`\`\`\n${comment.anchorText}\n\`\`\`\nReviewer note: ${comment.body}`,
    )
    .join("\n\n");

  const sections = [
    `You are revising the SKILL.md of a stella agent skill so that it addresses every reviewer comment below.

Rules:
- Apply each comment to the passage it quotes. Leave the rest of the document as it is.
- Keep the YAML frontmatter block byte for byte identical, including the "---" delimiters.
- Return the complete revised SKILL.md, not a diff or an excerpt, and no code fences.
- Never invent legal facts, jurisdictions, citations, or company details.
- Summarise the changes in one paragraph of at most ${SUMMARY_MAX_CHARS} characters.`,
    `Current SKILL.md:\n\`\`\`\n${currentBody}\n\`\`\``,
    `Reviewer comments:\n${numbered}`,
  ];

  const trimmedInstructions = instructions?.trim();
  if (trimmedInstructions) {
    sections.push(`Additional instructions:\n${trimmedInstructions}`);
  }

  return sections.join("\n\n");
};

export default createProposalFromComments;
