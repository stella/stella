import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";

import { WORKSPACE_ACCESS_MODE } from "@/api/db/rls";
import type { ScopedDb } from "@/api/db/safe-db";
import type { TransactionOf } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { executedRows } from "@/api/lib/db/executed-rows";
import { LEGAL_LISTS_FEATURE_ID } from "@/api/lib/feature-access/registry";
import { createPgFtsSearchReader } from "@/api/lib/search/pg-fts-provider";
import type { SearchQuery } from "@/api/lib/search/types";
import { isRecord } from "@/api/lib/type-guards";
import {
  explainAsStella,
  type ExplainPlanDocument,
} from "@/api/tests/explain-as-stella";
import { openGatedTestDatabase } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const databaseUrl = process.env["DATABASE_URL"];
const ENTITY_COUNT = 100_000;
const MATCHES_PER_KIND = 1000;
const SAMPLE_COUNT = 5;
const POLICY_COUNT = 47;
const MAX_TIME_RATIO = 1.1;
const MAX_BUFFER_RATIO = 1.25;
const QUERY_TEXT = "budgetneedle";
const HIT_LIMIT = 20;
const ROLLBACK_POLICY_CHANGES = new Error(
  "Roll back policy-off search plan sample",
);

type SearchQueries = {
  hits: SQLWrapper;
  count: SQLWrapper;
};

type TestTransaction = TransactionOf<GatedTestDb>;

type QueryMetrics = {
  executionTimeMs: number;
  sharedBlocks: number;
};

type FeatureCase = {
  label: "disabled" | "enabled";
  featureIds: readonly string[];
  expectedMatches: number;
};

const FEATURE_CASES = [
  {
    label: "disabled",
    featureIds: [],
    expectedMatches: MATCHES_PER_KIND,
  },
  {
    label: "enabled",
    featureIds: [LEGAL_LISTS_FEATURE_ID],
    expectedMatches: MATCHES_PER_KIND * 2,
  },
] as const satisfies readonly FeatureCase[];

const emptyQueryMetrics = (): QueryMetrics[] => [];

const metricsFromPlan = (document: ExplainPlanDocument): QueryMetrics => {
  const executionTimeMs = document["Execution Time"];
  const sharedHitBlocks = document.Plan["Shared Hit Blocks"];
  const sharedReadBlocks = document.Plan["Shared Read Blocks"];
  if (
    typeof executionTimeMs !== "number" ||
    typeof sharedHitBlocks !== "number" ||
    typeof sharedReadBlocks !== "number"
  ) {
    return panic(
      "Search plan did not expose execution and shared-buffer metrics",
    );
  }
  return {
    executionTimeMs,
    sharedBlocks: sharedHitBlocks + sharedReadBlocks,
  };
};

const hasExecutedRepeatedSubplan = (node: Record<string, unknown>): boolean => {
  if (
    node["Parent Relationship"] === "SubPlan" &&
    typeof node["Actual Loops"] === "number" &&
    node["Actual Loops"] > 1
  ) {
    return true;
  }
  const plans = node["Plans"];
  return (
    Array.isArray(plans) &&
    plans.some((plan) => isRecord(plan) && hasExecutedRepeatedSubplan(plan))
  );
};

const summarizePlanNode = (
  node: Record<string, unknown>,
): Record<string, unknown> => {
  const fields = [
    "Node Type",
    "Parent Relationship",
    "Relation Name",
    "Alias",
    "Index Name",
    "Actual Rows",
    "Actual Loops",
    "Actual Total Time",
    "Plan Rows",
    "Rows Removed by Filter",
    "Shared Hit Blocks",
    "Shared Read Blocks",
    "Filter",
    "Index Cond",
    "Join Filter",
    "Hash Cond",
  ];
  const summary: Record<string, unknown> = {};
  for (const field of fields) {
    if (field in node) {
      summary[field] = node[field];
    }
  }
  const plans = node["Plans"];
  if (Array.isArray(plans)) {
    summary["Plans"] = plans
      .filter(isRecord)
      .filter(
        (plan) =>
          plan["Parent Relationship"] !== "InitPlan" &&
          (typeof plan["Actual Loops"] !== "number" ||
            plan["Actual Loops"] > 0),
      )
      .map(summarizePlanNode);
  }
  return summary;
};

const median = (values: readonly number[]): number => {
  if (values.length !== SAMPLE_COUNT) {
    return panic("Search plan comparison requires five paired samples");
  }
  const sorted = [...values].toSorted((left, right) => left - right);
  const value = sorted.at(Math.floor(sorted.length / 2));
  return value ?? panic("Search plan median is missing");
};

const captureSearchQueries = async (
  query: SearchQuery,
): Promise<SearchQueries> => {
  const captured: SQLWrapper[] = [];
  const captureDb = asTestRaw<ScopedDb>(
    async <T>(fn: (tx: TestTransaction) => Promise<T>) =>
      await fn(
        asTestRaw<TestTransaction>({
          execute: async (statement: SQLWrapper | string) => {
            if (typeof statement !== "string") {
              captured.push(statement);
            }
            return [];
          },
        }),
      ),
  );
  await createPgFtsSearchReader(captureDb).search(query);
  if (captured.length !== 4) {
    return panic(
      "Production search reader did not issue its four query builders",
    );
  }
  const hits = captured.at(0);
  const count = captured.at(1);
  if (hits === undefined || count === undefined) {
    return panic("Production search reader omitted hits or count SQL");
  }
  return { hits, count };
};

const dropEntityFeaturePolicies = async (
  tx: TestTransaction,
): Promise<void> => {
  const policies = executedRows(
    await tx.execute(sql`
      SELECT schemaname, tablename
      FROM pg_catalog.pg_policies
      WHERE schemaname = 'public'
        AND policyname = 'workspace_entity_feature'
        AND 'stella' = ANY(roles)
      ORDER BY tablename
    `),
  );
  if (policies.length !== POLICY_COUNT) {
    return panic(
      `Expected ${POLICY_COUNT} entity feature policies, found ${policies.length}`,
    );
  }
  for (const policy of policies) {
    if (
      !isRecord(policy) ||
      policy["schemaname"] !== "public" ||
      typeof policy["tablename"] !== "string"
    ) {
      return panic("Malformed entity feature policy catalog row");
    }
    await tx.execute(sql`
      DROP POLICY ${sql.identifier("workspace_entity_feature")}
      ON ${sql.identifier(policy["schemaname"])}.${sql.identifier(policy["tablename"])}
    `);
  }
};

const assertSearchFencePolicies = async (
  tx: TestTransaction,
): Promise<void> => {
  const policies = executedRows(
    await tx.execute(sql`
      SELECT tablename, qual
      FROM pg_catalog.pg_policies
      WHERE schemaname = 'public'
        AND policyname = 'workspace_entity_feature'
        AND 'stella' = ANY(roles)
        AND tablename IN ('entity_versions', 'search_documents')
      ORDER BY tablename
    `),
  );
  if (policies.length !== 2) {
    return panic(
      "Search budget requires entity feature policies on both search relations",
    );
  }
  for (const policy of policies) {
    if (
      !isRecord(policy) ||
      typeof policy["tablename"] !== "string" ||
      typeof policy["qual"] !== "string" ||
      !policy["qual"].includes("entity_feature_gate")
    ) {
      return panic(
        "Search budget requires stored entity feature gate policies",
      );
    }
  }
};

const transactionOn = (tx: TestTransaction) => ({
  transaction: async <TResult>(
    fn: (inner: TestTransaction) => Promise<TResult>,
  ) => await fn(tx),
});

const planFor = async ({
  tx,
  organizationId,
  userId,
  workspaceId,
  featureIds,
  jit,
  query,
}: {
  tx: TestTransaction;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
  featureIds: readonly string[];
  jit: "off" | "on";
  query: SQLWrapper;
}): Promise<ExplainPlanDocument> => {
  const documents = await explainAsStella({
    database: transactionOn(tx),
    organizationId,
    userId,
    workspaceScope: {
      type: WORKSPACE_ACCESS_MODE.explicit,
      workspaceIds: [workspaceId],
    },
    featureIds,
    jit,
    query,
  });
  const document = documents.at(0);
  if (documents.length !== 1 || document === undefined) {
    return panic("Search EXPLAIN did not return one JSON document");
  }
  if (hasExecutedRepeatedSubplan(document.Plan)) {
    return panic("Search plan contains an executed correlated subplan");
  }
  return document;
};

const policyOffSample = async <T>(
  database: GatedTestDb,
  run: (tx: TestTransaction) => Promise<T>,
): Promise<T> => {
  let value: T | undefined;
  const outcome = await Result.tryPromise({
    try: async () =>
      await database.transaction(async (tx) => {
        await dropEntityFeaturePolicies(tx);
        value = await run(tx);
        throw ROLLBACK_POLICY_CHANGES;
      }),
    catch: (cause: unknown) => cause,
  });
  if (Result.isError(outcome)) {
    if (outcome.error !== ROLLBACK_POLICY_CHANGES) {
      throw outcome.error;
    }
    if (value === undefined) {
      return panic("Policy-off search sample did not produce a result");
    }
    return value;
  }
  return panic("Policy-off search sample committed its policy drops");
};

describe.skipIf(!enabled)(
  "entity feature search plan budget (postgres)",
  () => {
    const fixture =
      enabled && databaseUrl !== undefined
        ? openGatedTestDatabase(databaseUrl, {
            max: 1,
            cleanupTimeoutMs: 300_000,
          })
        : undefined;
    test("search hits and count stay within budget with entity feature policies enabled and JIT off or on", async () => {
      if (databaseUrl === undefined) {
        panic("DATABASE_URL required for the gated search plan test");
      }
      if (fixture === undefined) {
        panic("Search budget fixture is unavailable");
      }
      const { sql: client, db } = fixture;
      const organizationId = mintAuthProviderId<"organization">();
      const userId = mintAuthProviderId<"user">();
      const workspaceId = createSafeId<"workspace">();
      const memberId = mintAuthProviderIdValue();
      const reference = `search-budget-${workspaceId}`;
      const cleanupIndexName = `search_budget_${workspaceId.slice(0, 8)}_current_version_idx`;
      const entityIdPrefix = `${workspaceId.slice(0, 8)}-0000-7000-8000-`;
      const versionIdPrefix = `${workspaceId.slice(0, 8)}-0001-7000-8000-`;
      const searchQuery: SearchQuery = {
        query: QUERY_TEXT,
        organizationId,
        workspaceIds: [workspaceId],
        limit: HIT_LIMIT,
      };
      let seeded = false;
      const finished = Promise.withResolvers<undefined>();
      const startedAt = performance.now();
      const reportStage = (stage: string) => {
        console.info(
          JSON.stringify({
            event: "search_budget_stage",
            stage,
            elapsedMs: performance.now() - startedAt,
          }),
        );
      };
      // Bun can start suite teardown while a timed-out callback is still running.
      // Wait for that callback before deleting the rows it is measuring.
      fixture.cleanUp(async () => {
        await finished.promise;
        if (seeded) {
          let cleanupIndexCreated = false;
          try {
            await db.execute(sql`
                CREATE INDEX ${sql.identifier(cleanupIndexName)}
                ON public.entities (current_version_id)
              `);
            cleanupIndexCreated = true;
            await client`DELETE FROM search_documents
                WHERE workspace_id = ${workspaceId}`;
            await client`UPDATE entities SET current_version_id = NULL
                WHERE workspace_id = ${workspaceId}
                  AND current_version_id IS NOT NULL`;
            await client`DELETE FROM entity_versions
                WHERE workspace_id = ${workspaceId}`;
            await client`DELETE FROM workspaces WHERE id = ${workspaceId}`;
          } finally {
            if (cleanupIndexCreated) {
              await db.execute(sql`
                  DROP INDEX public.${sql.identifier(cleanupIndexName)}
                `);
            }
          }
        }
        await client`DELETE FROM organization WHERE id = ${organizationId}`;
        await client`DELETE FROM "user" WHERE id = ${userId}`;
      });
      try {
        await client`INSERT INTO organization (id, name, slug, created_at)
            VALUES (${organizationId}, 'Search budget organization', ${organizationId}, now())`;
        await client`INSERT INTO "user" (id, name, email)
            VALUES (${userId}, 'Search budget user', ${`${userId}@example.test`})`;
        await client`INSERT INTO member (id, organization_id, user_id, role, created_at)
            VALUES (${memberId}, ${organizationId}, ${userId}, 'owner', now())`;
        await client`INSERT INTO workspaces (id, organization_id, name, reference)
            VALUES (${workspaceId}, ${organizationId}, 'Search budget matter', ${reference})`;
        seeded = true;
        reportStage("scope-seeded");

        await client`INSERT INTO entities (id, workspace_id, kind, list_item_type, name)
            SELECT
              (${entityIdPrefix} || lpad(n::text, 12, '0'))::uuid,
              ${workspaceId},
              CASE WHEN n % 10 = 0 THEN 'task' ELSE 'document' END,
              CASE WHEN n % 10 = 0 THEN 'fact' ELSE NULL END,
              'Search budget entity ' || n::text
            FROM generate_series(1, ${ENTITY_COUNT}) AS series(n)`;
        reportStage("entities-seeded");
        await client`INSERT INTO entity_versions (id, workspace_id, entity_id)
            SELECT
              (${versionIdPrefix} || lpad(n::text, 12, '0'))::uuid,
              ${workspaceId},
              (${entityIdPrefix} || lpad(n::text, 12, '0'))::uuid
            FROM generate_series(1, ${ENTITY_COUNT}) AS series(n)`;
        reportStage("versions-seeded");
        await client`UPDATE entities e
            SET current_version_id = v.id
            FROM entity_versions v
            WHERE e.workspace_id = ${workspaceId}
              AND v.workspace_id = e.workspace_id
              AND v.entity_id = e.id
              AND e.current_version_id IS DISTINCT FROM v.id`;
        reportStage("current-versions-linked");
        await client`WITH population AS (
              SELECT n, n % 10 = 0 AS is_fact,
                row_number() OVER (
                  PARTITION BY n % 10 = 0 ORDER BY md5(n::text)
                ) AS position
              FROM generate_series(1, ${ENTITY_COUNT}) AS series(n)
            ), documents AS (
              SELECT e.id, e.kind,
                population.position <= ${MATCHES_PER_KIND} AS has_needle,
                'Search budget title ' || population.n::text AS title
              FROM population
              JOIN entities e ON e.id =
                (${entityIdPrefix} || lpad(population.n::text, 12, '0'))::uuid
              WHERE e.workspace_id = ${workspaceId}
            )
            INSERT INTO search_documents
              (entity_id, workspace_id, organization_id, kind, title,
               searchable_text, language, tsv)
            SELECT id, ${workspaceId}, ${organizationId}, kind, title,
              CASE WHEN has_needle THEN ${`${QUERY_TEXT} body text`} ELSE 'ordinary body text' END,
              'simple',
              to_tsvector('simple', CASE WHEN has_needle
                THEN ${`${QUERY_TEXT} body text`} ELSE 'ordinary body text' END)
            FROM documents`;
        reportStage("search-documents-seeded");
        await client`VACUUM (ANALYZE) entities`;
        await client`VACUUM (ANALYZE) entity_versions`;
        await client`VACUUM (ANALYZE) search_documents`;

        await db.transaction(async (tx) => await assertSearchFencePolicies(tx));

        reportStage("fixture-analyzed");
        const queries = await captureSearchQueries(searchQuery);
        const sample = async (
          policyMode: "on" | "off",
          featureCase: FeatureCase,
          jit: "off" | "on",
          verifyRows: boolean,
        ): Promise<{ hits: QueryMetrics; count: QueryMetrics }> => {
          const run = async (
            tx: TestTransaction,
          ): Promise<{ hits: QueryMetrics; count: QueryMetrics }> => {
            const hitsPlan = await planFor({
              tx,
              organizationId,
              userId,
              workspaceId,
              featureIds: featureCase.featureIds,
              jit,
              query: queries.hits,
            });
            const countPlan = await planFor({
              tx,
              organizationId,
              userId,
              workspaceId,
              featureIds: featureCase.featureIds,
              jit,
              query: queries.count,
            });
            if (verifyRows) {
              if (jit === "off") {
                console.info(
                  JSON.stringify({
                    event: "search_budget_count_plan",
                    policyMode,
                    featureLabel: featureCase.label,
                    planningTime: countPlan["Planning Time"],
                    executionTime: countPlan["Execution Time"],
                    plan: summarizePlanNode(countPlan.Plan),
                  }),
                );
              }
              const hitRows = executedRows(await tx.execute(queries.hits));
              const countRow = executedRows(await tx.execute(queries.count)).at(
                0,
              );
              if (
                !isRecord(countRow) ||
                typeof countRow["total"] !== "number"
              ) {
                return panic("Search count query returned no numeric total");
              }
              expect(hitRows).toHaveLength(HIT_LIMIT + 1);
              expect(countRow["total"]).toBe(
                policyMode === "off"
                  ? MATCHES_PER_KIND * 2
                  : featureCase.expectedMatches,
              );
            }
            return {
              hits: metricsFromPlan(hitsPlan),
              count: metricsFromPlan(countPlan),
            };
          };
          return policyMode === "off"
            ? await policyOffSample(db, run)
            : await db.transaction(async (tx) => await run(tx));
        };

        const comparisons: {
          jit: "off" | "on";
          featureLabel: FeatureCase["label"];
          queryName: "hits" | "count";
          offBuffers: number;
          onBuffers: number;
          offTime: number;
          onTime: number;
        }[] = [];
        for (const jit of ["off", "on"] as const) {
          for (const featureCase of FEATURE_CASES) {
            await sample("off", featureCase, jit, true);
            await sample("on", featureCase, jit, true);

            const samples = {
              hits: { off: emptyQueryMetrics(), on: emptyQueryMetrics() },
              count: { off: emptyQueryMetrics(), on: emptyQueryMetrics() },
            };
            for (let index = 0; index < SAMPLE_COUNT; index++) {
              const order =
                index % 2 === 0
                  ? (["off", "on"] as const)
                  : (["on", "off"] as const);
              for (const policyMode of order) {
                const measured = await sample(
                  policyMode,
                  featureCase,
                  jit,
                  false,
                );
                samples.hits[policyMode].push(measured.hits);
                samples.count[policyMode].push(measured.count);
              }
            }

            for (const queryName of ["hits", "count"] as const) {
              const off = samples[queryName].off;
              const on = samples[queryName].on;
              const offBuffers = median(
                off.map(({ sharedBlocks }) => sharedBlocks),
              );
              const onBuffers = median(
                on.map(({ sharedBlocks }) => sharedBlocks),
              );
              const offTime = median(
                off.map(({ executionTimeMs }) => executionTimeMs),
              );
              const onTime = median(
                on.map(({ executionTimeMs }) => executionTimeMs),
              );
              comparisons.push({
                jit,
                featureLabel: featureCase.label,
                queryName,
                offBuffers,
                onBuffers,
                offTime,
                onTime,
              });
            }
          }
        }
        console.info(
          JSON.stringify({
            event: "search_budget_comparisons",
            maxTimeRatio: MAX_TIME_RATIO,
            maxBufferRatio: MAX_BUFFER_RATIO,
            comparisons,
          }),
        );
        for (const comparison of comparisons) {
          const {
            jit,
            featureLabel,
            queryName,
            offBuffers,
            onBuffers,
            offTime,
            onTime,
          } = comparison;
          expect(
            onBuffers,
            `JIT ${jit}, ${featureLabel} ${queryName} shared buffers: on=${onBuffers}, off=${offBuffers}`,
          ).toBeLessThanOrEqual(offBuffers * MAX_BUFFER_RATIO);
          expect(
            onTime,
            `JIT ${jit}, ${featureLabel} ${queryName} execution time: on=${onTime}ms, off=${offTime}ms`,
          ).toBeLessThanOrEqual(offTime * MAX_TIME_RATIO);
        }
      } finally {
        finished.resolve(undefined);
      }
    }, 240_000);
  },
);
