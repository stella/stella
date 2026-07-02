import { Result } from "better-result";
import { and, eq, isNotNull, notInArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { t } from "elysia";

import type { SafeDb } from "@/api/db";
import { entities, properties } from "@/api/db/schema";
import type { EntityKind } from "@/api/db/schema-validators";
import {
  buildKanbanGroupCondition,
  buildOptionArraySql,
} from "@/api/handlers/entities/kanban-group-condition";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tConditionNode } from "@/api/lib/conditions/contract";
import { tSafeId } from "@/api/lib/custom-schema";
import { buildFilterConditions } from "@/api/lib/entity-filters";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { groupableSql } from "@/api/lib/groupable-sql";

const STATUS_GROUP_ID = "_status";
const KIND_GROUP_ID = "_kind";
// Folders and tasks are not rows in a document table view; the flat window query
// excludes them, so the grouped counts must too.
const TABLE_EXCLUDED_ENTITY_KINDS = ["folder", "task"] satisfies EntityKind[];
const TASK_STATUS_VALUES = [
  "open",
  "in_progress",
  "in_review",
  "done",
  "cancelled",
] as const;
// Inline the status literals with `sql.raw` rather than binding them: the
// enclosing CASE expression is rendered into both the SELECT list and the
// GROUP BY, and a bound value would get different placeholder numbers per
// render, making Postgres reject the grouped query. These are fixed code
// constants, never user input, so inlining is byte-identical and safe.
const TASK_STATUS_SQL_VALUES = TASK_STATUS_VALUES.map((statusValue) =>
  sql.raw(`'${statusValue}'`),
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
    // The grouped table is a document table: it never renders folders or tasks
    // (the flat window query excludes them too), so the counts must exclude them
    // to stay in sync with the rows. The status branch is task-only and keeps
    // the base conditions.
    const documentConditions = and(
      baseConditions,
      notInArray(entities.kind, TABLE_EXCLUDED_ENTITY_KINDS),
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
            .where(documentConditions)
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
      const statusBucketExpr = groupableSql(sql<string | null>`CASE
        WHEN ${entities.status} IN (${sql.join(TASK_STATUS_SQL_VALUES, sql`, `)})
        THEN ${entities.status}
        ELSE NULL
      END`);
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
    // Validate server-side that the grouping property is a select type. The
    // frontend already hides non-select groupings, but this read endpoint is a
    // boundary: grouping a large free-form (text/date/int) column would bucket
    // every distinct value into an unbounded, expensive response.
    const propertyRows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({ content: properties.content })
          .from(properties)
          .where(
            and(
              eq(properties.id, propertyId),
              eq(properties.workspaceId, workspaceId),
            ),
          )
          .limit(1),
      ),
    );
    const property = propertyRows.at(0);
    if (
      !property ||
      (property.content.type !== "single-select" &&
        property.content.type !== "multi-select")
    ) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Group counts are only supported for select properties",
        }),
      );
    }
    return yield* readPropertyGroupCounts({
      safeDb,
      baseConditions: documentConditions,
      propertyId,
      // Configured option values are kept regardless of the bucket cap; only
      // stale (out-of-options) values are capped.
      optionValues: property.content.options.map((option) => option.value),
    });
  },
);

type ReadPropertyGroupCountsArgs = {
  safeDb: SafeDb;
  baseConditions: SQL | undefined;
  propertyId: string;
  optionValues: string[];
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
  optionValues,
}: ReadPropertyGroupCountsArgs) {
  const baseWhere = baseConditions ?? sql`true`;
  const optionArray = buildOptionArraySql(optionValues);

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
          AND group_value = ANY(${optionArray})
        GROUP BY group_value
      `),
    ),
  );

  // Uncategorized = no value matching a current option (so stale and empty
  // cells fold here). Reuse the kanban-group condition so the count matches the
  // rows that group actually fetches.
  const uncategorizedResult = buildKanbanGroupCondition({
    groupByPropertyId: propertyId,
    groupValue: null,
    optionValues,
  });
  if (Result.isError(uncategorizedResult)) {
    return Result.err(uncategorizedResult.error);
  }
  const uncategorizedCondition = uncategorizedResult.value;
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
