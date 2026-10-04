import { panic, Result } from "better-result";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { t } from "elysia";

import { Temporal } from "@stll/time";

import { entities, fields } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { arrayOrEmpty } from "@/api/lib/array";
import type { SafeId } from "@/api/lib/branded-types";
import { tConditionNode } from "@/api/lib/conditions/contract";
import {
  buildFilterConditions,
  buildSortExpressions,
} from "@/api/lib/entity-filters";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { brandValidatedPropertyId } from "@/api/lib/safe-id-boundaries";
import { tViewSortSchema } from "@/api/lib/views-schema";

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
  filters: t.Optional(
    t.Array(tConditionNode, { maxItems: LIMITS.viewFiltersCount }),
  ),
  sorts: t.Optional(
    t.Array(tViewSortSchema, { maxItems: LIMITS.viewSortsCount }),
  ),
});

const config = {
  description:
    "Read a matter's tasks that fall inside a date-time window, shaped for a " +
    "calendar. datePropertyIds chooses which date fields place an item, " +
    "including the built-in created, updated, due, and start dates; " +
    "endDatePropertyId supplies the end of a range. Filters and sorts follow " +
    "the same contract as the table views.",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "covered", by: "list_tasks" },
  access: "read",
  body: calendarTasksBodySchema,
} satisfies WorkspaceHandlerConfig;

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

type BuiltInDatePropertyId = (typeof BUILT_IN_DATE_IDS)[number];

// Calendar windows select inclusive UTC days, independent of request offsets or DB timezone.
type CalendarDayRange = {
  from: Temporal.PlainDate;
  to: Temporal.PlainDate;
};

const isBuiltInDatePropertyId = (
  propertyId: string,
): propertyId is BuiltInDatePropertyId => BUILT_IN_DATE_ID_SET.has(propertyId);

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

  return Temporal.PlainDate.from(value)
    .toZonedDateTime("UTC")
    .toInstant()
    .toString({ fractionalSecondDigits: 3 });
};

const requiredDateValueToIsoDateTime = (value: Date | string): string => {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value.includes("T")) {
    return value;
  }

  return Temporal.PlainDate.from(value)
    .toZonedDateTime("UTC")
    .toInstant()
    .toString({ fractionalSecondDigits: 3 });
};

const dateExprForProperty = (propertyId: BuiltInDatePropertyId) => {
  switch (propertyId) {
    case "_created-at":
      return sql`(${entities.createdAt} AT TIME ZONE 'UTC')::date`;
    case "_updated-at":
      return sql`(${entities.updatedAt} AT TIME ZONE 'UTC')::date`;
    case "_due-date":
      return sql`${entities.dueDate}`;
    case "_start-date":
      return sql`COALESCE((${entities.startAt} AT TIME ZONE 'UTC')::date, (${entities.occurredAt} AT TIME ZONE 'UTC')::date, ${entities.dueDate})`;
    default:
      propertyId satisfies never;
      return panic(`Unhandled calendar date property: ${String(propertyId)}`);
  }
};

const builtInDateInRange = (propertyId: string, range: CalendarDayRange) => {
  if (!isBuiltInDatePropertyId(propertyId)) {
    return null;
  }
  const dateExpr = dateExprForProperty(propertyId);
  return sql`${dateExpr} BETWEEN ${range.from.toString()}::date AND ${range.to.toString()}::date`;
};

const customDateInRange = (
  propertyId: string,
  range: CalendarDayRange,
) => sql`EXISTS (
  SELECT 1 FROM ${fields}
  WHERE ${fields.workspaceId} = ${entities.workspaceId}
    AND ${fields.entityVersionId} = ${entities.currentVersionId}
    AND ${fields.propertyId} = ${propertyId}
    AND ${fields.content}->>'type' = 'date'
    AND NULLIF(${fields.content}->>'value', '')::date BETWEEN ${range.from.toString()}::date AND ${range.to.toString()}::date
)`;

const dateOnOrBefore = (propertyId: string, dateTo: Temporal.PlainDate) => {
  if (isBuiltInDatePropertyId(propertyId)) {
    const dateExpr = dateExprForProperty(propertyId);
    return sql`${dateExpr} <= ${dateTo.toString()}::date`;
  }

  return sql`EXISTS (
    SELECT 1 FROM ${fields}
    WHERE ${fields.workspaceId} = ${entities.workspaceId}
      AND ${fields.entityVersionId} = ${entities.currentVersionId}
      AND ${fields.propertyId} = ${propertyId}
      AND ${fields.content}->>'type' = 'date'
      AND NULLIF(${fields.content}->>'value', '')::date <= ${dateTo.toString()}::date
  )`;
};

const dateOnOrAfter = (propertyId: string, dateFrom: Temporal.PlainDate) => {
  if (isBuiltInDatePropertyId(propertyId)) {
    const dateExpr = dateExprForProperty(propertyId);
    return sql`${dateExpr} >= ${dateFrom.toString()}::date`;
  }

  return sql`EXISTS (
    SELECT 1 FROM ${fields}
    WHERE ${fields.workspaceId} = ${entities.workspaceId}
      AND ${fields.entityVersionId} = ${entities.currentVersionId}
      AND ${fields.propertyId} = ${propertyId}
      AND ${fields.content}->>'type' = 'date'
      AND NULLIF(${fields.content}->>'value', '')::date >= ${dateFrom.toString()}::date
  )`;
};

const buildCalendarDateConditions = ({
  range,
  datePropertyIds,
  endDatePropertyId,
}: {
  range: CalendarDayRange;
  datePropertyIds: readonly string[];
  endDatePropertyId: string | undefined;
}) => {
  const conditions = datePropertyIds.map((propertyId) => {
    const builtIn = builtInDateInRange(propertyId, range);
    return builtIn ?? customDateInRange(propertyId, range);
  });

  const primaryDatePropertyId = datePropertyIds.at(0);
  if (primaryDatePropertyId && endDatePropertyId) {
    const spanCondition = and(
      dateOnOrBefore(primaryDatePropertyId, range.to),
      dateOnOrAfter(endDatePropertyId, range.from),
    );
    if (spanCondition) {
      conditions.push(spanCondition);
    }
  }

  return conditions;
};

const calendarTasks = createSafeHandler(
  config,
  async function* ({ body, safeDb, session, workspaceId }) {
    const { from, to } = yield* Result.try({
      try: () => ({
        from: Temporal.Instant.from(body.dateFrom),
        to: Temporal.Instant.from(body.dateTo),
      }),
      catch: () =>
        new HandlerError({
          status: 400,
          message: "Invalid calendar date range",
        }),
    });
    const range = {
      from: from.toZonedDateTimeISO("UTC").toPlainDate(),
      to: to.toZonedDateTimeISO("UTC").toPlainDate(),
    } satisfies CalendarDayRange;
    if (
      Temporal.Instant.compare(from, to) > 0 ||
      Temporal.PlainDate.compare(range.from, range.to) > 0
    ) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Invalid calendar date range",
        }),
      );
    }

    const datePropertyIds = unique(body.datePropertyIds);
    const fieldPropertyIds: SafeId<"property">[] = [];
    for (const requestedId of unique([
      ...datePropertyIds.filter((id) => !isBuiltInDatePropertyId(id)),
      ...(body.endDatePropertyId &&
      !isBuiltInDatePropertyId(body.endDatePropertyId)
        ? [body.endDatePropertyId]
        : []),
    ])) {
      const propertyId = brandValidatedPropertyId(requestedId);
      if (!propertyId) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: "Invalid calendar date property",
          }),
        );
      }
      fieldPropertyIds.push(propertyId);
    }
    const dateConditions = buildCalendarDateConditions({
      range,
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
      ...buildFilterConditions(arrayOrEmpty(body.filters)),
      dateClause,
    );
    const limit = LIMITS.calendarTasksMax;
    const taskIdRows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({ id: entities.id })
          .from(entities)
          .where(whereClause)
          .orderBy(
            ...buildSortExpressions(
              arrayOrEmpty(body.sorts),
              session.activeOrganizationId,
            ),
          )
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
                      inArray(fields.propertyId, fieldPropertyIds),
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
        fields: (() => {
          const storedFields = fieldsByEntityId.get(taskId);
          return arrayOrEmpty(storedFields);
        })(),
      });
    }

    return Result.ok({ tasks });
  },
);

export default calendarTasks;
