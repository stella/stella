// Ban computed-key assignment onto an object literal binding.
//
// `record[key] = value` is a [[Set]]: when `key` is `"__proto__"` it calls
// the inherited prototype setter instead of creating an own property, so the
// entry vanishes (and an object value becomes the record's prototype). A
// record rebuilt that way from client, model, provider or parsed-JSON keys
// silently loses data, and two inputs that differ only in that key compare
// equal afterwards. Reading back through the same binding (`record[key] ??=`,
// `record[key] = (record[key] ?? 0) + 1`) also sees inherited members such as
// `constructor`.
//
// `Object.fromEntries` defines own properties (CreateDataProperty), so it
// keeps `__proto__`, `constructor` and `prototype` as plain data; a `Map` keeps
// any key without touching a prototype. Build records with one of those.
//
// Detection: an assignment (any operator) whose target is `name[expr]`, where
// `expr` is not a string, number or zero-expression template literal and
// `name` resolves to a variable declared with an object literal initializer
// (wrappers such as `as`/`satisfies` peeled). Parameters, call results and
// `Object.create(null)` records are out of scope: a null-prototype object has
// no setter to hit.
//
// Flagged:
//   const out: Record<string, unknown> = {};
//   for (const [key, value] of Object.entries(input)) out[key] = value;
//   const counts: Record<string, number> = {};
//   counts[name] = (counts[name] ?? 0) + 1;
//
// Allowed:
//   const out = Object.fromEntries(Object.entries(input));
//   const counts = new Map<string, number>();
//   const fixed: Record<string, unknown> = {};
//   fixed["status-code"] = value;

import { eslintCompatPlugin } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

import {
  isAstNode,
  isIdentifierReference,
  resolveVariable,
  type ScopeContext,
  unwrapExpression,
} from "./utils.ts";

const isStaticKey = (node: unknown): boolean => {
  if (!isAstNode(node)) {
    return false;
  }
  if (node.type === "Literal") {
    return typeof node.value === "string" || typeof node.value === "number";
  }
  return (
    node.type === "TemplateLiteral" &&
    Array.isArray(node.expressions) &&
    node.expressions.length === 0
  );
};

const isObjectLiteralBinding = (
  context: ScopeContext,
  identifier: ESTree.IdentifierReference,
): boolean => {
  const variable = resolveVariable(context, identifier);
  if (variable === null) {
    return false;
  }
  return variable.defs.some(
    (definition) =>
      definition.type === "Variable" &&
      isAstNode(definition.node) &&
      definition.node.type === "VariableDeclarator" &&
      unwrapExpression(definition.node.init)?.type === "ObjectExpression",
  );
};

export default eslintCompatPlugin({
  meta: { name: "no-computed-key-record-assignment" },
  rules: {
    "no-computed-key-record-assignment": {
      meta: {
        type: "problem",
        messages: {
          computedKeyAssignment:
            "Computed-key assignment onto an object literal goes through the " +
            "prototype setter for `__proto__` and drops that entry. Build the " +
            "record with `Object.fromEntries(...)`, or key it with a `Map`.",
        },
      },
      createOnce(context) {
        return {
          AssignmentExpression(node) {
            const target = node.left;
            if (
              target.type !== "MemberExpression" ||
              !target.computed ||
              isStaticKey(target.property)
            ) {
              return;
            }
            const object = target.object;
            if (
              !isIdentifierReference(object) ||
              !isObjectLiteralBinding(context, object)
            ) {
              return;
            }
            context.report({
              node: target,
              messageId: "computedKeyAssignment",
            });
          },
        };
      },
    },
  },
});
