import { Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { t } from "elysia";

import { entities, fields } from "@/api/db/schema";
import { queryEntities } from "@/api/handlers/entities/query-entities";
import {
  decodeEntitiesWindowCursor,
  encodeEntitiesWindowCursor,
} from "@/api/handlers/entities/window-cursor";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { createCursorPage } from "@/api/lib/pagination";
import {
  tViewFilterConditionSchema,
  tViewSortSchema,
} from "@/api/lib/views-schema";

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

const readKanbanGroupBodySchema = t.Object({
  filters: t.Optional(t.Array(tViewFilterConditionSchema)),
  sorts: t.Optional(t.Array(tViewSortSchema)),
  limit: t.Optional(
    t.Integer({
      minimum: 1,
      maximum: LIMITS.entitiesWindowSizeMax,
    }),
  ),
  cursor: t.Optional(t.String({ maxLength: 512 })),
  fieldMode: t.Optional(t.UnionEnum(["full", "visible"])),
  fieldIds: t.Optional(
    t.Array(tSafeId("property"), {
      maxItems: LIMITS.propertiesCount,
    }),
  ),
  groupByPropertyId: t.Union([
    t.Literal(STATUS_GROUP_ID),
    t.Literal(KIND_GROUP_ID),
    tSafeId("property"),
  ]),
  groupValue: t.Nullable(t.String({ maxLength: 1000 })),
});

const config = {
  permissions: { workspace: ["read"] },
  body: readKanbanGroupBodySchema,
} satisfies HandlerConfig;

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

const buildPropertyGroupCondition = (
  propertyId: string,
  groupValue: string | null,
): SQL => {
  if (groupValue === null) {
    return sql`NOT EXISTS (
      SELECT 1 FROM ${fields}
      WHERE ${fields.workspaceId} = ${entities.workspaceId}
        AND ${fields.entityVersionId} = ${entities.currentVersionId}
        AND ${fields.propertyId} = ${propertyId}
        AND (
          (
            jsonb_typeof(${fields.content}->'value') = 'array'
            AND jsonb_array_length(${fields.content}->'value') > 0
          )
          OR (
            jsonb_typeof(${fields.content}->'value') != 'array'
            AND COALESCE(${fields.content}->>'value', '') != ''
          )
        )
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

const buildKanbanGroupCondition = ({
  groupByPropertyId,
  groupValue,
}: {
  groupByPropertyId: string;
  groupValue: string | null;
}): Result<SQL, HandlerError> => {
  if (groupByPropertyId === STATUS_GROUP_ID) {
    return Result.ok(buildStatusGroupCondition(groupValue));
  }

  if (groupByPropertyId === KIND_GROUP_ID) {
    return buildKindGroupCondition(groupValue);
  }

  return Result.ok(buildPropertyGroupCondition(groupByPropertyId, groupValue));
};

const readKanbanGroup = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, session, body, user: currentUser }) {
    const cursorResult = decodeEntitiesWindowCursor(body.cursor);
    if (Result.isError(cursorResult)) {
      return Result.err(cursorResult.error);
    }

    const conditionResult = buildKanbanGroupCondition({
      groupByPropertyId: body.groupByPropertyId,
      groupValue: body.groupValue,
    });
    if (Result.isError(conditionResult)) {
      return Result.err(conditionResult.error);
    }

    const offset = cursorResult.value;
    const limit = body.limit ?? LIMITS.entitiesWindowSizeDefault;
    const result = yield* Result.await(
      queryEntities({
        safeDb,
        workspaceId,
        currentUserId: currentUser.id,
        currentOrganizationId: session.activeOrganizationId,
        filters: body.filters ?? [],
        sorts: body.sorts ?? [],
        offset,
        limit: limit + 1,
        fieldMode: body.fieldMode ?? "full",
        fieldIds: body.fieldIds ?? [],
        extraConditions: [conditionResult.value],
        includeTotalCount: false,
      }),
    );

    return Result.ok(
      createCursorPage({
        rows: result.entities,
        limit,
        cursorForItem: () => encodeEntitiesWindowCursor(offset + limit),
      }),
    );
  },
);

export default readKanbanGroup;
