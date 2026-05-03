import { Result } from "better-result";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { t } from "elysia";

import { entities, fields } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import {
  buildFilterConditions,
  buildSortExpressions,
} from "@/api/lib/entity-filters";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import {
  tViewFilterConditionSchema,
  tViewSortSchema,
} from "@/api/lib/views-schema";

const INTERNAL_DATE_IDS = ["_created-at", "_updated-at"] as const;
const TASK_DATE_IDS = ["_due-date", "_start-date"] as const;
const BUILT_IN_DATE_IDS = [...INTERNAL_DATE_IDS, ...TASK_DATE_IDS] as const;
const BUILT_IN_DATE_ID_SET: ReadonlySet<string> = new Set(BUILT_IN_DATE_IDS);

const calendarTasksBodySchema = t.Object({
  dateFrom: t.String({ format: "date-time" }),
  dateTo: t.String({ format: "date-time" }),
  datePropertyIds: t.Array(t.String({ minLength: 1 }), {
    minItems: 1,
    maxItems: LIMITS.propertiesCount + BUILT_IN_DATE_IDS.length,
  }),
  endDatePropertyId: t.Optional(t.String({ minLength: 1 })),
  filters: t.Optional(t.Array(tViewFilterConditionSchema)),
  sorts: t.Optional(t.Array(tViewSortSchema)),
});

const config = {
  permissions: { workspace: ["read"] },
  body: calendarTasksBodySchema,
} satisfies HandlerConfig;

type CalendarTaskField = {
  id: string;
  propertyId: string;
  entityId: string;
  content: {
    type: "date";
    version: 1;
    value: string | null;
  };
};

type CalendarTask = {
  taskId: string;
  name: string | null;
  status: string | null;
  createdAt: string;
  updatedAt: string | null;
  dueDate: string | null;
  startAt: string | null;
  endAt: string | null;
  occurredAt: string | null;
  fields: CalendarTaskField[];
};

const isBuiltInDatePropertyId = (propertyId: string): boolean =>
  BUILT_IN_DATE_ID_SET.has(propertyId);

const unique = (values: readonly string[]): string[] => [
  ...new Set(values.filter((value) => value.length > 0)),
];

const dateValueToIsoDateTime = (
  value: Date | string | null | undefined,
): string | null => {
  if (value === null || value === undefined) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value.includes("T")) {
    return value;
  }

  return new Date(`${value}T00:00:00.000Z`).toISOString();
};

const requiredDateValueToIsoDateTime = (value: Date | string): string => {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value.includes("T")) {
    return value;
  }

  return new Date(`${value}T00:00:00.000Z`).toISOString();
};

const dateExprForProperty = (propertyId: string) => {
  switch (propertyId) {
    case "_created-at":
      return sql`(${entities.createdAt})::date`;
    case "_updated-at":
      return sql`(${entities.updatedAt})::date`;
    case "_due-date":
      return sql`(${entities.dueDate})::date`;
    case "_start-date":
      return sql`(COALESCE(${entities.startAt}, ${entities.occurredAt}, ${entities.dueDate}::timestamp))::date`;
    default:
      return null;
  }
};

const builtInDateInRange = (
  propertyId: string,
  dateFrom: string,
  dateTo: string,
) => {
  const dateExpr = dateExprForProperty(propertyId);
  if (!dateExpr) {
    return null;
  }

  return sql`${dateExpr} BETWEEN ${dateFrom}::date AND ${dateTo}::date`;
};

const customDateInRange = (
  propertyId: string,
  dateFrom: string,
  dateTo: string,
) => sql`EXISTS (
  SELECT 1 FROM ${fields}
  WHERE ${fields.workspaceId} = ${entities.workspaceId}
    AND ${fields.entityVersionId} = ${entities.currentVersionId}
    AND ${fields.propertyId} = ${propertyId}
    AND ${fields.content}->>'type' = 'date'
    AND NULLIF(${fields.content}->>'value', '')::date BETWEEN ${dateFrom}::date AND ${dateTo}::date
)`;

const dateOnOrBefore = (propertyId: string, dateTo: string) => {
  const dateExpr = dateExprForProperty(propertyId);
  if (dateExpr) {
    return sql`${dateExpr} <= ${dateTo}::date`;
  }

  return sql`EXISTS (
    SELECT 1 FROM ${fields}
    WHERE ${fields.workspaceId} = ${entities.workspaceId}
      AND ${fields.entityVersionId} = ${entities.currentVersionId}
      AND ${fields.propertyId} = ${propertyId}
      AND ${fields.content}->>'type' = 'date'
      AND NULLIF(${fields.content}->>'value', '')::date <= ${dateTo}::date
  )`;
};

const dateOnOrAfter = (propertyId: string, dateFrom: string) => {
  const dateExpr = dateExprForProperty(propertyId);
  if (dateExpr) {
    return sql`${dateExpr} >= ${dateFrom}::date`;
  }

  return sql`EXISTS (
    SELECT 1 FROM ${fields}
    WHERE ${fields.workspaceId} = ${entities.workspaceId}
      AND ${fields.entityVersionId} = ${entities.currentVersionId}
      AND ${fields.propertyId} = ${propertyId}
      AND ${fields.content}->>'type' = 'date'
      AND NULLIF(${fields.content}->>'value', '')::date >= ${dateFrom}::date
  )`;
};

const buildCalendarDateConditions = ({
  dateFrom,
  datePropertyIds,
  dateTo,
  endDatePropertyId,
}: {
  dateFrom: string;
  datePropertyIds: readonly string[];
  dateTo: string;
  endDatePropertyId: string | undefined;
}) => {
  const conditions = datePropertyIds.map((propertyId) => {
    const builtIn = builtInDateInRange(propertyId, dateFrom, dateTo);
    return builtIn ?? customDateInRange(propertyId, dateFrom, dateTo);
  });

  const primaryDatePropertyId = datePropertyIds.at(0);
  if (primaryDatePropertyId && endDatePropertyId) {
    const spanCondition = and(
      dateOnOrBefore(primaryDatePropertyId, dateTo),
      dateOnOrAfter(endDatePropertyId, dateFrom),
    );
    if (spanCondition) {
      conditions.push(spanCondition);
    }
  }

  return conditions;
};

const calendarTasks = createSafeHandler(
  config,
  async function* ({ body, safeDb, workspaceId }) {
    if (body.dateFrom > body.dateTo) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Invalid calendar date range",
        }),
      );
    }

    const datePropertyIds = unique(body.datePropertyIds);
    const fieldPropertyIds = unique([
      ...datePropertyIds.filter((id) => !isBuiltInDatePropertyId(id)),
      ...(body.endDatePropertyId &&
      !isBuiltInDatePropertyId(body.endDatePropertyId)
        ? [body.endDatePropertyId]
        : []),
    ]);
    const dateConditions = buildCalendarDateConditions({
      dateFrom: body.dateFrom,
      dateTo: body.dateTo,
      datePropertyIds,
      endDatePropertyId: body.endDatePropertyId,
    });
    const dateClause = or(...dateConditions);
    if (!dateClause) {
      return Result.ok({ tasks: [] });
    }

    const whereClause = and(
      eq(entities.workspaceId, workspaceId),
      eq(entities.kind, "task"),
      ...buildFilterConditions(body.filters ?? []),
      dateClause,
    );
    const limit = LIMITS.calendarTasksMax;
    const taskIdRows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({ id: entities.id })
          .from(entities)
          .where(whereClause)
          .orderBy(...buildSortExpressions(body.sorts ?? []))
          .limit(limit + 1),
      ),
    );

    if (taskIdRows.length > limit) {
      return Result.err(
        new HandlerError({
          status: 422,
          message: "Calendar task limit exceeded",
        }),
      );
    }

    const taskIds = taskIdRows.map((row) => row.id);
    if (taskIds.length === 0) {
      return Result.ok({ tasks: [] });
    }

    const idFilter = inArray(entities.id, taskIds);
    const [taskRows, fieldRows] = yield* Result.await(
      safeDb(
        async (tx) =>
          await Promise.all([
            tx
              .select({
                id: entities.id,
                name: entities.name,
                status: entities.status,
                createdAt: entities.createdAt,
                updatedAt: entities.updatedAt,
                dueDate: entities.dueDate,
                startAt: entities.startAt,
                endAt: entities.endAt,
                occurredAt: entities.occurredAt,
              })
              .from(entities)
              .where(idFilter),
            fieldPropertyIds.length === 0
              ? Promise.resolve([])
              : tx
                  .select({
                    entityId: entities.id,
                    id: fields.id,
                    propertyId: fields.propertyId,
                    content: fields.content,
                  })
                  .from(fields)
                  .innerJoin(
                    entities,
                    and(
                      eq(fields.entityVersionId, entities.currentVersionId),
                      idFilter,
                    ),
                  )
                  .where(
                    and(
                      eq(fields.workspaceId, workspaceId),
                      sql`${fields.propertyId} = ANY(${fieldPropertyIds}::uuid[])`,
                      sql`${fields.content}->>'type' = 'date'`,
                    ),
                  ),
          ]),
      ),
    );

    const fieldsByEntityId = new Map<string, CalendarTaskField[]>();
    for (const field of fieldRows) {
      if (field.content.type !== "date") {
        continue;
      }

      const calendarField: CalendarTaskField = {
        id: field.id,
        propertyId: field.propertyId,
        entityId: field.entityId,
        content: {
          type: "date",
          version: 1,
          value: dateValueToIsoDateTime(field.content.value),
        },
      };
      const list = fieldsByEntityId.get(field.entityId);
      if (list) {
        list.push(calendarField);
      } else {
        fieldsByEntityId.set(field.entityId, [calendarField]);
      }
    }

    const taskRowsById = new Map(taskRows.map((task) => [task.id, task]));
    const tasks: CalendarTask[] = [];
    for (const taskId of taskIds) {
      const task = taskRowsById.get(taskId);
      if (!task) {
        continue;
      }
      tasks.push({
        taskId,
        name: task.name,
        status: task.status,
        createdAt: requiredDateValueToIsoDateTime(task.createdAt),
        updatedAt: dateValueToIsoDateTime(task.updatedAt),
        dueDate: dateValueToIsoDateTime(task.dueDate),
        startAt: dateValueToIsoDateTime(task.startAt),
        endAt: dateValueToIsoDateTime(task.endAt),
        occurredAt: dateValueToIsoDateTime(task.occurredAt),
        fields: fieldsByEntityId.get(taskId) ?? [],
      });
    }

    return Result.ok({ tasks });
  },
);

export default calendarTasks;
