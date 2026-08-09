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
const FUNCTION_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);
const LOOP_TYPES = new Set([
  "DoWhileStatement",
  "ForInStatement",
  "ForOfStatement",
  "ForStatement",
  "WhileStatement",
]);
const CONDITIONAL_EXECUTION_TYPES = new Set([
  "CatchClause",
  "ConditionalExpression",
  "DoWhileStatement",
  "ForInStatement",
  "ForOfStatement",
  "ForStatement",
  "IfStatement",
  "LogicalExpression",
  "SwitchCase",
  "WhileStatement",
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
  aliasPositions: number[];
  argumentBinding: ScopeVariable | null;
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

type StatementSite = {
  block: AstNode;
  statement: AstNode;
};

const statementSite = (node: unknown): StatementSite | null => {
  let current = isAstNode(node) ? node : null;
  while (current !== null) {
    const parent = isAstNode(current.parent) ? current.parent : null;
    if (
      parent !== null &&
      (parent.type === "BlockStatement" || parent.type === "Program") &&
      Array.isArray(parent.body) &&
      parent.body.includes(current)
    ) {
      return { block: parent, statement: current };
    }
    current = parent;
  }
  return null;
};

const abruptCompletionTarget = (node: AstNode): AstNode | null => {
  if (node.type !== "BreakStatement" && node.type !== "ContinueStatement") {
    return null;
  }
  const labelName = isIdentifier(node.label) ? node.label.name : null;
  let current = isAstNode(node.parent) ? node.parent : null;
  while (current !== null) {
    if (
      labelName !== null &&
      current.type === "LabeledStatement" &&
      isIdentifier(current.label, labelName)
    ) {
      return current;
    }
    if (
      labelName === null &&
      (LOOP_TYPES.has(current.type) ||
        (node.type === "BreakStatement" && current.type === "SwitchStatement"))
    ) {
      return current;
    }
    if (FUNCTION_TYPES.has(current.type)) {
      return null;
    }
    current = isAstNode(current.parent) ? current.parent : null;
  }
  return null;
};

const abruptCompletionBypasses = (
  node: AstNode,
  destination: unknown,
): boolean => {
  if (node.type === "ReturnStatement" || node.type === "ThrowStatement") {
    return true;
  }
  const target = abruptCompletionTarget(node);
  return target !== null && isDescendantOf(destination, target);
};

const containsBypassingAbruptCompletion = (
  node: unknown,
  destination: unknown,
  root: unknown = node,
  seen = new Set<unknown>(),
): boolean => {
  if (!isAstNode(node) || seen.has(node)) {
    return false;
  }
  seen.add(node);
  if (node !== root && FUNCTION_TYPES.has(node.type)) {
    return false;
  }
  if (
    (node.type === "BreakStatement" ||
      node.type === "ContinueStatement" ||
      node.type === "ReturnStatement" ||
      node.type === "ThrowStatement") &&
    abruptCompletionBypasses(node, destination)
  ) {
    return true;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent") {
      continue;
    }
    if (Array.isArray(value)) {
      if (
        value.some((child) =>
          containsBypassingAbruptCompletion(child, destination, root, seen),
        )
      ) {
        return true;
      }
      continue;
    }
    if (containsBypassingAbruptCompletion(value, destination, root, seen)) {
      return true;
    }
  }
  return false;
};

const isUnconditionallyExecuted = (
  node: unknown,
  statement: AstNode,
): boolean => {
  let child = isAstNode(node) ? node : null;
  while (child !== null && child !== statement) {
    const parent = isAstNode(child.parent) ? child.parent : null;
    if (parent === null) {
      return false;
    }
    if (parent.type === "TryStatement") {
      if (parent.finalizer !== child) {
        return false;
      }
    } else if (CONDITIONAL_EXECUTION_TYPES.has(parent.type)) {
      return false;
    }
    child = parent;
  }
  return child === statement;
};

const isDescendantOf = (node: unknown, ancestor: unknown): boolean => {
  let current = isAstNode(node) ? node : null;
  while (current !== null) {
    if (current === ancestor) {
      return true;
    }
    current = isAstNode(current.parent) ? current.parent : null;
  }
  return false;
};

const repeatingLoopForNode = (node: unknown): AstNode | null => {
  let child = isAstNode(node) ? node : null;
  while (child !== null) {
    const parent = isAstNode(child.parent) ? child.parent : null;
    if (parent === null || FUNCTION_TYPES.has(parent.type)) {
      return null;
    }
    if (
      LOOP_TYPES.has(parent.type) &&
      (parent.type !== "ForStatement" || parent.init !== child)
    ) {
      return parent;
    }
    child = parent;
  }
  return null;
};

const isReturnedCleanupFunction = (
  functionNode: AstNode,
  ownerFunction: AstNode | null,
): boolean => {
  let child = functionNode;
  while (child !== ownerFunction) {
    const parent = isAstNode(child.parent) ? child.parent : null;
    if (parent === null) {
      return false;
    }
    if (parent.type === "ReturnStatement") {
      return parent.argument === child;
    }
    child = parent;
  }
  return false;
};

const functionAlwaysReachesNode = (
  functionNode: AstNode,
  node: unknown,
): boolean => {
  if (!isAstNode(functionNode.body)) {
    return false;
  }
  if (functionNode.body.type !== "BlockStatement") {
    return isDescendantOf(node, functionNode.body);
  }
  const revocationSite = statementSite(node);
  if (
    revocationSite === null ||
    revocationSite.block !== functionNode.body ||
    !isUnconditionallyExecuted(node, revocationSite.statement) ||
    !Array.isArray(functionNode.body.body)
  ) {
    return false;
  }
  const revocationIndex = functionNode.body.body.indexOf(
    revocationSite.statement,
  );
  return (
    revocationIndex !== -1 &&
    !functionNode.body.body
      .slice(0, revocationIndex)
      .some((statement) => containsBypassingAbruptCompletion(statement, node))
  );
};

const isRevokedByEnclosingFinally = (
  creation: Creation,
  revocation: Revocation,
): boolean => {
  let child = isAstNode(revocation.node) ? revocation.node : null;
  while (child !== null) {
    const parent = isAstNode(child.parent) ? child.parent : null;
    if (parent?.type === "TryStatement" && parent.finalizer === child) {
      if (!isUnconditionallyExecuted(revocation.node, child)) {
        return false;
      }
      if (isDescendantOf(creation.node, parent.block)) {
        return true;
      }
      const creationSite = statementSite(creation.node);
      const trySite = statementSite(parent);
      if (
        creationSite === null ||
        trySite === null ||
        creationSite.block !== trySite.block ||
        !Array.isArray(creationSite.block.body)
      ) {
        return false;
      }
      const creationIndex = creationSite.block.body.indexOf(
        creationSite.statement,
      );
      const tryIndex = creationSite.block.body.indexOf(trySite.statement);
      return (
        creationIndex !== -1 &&
        tryIndex > creationIndex &&
        !creationSite.block.body
          .slice(creationIndex + 1, tryIndex)
          .some((statement) =>
            containsBypassingAbruptCompletion(statement, revocation.node),
          )
      );
    }
    child = parent;
  }
  return false;
};

const isImmutablePerIterationBinding = (
  binding: ScopeVariable | null,
  repeatingLoop: AstNode,
  creationFunction: AstNode | null,
): boolean => {
  if (!isAstNode(repeatingLoop.body)) {
    return false;
  }
  return (
    binding?.defs.some(
      (definition) =>
        definition.type === "Variable" &&
        isAstNode(definition.node) &&
        definition.node.type === "VariableDeclarator" &&
        isAstNode(definition.parent) &&
        definition.parent.type === "VariableDeclaration" &&
        definition.parent.kind === "const" &&
        nearestFunction(definition.node) === creationFunction &&
        isDescendantOf(definition.node, repeatingLoop.body),
    ) === true
  );
};

const revocationCoversCreation = (
  creation: Creation,
  revocation: Revocation,
  callbackRegistrationSites: AstNode[],
): boolean => {
  const creationFunction = nearestFunction(creation.node);
  const revocationFunction = nearestFunction(revocation.node);
  const usesReturnedCleanup = isNestedFunction(
    revocationFunction,
    creationFunction,
  );
  const repeatingLoop = repeatingLoopForNode(creation.node);
  const isReturnedCleanup =
    usesReturnedCleanup &&
    revocationFunction !== null &&
    isReturnedCleanupFunction(revocationFunction, creationFunction);
  if (
    repeatingLoop !== null &&
    usesReturnedCleanup &&
    !isReturnedCleanup &&
    callbackRegistrationSites.length > 0 &&
    !isImmutablePerIterationBinding(
      revocation.argumentBinding,
      repeatingLoop,
      creationFunction,
    )
  ) {
    return false;
  }
  if (
    isRevokedByEnclosingFinally(creation, revocation) &&
    (repeatingLoop === null || isDescendantOf(revocation.node, repeatingLoop))
  ) {
    return true;
  }
  if (
    usesReturnedCleanup &&
    (revocationFunction === null ||
      !functionAlwaysReachesNode(revocationFunction, revocation.node))
  ) {
    return false;
  }
  const coverageNodes = usesReturnedCleanup
    ? isReturnedCleanup
      ? [revocationFunction]
      : callbackRegistrationSites
    : [revocation.node];

  return coverageNodes.some((coverageNode) => {
    if (
      repeatingLoop !== null &&
      !isDescendantOf(coverageNode, repeatingLoop)
    ) {
      return false;
    }
    const creationSite = statementSite(creation.node);
    const revocationSite = statementSite(coverageNode);
    if (
      creationSite === null ||
      revocationSite === null ||
      creationSite.block !== revocationSite.block ||
      !isUnconditionallyExecuted(coverageNode, revocationSite.statement) ||
      !Array.isArray(creationSite.block.body)
    ) {
      return false;
    }

    const creationIndex = creationSite.block.body.indexOf(
      creationSite.statement,
    );
    const revocationIndex = creationSite.block.body.indexOf(
      revocationSite.statement,
    );
    if (creationIndex === -1 || revocationIndex <= creationIndex) {
      return false;
    }
    return !creationSite.block.body
      .slice(creationIndex + 1, revocationIndex)
      .some((statement) =>
        containsBypassingAbruptCompletion(statement, coverageNode),
      );
  });
};

// Find the declaration/assignment that receives this value. Conditional and
// short-circuit expressions are transparent only when this creation can be
// the expression's owned result. A createObjectURL call on the left of `&&`
// produces a separate, truthy URL before the right operand runs, so it must
// not share the right operand's ownership slot. `||` and `??` select at most
// one created URL because object URLs are non-empty, non-nullish strings.
const wrapperCarriesCreatedValue = (
  parent: AstNode,
  current: AstNode,
): boolean => {
  if (parent.type === "ConditionalExpression") {
    return parent.consequent === current || parent.alternate === current;
  }
  if (parent.type !== "LogicalExpression") {
    return false;
  }
  if (parent.operator === "&&") {
    return parent.right === current;
  }
  return (
    (parent.operator === "||" || parent.operator === "??") &&
    (parent.left === current || parent.right === current)
  );
};

const creationOwner = (creation) => {
  let current = creation;
  let parent = isAstNode(current.parent) ? current.parent : null;
  while (
    parent !== null &&
    (parent.type === "TSAsExpression" ||
      parent.type === "TSNonNullExpression" ||
      parent.type === "TSSatisfiesExpression" ||
      parent.type === "TSTypeAssertion" ||
      wrapperCarriesCreatedValue(parent, current))
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
        const callbackRegistrations = new Map<ScopeVariable, AstNode[]>();

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

        const canonicalBindingInfo = (
          node: unknown,
          visited = new Set<ScopeVariable>(),
        ): {
          aliasPositions: number[];
          binding: ScopeVariable;
        } | null => {
          const expression = unwrapExpression(node);
          if (!isIdentifier(expression)) {
            return null;
          }
          const variable = resolveVariable(expression);
          if (variable === null) {
            return null;
          }
          if (visited.has(variable)) {
            return { aliasPositions: [], binding: variable };
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
            const aliasedBinding = canonicalBindingInfo(
              definition.node.init,
              visited,
            );
            if (aliasedBinding !== null) {
              return {
                aliasPositions: [
                  ...aliasedBinding.aliasPositions,
                  nodePosition(definition.node),
                ],
                binding: aliasedBinding.binding,
              };
            }
          }
          return { aliasPositions: [], binding: variable };
        };

        const canonicalBinding = (node: unknown): ScopeVariable | null =>
          canonicalBindingInfo(node)?.binding ?? null;

        const directRevokedCreation = (argument) => {
          const expression = unwrapExpression(argument);
          return expression !== null &&
            isUrlMethodCall(expression, "createObjectURL")
            ? expression
            : null;
        };

        const cleanupFunctionBinding = (
          node: AstNode | null,
        ): ScopeVariable | null => {
          if (node === null) {
            return null;
          }
          const parent = isAstNode(node.parent) ? node.parent : null;
          if (
            parent?.type !== "VariableDeclarator" ||
            parent.init !== node ||
            !isIdentifier(parent.id)
          ) {
            return null;
          }
          return resolveVariable(parent.id);
        };

        const recordTimerCallbackRegistration = (node): void => {
          const callee = unwrapExpression(node.callee);
          if (
            !isIdentifier(callee, "setTimeout") ||
            !isGlobalReference(callee, "setTimeout") ||
            !Array.isArray(node.arguments)
          ) {
            return;
          }
          const callbackBinding = canonicalBinding(node.arguments.at(0));
          if (callbackBinding === null) {
            return;
          }
          const registrations =
            callbackRegistrations.get(callbackBinding) ?? [];
          registrations.push(node);
          callbackRegistrations.set(callbackBinding, registrations);
        };

        const cleanupCallbackRegistrations = (node: unknown): AstNode[] => {
          const binding = cleanupFunctionBinding(nearestFunction(node));
          return binding === null
            ? []
            : (callbackRegistrations.get(binding) ?? []);
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
            callbackRegistrations.clear();
            return context.sourceCode.text.includes("createObjectURL");
          },
          AssignmentExpression(node) {
            recordAssignment(node);
          },
          CallExpression(node) {
            recordTimerCallbackRegistration(node);
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
            const bindingInfo = canonicalBindingInfo(argument);
            revocations.push({
              aliasPositions: bindingInfo?.aliasPositions ?? [],
              argumentBinding: isIdentifier(unwrapExpression(argument))
                ? resolveVariable(unwrapExpression(argument))
                : null,
              binding: bindingInfo?.binding ?? null,
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
                const matchingRevocation = revocations.find((revocation) => {
                  if (revocation.binding !== binding) {
                    return false;
                  }
                  if (
                    revocation.aliasPositions.some(
                      (position) => position < creation.position,
                    )
                  ) {
                    return false;
                  }
                  return (
                    (revocation.position > creation.position ||
                      isNestedFunction(
                        nearestFunction(revocation.node),
                        nearestFunction(creation.node),
                      )) &&
                    revocationCoversCreation(
                      creation,
                      revocation,
                      cleanupCallbackRegistrations(revocation.node),
                    ) &&
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
