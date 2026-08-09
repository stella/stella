import { eslintCompatPlugin } from "@oxlint/plugins";
import type { Ranged } from "@oxlint/plugins";
// Require every locally created Blob URL to have a matching revocation.
//
// URL.createObjectURL pins its Blob/File until URL.revokeObjectURL receives
// that produced value. This rule follows clear local ownership shapes: a URL
// held by one identifier, immutable aliases of that identifier, and cleanup
// callbacks that close over it. Escaped, discarded, or reassigned results are
// not considered disposed. Binding-aware global checks avoid matching a
// locally shadowed URL/window/globalThis object.

import {
  getPropertyName,
  isAstNode,
  isIdentifier,
  unwrapExpression,
} from "./utils.ts";
import type { AstNode } from "./utils.ts";

const RULE_NAME = "no-object-url-leak";
const GLOBAL_HOST_NAMES = new Set(["globalThis", "self", "window"]);
const VALUE_WRAPPER_TYPES = new Set([
  "ConditionalExpression",
  "LogicalExpression",
]);
const FUNCTION_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);

type Scope = {
  set: Map<string, ScopeVariable>;
  upper: Scope | null;
};

type ScopeVariable = {
  defs: {
    node: unknown;
    parent: unknown;
    type: string;
  }[];
};

type Creation = {
  binding: ScopeVariable | null;
  node: Ranged;
  owner: object | null;
  position: number;
};

type Revocation = {
  binding: ScopeVariable | null;
  node: Ranged;
  position: number;
  revokedCreation: object | null;
};

const nodePosition = (node: unknown): number => {
  if (
    !isAstNode(node) ||
    !Array.isArray(node.range) ||
    typeof node.range.at(0) !== "number"
  ) {
    return Number.POSITIVE_INFINITY;
  }
  return node.range.at(0) ?? Number.POSITIVE_INFINITY;
};

const staticMemberName = (node: unknown): string | null => {
  const member = unwrapExpression(node);
  if (member === null || member.type !== "MemberExpression") {
    return null;
  }
  return getPropertyName(member.property);
};

const nearestFunction = (node: unknown): AstNode | null => {
  let current = isAstNode(node) ? node.parent : null;
  while (isAstNode(current)) {
    if (FUNCTION_TYPES.has(current.type)) {
      return current;
    }
    current = current.parent;
  }
  return null;
};

const isNestedFunction = (
  candidate: AstNode | null,
  owner: AstNode | null,
): boolean => {
  if (candidate === null || candidate === owner) {
    return false;
  }
  let current: unknown = candidate.parent;
  while (isAstNode(current)) {
    if (current === owner || (owner === null && current.type === "Program")) {
      return true;
    }
    current = current.parent;
  }
  return false;
};

// Find the declaration/assignment that receives this value. Conditional and
// logical expressions are transparent because only their selected result is
// assigned to the binding.
const creationOwner = (creation) => {
  let current = creation;
  let parent = isAstNode(current.parent) ? current.parent : null;
  while (
    parent !== null &&
    (parent.type === "TSAsExpression" ||
      parent.type === "TSNonNullExpression" ||
      parent.type === "TSSatisfiesExpression" ||
      parent.type === "TSTypeAssertion" ||
      (VALUE_WRAPPER_TYPES.has(parent.type) &&
        (parent.left === current ||
          parent.right === current ||
          parent.consequent === current ||
          parent.alternate === current)))
  ) {
    current = parent;
    parent = isAstNode(current.parent) ? current.parent : null;
  }
  if (
    parent?.type === "VariableDeclarator" &&
    parent.init === current &&
    isIdentifier(parent.id)
  ) {
    return { identifier: parent.id, owner: parent };
  }
  if (
    parent?.type === "AssignmentExpression" &&
    parent.right === current &&
    isIdentifier(parent.left)
  ) {
    return { identifier: parent.left, owner: parent };
  }
  return null;
};

export default eslintCompatPlugin({
  meta: { name: RULE_NAME },
  rules: {
    [RULE_NAME]: {
      meta: {
        type: "problem",
        messages: {
          noObjectUrlLeak:
            "This URL.createObjectURL() result is not provably revoked. " +
            "Store it in a local variable and pass that same value to " +
            "URL.revokeObjectURL() when ownership ends.",
        },
      },
      createOnce(context) {
        const creations: Creation[] = [];
        const revocations: Revocation[] = [];
        const assignments = new Map<ScopeVariable, number[]>();

        const resolveVariable = (identifier): ScopeVariable | null => {
          let scope: Scope | null = context.sourceCode.getScope(identifier);
          while (scope !== null) {
            const variable = scope.set.get(identifier.name);
            if (variable !== undefined) {
              return variable;
            }
            scope = scope.upper;
          }
          return null;
        };

        const isGlobalReference = (node: unknown, name: string): boolean => {
          if (!isIdentifier(node, name)) {
            return false;
          }
          const variable = resolveVariable(node);
          return variable === null || variable.defs.length === 0;
        };

        const isUrlNamespace = (node: unknown): boolean => {
          const expression = unwrapExpression(node);
          if (expression === null) {
            return false;
          }
          if (isIdentifier(expression, "URL")) {
            return isGlobalReference(expression, "URL");
          }
          if (
            expression.type !== "MemberExpression" ||
            staticMemberName(expression) !== "URL"
          ) {
            return false;
          }
          const host = unwrapExpression(expression.object);
          return (
            isIdentifier(host) &&
            GLOBAL_HOST_NAMES.has(host.name) &&
            isGlobalReference(host, host.name)
          );
        };

        const isUrlMethodCall = (node: unknown, method: string): boolean => {
          const call = unwrapExpression(node);
          if (call === null || call.type !== "CallExpression") {
            return false;
          }
          const callee = unwrapExpression(call.callee);
          return (
            callee !== null &&
            callee.type === "MemberExpression" &&
            staticMemberName(callee) === method &&
            isUrlNamespace(callee.object)
          );
        };

        const canonicalBinding = (
          node: unknown,
          visited = new Set<ScopeVariable>(),
        ): ScopeVariable | null => {
          const expression = unwrapExpression(node);
          if (!isIdentifier(expression)) {
            return null;
          }
          const variable = resolveVariable(expression);
          if (variable === null || visited.has(variable)) {
            return variable;
          }
          visited.add(variable);
          for (const definition of variable.defs) {
            if (
              definition.type !== "Variable" ||
              !isAstNode(definition.node) ||
              definition.node.type !== "VariableDeclarator" ||
              !isAstNode(definition.parent) ||
              definition.parent.type !== "VariableDeclaration" ||
              definition.parent.kind !== "const"
            ) {
              continue;
            }
            const aliasedBinding = canonicalBinding(
              definition.node.init,
              visited,
            );
            return aliasedBinding ?? variable;
          }
          return variable;
        };

        const directRevokedCreation = (argument) => {
          const expression = unwrapExpression(argument);
          return expression !== null &&
            isUrlMethodCall(expression, "createObjectURL")
            ? expression
            : null;
        };

        const recordAssignment = (node): void => {
          if (!isIdentifier(node.left)) {
            return;
          }
          const variable = resolveVariable(node.left);
          if (variable === null) {
            return;
          }
          const positions = assignments.get(variable) ?? [];
          positions.push(nodePosition(node));
          assignments.set(variable, positions);
        };

        const hasInterveningAssignment = (
          binding: ScopeVariable,
          creationPosition: number,
          revocationPosition: number,
        ): boolean =>
          (assignments.get(binding) ?? []).some(
            (position) =>
              position > creationPosition && position < revocationPosition,
          );

        return {
          before() {
            creations.length = 0;
            revocations.length = 0;
            assignments.clear();
            return context.sourceCode.text.includes("createObjectURL");
          },
          AssignmentExpression(node) {
            recordAssignment(node);
          },
          CallExpression(node) {
            if (isUrlMethodCall(node, "createObjectURL")) {
              const owner = creationOwner(node);
              creations.push({
                binding:
                  owner === null ? null : resolveVariable(owner.identifier),
                node,
                owner: owner?.owner ?? null,
                position: nodePosition(node),
              });
              return;
            }
            if (!isUrlMethodCall(node, "revokeObjectURL")) {
              return;
            }
            const argument = Array.isArray(node.arguments)
              ? node.arguments.at(0)
              : null;
            revocations.push({
              binding: canonicalBinding(argument),
              node,
              position: nodePosition(node),
              revokedCreation: directRevokedCreation(argument),
            });
          },
          "Program:exit"() {
            const ownerSets = new Map<ScopeVariable, Set<object>>();
            for (const creation of creations) {
              if (creation.binding === null || creation.owner === null) {
                continue;
              }
              const owners = ownerSets.get(creation.binding) ?? new Set();
              owners.add(creation.owner);
              ownerSets.set(creation.binding, owners);
            }

            for (const creation of creations) {
              const directlyRevoked = revocations.some(
                ({ revokedCreation }) => revokedCreation === creation.node,
              );
              if (directlyRevoked) {
                continue;
              }
              if (creation.binding !== null) {
                const binding = creation.binding;
                const hasOneOwnershipWrite = ownerSets.get(binding)?.size === 1;
                const creationFunction = nearestFunction(creation.node);
                const matchingRevocation = revocations.find((revocation) => {
                  if (revocation.binding !== binding) {
                    return false;
                  }
                  const runsAfterCreation =
                    revocation.position > creation.position ||
                    isNestedFunction(
                      nearestFunction(revocation.node),
                      creationFunction,
                    );
                  return (
                    runsAfterCreation &&
                    !hasInterveningAssignment(
                      binding,
                      creation.position,
                      revocation.position,
                    )
                  );
                });
                if (hasOneOwnershipWrite && matchingRevocation !== undefined) {
                  continue;
                }
              }
              context.report({
                node: creation.node,
                messageId: "noObjectUrlLeak",
              });
            }
          },
        };
      },
    },
  },
});
