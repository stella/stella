import { Result } from "better-result";
import { and, eq, gt, ilike, inArray, like, sql } from "drizzle-orm";
import * as v from "valibot";

import { agentSkillResources, agentSkills } from "@/api/db/schema";
import { EDITABLE_AGENT_SKILL_ORIGINS } from "@/api/lib/agent-skills/origin";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import {
  paginationCursorSchema,
  resourceIdSchema,
} from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { escapeLike } from "@/api/lib/escape-like";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";

const BILLING_KNOWLEDGE_FILES_PAGE_SIZE = 20;

const permissions = {
  organizationSettings: ["update"],
} satisfies HandlerConfig["permissions"];
export const listBillingKnowledgeFiles = createSafeRootHandler(
  {
    contract: "patch",
    permissions,
    accountAccess: ACCOUNT_ACCESS.accountControl,
    mcp: { type: "internal", reason: "auth_plumbing" },
    query: v.object({
      query: v.optional(v.pipe(v.string(), v.maxLength(200))),
      cursor: v.optional(paginationCursorSchema()),
    }),
  },
  async function* ({ safeDb, session, query }) {
    const cursorParts = query.cursor
      ? decodePaginationCursor(query.cursor)
      : null;
    const afterResourceId = cursorParts?.at(0);
    if (
      query.cursor &&
      (cursorParts?.length !== 1 ||
        !isUuidPaginationCursorPart(afterResourceId))
    ) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Invalid knowledge-file cursor",
        }),
      );
    }

    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: agentSkillResources.id,
            path: agentSkillResources.path,
            skillId: agentSkills.id,
            skillName: agentSkills.name,
          })
          .from(agentSkillResources)
          .innerJoin(
            agentSkills,
            eq(agentSkills.id, agentSkillResources.skillId),
          )
          .where(
            and(
              eq(
                agentSkillResources.organizationId,
                session.activeOrganizationId,
              ),
              eq(agentSkills.organizationId, session.activeOrganizationId),
              eq(agentSkills.scope, "team"),
              inArray(agentSkills.origin, EDITABLE_AGENT_SKILL_ORIGINS),
              like(agentSkillResources.path, "references/%"),
              afterResourceId !== undefined
                ? gt(agentSkillResources.id, sql`${afterResourceId}`)
                : undefined,
              query.query
                ? // sql-perf-allow: index agent_skill_resources_path_billing_trgm_idx
                  ilike(
                    agentSkillResources.path,
                    `%${escapeLike(query.query)}%`,
                  )
                : undefined,
            ),
          )
          .orderBy(agentSkillResources.id)
          .limit(BILLING_KNOWLEDGE_FILES_PAGE_SIZE + 1),
      ),
    );
    return Result.ok(
      createCursorPage({
        rows,
        limit: BILLING_KNOWLEDGE_FILES_PAGE_SIZE,
        cursorForItem: (file) => encodePaginationCursor([file.id]),
      }),
    );
  },
);

export const readBillingKnowledgeFile = createSafeRootHandler(
  {
    contract: "patch",
    permissions,
    accountAccess: ACCOUNT_ACCESS.accountControl,
    mcp: { type: "internal", reason: "auth_plumbing" },
    params: v.object({ resourceId: resourceIdSchema("agentSkillResource") }),
  },
  async function* ({ safeDb, session, params }) {
    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({ content: agentSkillResources.content })
          .from(agentSkillResources)
          .innerJoin(
            agentSkills,
            eq(agentSkills.id, agentSkillResources.skillId),
          )
          .where(
            and(
              eq(agentSkillResources.id, params.resourceId),
              eq(
                agentSkillResources.organizationId,
                session.activeOrganizationId,
              ),
              eq(agentSkills.organizationId, session.activeOrganizationId),
              eq(agentSkills.scope, "team"),
              like(agentSkillResources.path, "references/%"),
            ),
          )
          .limit(1),
      ),
    );
    const file = rows.at(0);
    if (!file) {
      return Result.err(
        new HandlerError({ status: 404, message: "Knowledge file not found" }),
      );
    }
    return Result.ok(file);
  },
);
