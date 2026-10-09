import { sql } from "drizzle-orm";

import { WORKSPACE_ACCESS_MODE } from "@/api/db/rls";
import type { WorkspaceScope } from "@/api/db/scoped";
import { resolveScopedFeatureIds } from "@/api/db/scoped-feature-access";
import { toSafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import type { SearchQuery } from "@/api/lib/search/types";
import type { GatedTestDb } from "@/api/tests/gated-test-database";

import type { QueryPerfProfileId } from "./profiles";

export const QUERY_PERF_SEED_ID = "document-search-small-v2";
const DOCUMENT_COUNT = 3000;
const MATCH_COUNT = 200;

const seedSmallQueryPerf = async (
  database: GatedTestDb,
  profileId: QueryPerfProfileId,
) => {
  const organizationId = toSafeId<"organization">(
    "queryperforganization00000000001",
  );
  const userId = toSafeId<"user">("queryperfuser0000000000000000001");
  const workspaceId = toSafeId<"workspace">(
    "01990000-0000-7000-8000-000000000001",
  );
  const queryText = `perfneedle${profileId}`;
  await database.transaction(async (tx) => {
    await tx.execute(sql`INSERT INTO organization (id, name, slug, created_at)
      VALUES (${organizationId}, 'Query perf fixture', ${organizationId}, now())`);
    await tx.execute(sql`INSERT INTO "user" (id, name, email)
      VALUES (${userId}, 'Query perf fixture', 'query-perf@example.test')`);
    await tx.execute(sql`INSERT INTO member (id, organization_id, user_id, role, created_at)
      VALUES ('queryperfmember00000000000000001', ${organizationId}, ${userId}, 'member', now())`);
    await tx.execute(sql`INSERT INTO workspaces (id, organization_id, name, reference)
      VALUES (${workspaceId}, ${organizationId}, 'Query perf matter', 'query-perf')`);
    await tx.execute(sql`INSERT INTO workspace_members (id, workspace_id, user_id)
      VALUES ('01990000-0003-7000-8000-000000000001', ${workspaceId}, ${userId})`);
    await tx.execute(sql`INSERT INTO entities (id, workspace_id, kind, name)
      SELECT ('01990000-0001-7000-8000-' || lpad(n::text, 12, '0'))::uuid,
        ${workspaceId}, 'document', 'Fixture document ' || n
      FROM generate_series(1, ${DOCUMENT_COUNT}) series(n)`);
    await tx.execute(sql`INSERT INTO entity_versions (id, workspace_id, entity_id)
      SELECT ('01990000-0002-7000-8000-' || lpad(n::text, 12, '0'))::uuid,
        ${workspaceId}, ('01990000-0001-7000-8000-' || lpad(n::text, 12, '0'))::uuid
      FROM generate_series(1, ${DOCUMENT_COUNT}) series(n)`);
    await tx.execute(sql`UPDATE entities e SET current_version_id = v.id
      FROM entity_versions v WHERE e.workspace_id = ${workspaceId} AND v.entity_id = e.id`);
    await tx.execute(sql`INSERT INTO search_documents
      (entity_id, workspace_id, organization_id, kind, title, searchable_text, language, tsv)
      SELECT ('01990000-0001-7000-8000-' || lpad(n::text, 12, '0'))::uuid,
        ${workspaceId}, ${organizationId}, 'document', 'Fixture document ' || n,
        CASE WHEN n <= ${MATCH_COUNT} THEN ${queryText} ELSE 'ordinary' END,
        'simple', to_tsvector('simple', CASE WHEN n <= ${MATCH_COUNT} THEN ${queryText} ELSE 'ordinary' END)
      FROM generate_series(1, ${DOCUMENT_COUNT}) series(n)`);
  });
  await database.execute(sql`VACUUM (ANALYZE) entities`);
  await database.execute(sql`VACUUM (ANALYZE) entity_versions`);
  await database.execute(sql`VACUUM (ANALYZE) search_documents`);
  return {
    organizationId,
    userId,
    bigWorkspaceId: workspaceId,
    query: queryText,
    searchMatchCount: MATCH_COUNT,
  };
};

export const seedQueryPerf = async (
  database: GatedTestDb,
  profileId: QueryPerfProfileId,
) => {
  const { organizationId, userId, bigWorkspaceId, query, searchMatchCount } =
    await seedSmallQueryPerf(database, profileId);
  return {
    searchMatchCount,
    context: {
      organizationId,
      userId,
      workspaceScope: {
        type: WORKSPACE_ACCESS_MODE.membership,
        serverValidatedWorkspaceIds: [],
      } as const satisfies WorkspaceScope,
      featureIds: await database.transaction(
        async (tx) =>
          await resolveScopedFeatureIds({ tx, organizationId, userId }),
      ),
    },
    searchInput: {
      query,
      organizationId,
      workspaceIds: [bigWorkspaceId],
      limit: LIMITS.mcpSearchPageSizeDefault,
    } satisfies SearchQuery,
  };
};
