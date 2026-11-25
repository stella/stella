// Pass-through identity wrappers (`const defineFoo = (x: T): T => x`) add no
// runtime validation, transformation, or ownership boundary, and are often used
// to obscure declarations from syntactic lint rules. Prefer `as const`,
// `satisfies`, or a real boundary instead (AGENTS.md).
//
// Flagged: a synchronous 1-parameter function whose body simply returns its
// parameter unchanged, when called directly in the same file.
//   const defineTable = <const T extends Record<string, string>>(x: T): T => x;
//   export const TABLE = defineTable({ a: "1" }); // flagged
//
// Accepted:
//   - Identity callbacks passed by reference without direct calls
//     (`items.map(identity)`, `{ normalize: asWritten }`).
//   - Functions that transform, validate, or wrap their input.
//   - Async, generator, multi-parameter, default, rest, or destructured params.

import { eslintCompatPlugin } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

import { guardEnforcesLine } from "../scripts/guard-rollouts.ts";
import {
  filenameForContext,
  isAstNode,
  isIdentifier,
  isIdentifierReference,
  unwrapExpression,
} from "./utils.ts";

const RULE_NAME = "no-identity-wrapper";

const singleReturnedExpression = (body: unknown): unknown => {
  if (!isAstNode(body)) {
    return null;
  }
  if (body.type !== "BlockStatement") {
    return body;
  }
  if (!Array.isArray(body.body) || body.body.length !== 1) {
    return null;
  }
  const stmt = body.body.at(0);
  return isAstNode(stmt) && stmt.type === "ReturnStatement"
    ? stmt.argument
    : null;
};

const isIdentityFunction = (fn: unknown): boolean => {
  if (
    !isAstNode(fn) ||
    (fn.type !== "ArrowFunctionExpression" &&
      fn.type !== "FunctionExpression" &&
      fn.type !== "FunctionDeclaration") ||
    fn.async === true ||
    fn.generator === true ||
    !Array.isArray(fn.params) ||
    fn.params.length !== 1
  ) {
    return false;
  }
  const param = fn.params.at(0);
  if (!isIdentifierReference(param)) {
    return false;
  }
  const returned = singleReturnedExpression(fn.body);
  return isAstNode(returned) && isIdentifier(returned, param.name);
};

const isDirectCallCallee = (identifier: unknown): boolean => {
  if (!isAstNode(identifier)) {
    return false;
  }
  const parent = identifier.parent;
  return (
    isAstNode(parent) &&
    parent.type === "CallExpression" &&
    parent.callee === identifier
  );
};

export default eslintCompatPlugin({
  meta: { name: "no-identity-wrapper" },
  rules: {
    "no-identity-wrapper": {
      meta: {
        type: "problem",
        messages: {
          identityWrapper:
            "`{{name}}` returns its single parameter unchanged and is called directly. Remove the pass-through wrapper and use `as const`, `satisfies`, or a real boundary instead.",
        },
        schema: [],
      },
      createOnce(context) {
        const checkBinding = (
          node: ESTree.VariableDeclarator | ESTree.FunctionDeclaration,
          name: string,
        ) => {
          const variables = context.sourceCode.getDeclaredVariables(node);
          const calledDirectly = variables.some((variable) =>
            variable.references.some((reference) =>
              isDirectCallCallee(reference.identifier),
            ),
          );
          if (!calledDirectly) {
            return;
          }
          // First-week rollout: only lines this change touched
          // (scripts/guard-rollouts/no-identity-wrapper.json).
          if (
            !guardEnforcesLine({
              guard: RULE_NAME,
              file: filenameForContext(context),
              line: context.sourceCode.getLocFromIndex(node.range[0]).line,
            })
          ) {
            return;
          }
          context.report({
            node,
            messageId: "identityWrapper",
            data: { name },
          });
        };

        return {
          VariableDeclarator(node) {
            const id: unknown = node.id;
            if (!isIdentifierReference(id)) {
              return;
            }
            const init = unwrapExpression(node.init);
            if (!isIdentityFunction(init)) {
              return;
            }
            checkBinding(node, id.name);
          },
          FunctionDeclaration(node) {
            const id: unknown = node.id;
            if (!isIdentifierReference(id) || !isIdentityFunction(node)) {
              return;
            }
            checkBinding(node, id.name);
          },
        };
      },
    },
  },
});
