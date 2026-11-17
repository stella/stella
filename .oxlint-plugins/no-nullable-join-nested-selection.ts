// Reject a nested object in a Drizzle selection whose columns come from a
// table the same query joins as nullable (left, right or full join), unless
// the object carries that join's key.
//
// Drizzle maps every top-level nested object of a joined selection through a
// null check: when all of the object's columns belong to one nullable side of
// the join and the FIRST of them reads back NULL, the whole object becomes
// `null` (a later non-NULL column of the same table does not undo that). That
// is right only when the first column can never be NULL on a matched row.
// Otherwise a matched row whose first value happens to be NULL reads back
// exactly like no matched row: `source: { descriptor }` over a left-joined
// source whose descriptor is NULL becomes `source: null`, and the caller treats
// a real source as a missing one. An object that also reads another table's
// column is never nullified.
//
// A column the left join's own condition matches with `eq` or tests with
// `isNotNull` (directly or under `and`, as imported from drizzle-orm) is never
// NULL on a matched row, so a nested object that selects it FIRST reads back
// null exactly when no row matched. Anything else is selected flat with the
// join key, and the object is built after the read keyed on it:
//
//   .select({ sourceId: sources.id, sourceDescriptor: sources.descriptor })
//   ...
//   source: row.sourceId === null ? null : { descriptor: row.sourceDescriptor }
//
// Reported, in `select`, `selectDistinct` and `selectDistinctOn` selections
// (inline or through a never-reassigned `const`), on a fluent chain that
// `leftJoin`s / `leftJoinLateral`s / `fullJoin`s the table, or `rightJoin`s
// another table after it:
//
//   db.select({ source: { descriptor: sources.descriptor } })
//     .from(decisions)
//     .leftJoin(sources, eq(sources.id, decisions.sourceId))
//
// Accepted: a nested object whose first column is its left-joined table's
// join key (`source: { id: sources.id, descriptor: sources.descriptor }`
// above), a nested object reading columns of more than one table,
// nested objects over the base table or inner-joined tables (they are never
// nullified), flat columns from a nullable table, and nested objects more than
// one level deep (Drizzle nullifies only the top level). Right and full joins
// get no key exemption: their nullable side is matched by another table's
// condition, so only flat columns are accepted there.
//
// Tables are matched by the expression naming them (`sources`, `schema.x`, an
// `alias(...)` bound to a const), so the join argument and the column's table
// must be spelled alike. Nested objects are read inline or through a
// never-reassigned const binding (its properties reassigned later are not
// followed), and one holding a spread is skipped. Builders split across statements (`$dynamic()`,
// a stored query extended later), join conditions held in variables, and
// nested objects assembled by spreading other objects or by helper calls such
// as `getTableColumns(...)` are outside this syntactic check.

import { eslintCompatPlugin } from "@oxlint/plugins";
import type { Ranged } from "@oxlint/plugins";

import { guardEnforcesLine } from "../scripts/guard-rollouts.ts";
import {
  type AstNode,
  type FilenameContext,
  filenameForContext,
  getPropertyName,
  isAstNode,
  isIdentifierReference,
  resolveImport,
  resolveVariable,
  type ScopeContext,
  stableInitializer,
  unwrapExpression,
} from "./utils.ts";

const GUARD = "no-nullable-join-nested-selection";

type RuleContext = ScopeContext & FilenameContext;

const SELECTION_ARGUMENT_INDEX: Readonly<Record<string, number>> = {
  select: 0,
  selectDistinct: 0,
  selectDistinctOn: 1,
};

type JoinNullability = "nullable" | "required" | "nullable-before";

const JOIN_KIND: Readonly<Record<string, JoinNullability>> = {
  leftJoin: "nullable",
  leftJoinLateral: "nullable",
  // Every table before a right join may be unmatched; the joined one may not.
  rightJoin: "nullable-before",
  innerJoin: "required",
  innerJoinLateral: "required",
  crossJoin: "required",
  crossJoinLateral: "required",
};

// A dotted name for `table`, `schema.table`, `this.table`; null otherwise.
const tableKey = (node: unknown): string | null => {
  const expression = unwrapExpression(node);
  if (expression === null) {
    return null;
  }
  if (expression.type === "Identifier") {
    return getPropertyName(expression);
  }
  if (expression.type === "ThisExpression") {
    return "this";
  }
  if (expression.type === "MemberExpression" && expression.computed !== true) {
    const object = tableKey(expression.object);
    const property = getPropertyName(expression.property);
    return object === null || property === null
      ? null
      : `${object}.${property}`;
  }
  return null;
};

type ChainCall = {
  method: string;
  arguments: readonly unknown[];
  node: AstNode;
};

// The calls chained onto `call`: `.from(x).leftJoin(y, on).where(...)`.
const chainedCalls = (call: unknown): ChainCall[] => {
  const calls: ChainCall[] = [];
  if (!isAstNode(call)) {
    return calls;
  }
  let current: AstNode = call;
  for (;;) {
    let member = current.parent;
    // `(await? no) builder!.from(...)`: only value-preserving wrappers.
    while (
      isAstNode(member) &&
      (member.type === "TSNonNullExpression" ||
        member.type === "ParenthesizedExpression")
    ) {
      member = member.parent;
    }
    if (
      !isAstNode(member) ||
      member.type !== "MemberExpression" ||
      member.computed === true
    ) {
      return calls;
    }
    const next = member.parent;
    const method = getPropertyName(member.property);
    if (
      !isAstNode(next) ||
      next.type !== "CallExpression" ||
      next.callee !== member ||
      method === null
    ) {
      return calls;
    }
    calls.push({
      method,
      arguments: Array.isArray(next.arguments) ? next.arguments : [],
      node: next,
    });
    current = next;
  }
};

type JoinedTable = {
  key: string;
  nullable: boolean;
  via: string;
  /** Columns the table's own left-join condition matches with `eq`. */
  joinKeys: ReadonlySet<string>;
};

const DRIZZLE_MODULE = /^drizzle-orm(?:\/|$)/u;

// The drizzle-orm helper a call invokes, through its import binding
// (`import { eq as equals }`, `import * as d` with `d.eq`). A helper not
// imported from drizzle-orm proves nothing: a local `eq` may compare with
// `IS NOT DISTINCT FROM`, which matches two NULLs.
const calleeName = (context: RuleContext, node: unknown): string | null => {
  const expression = unwrapExpression(node);
  if (expression?.type !== "CallExpression") {
    return null;
  }
  const callee = unwrapExpression(expression.callee);
  if (callee === null) {
    return null;
  }
  const resolved = resolveImport(context, callee);
  return resolved !== null && DRIZZLE_MODULE.test(resolved.moduleId)
    ? resolved.imported
    : null;
};

// Columns of `table` that `condition` proves non-NULL on a matched row: an
// `eq` operand or an `isNotNull` argument, through `and(...)` only. Under `or`
// or any other operator the column may still be NULL on a match.
const equalityKeys = (
  context: RuleContext,
  condition: unknown,
  table: string,
): Set<string> => {
  const keys = new Set<string>();
  const visit = (node: unknown): void => {
    const expression = unwrapExpression(node);
    if (expression?.type !== "CallExpression") {
      return;
    }
    const args = Array.isArray(expression.arguments)
      ? expression.arguments
      : [];
    const name = calleeName(context, expression);
    if (name === "and") {
      for (const argument of args) {
        visit(argument);
      }
      return;
    }
    if (name !== "eq" && name !== "isNotNull") {
      return;
    }
    for (const side of name === "eq" ? args : args.slice(0, 1)) {
      const column = unwrapExpression(side);
      if (
        column?.type === "MemberExpression" &&
        column.computed !== true &&
        tableKey(column.object) === table
      ) {
        const property = getPropertyName(column.property);
        if (property !== null) {
          keys.add(property);
        }
      }
    }
  };
  visit(condition);
  return keys;
};

const NO_KEYS: ReadonlySet<string> = new Set();

// The tables the chain reads, in order, with whether each may be unmatched.
const joinedTables = (
  context: RuleContext,
  calls: readonly ChainCall[],
): JoinedTable[] => {
  const tables: JoinedTable[] = [];
  for (const { method, arguments: args } of calls) {
    const key = tableKey(args.at(0));
    if (method === "from") {
      if (key !== null) {
        tables.push({ key, nullable: false, via: "from", joinKeys: NO_KEYS });
      }
      continue;
    }
    if (method === "fullJoin") {
      for (const table of tables) {
        if (!table.nullable) {
          table.nullable = true;
          table.via = method;
        }
      }
      if (key !== null) {
        tables.push({ key, nullable: true, via: method, joinKeys: NO_KEYS });
      }
      continue;
    }
    const kind = JOIN_KIND[method];
    if (kind === undefined) {
      continue;
    }
    if (kind === "nullable-before") {
      for (const table of tables) {
        if (!table.nullable) {
          table.nullable = true;
          table.via = method;
        }
      }
    }
    if (key !== null) {
      tables.push({
        key,
        nullable: kind === "nullable",
        via: method,
        joinKeys:
          kind === "nullable"
            ? equalityKeys(context, args.at(1), key)
            : NO_KEYS,
      });
    }
  }
  return tables;
};

// The selection object literal: inline, or a never-reassigned const.
const selectionObject = (
  context: Parameters<typeof resolveVariable>[0],
  node: unknown,
): AstNode | null => {
  const expression = unwrapExpression(node);
  if (expression === null) {
    return null;
  }
  if (expression.type === "ObjectExpression") {
    return expression;
  }
  if (!isIdentifierReference(expression)) {
    return null;
  }
  const variable = resolveVariable(context, expression);
  const initializer =
    variable === null ? null : unwrapExpression(stableInitializer(variable));
  return initializer?.type === "ObjectExpression" ? initializer : null;
};

const propertiesOf = (object: AstNode): AstNode[] =>
  Array.isArray(object.properties)
    ? object.properties.filter(
        (property): property is AstNode =>
          isAstNode(property) && property.type === "Property",
      )
    : [];

// The nullable table a nested object is nullified by without its join key:
// Drizzle nullifies an object whose columns all come from one nullable table
// when the first of them is NULL, so that first column must be a join key.
const nullableColumnTable = (
  nested: AstNode,
  nullable: ReadonlyMap<string, JoinedTable>,
): JoinedTable | null => {
  // A spread may supply the first column, which this check cannot see.
  if (
    Array.isArray(nested.properties) &&
    nested.properties.some(
      (property) => isAstNode(property) && property.type !== "Property",
    )
  ) {
    return null;
  }
  const columns: { table: string; column: string }[] = [];
  for (const property of propertiesOf(nested)) {
    const value = unwrapExpression(property.value);
    if (value?.type !== "MemberExpression" || value.computed === true) {
      continue;
    }
    const table = tableKey(value.object);
    const column = getPropertyName(value.property);
    if (table === null || column === null) {
      return null;
    }
    columns.push({ table, column });
  }
  const first = columns.at(0);
  if (
    first === undefined ||
    columns.some(({ table }) => table !== first.table)
  ) {
    return null;
  }
  const table = nullable.get(first.table);
  return table === undefined || table.joinKeys.has(first.column) ? null : table;
};

export const createNullableJoinNestedSelectionPlugin = (
  enforcesLine = guardEnforcesLine,
) =>
  eslintCompatPlugin({
    meta: { name: "no-nullable-join-nested-selection" },
    rules: {
      "no-nullable-join-nested-selection": {
        meta: {
          type: "problem",
          messages: {
            nestedOverNullableJoin:
              "`{{field}}` nests columns of `{{table}}`, which this query reaches through `{{join}}`, without its join key first. Drizzle reads a nested object over a nullable join back as `null` whenever its first column is NULL, so a matched `{{table}}` row whose first selected column is NULL looks like no row at all. Select the columns flat together with the join key (e.g. `{{field}}Id: {{table}}.id`) and build `{{field}}` after the read, `row.{{field}}Id === null ? null : { ... }`; under a left join, selecting a column the join's own `eq` matches as the object's first column also works.",
          },
        },
        createOnce(context) {
          const enforces = (node: Ranged): boolean => {
            const start = context.sourceCode.getLocFromIndex(
              node.range[0],
            ).line;
            const end = context.sourceCode.getLocFromIndex(
              node.range[1] - 1,
            ).line;
            for (let line = start; line <= end; line++) {
              if (
                enforcesLine({
                  guard: GUARD,
                  file: filenameForContext(context),
                  line,
                })
              ) {
                return true;
              }
            }
            return false;
          };
          return {
            CallExpression(node) {
              const callee = unwrapExpression(node.callee);
              if (
                callee?.type !== "MemberExpression" ||
                callee.computed === true
              ) {
                return;
              }
              const method = getPropertyName(callee.property);
              const index =
                method === null ? undefined : SELECTION_ARGUMENT_INDEX[method];
              if (index === undefined) {
                return;
              }
              const calls = chainedCalls(node);
              // The whole statement: a change to its joins or its select call
              // re-checks a const selection whose own lines did not change.
              const statement = calls.at(-1)?.node ?? node;
              const nullable = new Map(
                joinedTables(context, calls)
                  .filter((table) => table.nullable)
                  .map((table) => [table.key, table] as const),
              );
              if (nullable.size === 0) {
                return;
              }
              const selection = selectionObject(
                context,
                node.arguments.at(index),
              );
              if (selection === null) {
                return;
              }
              for (const property of propertiesOf(selection)) {
                const value = selectionObject(context, property.value);
                if (value === null) {
                  continue;
                }
                const table = nullableColumnTable(value, nullable);
                if (
                  table === null ||
                  (!enforces(property) && !enforces(statement))
                ) {
                  continue;
                }
                context.report({
                  node: property,
                  messageId: "nestedOverNullableJoin",
                  data: {
                    field: getPropertyName(property.key) ?? "nested",
                    table: table.key,
                    join: table.via,
                  },
                });
              }
            },
          };
        },
      },
    },
  });

export default createNullableJoinNestedSelectionPlugin();
