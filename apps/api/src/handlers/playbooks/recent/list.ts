import { Result } from "better-result";
import { and, desc, eq, sql } from "drizzle-orm";
import { t } from "elysia";

import type { SafeDb } from "@/api/db/safe-db";
import { documentReviewRuns, playbookDefinitions } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";

const RECENT_PLAYBOOKS_DEFAULT_LIMIT = 4;
const RECENT_PLAYBOOKS_MAX_LIMIT = 10;

export const recentPlaybooksQuerySchema = t.Object({
  limit: t.Optional(
    t.Integer({
      minimum: 1,
      maximum: RECENT_PLAYBOOKS_MAX_LIMIT,
      description: "Max recently used playbooks to return",
    }),
  ),
});

type ListRecentPlaybooksProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  limit?: number;
};

export const listRecentPlaybooksHandler = async function* ({
  safeDb,
  organizationId,
  userId,
  limit = RECENT_PLAYBOOKS_DEFAULT_LIMIT,
}: ListRecentPlaybooksProps) {
  const lastUsedAt = sql<Date>`max(${documentReviewRuns.createdAt})`
    .mapWith(documentReviewRuns.createdAt)
    .as("last_used_at");
  const rows = yield* Result.await(
    safeDb((tx) =>
      tx
        .select({
          id: playbookDefinitions.id,
          name: playbookDefinitions.name,
          description: playbookDefinitions.description,
          status: playbookDefinitions.status,
          createdAt: playbookDefinitions.createdAt,
          updatedAt: playbookDefinitions.updatedAt,
          lastUsedAt,
        })
        .from(documentReviewRuns)
        .innerJoin(
          playbookDefinitions,
          and(
            eq(playbookDefinitions.id, documentReviewRuns.playbookDefinitionId),
            eq(
              playbookDefinitions.organizationId,
              documentReviewRuns.organizationId,
            ),
          ),
        )
        .where(
          and(
            eq(documentReviewRuns.organizationId, organizationId),
            eq(documentReviewRuns.requestedBy, userId),
          ),
        )
        .groupBy(
          playbookDefinitions.id,
          playbookDefinitions.name,
          playbookDefinitions.description,
          playbookDefinitions.status,
          playbookDefinitions.createdAt,
          playbookDefinitions.updatedAt,
        )
        .orderBy(desc(lastUsedAt), desc(playbookDefinitions.id))
        .limit(limit),
    ),
  );

  return Result.ok({
    items: rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      lastUsedAt: row.lastUsedAt.toISOString(),
    })),
    nextCursor: null,
    limit,
  });
};

const config = {
  description:
    "List the current user's recently used playbooks in the active organization.",
  permissions: { workspace: ["read"] },
  mcp: { type: "capability", reason: "knowledge_library_admin" },
  access: "read",
  query: recentPlaybooksQuerySchema,
} satisfies HandlerConfig;

const listRecentPlaybooks = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, user, query }) {
    return yield* listRecentPlaybooksHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      userId: user.id,
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    });
  },
);

export default listRecentPlaybooks;
