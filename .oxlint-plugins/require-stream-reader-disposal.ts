// Require locally owned ReadableStream readers to release their lock on every
// exit. A reader that stops before EOF must also cancel the stream before the
// lock is released, otherwise the producer can remain active after its
// consumer has gone away.
//
// This rule deliberately proves the receiver first. It recognizes the global
// ReadableStream constructor, values annotated as ReadableStream, immutable
// aliases of those values, and Response.body from a proven Response. An
// arbitrary object that happens to expose getReader() is outside the rule.

import { eslintCompatPlugin } from "@oxlint/plugins";
import type { Ranged } from "@oxlint/plugins";

import {
  getPropertyName,
  isAstNode,
  isIdentifier,
  isStringLiteral,
  unwrapExpression,
} from "./utils.ts";
import type { AstNode } from "./utils.ts";

const RULE_NAME = "require-stream-reader-disposal";
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

type Scope = {
  set: Map<string, ScopeVariable>;
  upper: Scope | null;
};

type ScopeVariable = {
  defs: {
    name?: unknown;
    node: unknown;
    parent: unknown;
    type: string;
  }[];
};

type Acquisition = {
  binding: ScopeVariable | null;
  node: Ranged;
  root: AstNode;
  stableOwner: boolean;
};

type StatementSite = {
  block: AstNode;
  statement: AstNode;
};

const unwrapValue = (node: unknown): AstNode | null => {
  let current = unwrapExpression(node);
  while (
    current !== null &&
    (current.type === "TSNonNullExpression" ||
      current.type === "TSTypeAssertion")
  ) {
    current = unwrapExpression(current.expression);
  }
  return current;
};

const nearestFunctionOrProgram = (node: unknown): AstNode | null => {
  let current = isAstNode(node) ? node : null;
  while (current !== null) {
    if (FUNCTION_TYPES.has(current.type) || current.type === "Program") {
      return current;
    }
    current = isAstNode(current.parent) ? current.parent : null;
  }
  return null;
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

const visitNodes = (
  node: unknown,
  root: AstNode,
  visitor: (node: AstNode) => void,
  seen = new Set<unknown>(),
): void => {
  if (!isAstNode(node) || seen.has(node)) {
    return;
  }
  seen.add(node);
  if (node !== root && FUNCTION_TYPES.has(node.type)) {
    return;
  }
  visitor(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent") {
      continue;
    }
    if (Array.isArray(value)) {
      for (const child of value) {
        visitNodes(child, root, visitor, seen);
      }
      continue;
    }
    visitNodes(value, root, visitor, seen);
  }
};

const staticMemberName = (node: AstNode): string | null => {
  if (node.type !== "MemberExpression") {
    return null;
  }
  if (node.computed === true) {
    return isStringLiteral(node.property) ? node.property.value : null;
  }
  return getPropertyName(node.property);
};

const memberCall = (
  node: unknown,
  method: string,
): { call: AstNode; object: unknown } | null => {
  const call = unwrapValue(node);
  if (call === null || call.type !== "CallExpression") {
    return null;
  }
  const callee = unwrapValue(call.callee);
  if (
    callee === null ||
    callee.type !== "MemberExpression" ||
    staticMemberName(callee) !== method
  ) {
    return null;
  }
  return { call, object: callee.object };
};

const callWithinExpressionStatement = (
  statement: unknown,
  predicate: (node: AstNode) => boolean,
): boolean => {
  if (!isAstNode(statement) || statement.type !== "ExpressionStatement") {
    return false;
  }
  let matched = false;
  visitNodes(statement, statement, (node) => {
    if (predicate(node)) {
      matched = true;
    }
  });
  return matched;
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

const nearestLoopWithin = (node: unknown, boundary: AstNode): AstNode | null => {
  let current = isAstNode(node) ? node.parent : null;
  while (isAstNode(current) && current !== boundary) {
    if (LOOP_TYPES.has(current.type)) {
      return current;
    }
    if (FUNCTION_TYPES.has(current.type)) {
      return null;
    }
    current = current.parent;
  }
  return null;
};

const isLiteralTrue = (node: unknown): boolean => {
  const expression = unwrapValue(node);
  return (
    expression !== null &&
    expression.type === "Literal" &&
    expression.value === true
  );
};

const isInfiniteLoop = (node: AstNode): boolean => {
  if (node.type === "ForStatement") {
    return node.test === null;
  }
  return (
    (node.type === "WhileStatement" || node.type === "DoWhileStatement") &&
    isLiteralTrue(node.test)
  );
};

const breakExitsLoop = (node: AstNode, loop: AstNode): boolean => {
  const target = abruptCompletionTarget(node);
  return target !== null && isDescendantOf(loop, target);
};

export default eslintCompatPlugin({
  meta: { name: RULE_NAME },
  rules: {
    [RULE_NAME]: {
      meta: {
        type: "problem",
        messages: {
          cancelBeforeRelease:
            "This ReadableStream reader can stop before EOF. Cancel it before releasing its lock so the producer is not left active.",
          releaseInFinally:
            "Release this ReadableStream reader's lock in a finally block, or explicitly return the reader to transfer ownership.",
        },
      },
      createOnce(context) {
        const acquisitions: Acquisition[] = [];

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

        const namedType = (node: unknown, name: string): boolean => {
          const typeNode = isAstNode(node) ? node : null;
          if (typeNode === null) {
            return false;
          }
          if (
            typeNode.type === "TSTypeAnnotation" ||
            typeNode.type === "TSParenthesizedType" ||
            typeNode.type === "TSOptionalType"
          ) {
            return namedType(typeNode.typeAnnotation, name);
          }
          if (typeNode.type === "TSUnionType" && Array.isArray(typeNode.types)) {
            const meaningfulTypes = typeNode.types.filter(
              (part) =>
                isAstNode(part) &&
                part.type !== "TSNullKeyword" &&
                part.type !== "TSUndefinedKeyword",
            );
            return (
              meaningfulTypes.length > 0 &&
              meaningfulTypes.every((part) => namedType(part, name))
            );
          }
          return (
            typeNode.type === "TSTypeReference" &&
            isIdentifier(typeNode.typeName, name) &&
            isGlobalReference(typeNode.typeName, name)
          );
        };

        const definitionName = (definition): AstNode | null => {
          if (isAstNode(definition.name)) {
            return definition.name;
          }
          if (
            isAstNode(definition.node) &&
            definition.node.type === "VariableDeclarator" &&
            isAstNode(definition.node.id)
          ) {
            return definition.node.id;
          }
          return null;
        };

        const variableHasType = (
          variable: ScopeVariable,
          name: string,
        ): boolean =>
          variable.defs.some((definition) => {
            const identifier = definitionName(definition);
            return identifier !== null && namedType(identifier.typeAnnotation, name);
          });

        const constInitializer = (
          variable: ScopeVariable,
        ): unknown | null => {
          for (const definition of variable.defs) {
            if (
              definition.type === "Variable" &&
              isAstNode(definition.node) &&
              definition.node.type === "VariableDeclarator" &&
              isAstNode(definition.parent) &&
              definition.parent.type === "VariableDeclaration" &&
              definition.parent.kind === "const"
            ) {
              return definition.node.init;
            }
          }
          return null;
        };

        const isGlobalConstructor = (node: unknown, name: string): boolean => {
          const expression = unwrapValue(node);
          return (
            expression !== null &&
            expression.type === "NewExpression" &&
            isGlobalReference(expression.callee, name)
          );
        };

        const isGlobalFetch = (node: unknown): boolean => {
          const expression = unwrapValue(node);
          return (
            expression !== null &&
            expression.type === "CallExpression" &&
            isGlobalReference(expression.callee, "fetch")
          );
        };

        const isResponseExpression = (
          node: unknown,
          visited = new Set<ScopeVariable>(),
        ): boolean => {
          const expression = unwrapValue(node);
          if (expression === null) {
            return false;
          }
          if (expression.type === "AwaitExpression") {
            return isGlobalFetch(expression.argument);
          }
          if (isGlobalConstructor(expression, "Response")) {
            return true;
          }
          if (!isIdentifier(expression)) {
            return false;
          }
          const variable = resolveVariable(expression);
          if (variable === null || visited.has(variable)) {
            return false;
          }
          if (variableHasType(variable, "Response")) {
            return true;
          }
          visited.add(variable);
          const initializer = constInitializer(variable);
          return (
            initializer !== null && isResponseExpression(initializer, visited)
          );
        };

        const isReadableStreamExpression = (
          node: unknown,
          visited = new Set<ScopeVariable>(),
        ): boolean => {
          const expression = unwrapValue(node);
          if (expression === null) {
            return false;
          }
          if (isGlobalConstructor(expression, "ReadableStream")) {
            return true;
          }
          if (expression.type === "MemberExpression") {
            return (
              staticMemberName(expression) === "body" &&
              isResponseExpression(expression.object)
            );
          }
          if (!isIdentifier(expression)) {
            return false;
          }
          const variable = resolveVariable(expression);
          if (variable === null || visited.has(variable)) {
            return false;
          }
          if (variableHasType(variable, "ReadableStream")) {
            return true;
          }
          visited.add(variable);
          const initializer = constInitializer(variable);
          return (
            initializer !== null &&
            isReadableStreamExpression(initializer, visited)
          );
        };

        const canonicalBinding = (
          node: unknown,
          visited = new Set<ScopeVariable>(),
        ): ScopeVariable | null => {
          const expression = unwrapValue(node);
          if (!isIdentifier(expression)) {
            return null;
          }
          const variable = resolveVariable(expression);
          if (variable === null || visited.has(variable)) {
            return variable;
          }
          visited.add(variable);
          const initializer = constInitializer(variable);
          const aliased = canonicalBinding(initializer, visited);
          return aliased ?? variable;
        };

        const readerMethodCall = (
          node: unknown,
          method: string,
          binding: ScopeVariable,
        ): boolean => {
          const matched = memberCall(node, method);
          return (
            matched !== null && canonicalBinding(matched.object) === binding
          );
        };

        const acquisitionOwner = (
          node: AstNode,
        ): { binding: ScopeVariable | null; stable: boolean } => {
          let current = node;
          let parent = isAstNode(current.parent) ? current.parent : null;
          while (
            parent !== null &&
            (parent.type === "TSAsExpression" ||
              parent.type === "TSNonNullExpression" ||
              parent.type === "TSSatisfiesExpression" ||
              parent.type === "TSTypeAssertion")
          ) {
            current = parent;
            parent = isAstNode(current.parent) ? current.parent : null;
          }
          if (
            parent?.type === "VariableDeclarator" &&
            parent.init === current &&
            isIdentifier(parent.id)
          ) {
            const declaration = isAstNode(parent.parent) ? parent.parent : null;
            return {
              binding: resolveVariable(parent.id),
              stable:
                declaration?.type === "VariableDeclaration" &&
                declaration.kind === "const",
            };
          }
          if (
            parent?.type === "AssignmentExpression" &&
            parent.right === current &&
            isIdentifier(parent.left)
          ) {
            return { binding: resolveVariable(parent.left), stable: false };
          }
          return { binding: null, stable: false };
        };

        const directlyReturned = (node: unknown): boolean => {
          const expression = unwrapValue(node);
          if (expression === null) {
            return false;
          }
          let current = expression;
          let parent = isAstNode(current.parent) ? current.parent : null;
          while (
            parent !== null &&
            (parent.type === "TSAsExpression" ||
              parent.type === "TSNonNullExpression" ||
              parent.type === "TSSatisfiesExpression" ||
              parent.type === "TSTypeAssertion" ||
              parent.type === "AwaitExpression")
          ) {
            current = parent;
            parent = isAstNode(current.parent) ? current.parent : null;
          }
          return (
            (parent?.type === "ReturnStatement" && parent.argument === current) ||
            (parent?.type === "ArrowFunctionExpression" &&
              parent.body === current)
          );
        };

        const methodStatementIndexes = (
          block: unknown,
          method: string,
          binding: ScopeVariable,
        ): number[] => {
          if (
            !isAstNode(block) ||
            block.type !== "BlockStatement" ||
            !Array.isArray(block.body)
          ) {
            return [];
          }
          const indexes: number[] = [];
          for (const [index, statement] of block.body.entries()) {
            if (
              callWithinExpressionStatement(statement, (candidate) =>
                readerMethodCall(candidate, method, binding),
              )
            ) {
              indexes.push(index);
            }
          }
          return indexes;
        };

        const tryCoversAcquisition = (
          tryNode: AstNode,
          acquisition: Acquisition,
          binding: ScopeVariable,
        ): boolean => {
          if (isDescendantOf(acquisition.node, tryNode.block)) {
            return true;
          }
          const acquisitionSite = statementSite(acquisition.node);
          const trySite = statementSite(tryNode);
          if (
            acquisitionSite === null ||
            trySite === null ||
            acquisitionSite.block !== trySite.block ||
            !Array.isArray(acquisitionSite.block.body)
          ) {
            return false;
          }
          const acquisitionIndex = acquisitionSite.block.body.indexOf(
            acquisitionSite.statement,
          );
          const tryIndex = acquisitionSite.block.body.indexOf(trySite.statement);
          return (
            acquisitionIndex !== -1 &&
            tryIndex > acquisitionIndex &&
            acquisitionSite.block.body
              .slice(acquisitionIndex + 1, tryIndex)
              .every(
                (statement) =>
                  isAstNode(statement) &&
                  statement.type === "VariableDeclaration" &&
                  statement.kind === "const" &&
                  Array.isArray(statement.declarations) &&
                  statement.declarations.every(
                    (declaration) =>
                      isAstNode(declaration) &&
                      declaration.type === "VariableDeclarator" &&
                      canonicalBinding(declaration.init) === binding,
                  ),
              )
          );
        };

        const protectingTry = (
          acquisition: Acquisition,
          binding: ScopeVariable,
        ): AstNode | null => {
          let result: AstNode | null = null;
          visitNodes(acquisition.root, acquisition.root, (node) => {
            if (
              result !== null ||
              node.type !== "TryStatement" ||
              !isAstNode(node.finalizer) ||
              !tryCoversAcquisition(node, acquisition, binding) ||
              methodStatementIndexes(node.finalizer, "releaseLock", binding)
                .length === 0
            ) {
              return;
            }
            result = node;
          });
          return result;
        };

        const hasTransferredBinding = (
          acquisition: Acquisition,
          binding: ScopeVariable,
        ): boolean => {
          let transferred = false;
          let used = false;
          visitNodes(acquisition.root, acquisition.root, (node) => {
            if (
              node.type === "ReturnStatement" &&
              canonicalBinding(node.argument) === binding
            ) {
              transferred = true;
            }
            if (
              node.type === "CallExpression" &&
              ["cancel", "read", "releaseLock"].some((method) =>
                readerMethodCall(node, method, binding),
              )
            ) {
              used = true;
            }
          });
          return transferred && !used;
        };

        const readResultKind = (
          identifier: AstNode,
          binding: ScopeVariable,
        ): "done" | "result" | null => {
          const variable = resolveVariable(identifier);
          if (variable === null) {
            return null;
          }
          for (const definition of variable.defs) {
            if (
              definition.type !== "Variable" ||
              !isAstNode(definition.node) ||
              definition.node.type !== "VariableDeclarator"
            ) {
              continue;
            }
            let initializer = unwrapValue(definition.node.init);
            if (initializer?.type === "AwaitExpression") {
              initializer = unwrapValue(initializer.argument);
            }
            if (!readerMethodCall(initializer, "read", binding)) {
              continue;
            }
            if (isIdentifier(definition.node.id, identifier.name)) {
              return "result";
            }
            if (
              isAstNode(definition.node.id) &&
              definition.node.id.type === "ObjectPattern" &&
              Array.isArray(definition.node.id.properties) &&
              definition.node.id.properties.some(
                (property) =>
                  isAstNode(property) &&
                  property.type === "Property" &&
                  getPropertyName(property.key) === "done" &&
                  isIdentifier(property.value, identifier.name),
              )
            ) {
              return "done";
            }
          }
          return null;
        };

        const isDoneGuard = (
          node: unknown,
          binding: ScopeVariable,
        ): boolean => {
          const expression = unwrapValue(node);
          if (isIdentifier(expression)) {
            return readResultKind(expression, binding) === "done";
          }
          if (
            expression?.type === "MemberExpression" &&
            staticMemberName(expression) === "done" &&
            isIdentifier(unwrapValue(expression.object))
          ) {
            const object = unwrapValue(expression.object);
            return (
              isIdentifier(object) &&
              readResultKind(object, binding) === "result"
            );
          }
          if (
            expression?.type === "BinaryExpression" &&
            (expression.operator === "===" || expression.operator === "==")
          ) {
            return (
              (isDoneGuard(expression.left, binding) &&
                isLiteralTrue(expression.right)) ||
              (isLiteralTrue(expression.left) &&
                isDoneGuard(expression.right, binding))
            );
          }
          return false;
        };

        const controlGuardedByDone = (
          node: AstNode,
          binding: ScopeVariable,
        ): boolean => {
          let child = node;
          let parent = isAstNode(child.parent) ? child.parent : null;
          while (parent?.type === "BlockStatement") {
            child = parent;
            parent = isAstNode(child.parent) ? child.parent : null;
          }
          return (
            parent?.type === "IfStatement" &&
            parent.consequent === child &&
            isDoneGuard(parent.test, binding)
          );
        };

        const hasPriorCancel = (
          node: AstNode,
          binding: ScopeVariable,
        ): boolean => {
          const site = statementSite(node);
          if (site === null || !Array.isArray(site.block.body)) {
            return false;
          }
          const index = site.block.body.indexOf(site.statement);
          return site.block.body
            .slice(0, index)
            .some((statement) =>
              callWithinExpressionStatement(statement, (candidate) =>
                readerMethodCall(candidate, "cancel", binding),
              ),
            );
        };

        const catchCancels = (
          tryNode: AstNode,
          binding: ScopeVariable,
        ): boolean => {
          if (!isAstNode(tryNode.handler) || !isAstNode(tryNode.handler.body)) {
            return false;
          }
          return (
            methodStatementIndexes(tryNode.handler.body, "cancel", binding)
              .at(0) === 0
          );
        };

        const trailingCancelCoversTopLevelReads = (
          tryNode: AstNode,
          binding: ScopeVariable,
        ): boolean => {
          if (
            !isAstNode(tryNode.block) ||
            tryNode.block.type !== "BlockStatement" ||
            !Array.isArray(tryNode.block.body)
          ) {
            return false;
          }
          const readStatementIndexes: number[] = [];
          let hasNestedRead = false;
          visitNodes(tryNode.block, tryNode.block, (node) => {
            if (!readerMethodCall(node, "read", binding)) {
              return;
            }
            const site = statementSite(node);
            if (site === null || site.block !== tryNode.block) {
              hasNestedRead = true;
              return;
            }
            const index = tryNode.block.body.indexOf(site.statement);
            if (index !== -1) {
              readStatementIndexes.push(index);
            }
          });
          if (hasNestedRead || readStatementIndexes.length === 0) {
            return false;
          }
          const lastReadIndex = Math.max(...readStatementIndexes);
          return methodStatementIndexes(tryNode.block, "cancel", binding).some(
            (index) => index === lastReadIndex + 1,
          );
        };

        const readPathsRequireFinalCancel = (
          tryNode: AstNode,
          binding: ScopeVariable,
        ): boolean => {
          const readCalls: AstNode[] = [];
          visitNodes(tryNode.block, tryNode.block, (node) => {
            if (readerMethodCall(node, "read", binding)) {
              readCalls.push(node);
            }
          });
          if (readCalls.length === 0) {
            return false;
          }
          if (trailingCancelCoversTopLevelReads(tryNode, binding)) {
            return false;
          }
          const handlerCancels = catchCancels(tryNode, binding);
          const readLoops = new Set<AstNode>();
          for (const readCall of readCalls) {
            const loop = nearestLoopWithin(readCall, tryNode.block);
            if (loop === null || !isInfiniteLoop(loop)) {
              return true;
            }
            readLoops.add(loop);
          }
          for (const loop of readLoops) {
            let unsafeExit = false;
            visitNodes(loop, loop, (node) => {
              if (unsafeExit) {
                return;
              }
              if (node.type === "ThrowStatement") {
                unsafeExit =
                  !handlerCancels && !hasPriorCancel(node, binding);
                return;
              }
              if (node.type === "YieldExpression") {
                unsafeExit = true;
                return;
              }
              if (node.type === "ReturnStatement") {
                unsafeExit =
                  !controlGuardedByDone(node, binding) &&
                  !hasPriorCancel(node, binding);
                return;
              }
              if (
                node.type === "BreakStatement" &&
                breakExitsLoop(node, loop)
              ) {
                unsafeExit =
                  !controlGuardedByDone(node, binding) &&
                  !hasPriorCancel(node, binding);
              }
            });
            if (unsafeExit) {
              return true;
            }
          }
          return false;
        };

        return {
          before() {
            acquisitions.length = 0;
            return context.sourceCode.text.includes("getReader");
          },
          CallExpression(node) {
            const matched = memberCall(node, "getReader");
            if (
              matched === null ||
              !isReadableStreamExpression(matched.object)
            ) {
              return;
            }
            const root = nearestFunctionOrProgram(node);
            if (root === null) {
              return;
            }
            const owner = acquisitionOwner(matched.call);
            acquisitions.push({
              binding: owner.binding,
              node,
              root,
              stableOwner: owner.stable,
            });
          },
          "Program:exit"() {
            for (const acquisition of acquisitions) {
              if (directlyReturned(acquisition.node)) {
                continue;
              }
              const binding = acquisition.binding;
              if (
                binding !== null &&
                acquisition.stableOwner &&
                hasTransferredBinding(acquisition, binding)
              ) {
                continue;
              }
              if (binding === null || !acquisition.stableOwner) {
                context.report({
                  node: acquisition.node,
                  messageId: "releaseInFinally",
                });
                continue;
              }
              const tryNode = protectingTry(acquisition, binding);
              if (tryNode === null) {
                context.report({
                  node: acquisition.node,
                  messageId: "releaseInFinally",
                });
                continue;
              }
              const releaseIndexes = methodStatementIndexes(
                tryNode.finalizer,
                "releaseLock",
                binding,
              );
              const cancelIndexes = methodStatementIndexes(
                tryNode.finalizer,
                "cancel",
                binding,
              );
              const releaseIndex = releaseIndexes.at(0);
              const finalizerCancelsFirst =
                releaseIndex !== undefined &&
                cancelIndexes.some((index) => index < releaseIndex);
              if (
                !finalizerCancelsFirst &&
                readPathsRequireFinalCancel(tryNode, binding)
              ) {
                context.report({
                  node: acquisition.node,
                  messageId: "cancelBeforeRelease",
                });
              }
            }
          },
        };
      },
    },
  },
});
