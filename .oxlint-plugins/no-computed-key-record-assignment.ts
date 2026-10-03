// Records with dynamic keys are built with own-property entries; open module
// tables require an own-key check before lookup. Detection uses local syntax
// and scope bindings, not a TypeScript checker: aliases, literal members,
// record annotations, reducer seeds and class fields are resolved locally.

import { eslintCompatPlugin } from "@oxlint/plugins";
import type { Variable } from "@oxlint/plugins";

import {
  getPropertyName,
  isAstNode,
  isIdentifier,
  isIdentifierReference,
  isMemberAccess,
  resolveVariable,
  type AstNode,
  type ScopeContext,
  unwrapExpression,
} from "./utils.ts";

const isStaticKey = (node: unknown): boolean =>
  isAstNode(node) &&
  ((node.type === "Literal" &&
    (typeof node.value === "string" || typeof node.value === "number")) ||
    (node.type === "TemplateLiteral" &&
      Array.isArray(node.expressions) &&
      node.expressions.length === 0));

const resolveType = (
  context: ScopeContext,
  value: unknown,
  seen = new Set<Variable>(),
): AstNode | null => {
  if (!isAstNode(value)) {
    return null;
  }
  if (
    value.type === "TSTypeAnnotation" ||
    value.type === "TSParenthesizedType" ||
    value.type === "TSTypeOperator"
  ) {
    return resolveType(context, value.typeAnnotation, seen);
  }
  if (
    value.type !== "TSTypeReference" ||
    !isIdentifierReference(value.typeName)
  ) {
    return value;
  }
  const variable = resolveVariable(context, value.typeName);
  const definition = variable?.defs.at(0)?.node;
  if (
    !variable ||
    !isAstNode(definition) ||
    definition.type !== "TSTypeAliasDeclaration"
  ) {
    return value;
  }
  if (seen.has(variable)) {
    return null;
  }
  seen.add(variable);
  return resolveType(context, definition.typeAnnotation, seen);
};

const recordValueType = (
  context: ScopeContext,
  value: unknown,
): AstNode | null => {
  const type = resolveType(context, value);
  if (
    type?.type !== "TSTypeReference" ||
    !isIdentifierReference(type.typeName) ||
    type.typeName.name !== "Record" ||
    resolveVariable(context, type.typeName)?.defs.length ||
    !isAstNode(type.typeArguments) ||
    !Array.isArray(type.typeArguments.params)
  ) {
    return null;
  }
  return isAstNode(type.typeArguments.params.at(1))
    ? type.typeArguments.params.at(1)
    : null;
};

const isOpenRecordType = (context: ScopeContext, value: unknown): boolean => {
  const type = resolveType(context, value);
  if (recordValueType(context, type)) {
    const argumentsNode = type?.typeArguments;
    return (
      isAstNode(argumentsNode) &&
      Array.isArray(argumentsNode.params) &&
      resolveType(context, argumentsNode.params.at(0))?.type ===
        "TSStringKeyword"
    );
  }
  return (
    type?.type === "TSTypeLiteral" &&
    Array.isArray(type.members) &&
    type.members.some((member) => {
      if (
        !isAstNode(member) ||
        member.type !== "TSIndexSignature" ||
        !Array.isArray(member.parameters)
      ) {
        return false;
      }
      const parameter = member.parameters.at(0);
      return (
        isAstNode(parameter) &&
        resolveType(context, parameter.typeAnnotation)?.type ===
          "TSStringKeyword"
      );
    })
  );
};

const reducerSeed = (definition: AstNode, name: unknown): AstNode | null => {
  const call = definition.parent;
  if (
    !isAstNode(call) ||
    call.type !== "CallExpression" ||
    !isAstNode(call.callee) ||
    call.callee.type !== "MemberExpression" ||
    !["reduce", "reduceRight"].includes(
      getPropertyName(call.callee.property) ?? "",
    ) ||
    !Array.isArray(call.arguments) ||
    call.arguments.at(0) !== definition ||
    !Array.isArray(definition.params) ||
    definition.params.at(0) !== name
  ) {
    return null;
  }
  return unwrapExpression(call.arguments.at(1));
};

const instanceFieldShape = (
  context: ScopeContext,
  node: AstNode,
): AstNode | null => {
  let ancestor = node.parent;
  while (isAstNode(ancestor) && ancestor.type !== "ClassBody") {
    ancestor = ancestor.parent;
  }
  if (isAstNode(ancestor) && Array.isArray(ancestor.body)) {
    const field = ancestor.body.find(
      (member) =>
        isAstNode(member) &&
        member.type === "PropertyDefinition" &&
        !member.static &&
        getPropertyName(member.key) === getPropertyName(node.property),
    );
    return isAstNode(field)
      ? (resolveType(context, field.typeAnnotation) ??
          shapeOf(context, field.value))
      : null;
  }
  return null;
};

// A shape is either an initializer or a type node. Keeping the nested value
// shape lets a record of arrays stay distinct from a record of records.
const shapeOf = (
  context: ScopeContext,
  value: unknown,
  seen = new Set<Variable>(),
): AstNode | null => {
  if (!isAstNode(value)) {
    return null;
  }
  if (
    ["TSAsExpression", "TSSatisfiesExpression", "TSTypeAssertion"].includes(
      value.type,
    )
  ) {
    return (
      resolveType(context, value.typeAnnotation) ??
      shapeOf(context, value.expression, seen)
    );
  }
  const node = unwrapExpression(value);
  if (!node) {
    return null;
  }
  if (isIdentifierReference(node)) {
    const variable = resolveVariable(context, node);
    if (!variable || seen.has(variable)) {
      return null;
    }
    seen.add(variable);
    const definition = variable.defs.at(0);
    if (
      !definition ||
      !isAstNode(definition.node) ||
      !isAstNode(definition.name)
    ) {
      return null;
    }
    return (
      resolveType(context, definition.name.typeAnnotation) ??
      (definition.type === "Parameter"
        ? shapeOf(context, reducerSeed(definition.node, definition.name), seen)
        : shapeOf(context, definition.node.init, seen))
    );
  }
  if (node.type !== "MemberExpression") {
    return node;
  }
  let shape = shapeOf(context, node.object, seen);
  if (isAstNode(node.object) && node.object.type === "ThisExpression") {
    return instanceFieldShape(context, node);
  }
  shape = resolveType(context, shape);
  if (!shape) {
    return null;
  }
  const recordValue = recordValueType(context, shape);
  if (recordValue) {
    return resolveType(context, recordValue);
  }
  const members =
    shape.type === "ObjectExpression" ? shape.properties : shape.members;
  if (!Array.isArray(members)) {
    return null;
  }
  const key = getPropertyName(node.property);
  if (node.computed && !isStaticKey(node.property)) {
    const index = members.find(
      (member) => isAstNode(member) && member.type === "TSIndexSignature",
    );
    return isAstNode(index) ? resolveType(context, index.typeAnnotation) : null;
  }
  const matchedMember = members.find(
    (member) =>
      isAstNode(member) &&
      getPropertyName(member.key) === key &&
      !member.computed,
  );
  return isAstNode(matchedMember)
    ? (resolveType(context, matchedMember.typeAnnotation) ??
        shapeOf(context, matchedMember.value, seen))
    : null;
};

const isRecordShape = (context: ScopeContext, shape: AstNode | null): boolean =>
  shape?.type === "ObjectExpression" ||
  shape?.type === "TSTypeLiteral" ||
  isOpenRecordType(context, shape);

const isRecordReceiver = (context: ScopeContext, value: unknown): boolean => {
  if (isRecordShape(context, shapeOf(context, value))) {
    return true;
  }
  if (!isIdentifierReference(value)) {
    return false;
  }
  return (
    resolveVariable(context, value)?.defs.some(
      (definition) =>
        definition.type === "Variable" &&
        isAstNode(definition.node) &&
        unwrapExpression(definition.node.init)?.type === "ObjectExpression",
    ) ?? false
  );
};

const isFunction = (node: AstNode): boolean =>
  [
    "ArrowFunctionExpression",
    "FunctionExpression",
    "FunctionDeclaration",
  ].includes(node.type);

const sameBinding = (
  context: ScopeContext,
  left: unknown,
  right: unknown,
): boolean =>
  isIdentifierReference(left) &&
  isIdentifierReference(right) &&
  resolveVariable(context, left) !== null &&
  resolveVariable(context, left) === resolveVariable(context, right);

const ownKeyTest = (
  context: ScopeContext,
  test: unknown,
  table: unknown,
  key: unknown,
): boolean => {
  const node = unwrapExpression(test);
  if (node?.type !== "CallExpression" || !Array.isArray(node.arguments)) {
    return false;
  }
  const callee = node.callee;
  const objectHasOwn =
    isMemberAccess(callee, "Object", "hasOwn") &&
    isAstNode(callee) &&
    isIdentifierReference(callee.object) &&
    !resolveVariable(context, callee.object)?.defs.length;
  // Only the actual owner import (including an alias) can act as a helper.
  const variable = isIdentifierReference(callee)
    ? resolveVariable(context, callee)
    : null;
  const helper = variable?.defs.some((definition) => {
    const specifier = definition.node;
    const declaration = definition.parent;
    return (
      definition.type === "ImportBinding" &&
      isAstNode(specifier) &&
      isIdentifier(specifier.imported, "hasOwnKey") &&
      isAstNode(declaration) &&
      isAstNode(declaration.source) &&
      ["@/api/lib/json-value", "@/api/lib/json-value.ts"].includes(
        String(declaration.source.value),
      )
    );
  });
  return (
    Boolean(objectHasOwn || helper) &&
    sameBinding(context, node.arguments.at(0), table) &&
    sameBinding(context, node.arguments.at(1), key)
  );
};

const exits = (value: unknown): boolean => {
  if (!isAstNode(value)) {
    return false;
  }
  if (
    ["ReturnStatement", "ThrowStatement", "ContinueStatement"].includes(
      value.type,
    )
  ) {
    return true;
  }
  return (
    value.type === "BlockStatement" &&
    Array.isArray(value.body) &&
    exits(value.body.at(-1))
  );
};

const stableGuardKey = (
  context: ScopeContext,
  test: unknown,
  read: AstNode,
): boolean => {
  if (!isAstNode(test) || !isIdentifierReference(read.property)) {
    return false;
  }
  const variable = resolveVariable(context, read.property);
  return (
    variable !== null &&
    !variable.references.some(
      (reference) =>
        reference.isWrite() &&
        reference.identifier.range[0] >= test.range[1] &&
        reference.identifier.range[0] < read.range[0],
    )
  );
};

const guardedRead = (context: ScopeContext, read: AstNode): boolean => {
  let child = read;
  let parent = read.parent;
  while (isAstNode(parent) && !isFunction(parent)) {
    if (
      parent.type === "IfStatement" &&
      child === parent.consequent &&
      ownKeyTest(context, parent.test, read.object, read.property) &&
      stableGuardKey(context, parent.test, read)
    ) {
      return true;
    }
    if (
      parent.type === "ConditionalExpression" &&
      child === parent.consequent &&
      ownKeyTest(context, parent.test, read.object, read.property) &&
      stableGuardKey(context, parent.test, read)
    ) {
      return true;
    }
    if (
      parent.type === "LogicalExpression" &&
      parent.operator === "&&" &&
      child === parent.right &&
      ownKeyTest(context, parent.left, read.object, read.property) &&
      stableGuardKey(context, parent.left, read)
    ) {
      return true;
    }
    if (parent.type === "BlockStatement" && Array.isArray(parent.body)) {
      const index = parent.body.indexOf(child);
      for (const statement of parent.body.slice(0, index)) {
        if (
          !isAstNode(statement) ||
          statement.type !== "IfStatement" ||
          !isAstNode(statement.test)
        ) {
          continue;
        }
        if (
          statement.test.type === "UnaryExpression" &&
          statement.test.operator === "!" &&
          ownKeyTest(
            context,
            statement.test.argument,
            read.object,
            read.property,
          ) &&
          exits(statement.consequent) &&
          stableGuardKey(context, statement.test, read)
        ) {
          return true;
        }
      }
    }
    child = parent;
    parent = parent.parent;
  }
  return false;
};

const isOpenModuleTable = (context: ScopeContext, value: unknown): boolean => {
  if (!isIdentifierReference(value)) {
    return false;
  }
  const variable = resolveVariable(context, value);
  const definition = variable?.defs.at(0);
  if (
    definition?.type !== "Variable" ||
    !isAstNode(definition.node) ||
    !isAstNode(definition.name)
  ) {
    return false;
  }
  const declaration = definition.node.parent;
  if (
    !isAstNode(declaration) ||
    declaration.type !== "VariableDeclaration" ||
    declaration.kind !== "const"
  ) {
    return false;
  }
  const container = declaration.parent;
  const moduleLevel =
    isAstNode(container) &&
    (container.type === "Program" ||
      (container.type === "ExportNamedDeclaration" &&
        isAstNode(container.parent) &&
        container.parent.type === "Program"));
  return moduleLevel && isOpenRecordType(context, shapeOf(context, value));
};

export default eslintCompatPlugin({
  meta: { name: "no-computed-key-record-assignment" },
  rules: {
    "no-computed-key-record-assignment": {
      meta: {
        type: "problem",
        messages: {
          parameterRecordAssignment:
            "Build dynamically keyed parameter records with Object.fromEntries(...) or a Map.",
          nestedRecordAssignment:
            "Build dynamically keyed nested records with Object.fromEntries(...) or a Map.",
          computedKeyAssignment:
            "Build dynamically keyed records with Object.fromEntries(...) or a Map.",
          assignedSource:
            "Copy dynamic entries with Object.fromEntries(...) or object spread.",
          unguardedRead:
            "Check Object.hasOwn(table, key) before reading an open module-level record.",
        },
      },
      createOnce(context) {
        const reportWrite = (target) => {
          if (
            target.type !== "MemberExpression" ||
            !target.computed ||
            isStaticKey(target.property)
          ) {
            return;
          }
          if (!isRecordReceiver(context, target.object)) {
            return;
          }
          const variable = isIdentifierReference(target.object)
            ? resolveVariable(context, target.object)
            : null;
          const messageId =
            target.object.type === "MemberExpression"
              ? "nestedRecordAssignment"
              : variable?.defs.some(
                    (definition) => definition.type === "Parameter",
                  )
                ? "parameterRecordAssignment"
                : "computedKeyAssignment";
          context.report({ node: target, messageId });
        };
        return {
          AssignmentExpression(node) {
            reportWrite(node.left);
          },
          UpdateExpression(node) {
            reportWrite(node.argument);
          },
          CallExpression(node) {
            if (
              !isMemberAccess(node.callee, "Object", "assign") ||
              (isIdentifierReference(node.callee.object) &&
                resolveVariable(context, node.callee.object)?.defs.length)
            ) {
              return;
            }
            if (
              !node.arguments
                .slice(1)
                .some(
                  (source) =>
                    unwrapExpression(source)?.type !== "ObjectExpression",
                )
            ) {
              return;
            }
            context.report({ node, messageId: "assignedSource" });
          },
          MemberExpression(node) {
            if (
              !node.computed ||
              !isIdentifierReference(node.property) ||
              !isOpenModuleTable(context, node.object)
            ) {
              return;
            }
            const parent = node.parent;
            if (
              parent?.type === "AssignmentExpression" &&
              parent.left === node &&
              parent.operator === "="
            ) {
              return;
            }
            if (
              resolveType(context, shapeOf(context, node.property))?.type !==
                "TSStringKeyword" ||
              guardedRead(context, node)
            ) {
              return;
            }
            context.report({ node, messageId: "unguardedRead" });
          },
        };
      },
    },
  },
});
