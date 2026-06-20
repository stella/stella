import { and, asc, eq, inArray, isNull, ne, not, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import {
  type CompareNode,
  type ConditionNode,
  type ConditionValue,
  type GroupNode,
  type Operand,
  type PredicateNode,
  type RefOperand,
  evaluateCondition,
} from "@stll/conditions";

import { user } from "@/api/db/auth-schema";
import { entities, entityVersions, fields, properties } from "@/api/db/schema";
import type { EntityKind, FieldContent } from "@/api/db/schema-validators";

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

const NUMERIC_TEXT_PATTERN =
  "^[+-]?(?:(?:[0-9]+(?:\\.[0-9]*)?)|(?:\\.[0-9]+))(?:[eE][+-]?[0-9]+)?$";
const NUMERIC_TEXT_RE = new RegExp(NUMERIC_TEXT_PATTERN, "u");

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
  const raw = getFieldValue(content).trim();
  if (raw === "" || !NUMERIC_TEXT_RE.test(raw)) {
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

// -- In-memory evaluation --

const PASS_THROUGH = Symbol("builtin-pass-through");

/**
 * Resolves an operand to a concrete value for in-memory evaluation.
 *
 * Builtin filters narrow only in SQL; the in-memory evaluator never
 * sees the underlying status/priority columns, so a builtin operand
 * resolves to a sentinel that callers treat as "matches". `kind` and
 * `property` resolve from the entity itself.
 */
const buildResolver =
  (entity: FilterableEntity) =>
  (operand: RefOperand): ConditionValue | typeof PASS_THROUGH => {
    switch (operand.type) {
      case "kind":
        return entity.kind;
      case "property":
        return getFieldValue(
          findField(entity.fields, operand.propertyId)?.content,
        );
      case "builtin":
        return PASS_THROUGH;
      case "path":
        return PASS_THROUGH;
      default:
        return PASS_THROUGH;
    }
  };

const referencesPassThroughOperand = (operand: Operand): boolean =>
  operand.type === "builtin" || operand.type === "path";

const nodeIsServerSideOnly = (node: ConditionNode): boolean => {
  switch (node.type) {
    case "group":
      return node.children.some(nodeIsServerSideOnly);
    case "compare":
      return (
        referencesPassThroughOperand(node.left) ||
        referencesPassThroughOperand(node.right)
      );
    case "predicate":
      return referencesPassThroughOperand(node.operand);
    default:
      return false;
  }
};

const isKindInPredicate = (node: ConditionNode): node is PredicateNode =>
  node.type === "predicate" && node.operand.type === "kind" && node.op === "in";

/**
 * Mirrors the SQL document→folder expansion in-memory: a kind filter
 * that includes "document" also matches folders.
 */
const expandKindNode = (node: ConditionNode): ConditionNode => {
  if (!isKindInPredicate(node)) {
    return node;
  }
  const values = asValueArray(node.value);
  if (!values.includes(KIND_DOCUMENT) || values.includes(KIND_FOLDER)) {
    return node;
  }
  return { ...node, value: [...values, KIND_FOLDER] };
};

/**
 * In-memory filtering preserves the established semantics: builtin
 * (and path) operands are server-side only, so any node referencing
 * them passes through here and is enforced by SQL instead.
 */
export const applyFilters = <T extends FilterableEntity>(
  items: T[],
  filters: ConditionNode[],
): T[] => {
  if (filters.length === 0) {
    return items;
  }

  const prepared = filters.map(expandKindNode);

  return items.filter((entity) => {
    const resolveOrPass = buildResolver(entity);
    const resolve = (operand: RefOperand): ConditionValue => {
      const resolved = resolveOrPass(operand);
      return resolved === PASS_THROUGH ? undefined : resolved;
    };

    return prepared.every((node) => {
      if (nodeIsServerSideOnly(node)) {
        return true;
      }
      return evaluateCondition(node, resolve);
    });
  });
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

const numericFieldValueExpr = (contentCol: typeof fields.content): SQL => {
  const valueExpr = fieldValueExpr(contentCol);
  const trimmed = sql`BTRIM(${valueExpr})`;

  return sql`CASE
    WHEN ${trimmed} ~ ${NUMERIC_TEXT_PATTERN}
    THEN ${trimmed}::numeric
    ELSE NULL
  END`;
};

/**
 * Wraps a per-field predicate in an EXISTS subquery against the
 * entity's current version.
 */
const propertyExists = (propertyId: string, opCondition: SQL): SQL =>
  sql`EXISTS (
    SELECT 1 FROM ${fields}
    WHERE ${fields.entityVersionId} = ${entities.currentVersionId}
      AND ${fields.propertyId} = ${propertyId}
      AND ${opCondition}
  )`;

const builtinColumn = (field: "status" | "priority") =>
  field === "status" ? entities.status : entities.priority;

const KIND_DOCUMENT = "document" as const;
const KIND_FOLDER = "folder" as const;

/**
 * "document" implies "folder": folders are part of the document
 * hierarchy, not independently filterable, so a kind filter that
 * includes documents also matches folders.
 */
const expandKindValues = (values: readonly string[]): EntityKind[] => {
  const kinds = values.filter((value): value is EntityKind =>
    isEntityKind(value),
  );
  if (kinds.includes(KIND_DOCUMENT)) {
    return [...new Set([...kinds, KIND_FOLDER])];
  }
  return kinds;
};

const ENTITY_KINDS: readonly EntityKind[] = [
  "document",
  "folder",
  "task",
  "message",
  "link",
];

const isEntityKind = (value: string): value is EntityKind =>
  (ENTITY_KINDS as readonly string[]).includes(value);

const asValueArray = (value: string | string[] | undefined): string[] => {
  if (Array.isArray(value)) {
    return value;
  }
  if (value === undefined || value === "") {
    return [];
  }
  return [value];
};

// -- Compare nodes --

// Safe numeric form of an arbitrary text expression: non-numeric content
// becomes NULL (and drops out of comparisons) instead of crashing the cast.
const safeNumericExpr = (expr: SQL): SQL =>
  sql`CASE WHEN BTRIM(${expr}::text) ~ ${NUMERIC_TEXT_PATTERN}
    THEN BTRIM(${expr}::text)::numeric ELSE NULL END`;

const orderedSql = (op: "gt" | "lt" | "gte" | "lte", l: SQL, r: SQL): SQL => {
  if (op === "gt") {
    return sql`${l} > ${r}`;
  }
  if (op === "lt") {
    return sql`${l} < ${r}`;
  }
  if (op === "gte") {
    return sql`${l} >= ${r}`;
  }
  return sql`${l} <= ${r}`;
};

const compareOpSql = (op: CompareNode["op"], expr: SQL, value: string): SQL => {
  if (op === "eq") {
    return sql`${expr} = ${value}`;
  }
  if (op === "neq") {
    return sql`${expr} != ${value}`;
  }
  // Ordered comparison: numeric when the literal is a number (non-numeric
  // field values become NULL and drop out); otherwise a plain text compare so
  // ISO dates and other strings order correctly, without a cast that would
  // crash on non-numeric input.
  if (NUMERIC_TEXT_RE.test(value.trim())) {
    return orderedSql(op, safeNumericExpr(expr), sql`${Number(value)}`);
  }
  // Exclude blank/absent values: '' would otherwise sort before every date and
  // leak rows with no value into "is before/on or before" filters.
  return sql`${expr} <> '' AND ${orderedSql(op, expr, sql`${value}`)}`;
};

const literalString = (operand: Operand): string | null =>
  operand.type === "literal" ? String(operand.value) : null;

const compileBuiltinCompare = (
  field: "status" | "priority",
  op: CompareNode["op"],
  value: string,
): SQL | null => {
  const col = builtinColumn(field);
  if (op === "eq") {
    return value === "" ? null : eq(col, value);
  }
  if (op === "neq") {
    return value === "" ? null : (or(ne(col, value), isNull(col)) ?? null);
  }
  return compareOpSql(op, sql`${col}`, value);
};

const compileCompare = (node: CompareNode): SQL | null => {
  // The filter UI always compares a ref operand against a literal.
  const value = literalString(node.right);
  if (value === null) {
    return null;
  }
  // An ordered comparison with an empty literal is an incomplete filter
  // (operator chosen, value not yet entered); drop it so an in-progress
  // "date is before …" doesn't match nearly every row.
  if (value === "" && node.op !== "eq" && node.op !== "neq") {
    return null;
  }
  if (node.left.type === "property") {
    return propertyExists(
      node.left.propertyId,
      compareOpSql(node.op, fieldValueExpr(fields.content), value),
    );
  }
  if (node.left.type === "builtin") {
    return compileBuiltinCompare(node.left.field, node.op, value);
  }
  return null;
};

// -- Predicate nodes --

/**
 * Builds an EXISTS predicate over a property's value, transparently handling
 * multi-select arrays (the value matches if ANY element does) and scalar
 * values. `elemMatch` receives the per-element/per-scalar text expression.
 */
const propertyValueMatches = (
  propertyId: string,
  arrayMatch: (valueExpr: SQL) => SQL,
  scalarMatch: (valueExpr: SQL) => SQL,
): SQL => {
  const content = fields.content;
  const anyElement = sql`EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(${content}->'value') AS elem
    WHERE ${arrayMatch(sql`elem`)}
  )`;
  return propertyExists(
    propertyId,
    sql`CASE WHEN jsonb_typeof(${content}->'value') = 'array'
      THEN ${anyElement}
      ELSE ${scalarMatch(fieldValueExpr(content))}
    END`,
  );
};

const compilePropertyPredicate = (
  propertyId: string,
  node: PredicateNode,
): SQL | null => {
  const text = String(node.value ?? "");
  // Same matcher for arrays and scalars (membership/emptiness ops).
  const same = (match: (v: SQL) => SQL) =>
    propertyValueMatches(propertyId, match, match);
  // `contains` differs by shape: exact (case-insensitive) option membership for
  // multi-select array elements, substring for scalar text — matching the
  // in-memory evaluator (so e.g. "NDA" does not match the option "Non-NDA").
  const contains = () =>
    propertyValueMatches(
      propertyId,
      (v) => sql`LOWER(${v}) = LOWER(${text})`,
      (v) => sql`${v} ILIKE ${`%${text}%`}`,
    );
  switch (node.op) {
    case "contains":
      return contains();
    case "not_contains":
      // NOT EXISTS so absent/empty fields count as "does not contain".
      return sql`NOT ${contains()}`;
    case "starts_with":
      return same((v) => sql`${v} ILIKE ${`${text}%`}`);
    case "ends_with":
      return same((v) => sql`${v} ILIKE ${`%${text}`}`);
    case "is_not_empty":
      return same((v) => sql`${v} <> ''`);
    case "is_empty":
      // Empty when no non-empty value exists: covers an absent field, an empty
      // scalar, and an empty array.
      return sql`NOT ${same((v) => sql`${v} <> ''`)}`;
    case "contains_all": {
      const wanted = asValueArray(node.value);
      if (wanted.length === 0) {
        return null;
      }
      const clauses = wanted.map((want) => same((v) => sql`${v} = ${want}`));
      return and(...clauses) ?? null;
    }
    case "in": {
      const values = asValueArray(node.value);
      if (values.length === 0) {
        return null;
      }
      return same((v) => sql`${v} = ANY(${values})`);
    }
    default:
      return null;
  }
};

const compileBuiltinPredicate = (
  field: "status" | "priority",
  node: PredicateNode,
): SQL | null => {
  const col = builtinColumn(field);
  switch (node.op) {
    case "in": {
      const values = asValueArray(node.value);
      if (values.length === 0) {
        return null;
      }
      return inArray(col, values);
    }
    case "is_empty":
      return sql`(${col} IS NULL OR ${col} = '')`;
    case "is_not_empty":
      return sql`(${col} IS NOT NULL AND ${col} <> '')`;
    default:
      return null;
  }
};

const compileKindPredicate = (node: PredicateNode): SQL | null => {
  if (node.op !== "in") {
    return null;
  }
  const expanded = expandKindValues(asValueArray(node.value));
  if (expanded.length === 0) {
    return null;
  }
  return inArray(entities.kind, expanded);
};

const compilePredicate = (node: PredicateNode): SQL | null => {
  switch (node.operand.type) {
    case "kind":
      return compileKindPredicate(node);
    case "property":
      return compilePropertyPredicate(node.operand.propertyId, node);
    case "builtin":
      return compileBuiltinPredicate(node.operand.field, node);
    default:
      return null;
  }
};

// -- Group nodes --

const compileGroup = (node: GroupNode): SQL | null => {
  const children: SQL[] = [];
  for (const child of node.children) {
    const compiled = compileNode(child);
    if (compiled) {
      children.push(compiled);
    }
  }
  if (children.length === 0) {
    return null;
  }

  const combined =
    node.combinator === "and" ? and(...children) : or(...children);
  if (!combined) {
    return null;
  }
  return node.negated ? not(combined) : combined;
};

const compileNode = (node: ConditionNode): SQL | null => {
  switch (node.type) {
    case "group":
      return compileGroup(node);
    case "compare":
      return compileCompare(node);
    case "predicate":
      return compilePredicate(node);
    default:
      return null;
  }
};

/**
 * Compiles the implicit-AND filter array into SQL WHERE conditions
 * that can be combined with `and()`. The array is an implicit AND
 * group, so each node compiles independently and `null` results
 * (no-op filters) are dropped.
 */
export const buildFilterConditions = (filters: ConditionNode[]): SQL[] => {
  const conditions: SQL[] = [];
  for (const node of filters) {
    const compiled = compileNode(node);
    if (compiled) {
      conditions.push(compiled);
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

    const propertyIsInt = sql`EXISTS (
      SELECT 1 FROM ${properties}
      WHERE ${properties.workspaceId} = ${entities.workspaceId}
        AND ${properties.id} = ${sort.propertyId}
        AND ${properties.content}->>'type' = 'int'
      LIMIT 1
    )`;

    // Numeric sort key: `content->>'value'` is text, so a plain ORDER BY sorts
    // "10" before "9". Use numeric mode for int fields and int properties
    // with legacy text content, then break ties with the text key.
    const numericSortKey = sql`(
      SELECT CASE
        WHEN ${fields.content}->>'type' = 'int' OR ${propertyIsInt}
        THEN ${numericFieldValueExpr(fields.content)}
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
