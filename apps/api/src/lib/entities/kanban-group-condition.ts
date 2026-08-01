import { Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { t } from "elysia";

import { entities, fields } from "@/api/db/schema";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

export const STATUS_GROUP_ID = "_status";
export const KIND_GROUP_ID = "_kind";

// Elysia schema for the grouping discriminator, shared by every endpoint that
// scopes a query to one group (kanban-group, mark-column-flag) so they accept
// the exact same set of grouping properties.
export const tGroupByPropertyId = t.Union([
  t.Literal(STATUS_GROUP_ID),
  t.Literal(KIND_GROUP_ID),
  tSafeId("property"),
]);

const TASK_STATUS_VALUES = [
  "open",
  "in_progress",
  "in_review",
  "done",
  "cancelled",
] as const;
const TASK_STATUS_SQL_VALUES = TASK_STATUS_VALUES.map(
  (status) => sql`${status}`,
);
const ENTITY_KIND_VALUES = [
  "document",
  "folder",
  "task",
  "message",
  "link",
] as const;
type EntityKindValue = (typeof ENTITY_KIND_VALUES)[number];

const isEntityKindValue = (value: string): value is EntityKindValue =>
  ENTITY_KIND_VALUES.some((kind) => kind === value);

const invalidKanbanGroup = () =>
  new HandlerError({ status: 400, message: "Invalid Kanban group" });

const buildStatusGroupCondition = (groupValue: string | null): SQL => {
  const taskCondition = eq(entities.kind, "task");
  if (groupValue === null) {
    return (
      and(
        taskCondition,
        sql`(${entities.status} IS NULL OR ${entities.status} NOT IN (${sql.join(TASK_STATUS_SQL_VALUES, sql`, `)}))`,
      ) ?? taskCondition
    );
  }

  return and(taskCondition, eq(entities.status, groupValue)) ?? taskCondition;
};

const buildKindGroupCondition = (
  groupValue: string | null,
): Result<SQL, HandlerError> => {
  if (groupValue === null) {
    return Result.err(invalidKanbanGroup());
  }

  if (!isEntityKindValue(groupValue)) {
    return Result.err(invalidKanbanGroup());
  }

  return Result.ok(eq(entities.kind, groupValue));
};

// A Postgres `text[]` literal for the property's option values, used to fold
// rows whose value is no longer a current option into the uncategorized bucket.
export const buildOptionArraySql = (optionValues: readonly string[]): SQL =>
  sql`ARRAY[${sql.join(
    optionValues.map((value) => sql`${value}`),
    sql`, `,
  )}]::text[]`;

const buildPropertyGroupCondition = (
  propertyId: string,
  groupValue: string | null,
  // When provided (grouped table), the uncategorized bucket is "no value that is
  // a current option", so stale (out-of-options) cells fold into it instead of
  // forming an unbounded set of per-value groups. Omitted (kanban board) keeps
  // the original "no non-empty value".
  optionValues: readonly string[] | undefined,
): SQL => {
  if (groupValue === null) {
    const optionArray = optionValues && buildOptionArraySql(optionValues);
    const hasCategorizingValue = optionArray
      ? sql`(
          (
            jsonb_typeof(${fields.content}->'value') = 'array'
            AND ${fields.content}->'value' ?| ${optionArray}
          )
          OR (
            jsonb_typeof(${fields.content}->'value') != 'array'
            AND ${fields.content}->>'value' = ANY(${optionArray})
          )
        )`
      : sql`(
          (
            jsonb_typeof(${fields.content}->'value') = 'array'
            AND jsonb_array_length(${fields.content}->'value') > 0
          )
          OR (
            jsonb_typeof(${fields.content}->'value') != 'array'
            AND COALESCE(${fields.content}->>'value', '') != ''
          )
        )`;
    return sql`NOT EXISTS (
      SELECT 1 FROM ${fields}
      WHERE ${fields.workspaceId} = ${entities.workspaceId}
        AND ${fields.entityVersionId} = ${entities.currentVersionId}
        AND ${fields.propertyId} = ${propertyId}
        AND ${hasCategorizingValue}
    )`;
  }

  return sql`EXISTS (
    SELECT 1 FROM ${fields}
    WHERE ${fields.workspaceId} = ${entities.workspaceId}
      AND ${fields.entityVersionId} = ${entities.currentVersionId}
      AND ${fields.propertyId} = ${propertyId}
      AND (
        (
          jsonb_typeof(${fields.content}->'value') = 'array'
          AND ${fields.content}->'value' ? ${groupValue}
        )
        OR ${fields.content}->>'value' = ${groupValue}
      )
  )`;
};

export const buildKanbanGroupCondition = ({
  groupByPropertyId,
  groupValue,
  optionValues,
}: {
  groupByPropertyId: string;
  groupValue: string | null;
  optionValues: readonly string[] | undefined;
}): Result<SQL, HandlerError> => {
  if (groupByPropertyId === STATUS_GROUP_ID) {
    return Result.ok(buildStatusGroupCondition(groupValue));
  }

  if (groupByPropertyId === KIND_GROUP_ID) {
    return buildKindGroupCondition(groupValue);
  }

  return Result.ok(
    buildPropertyGroupCondition(groupByPropertyId, groupValue, optionValues),
  );
};
