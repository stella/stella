import { Result } from "better-result";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { t } from "elysia";

import type { SafeDb } from "@/api/db";
import { entities } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tConditionNode } from "@/api/lib/conditions/contract";
import { tSafeId } from "@/api/lib/custom-schema";
import { buildFilterConditions } from "@/api/lib/entity-filters";

const STATUS_GROUP_ID = "_status";
const KIND_GROUP_ID = "_kind";
const TASK_STATUS_VALUES = [
  "open",
  "in_progress",
  "in_review",
  "done",
  "cancelled",
] as const;
const TASK_STATUS_SQL_VALUES = TASK_STATUS_VALUES.map(
  (statusValue) => sql`${statusValue}`,
);

const readGroupCountsBodySchema = t.Object({
  groupByPropertyId: t.Union([
    t.Literal(STATUS_GROUP_ID),
    t.Literal(KIND_GROUP_ID),
    tSafeId("property"),
  ]),
  filters: t.Optional(t.Array(tConditionNode)),
});

const config = {
  permissions: { workspace: ["read"] },
  body: readGroupCountsBodySchema,
} satisfies HandlerConfig;

type GroupCount = { value: string | null; count: number };

type GroupCountRow = { value: string | null; count: number };

const readGroupCounts = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, body }) {
    // Same base set the table/window query scopes to: this workspace, only
    // entities with a live current version, plus the view's compiled filters.
    // Matching this exactly is what keeps the group-header counts in sync with
    // the rows the table actually renders.
    const baseConditions = and(
      eq(entities.workspaceId, workspaceId),
      isNotNull(entities.currentVersionId),
      ...buildFilterConditions(body.filters ?? []),
    );

    if (body.groupByPropertyId === KIND_GROUP_ID) {
      // `kind` is never null, so every base entity lands in exactly one bucket.
      const rows = yield* Result.await(
        safeDb((tx) =>
          tx
            .select({
              value: sql<string>`${entities.kind}`,
              count: sql<number>`count(*)::int`,
            })
            .from(entities)
            .where(baseConditions)
            .groupBy(entities.kind),
        ),
      );
      return Result.ok({ counts: rows satisfies GroupCount[] });
    }

    if (body.groupByPropertyId === STATUS_GROUP_ID) {
      // Status groups are task-only. Task entities whose status is null or not a
      // recognized task status collapse into the uncategorized (null) bucket;
      // mirrors buildStatusGroupCondition's value logic from
      // kanban-group-condition.
      const statusBucketExpr = sql<string | null>`CASE
        WHEN ${entities.status} IN (${sql.join(TASK_STATUS_SQL_VALUES, sql`, `)})
        THEN ${entities.status}
        ELSE NULL
      END`;
      const rows = yield* Result.await(
        safeDb((tx) =>
          tx
            .select({
              value: statusBucketExpr,
              count: sql<number>`count(*)::int`,
            })
            .from(entities)
            .where(and(baseConditions, eq(entities.kind, "task")))
            .groupBy(statusBucketExpr),
        ),
      );
      return Result.ok({ counts: rows satisfies GroupCount[] });
    }

    const propertyId = body.groupByPropertyId;
    return yield* readPropertyGroupCounts({
      safeDb,
      baseConditions,
      propertyId,
    });
  },
);

type ReadPropertyGroupCountsArgs = {
  safeDb: SafeDb;
  baseConditions: SQL | undefined;
  propertyId: string;
};

// One GROUP BY over the base set joined LATERAL to its group values for the
// property: multi-select arrays unnest to one row per element, single-select
// scalars yield one row. An entity therefore contributes to every distinct
// value it carries (a 2-element multi-select counts toward 2 values). The
// uncategorized (null) bucket is computed separately as the count of base
// entities with no non-empty value for the property — the NOT EXISTS form from
// kanban-group-condition — and appended only when non-zero.
async function* readPropertyGroupCounts({
  safeDb,
  baseConditions,
  propertyId,
}: ReadPropertyGroupCountsArgs) {
  const baseWhere = baseConditions ?? sql`true`;

  const valueRows = yield* Result.await(
    safeDb((tx) =>
      tx.execute<GroupCountRow>(sql`
        SELECT group_value AS "value", count(*)::int AS "count"
        FROM ${entities}
        CROSS JOIN LATERAL (
          SELECT elem AS group_value
          FROM fields f
          CROSS JOIN LATERAL jsonb_array_elements_text(
            -- Guard the unnest against scalars: the planner may evaluate this
            -- LATERAL before the WHERE filters non-array rows, so feed an empty
            -- array for non-arrays instead of letting Postgres raise "cannot
            -- extract elements from a scalar".
            CASE
              WHEN jsonb_typeof(f.content->'value') = 'array'
              THEN f.content->'value'
              ELSE '[]'::jsonb
            END
          ) AS elem
          WHERE f.workspace_id = ${entities.workspaceId}
            AND f.entity_version_id = ${entities.currentVersionId}
            AND f.property_id = ${propertyId}
            AND jsonb_typeof(f.content->'value') = 'array'
          UNION ALL
          SELECT f.content->>'value' AS group_value
          FROM fields f
          WHERE f.workspace_id = ${entities.workspaceId}
            AND f.entity_version_id = ${entities.currentVersionId}
            AND f.property_id = ${propertyId}
            AND jsonb_typeof(f.content->'value') != 'array'
            AND COALESCE(f.content->>'value', '') != ''
        ) AS group_values
        WHERE ${baseWhere}
        GROUP BY group_value
      `),
    ),
  );

  const uncategorizedCondition = sql`NOT EXISTS (
    SELECT 1 FROM fields f
    WHERE f.workspace_id = ${entities.workspaceId}
      AND f.entity_version_id = ${entities.currentVersionId}
      AND f.property_id = ${propertyId}
      AND (
        (
          jsonb_typeof(f.content->'value') = 'array'
          AND jsonb_array_length(f.content->'value') > 0
        )
        OR (
          jsonb_typeof(f.content->'value') != 'array'
          AND COALESCE(f.content->>'value', '') != ''
        )
      )
  )`;
  const uncategorizedRows = yield* Result.await(
    safeDb((tx) =>
      tx
        .select({ count: sql<number>`count(*)::int` })
        .from(entities)
        .where(and(baseWhere, uncategorizedCondition)),
    ),
  );

  const counts: GroupCount[] = valueRows.map((row) => ({
    value: row.value,
    count: row.count,
  }));
  const uncategorizedCount = uncategorizedRows.at(0)?.count ?? 0;
  if (uncategorizedCount > 0) {
    counts.push({ value: null, count: uncategorizedCount });
  }

  return Result.ok({ counts });
}

export default readGroupCounts;
