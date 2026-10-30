import { type SQL, sql } from "drizzle-orm";

import { WORKSPACE_ACCESS_MODE } from "@/api/db/rls";
import type { TransactionOf, WorkspaceScope } from "@/api/db/scoped";
import { resolveScopedFeatureIds } from "@/api/db/scoped-feature-access";
import {
  billingDraftCandidateMattersStatement,
  billingDraftCandidateWindowStart,
} from "@/api/handlers/desktop-time-entries/billing-drafts-context";
import { toSafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import type { SearchQuery } from "@/api/lib/search/types";
import { recordNewOrganizationAccessState } from "@/api/lib/usage/organization-access-state";
import type { GatedTestDb } from "@/api/tests/gated-test-database";

import type { QueryPerfTenantProfileId } from "./profiles";

const DOCUMENT_COUNTS = {
  small: 3000,
  growth: 100_000,
} as const satisfies Record<QueryPerfTenantProfileId, number>;
const MATCH_COUNT = 200;
const GROWTH_SELECTED_WORKSPACE_FRACTION = 1 / 100;

/**
 * Rows per seed statement. One statement over the whole growth population
 * can outlast the connection's statement timeout on a loaded runner; the
 * chunks insert the same rows.
 */
const SEED_CHUNK_ROWS = 10_000;

/** Documents `first`..`last` (1-based): entity, version, search row. */
const seedDocumentChunk = async (
  tx: TransactionOf<GatedTestDb>,
  {
    first,
    last,
    organizationId,
    queryText,
    seededWorkspace,
  }: {
    first: number;
    last: number;
    organizationId: string;
    queryText: string;
    seededWorkspace: SQL;
  },
) => {
  await tx.execute(sql`INSERT INTO entities (id, workspace_id, kind, name)
    SELECT ('01990000-0001-7000-8000-' || lpad(n::text, 12, '0'))::uuid,
      ${seededWorkspace}, 'document', 'Fixture document ' || n
    FROM generate_series(${first}::integer, ${last}::integer) series(n)`);
  await tx.execute(sql`INSERT INTO entity_versions (id, workspace_id, entity_id)
    SELECT ('01990000-0002-7000-8000-' || lpad(n::text, 12, '0'))::uuid,
      ${seededWorkspace}, ('01990000-0001-7000-8000-' || lpad(n::text, 12, '0'))::uuid
    FROM generate_series(${first}::integer, ${last}::integer) series(n)`);
  await tx.execute(sql`UPDATE entities e
    SET current_version_id = ('01990000-0002-7000-8000-' || lpad(n::text, 12, '0'))::uuid
    FROM generate_series(${first}::integer, ${last}::integer) series(n)
    WHERE e.id = ('01990000-0001-7000-8000-' || lpad(n::text, 12, '0'))::uuid`);
  await tx.execute(sql`INSERT INTO search_documents
    (entity_id, workspace_id, organization_id, kind, title, searchable_text, language, tsv)
    SELECT ('01990000-0001-7000-8000-' || lpad(n::text, 12, '0'))::uuid,
      ${seededWorkspace}, ${organizationId}, 'document', 'Fixture document ' || n,
      CASE WHEN n <= ${MATCH_COUNT} THEN ${queryText} ELSE 'ordinary' END,
      'simple', to_tsvector('simple', CASE WHEN n <= ${MATCH_COUNT} THEN ${queryText} ELSE 'ordinary' END)
    FROM generate_series(${first}::integer, ${last}::integer) series(n)`);
};

const seedPlaceholderQueryPerf = async (
  database: GatedTestDb,
  profileId: QueryPerfTenantProfileId,
) => {
  const documentCount = DOCUMENT_COUNTS[profileId];
  const organizationId = toSafeId<"organization">(
    "queryperforganization00000000001",
  );
  const userId = toSafeId<"user">("queryperfuser0000000000000000001");
  const workspaceId = toSafeId<"workspace">(
    "01990000-0000-7000-8000-000000000001",
  );
  const backgroundWorkspaceId = toSafeId<"workspace">(
    "01990000-0000-7000-8000-000000000002",
  );
  // A single-matter population cannot exercise selective matter access under RLS.
  const selectedWorkspaceCount =
    profileId === "growth"
      ? documentCount * GROWTH_SELECTED_WORKSPACE_FRACTION
      : documentCount;
  const seededWorkspace = sql`CASE WHEN n <= ${selectedWorkspaceCount} THEN ${workspaceId}::uuid ELSE ${backgroundWorkspaceId}::uuid END`;
  const queryText = `perfneedle${profileId}`;
  await database.transaction(async (tx) => {
    await tx.execute(sql`INSERT INTO organization (id, name, slug, created_at)
      VALUES (${organizationId}, 'Query perf fixture', ${organizationId}, now())`);
    await recordNewOrganizationAccessState(tx, {
      organizationId,
      now: new Date(),
    });
    await tx.execute(sql`INSERT INTO "user" (id, name, email)
      VALUES (${userId}, 'Query perf fixture', 'query-perf@example.test')`);
    await tx.execute(sql`INSERT INTO member (id, organization_id, user_id, role, created_at)
      VALUES ('queryperfmember00000000000000001', ${organizationId}, ${userId}, 'member', now())`);
    await tx.execute(sql`INSERT INTO workspaces (id, organization_id, name, reference)
      VALUES (${workspaceId}, ${organizationId}, 'Query perf matter', 'query-perf'),
        (${backgroundWorkspaceId}, ${organizationId}, 'Query perf background matter', 'query-perf-background')`);
    await tx.execute(sql`INSERT INTO workspace_members (id, workspace_id, user_id)
      VALUES ('01990000-0003-7000-8000-000000000001', ${workspaceId}, ${userId})`);
    // Fixed-size authorization metadata keeps tenant plans from depending on tiny-table sequential scans.
    await tx.execute(sql`INSERT INTO "user" (id, name, email)
      SELECT 'queryperfdecoyuser' || n, 'Decoy member', 'query-perf-decoy-' || n || '@example.test'
      FROM generate_series(1, 3000) series(n)`);
    await tx.execute(sql`INSERT INTO member (id, organization_id, user_id, role, created_at)
      SELECT 'queryperfdecoymember' || n, ${organizationId}, 'queryperfdecoyuser' || n, 'member', now()
      FROM generate_series(1, 3000) series(n)`);
    await tx.execute(sql`INSERT INTO workspaces (id, organization_id, name, reference)
      SELECT ('01990000-0030-7000-8000-' || lpad(n::text, 12, '0'))::uuid,
        ${organizationId}, 'Decoy matter', 'query-perf-decoy-' || n
      FROM generate_series(1, 3000) series(n)`);
    await tx.execute(sql`INSERT INTO workspace_members (id, workspace_id, user_id)
      SELECT ('01990000-0031-7000-8000-' || lpad(n::text, 12, '0'))::uuid,
        ('01990000-0030-7000-8000-' || lpad(n::text, 12, '0'))::uuid, 'queryperfdecoyuser' || n
      FROM generate_series(1, 3000) series(n)`);
    await tx.execute(sql`INSERT INTO time_entries
      (id, organization_id, workspace_id, user_id, date_worked, timezone_id,
       duration_minutes, billed_minutes, rate_at_entry, currency, narrative, created_at)
      VALUES ('01990000-0040-7000-8000-000000000000'::uuid, ${organizationId}, ${workspaceId}, ${userId},
        CURRENT_DATE, 'UTC', 30, 30, 100, 'EUR', 'Recent own work', now())`);
    for (let first = 1; first <= documentCount; first += SEED_CHUNK_ROWS) {
      const last = Math.min(first + SEED_CHUNK_ROWS - 1, documentCount);
      // db-await-in-loop: bounded chunks keep each seed statement well inside the connection's statement timeout.
      await seedDocumentChunk(tx, {
        first,
        last,
        organizationId,
        queryText,
        seededWorkspace,
      });
      // db-await-in-loop: bounded fixture chunks seed historical records independently of the fixed recent window.
      await tx.execute(sql`INSERT INTO time_entries
        (id, organization_id, workspace_id, user_id, date_worked, timezone_id,
         duration_minutes, billed_minutes, rate_at_entry, currency, narrative, created_at)
        SELECT ('01990000-0040-7000-8000-' || lpad(n::text, 12, '0'))::uuid,
          ${organizationId}, ${workspaceId}, 'queryperfdecoyuser1', CURRENT_DATE - 365,
          'UTC', 30, 30, 100, 'EUR', 'Historical colleague work', now() - interval '365 days'
        FROM generate_series(${first}::integer, ${last}::integer) series(n)`);
      // audit: skip - isolated query-perf fixture seeds historical audit volume, not a product mutation.
      // db-await-in-loop: bounded chunks keep historical audit seeding below the fixture statement timeout.
      await tx.execute(sql`INSERT INTO audit_logs
        (id, organization_id, workspace_id, user_id, performer_type, action, resource_type, resource_id, metadata, created_at)
        SELECT ('01990000-0041-7000-8000-' || lpad(n::text, 12, '0'))::uuid,
          ${organizationId}, ${workspaceId}, CASE WHEN n % 2 = 0 THEN ${userId} ELSE 'queryperfdecoyuser1' END,
          'user', 'update', 'workspace', ${workspaceId}, jsonb_build_object('fixture', repeat('x', 512)), now() - interval '365 days'
        FROM generate_series(${first}::integer, ${last}::integer) series(n)`);
    }
  });
  await database.execute(sql`VACUUM (ANALYZE) entities`);
  await database.execute(sql`VACUUM (ANALYZE) entity_versions`);
  await database.execute(sql`VACUUM (ANALYZE) search_documents`);
  await database.execute(sql`VACUUM (ANALYZE) workspaces`);
  await database.execute(sql`VACUUM (ANALYZE) workspace_members`);
  await database.execute(sql`VACUUM (ANALYZE) member`);
  await database.execute(sql`VACUUM (ANALYZE) audit_logs`);
  await database.execute(sql`VACUUM (ANALYZE) time_entries`);
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
  profileId: QueryPerfTenantProfileId,
) => {
  const { organizationId, userId, bigWorkspaceId, query, searchMatchCount } =
    await seedPlaceholderQueryPerf(database, profileId);
  return {
    billingDraftCandidates: billingDraftCandidateMattersStatement({
      tx: database,
      organizationId,
      userId,
      windowStart: billingDraftCandidateWindowStart(),
    }),
    billingDraftUnboundedCandidates: billingDraftCandidateMattersStatement({
      tx: database,
      organizationId,
      userId,
      windowStart: new Date(0),
    }),
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
