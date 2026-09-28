// Read the rows of an `execute(...)` result through `executedRows`.
//
// Drizzle's `execute` answers in the driver's shape: the server driver yields
// the rows directly, PGlite (the database tests) wraps them in `{ rows }`. A
// reader that tests the shape itself handles one driver and answers "no rows"
// for the other, so a query verified under one reads nothing under the other.
// `executedRows` (`@/api/lib/db/executed-rows`) reads both and panics on any
// third shape instead of answering `[]`.
//
// Reported, where `result` is an `execute` result:
//   Array.isArray(result)
//   result.rows / result["rows"] / Reflect.get(result, "rows")
//   "rows" in result / const { rows } = result
// and, for a value of any provenance, a `rows` read of a binding that is also
// tested with `Array.isArray`: a hand-written copy of the owner, e.g.
//   const rowsOf = (result: unknown) =>
//     Array.isArray(result) ? result : isRecord(result) ? result["rows"] : [];
//
// A value is an `execute` result by visible provenance: a one-argument
// `<receiver>.execute(query)` (Drizzle's signature) whose query is a `sql`
// template or `sql.*(...)` call, directly or through a stable binding, or
// whose receiver is named as a database handle (`db`, `tx`, `rootDb`,
// `this.db`, `getDb()`); a tool's `execute(input)` is neither. Provenance
// follows `await`, type assertions, a `const` (or never-reassigned `let`)
// bound to one, and the `.value` of a `Result.tryPromise` / `Result.try` whose
// callback returns one. Bindings are resolved through scope analysis, so a
// shadowing name does not inherit provenance.
//
// Accepted:
//   executedRows(await tx.execute(query)).at(0)
//   Array.isArray(table["rows"])   // a rows field, never tested as an array
//
// Known blind spots: a result read inside a `.then` callback, and one handed
// to a helper under another name that reads it as an array only
// (`Array.isArray(value) ? value : []`, `value.at(0)`) with no `rows` read.
// From the helper alone that is indistinguishable from reading a raw Bun SQL
// result, which is always an array. The owner module is excluded in
// `oxlint.config.ts`.

import { eslintCompatPlugin } from "@oxlint/plugins";
import type { Ranged, Variable } from "@oxlint/plugins";

import {
  type AstNode,
  getPropertyName,
  isAstNode,
  isIdentifier,
  isIdentifierReference,
  isMemberAccess,
  isStringLiteral,
  memberPropertyName,
  resolveVariable,
  returnArguments,
  stableInitializer,
  unwrapExpression,
} from "./utils.ts";

const ROWS = "rows";
const SQL = "sql";

const DATABASE_HANDLE_NAME =
  /^(?:db|tx|trx|database|transaction|savepoint)$|(?:Db|Tx|Trx|Database|Transaction)$/;

// The name a receiver is known by: `db`, `this.db`, `getDb()`.
const receiverName = (node: unknown): string | null => {
  const receiver = unwrapExpression(node);
  if (receiver === null) {
    return null;
  }
  switch (receiver.type) {
    case "Identifier":
      return getPropertyName(receiver);
    case "MemberExpression":
      return memberPropertyName(receiver);
    case "CallExpression":
      return receiverName(receiver.callee);
    case "AwaitExpression":
      return receiverName(receiver.argument);
    default:
      return null;
  }
};

const isDatabaseHandle = (node: unknown): boolean => {
  const name = receiverName(node);
  return name !== null && DATABASE_HANDLE_NAME.test(name);
};

// A `sql` template (`sql<T>` too) or a `sql.raw(...)` / `sql.join(...)` call.
const isSqlBuilder = (node: AstNode): boolean => {
  if (node.type === "TaggedTemplateExpression") {
    return isIdentifier(unwrapExpression(node.tag), SQL);
  }
  const callee = node.type === "CallExpression" ? node.callee : null;
  return (
    isAstNode(callee) &&
    callee.type === "MemberExpression" &&
    isIdentifier(callee.object, SQL)
  );
};

// The single argument of an `Array.isArray(x)` call, or null for any other
// node.
const arrayTestArgument = (node: unknown): unknown => {
  if (
    !isAstNode(node) ||
    node.type !== "CallExpression" ||
    !isMemberAccess(node.callee, "Array", "isArray") ||
    !Array.isArray(node.arguments) ||
    node.arguments.length !== 1
  ) {
    return null;
  }
  return node.arguments.at(0);
};

const isResultWrapperCall = (node: AstNode): boolean =>
  isMemberAccess(node.callee, "Result", "tryPromise") ||
  isMemberAccess(node.callee, "Result", "try");

// The callback a `Result.tryPromise(fn)` or `Result.tryPromise({ try: fn })`
// runs.
const wrappedCallback = (call: AstNode): AstNode | null => {
  const argument = unwrapExpression(
    Array.isArray(call.arguments) ? call.arguments.at(0) : null,
  );
  if (argument?.type !== "ObjectExpression") {
    return argument;
  }
  const properties = Array.isArray(argument.properties)
    ? argument.properties
    : [];
  for (const property of properties) {
    if (
      isAstNode(property) &&
      property.type === "Property" &&
      getPropertyName(property.key) === "try"
    ) {
      return unwrapExpression(property.value);
    }
  }
  return null;
};

const FUNCTION_TYPES: ReadonlySet<string> = new Set([
  "ArrowFunctionExpression",
  "FunctionExpression",
]);

// What a callback evaluates to: an arrow's expression body, or every `return`.
const callbackResults = (callback: AstNode | null): AstNode[] => {
  if (callback === null || !FUNCTION_TYPES.has(callback.type)) {
    return [];
  }
  const body = unwrapExpression(callback.body);
  if (body === null) {
    return [];
  }
  return body.type === "BlockStatement" ? returnArguments(body) : [body];
};

// Whether some reference to the binding is the argument of `Array.isArray`.
const isTestedAsArray = (variable: Variable): boolean =>
  variable.references.some((reference) => {
    const identifier: unknown = reference.identifier;
    if (!isAstNode(identifier)) {
      return false;
    }
    // Climb through `(x)`, `x as T`, `x!` to the expression the call sees.
    let current: AstNode = identifier;
    let parent: unknown = current.parent;
    while (isAstNode(parent) && unwrapExpression(parent) !== parent) {
      current = parent;
      parent = current.parent;
    }
    return arrayTestArgument(parent) === current;
  });

export default eslintCompatPlugin({
  meta: { name: "no-hand-rolled-execute-rows" },
  rules: {
    "no-hand-rolled-execute-rows": {
      meta: {
        type: "problem",
        messages: {
          executeShape:
            "Testing an execute() result's shape by hand reads one driver " +
            "only. Read its rows with executedRows " +
            "(@/api/lib/db/executed-rows).",
          shapeSniff:
            "This tests for both an array and a `rows` key: a hand-written " +
            "copy of executedRows. Read execute() rows with executedRows " +
            "(@/api/lib/db/executed-rows).",
        },
      },
      createOnce(context) {
        const resolvedInitializer = (node: AstNode): AstNode | null => {
          if (!isIdentifierReference(node)) {
            return null;
          }
          const variable = resolveVariable(context, node);
          return variable === null ? null : stableInitializer(variable);
        };

        const isSqlQuery = (node: unknown, visited: Set<unknown>): boolean => {
          const current = unwrapExpression(node);
          if (current === null || visited.has(current)) {
            return false;
          }
          visited.add(current);
          if (isSqlBuilder(current)) {
            return true;
          }
          const initializer = resolvedInitializer(current);
          return initializer !== null && isSqlQuery(initializer, visited);
        };

        const isExecuteCall = (node: AstNode): boolean => {
          const callee = unwrapExpression(node.callee);
          if (
            callee?.type !== "MemberExpression" ||
            memberPropertyName(callee) !== "execute" ||
            !Array.isArray(node.arguments) ||
            node.arguments.length !== 1
          ) {
            return false;
          }
          return (
            isDatabaseHandle(callee.object) ||
            isSqlQuery(node.arguments.at(0), new Set())
          );
        };

        // A `Result` whose success value is an execute result.
        const isWrappedExecute = (
          node: unknown,
          visited: Set<unknown>,
        ): boolean => {
          let current = unwrapExpression(node);
          if (current?.type === "AwaitExpression") {
            current = unwrapExpression(current.argument);
          }
          if (current === null || visited.has(current)) {
            return false;
          }
          visited.add(current);
          if (current.type === "CallExpression") {
            if (!isResultWrapperCall(current)) {
              return false;
            }
            const results = callbackResults(wrappedCallback(current));
            return (
              results.length > 0 &&
              results.every((result) => isExecuteResult(result, visited))
            );
          }
          const initializer = resolvedInitializer(current);
          return initializer !== null && isWrappedExecute(initializer, visited);
        };

        const isExecuteResult = (
          node: unknown,
          visited: Set<unknown>,
        ): boolean => {
          const current = unwrapExpression(node);
          if (current === null || visited.has(current)) {
            return false;
          }
          visited.add(current);
          if (current.type === "AwaitExpression") {
            return isExecuteResult(current.argument, visited);
          }
          if (current.type === "CallExpression") {
            return isExecuteCall(current);
          }
          if (current.type === "MemberExpression") {
            return (
              memberPropertyName(current) === "value" &&
              isWrappedExecute(current.object, visited)
            );
          }
          const initializer = resolvedInitializer(current);
          return initializer !== null && isExecuteResult(initializer, visited);
        };

        const executeResult = (node: unknown): boolean =>
          isExecuteResult(node, new Set());

        // A `rows` read of `target`, reported by what `target` is.
        const checkRowsRead = (node: Ranged, target: unknown): void => {
          if (executeResult(target)) {
            context.report({ node, messageId: "executeShape" });
            return;
          }
          const binding = unwrapExpression(target);
          if (binding === null || !isIdentifierReference(binding)) {
            return;
          }
          const variable = resolveVariable(context, binding);
          if (variable !== null && isTestedAsArray(variable)) {
            context.report({ node, messageId: "shapeSniff" });
          }
        };

        return {
          CallExpression(node) {
            const tested = arrayTestArgument(node);
            if (tested !== null) {
              if (executeResult(tested)) {
                context.report({ node, messageId: "executeShape" });
              }
              return;
            }
            const [target, key] = node.arguments;
            if (
              isMemberAccess(node.callee, "Reflect", "get") &&
              isStringLiteral(key) &&
              key.value === ROWS
            ) {
              checkRowsRead(node, target);
            }
          },
          MemberExpression(node) {
            if (isAstNode(node) && memberPropertyName(node) === ROWS) {
              checkRowsRead(node, node.object);
            }
          },
          BinaryExpression(node) {
            if (
              node.operator === "in" &&
              isStringLiteral(node.left) &&
              node.left.value === ROWS
            ) {
              checkRowsRead(node, node.right);
            }
          },
          VariableDeclarator(node) {
            if (node.id.type !== "ObjectPattern") {
              return;
            }
            const readsRows = node.id.properties.some(
              (property) =>
                property.type === "Property" &&
                getPropertyName(property.key) === ROWS,
            );
            if (readsRows) {
              checkRowsRead(node, node.init);
            }
          },
        };
      },
    },
  },
});
