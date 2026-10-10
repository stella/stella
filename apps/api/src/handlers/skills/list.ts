import { Result } from "better-result";
import { and, asc, desc, eq, gt, or, sql } from "drizzle-orm";
import { t } from "elysia";

import { listSkillMetadata, listSkillResources } from "@stll/skills";
import { readSkillDisplayName } from "@stll/skills/frontmatter";

import { member, user } from "@/api/db/auth-schema";
import {
  agentSkillRevisions,
  agentSkills,
  AGENT_SKILL_SCOPES,
  type AgentSkillOrigin,
  type AgentSkillScope,
} from "@/api/db/schema";
import { DEFAULT_SKILL_BODY_BY_SLUG } from "@/api/lib/agent-skills/default-skills";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { tPaginationCursor } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";
import { hasManagementPermission } from "@/api/lib/permission-authorization";
import { normalizeTenantPageLimit } from "@/api/lib/rate-limit/action-size-limits";
import { brandPersistedAgentSkillId } from "@/api/lib/safe-id-boundaries";
import { sqlCaseFragment } from "@/api/lib/sql-case-expression";

const listSkillsQuerySchema = t.Object({
  limit: t.Optional(
    t.Integer({
      minimum: 1,
      maximum: LIMITS.agentSkillsPageSizeMax,
    }),
  ),
  cursor: t.Optional(tPaginationCursor()),
});

const config = {
  description:
    "List the agent skills visible to you, the organization's team skills " +
    "plus your own private ones, enabled first and then by scope and name, " +
    "with cursor pagination, alongside the skills shipped with stella " +
    "(`builtIn`). Instruction bodies come back only for skills that carry a slash " +
    "command; read one skill in full with skills.get. Each installed skill " +
    "carries `lastEdit`: who wrote its newest revision and when, or " +
    "`stella` for an unedited stella starter skill, `unattributed` for other system " +
    "writes and former members. Also reports " +
    "whether you may manage team skills.",
  permissions: { chat: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "read",
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "agent_tool_authoring",
    consumesServices: false,
  },
  query: listSkillsQuerySchema,
} satisfies HandlerConfig;

type SkillCursor = {
  enabled: boolean;
  scope: AgentSkillScope;
  name: string;
  id: SafeId<"agentSkill">;
};

const isAgentSkillScope = (value: unknown): value is AgentSkillScope => {
  for (const scope of AGENT_SKILL_SCOPES) {
    if (value === scope) {
      return true;
    }
  }

  return false;
};

const decodeSkillCursor = (cursor: string): SkillCursor | null => {
  const parts = decodePaginationCursor(cursor);
  const enabled = parts?.at(0);
  const scope = parts?.at(1);
  const name = parts?.at(2);
  const id = parts?.at(3);

  if (
    typeof enabled !== "boolean" ||
    !isAgentSkillScope(scope) ||
    typeof name !== "string" ||
    !isUuidPaginationCursorPart(id)
  ) {
    return null;
  }

  return { enabled, scope, name, id: brandPersistedAgentSkillId(id) };
};

/**
 * Who wrote a skill's newest revision. `stella` is a starter skill (origin
 * `default`) whose newest revision is a system write that still holds the
 * starter body, so no member has edited it; an authorless revision with
 * another body was written by an account since deleted. `unattributed` covers other system writes, deleted accounts, and authors
 * who have left the organization: names resolve through the membership so they
 * never leak across organizations. `null` means the skill has no recorded
 * revision.
 */
type SkillLastEdit =
  | {
      type: "user";
      user: { id: string; name: string; image: string | null };
      at: Date;
    }
  | { type: "stella"; at: Date }
  | { type: "unattributed"; at: Date };

type ReadSkillLastEditInput = {
  at: Date | null;
  origin: AgentSkillOrigin;
  authorId: string | null;
  isStarterBody: boolean | null;
  editorId: string | null;
  editorName: string | null;
  editorImage: string | null;
};

const readSkillLastEdit = ({
  at,
  authorId,
  editorId,
  editorName,
  editorImage,
  isStarterBody,
  origin,
}: ReadSkillLastEditInput): SkillLastEdit | null => {
  if (at === null) {
    return null;
  }
  if (authorId === null) {
    return origin === "default" && isStarterBody === true
      ? { type: "stella", at }
      : { type: "unattributed", at };
  }
  // An author with no membership here has left the organization.
  if (editorId === null || editorName === null) {
    return { type: "unattributed", at };
  }
  return {
    type: "user",
    user: { id: editorId, name: editorName, image: editorImage },
    at,
  };
};

const listSkills = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, user: currentUser, memberRole, query }) {
    const limit = normalizeTenantPageLimit(
      query.limit ?? LIMITS.agentSkillsPageSizeDefault,
    );

    const visibilityFilter = and(
      eq(agentSkills.organizationId, session.activeOrganizationId),
      or(
        eq(agentSkills.scope, AGENT_SKILL_SCOPES[0]), // "team"
        eq(agentSkills.userId, currentUser.id),
      ),
    );
    const conditions = [visibilityFilter];

    if (query.cursor) {
      const cursor = decodeSkillCursor(query.cursor);

      if (!cursor) {
        return Result.err(
          new HandlerError({ status: 400, message: "Invalid cursor" }),
        );
      }

      const sameEnabledCursorCondition = or(
        and(
          eq(agentSkills.enabled, cursor.enabled),
          gt(agentSkills.scope, cursor.scope),
        ),
        and(
          eq(agentSkills.enabled, cursor.enabled),
          eq(agentSkills.scope, cursor.scope),
          gt(agentSkills.name, cursor.name),
        ),
        and(
          eq(agentSkills.enabled, cursor.enabled),
          eq(agentSkills.scope, cursor.scope),
          eq(agentSkills.name, cursor.name),
          gt(agentSkills.id, cursor.id),
        ),
      );

      const cursorCondition = cursor.enabled
        ? or(eq(agentSkills.enabled, false), sameEnabledCursorCondition)
        : sameEnabledCursorCondition;

      if (cursorCondition) {
        conditions.push(cursorCondition);
      }
    }

    const installedRows = yield* Result.await(
      safeDb((tx) => {
        // The newest revision per skill: one probe of the unique
        // (skill_id, revision_number) index for each row on the page.
        const latestRevision = tx
          .select({
            createdBy: agentSkillRevisions.createdBy,
            // A revision absorbs its author's consecutive saves, so its
            // update time is when the body last changed.
            updatedAt: agentSkillRevisions.updatedAt,
            // Compared here so the body never leaves the database.
            isStarterBody: sql<boolean>`coalesce(
              ${agentSkillRevisions.body} = ${sqlCaseFragment({
                operand: sql`${agentSkills.slug}`,
                branches: [...DEFAULT_SKILL_BODY_BY_SLUG].map(
                  ([slug, body]) => sql`when ${slug} then ${body}`,
                ),
                fallback: sql`null`,
              })},
              false
            )`.as("is_starter_body"),
          })
          .from(agentSkillRevisions)
          .where(
            and(
              eq(agentSkillRevisions.skillId, agentSkills.id),
              eq(
                agentSkillRevisions.organizationId,
                session.activeOrganizationId,
              ),
            ),
          )
          .orderBy(desc(agentSkillRevisions.revisionNumber))
          .limit(1)
          .as("latest_revision");

        return tx
          .select({
            id: agentSkills.id,
            scope: agentSkills.scope,
            origin: agentSkills.origin,
            slug: agentSkills.slug,
            name: agentSkills.name,
            description: agentSkills.description,
            version: agentSkills.version,
            license: agentSkills.license,
            compatibility: agentSkills.compatibility,
            sourceUrl: agentSkills.sourceUrl,
            contentHash: agentSkills.contentHash,
            enabled: agentSkills.enabled,
            command: agentSkills.command,
            body: sql<string | null>`
              case
                when ${agentSkills.command} is not null then ${agentSkills.body}
                else null
              end
            `.as("body"),
            userId: agentSkills.userId,
            createdAt: agentSkills.createdAt,
            lastEditAt: latestRevision.updatedAt,
            lastEditAuthorId: latestRevision.createdBy,
            lastEditIsStarterBody: latestRevision.isStarterBody,
            editorId: user.id,
            editorName: user.name,
            editorImage: user.image,
          })
          .from(agentSkills)
          .leftJoinLateral(latestRevision, sql`true`)
          .leftJoin(
            member,
            and(
              eq(member.userId, latestRevision.createdBy),
              eq(member.organizationId, session.activeOrganizationId),
            ),
          )
          .leftJoin(user, eq(user.id, member.userId))
          .where(and(...conditions))
          .orderBy(
            desc(agentSkills.enabled),
            asc(agentSkills.scope),
            asc(agentSkills.name),
            asc(agentSkills.id),
          )
          .limit(limit + 1);
      }),
    );
    const installedPage = createCursorPage({
      rows: installedRows,
      limit,
      cursorForItem: (item) =>
        encodePaginationCursor([item.enabled, item.scope, item.name, item.id]),
    });

    return Result.ok({
      canManageTeam: hasManagementPermission(memberRole, {
        agentSkill: ["update"],
      }),
      builtIn: listSkillMetadata().map((skill) => ({
        id: skill.name,
        scope: "built-in" as const,
        origin: "built-in" as const,
        slug: skill.name,
        name: readSkillDisplayName(skill),
        description: skill.description,
        version: skill.version,
        license: skill.license ?? null,
        compatibility: skill.compatibility ?? null,
        enabled: true,
        resourceCount: listSkillResources(skill.name).length,
      })),
      installed: installedPage.items.map(
        ({
          lastEditAt,
          lastEditAuthorId,
          lastEditIsStarterBody,
          editorId,
          editorName,
          editorImage,
          ...skill
        }) => ({
          ...skill,
          lastEdit: readSkillLastEdit({
            at: lastEditAt,
            authorId: lastEditAuthorId,
            // Null only when the skill has no revision, which `at` reports.
            isStarterBody: lastEditIsStarterBody,
            editorId,
            editorName,
            editorImage,
            origin: skill.origin,
          }),
        }),
      ),
      limit: installedPage.limit,
      nextCursor: installedPage.nextCursor,
    });
  },
);

export default listSkills;
