import { asc, inArray, sql, type SQL } from "drizzle-orm";

import { user } from "@/api/db/auth-schema";
import { entities, entityVersions, fields } from "@/api/db/schema";
import type { EntityKind, FieldContent } from "@/api/db/schema-validators";
import type { ViewFilterCondition } from "@/api/handlers/registry/actors/views/schema";

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
    default:
      return "";
  }
};

const findField = (
  fields: EntityField[],
  propertyId: string,
): EntityField | undefined => fields.find((f) => f.propertyId === propertyId);

const matchesFilter = <T extends FilterableEntity>(
  entity: T,
  filter: ViewFilterCondition,
): boolean => {
  if (filter.field === "kind") {
    return filter.value.includes(entity.kind);
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
  entities: T[],
  filters: ViewFilterCondition[],
): T[] => {
  if (filters.length === 0) {
    return entities;
  }

  return entities.filter((entity) =>
    filters.every((filter) => matchesFilter(entity, filter)),
  );
};

export const applySorts = <T extends FilterableEntity>(
  entities: T[],
  sorts: ViewSort[],
): T[] => {
  if (sorts.length === 0) {
    return entities;
  }

  return [...entities].sort((a, b) => {
    for (const sort of sorts) {
      const fieldA = findField(a.fields, sort.propertyId);
      const fieldB = findField(b.fields, sort.propertyId);
      const dir = sort.desc ? -1 : 1;

      if (fieldA?.content.type === "int" && fieldB?.content.type === "int") {
        const cmp = (fieldA.content.value - fieldB.content.value) * dir;
        if (cmp !== 0) {
          return cmp;
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
 * Converts ViewFilterCondition[] into SQL WHERE conditions
 * that can be combined with `and()`.
 */
export const buildFilterConditions = (
  filters: ViewFilterCondition[],
): SQL[] => {
  const conditions: SQL[] = [];

  for (const filter of filters) {
    if (filter.field === "kind") {
      conditions.push(inArray(entities.kind, filter.value));
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
    case "_created-by": {
      const sub = sql`(
        SELECT ${user.name} FROM ${user}
        WHERE ${user.id} = ${entities.createdBy}
      )`;
      return dir(sub);
    }
    case "_updated-at":
      return direction
        ? sql`${entities.updatedAt} DESC NULLS LAST`
        : sql`${entities.updatedAt} ASC NULLS FIRST`;
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
export const buildSortExpressions = (sorts: ViewSort[]): SQL[] => {
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

    const sortKeySubquery = sql`(
      SELECT COALESCE(
        ${fields.content}->>'value',
        ${fields.content}->>'fileName',
        ''
      )
      FROM ${fields}
      WHERE ${fields.entityVersionId} = ${entities.currentVersionId}
        AND ${fields.propertyId} = ${sort.propertyId}
      LIMIT 1
    )`;

    expressions.push(
      sort.desc ? sql`${sortKeySubquery} DESC` : sql`${sortKeySubquery} ASC`,
    );
  }

  // Tie-breaker for stable ordering
  expressions.push(asc(entities.id));

  return expressions;
};
