import { asc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { user } from "@/api/db/auth-schema";
import { entities, entityVersions, fields } from "@/api/db/schema";
import type { EntityKind, FieldContent } from "@/api/db/schema-validators";
import type { ViewFilterCondition } from "@/api/lib/views-schema";

// -- Types --

type EntityField = {
  id: string;
  propertyId: string;
  entityId: string;
  content: FieldContent;
};

type FilterableEntity = {
  entityId: string;
  kind: EntityKind;
  fields: EntityField[];
};

type ViewSort = {
  propertyId: string;
  desc: boolean;
};

// -- Helpers --

const getFieldValue = (content: FieldContent | undefined): string => {
  if (!content) {
    return "";
  }

  switch (content.type) {
    case "text":
      return content.value;
    case "file":
      return content.fileName;
    case "single-select":
      return content.value ?? "";
    case "multi-select":
      return content.value.join(", ");
    case "date":
      return content.value ?? "";
    case "int":
      return String(content.value);
    case "error":
    case "pending":
    case "unsupported":
    case "clip":
      return "";
    default:
      return "";
  }
};

// Numeric value for sort comparison: int content uses its number; a
// missing field or a legacy/coerced non-int value parses its string form,
// returning null when no finite number is available (sorts to the end).
const numericContentValue = (
  content: FieldContent | undefined,
): number | null => {
  if (content?.type === "int") {
    return content.value;
  }
  const raw = getFieldValue(content);
  if (raw.trim() === "") {
    return null;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

const findField = (
  entityFields: EntityField[],
  propertyId: string,
): EntityField | undefined =>
  entityFields.find((f) => f.propertyId === propertyId);

const matchesFilter = (
  entity: FilterableEntity,
  filter: ViewFilterCondition,
): boolean => {
  if (filter.field === "kind") {
    if (filter.value.length === 0) {
      return true;
    }
    if (filter.value.includes("document") && entity.kind === "folder") {
      return true;
    }
    return filter.value.includes(entity.kind);
  }

  if (filter.field === "builtin") {
    // Builtin filters are handled server-side only.
    return true;
  }

  const field = findField(entity.fields, filter.propertyId);
  const value = getFieldValue(field?.content);

  switch (filter.op) {
    case "eq":
      return value === (filter.value ?? "");
    case "neq":
      return value !== (filter.value ?? "");
    case "contains":
      return value
        .toLowerCase()
        .includes(String(filter.value ?? "").toLowerCase());
    case "is_empty":
      return value === "";
    default:
      return true;
  }
};

// -- Public API --

export const applyFilters = <T extends FilterableEntity>(
  items: T[],
  filters: ViewFilterCondition[],
): T[] => {
  if (filters.length === 0) {
    return items;
  }

  return items.filter((entity) =>
    filters.every((filter) => matchesFilter(entity, filter)),
  );
};

export const applySorts = <T extends FilterableEntity>(
  items: T[],
  sorts: ViewSort[],
): T[] => {
  if (sorts.length === 0) {
    return items;
  }

  return [...items].toSorted((a, b) => {
    for (const sort of sorts) {
      const fieldA = findField(a.fields, sort.propertyId);
      const fieldB = findField(b.fields, sort.propertyId);
      const dir = sort.desc ? -1 : 1;

      // Numeric ordering whenever the property is numeric on at least one
      // side. Comparing only when BOTH sides are int dropped to a string
      // localeCompare the moment a row was missing the field or held a
      // legacy non-int value, so 10 sorted before 9. Rows without a numeric
      // value bucket to the end, independent of sort direction.
      if (fieldA?.content.type === "int" || fieldB?.content.type === "int") {
        const numA = numericContentValue(fieldA?.content);
        const numB = numericContentValue(fieldB?.content);
        if (numA !== null && numB !== null) {
          const cmp = (numA - numB) * dir;
          if (cmp !== 0) {
            return cmp;
          }
          continue;
        }
        if (numA === null && numB !== null) {
          return 1;
        }
        if (numA !== null && numB === null) {
          return -1;
        }
        continue;
      }

      const valueA = getFieldValue(fieldA?.content);
      const valueB = getFieldValue(fieldB?.content);
      const cmp = valueA.localeCompare(valueB) * dir;

      if (cmp !== 0) {
        return cmp;
      }
    }

    return 0;
  });
};

// -- SQL Builders (for server-side filtering/sorting) --

/**
 * Extracts a text value from a JSONB field content column.
 * Covers text, single-select, date, int (via `value` key)
 * and file (via `fileName` key).
 */
const fieldValueExpr = (contentCol: typeof fields.content): SQL =>
  sql`COALESCE(${contentCol}->>'value', ${contentCol}->>'fileName', '')`;

/**
 * Builds an EXISTS subquery that checks whether an entity's
 * current version has a field matching the given condition.
 */
const buildPropertyFilterCondition = (
  filter: Extract<ViewFilterCondition, { field: "property" }>,
): SQL => {
  const valExpr = fieldValueExpr(fields.content);

  let opCondition: SQL;
  switch (filter.op) {
    case "eq":
      opCondition = sql`${valExpr} = ${String(filter.value ?? "")}`;
      break;
    case "neq":
      opCondition = sql`${valExpr} != ${String(filter.value ?? "")}`;
      break;
    case "contains":
      opCondition = sql`${valExpr} ILIKE ${`%${String(filter.value ?? "")}%`}`;
      break;
    case "is_empty":
      opCondition = sql`${valExpr} = ''`;
      break;
    default:
      opCondition = sql`TRUE`;
      break;
  }

  return sql`EXISTS (
    SELECT 1 FROM ${fields}
    WHERE ${fields.entityVersionId} = ${entities.currentVersionId}
      AND ${fields.propertyId} = ${filter.propertyId}
      AND ${opCondition}
  )`;
};

/**
 * Maps a builtin field name to its database column.
 */
const builtinColumn = (field: string) => {
  switch (field) {
    case "status":
      return entities.status;
    case "priority":
      return entities.priority;
    default:
      return null;
  }
};

const buildBuiltinFilterCondition = (
  filter: Extract<ViewFilterCondition, { field: "builtin" }>,
): SQL | null => {
  const col = builtinColumn(filter.builtinField);
  if (!col) {
    return null;
  }

  switch (filter.op) {
    case "eq":
      if (filter.value === undefined || filter.value === "") {
        return null;
      }
      return eq(col, String(filter.value));
    case "neq":
      if (filter.value === undefined || filter.value === "") {
        return null;
      }
      return or(ne(col, String(filter.value)), isNull(col)) ?? null;
    case "in": {
      const vals = (() => {
        if (Array.isArray(filter.value)) {
          return filter.value;
        }
        if (filter.value) {
          return [filter.value];
        }
        return [];
      })();
      if (vals.length === 0) {
        return null;
      }
      return inArray(col, vals);
    }
    case "is_empty":
      return sql`(${col} IS NULL OR ${col} = '')`;
    default:
      return null;
  }
};

/**
 * Converts ViewFilterCondition[] into SQL WHERE conditions
 * that can be combined with `and()`.
 */
export const buildFilterConditions = (
  filters: ViewFilterCondition[],
): SQL[] => {
  const conditions: SQL[] = [];

  for (const filter of filters) {
    if (filter.field === "kind") {
      if (filter.value.length > 0) {
        // "document" implies "folder" (folders are part of
        // the document hierarchy, not independently filterable)
        const expanded = filter.value.includes("document")
          ? [...new Set([...filter.value, "folder" as const])]
          : filter.value;
        conditions.push(inArray(entities.kind, expanded));
      }
    } else if (filter.field === "builtin") {
      const cond = buildBuiltinFilterCondition(filter);
      if (cond) {
        conditions.push(cond);
      }
    } else {
      conditions.push(buildPropertyFilterCondition(filter));
    }
  }

  return conditions;
};

// Internal property sort expressions (metadata columns).
const internalSortExpr = (
  propertyId: string,
  direction: boolean,
): SQL | null => {
  const dir = (col: SQL) => (direction ? sql`${col} DESC` : sql`${col} ASC`);
  switch (propertyId) {
    case "_name": {
      return dir(sql`${entities.displayName}`);
    }
    case "_created-by": {
      const sub = sql`(
        SELECT ${user.name} FROM ${user}
        WHERE ${user.id} = ${entities.createdBy}
      )`;
      return dir(sub);
    }
    case "_created-at":
      return direction
        ? sql`${entities.createdAt} DESC`
        : sql`${entities.createdAt} ASC`;
    case "_updated-at":
      return direction
        ? sql`${entities.updatedAt} DESC NULLS LAST`
        : sql`${entities.updatedAt} ASC NULLS FIRST`;
    case "_status":
      return direction
        ? sql`${entities.status} DESC NULLS LAST`
        : sql`${entities.status} ASC NULLS LAST`;
    case "_priority":
      return direction
        ? sql`${entities.priority} DESC NULLS LAST`
        : sql`${entities.priority} ASC NULLS LAST`;
    case "_due-date":
      return direction
        ? sql`${entities.dueDate} DESC NULLS LAST`
        : sql`${entities.dueDate} ASC NULLS LAST`;
    case "_version": {
      const sub = sql`(
        SELECT COUNT(*) FROM ${entityVersions}
        WHERE ${entityVersions.entityId} = ${entities.id}
      )`;
      return dir(sub);
    }
    case "_kind":
      return dir(sql`${entities.kind}`);
    default:
      return null;
  }
};

/**
 * Builds ORDER BY expressions from ViewSort[].
 *
 * For property-based sorts, generates a subquery that
 * extracts the sort key from the fields table.
 * Falls back to createdAt ASC when no sorts are provided.
 */
export const buildSortExpressions = (sorts: readonly ViewSort[]): SQL[] => {
  if (sorts.length === 0) {
    return [asc(entities.createdAt), asc(entities.id)];
  }

  const expressions: SQL[] = [];

  for (const sort of sorts) {
    const internal = internalSortExpr(sort.propertyId, sort.desc);
    if (internal) {
      expressions.push(internal);
      continue;
    }

    // Numeric sort key for int fields: `content->>'value'` is text, so a
    // plain ORDER BY sorts "10" before "9". Cast to numeric for int fields
    // (NULL otherwise, bucketed last via NULLS LAST), then break ties with
    // the text key so text properties still order correctly.
    const numericSortKey = sql`(
      SELECT CASE
        WHEN ${fields.content}->>'type' = 'int'
        THEN (${fields.content}->>'value')::numeric
        ELSE NULL
      END
      FROM ${fields}
      WHERE ${fields.workspaceId} = ${entities.workspaceId}
        AND ${fields.entityVersionId} = ${entities.currentVersionId}
        AND ${fields.propertyId} = ${sort.propertyId}
      LIMIT 1
    )`;
    const textSortKey = sql`(
      SELECT COALESCE(
        ${fields.content}->>'value',
        ${fields.content}->>'fileName',
        ''
      )
      FROM ${fields}
      WHERE ${fields.workspaceId} = ${entities.workspaceId}
        AND ${fields.entityVersionId} = ${entities.currentVersionId}
        AND ${fields.propertyId} = ${sort.propertyId}
      LIMIT 1
    )`;

    expressions.push(
      sort.desc
        ? sql`${numericSortKey} DESC NULLS LAST`
        : sql`${numericSortKey} ASC NULLS LAST`,
    );
    expressions.push(
      sort.desc ? sql`${textSortKey} DESC` : sql`${textSortKey} ASC`,
    );
  }

  // Tie-breaker for stable ordering
  expressions.push(asc(entities.id));

  return expressions;
};
