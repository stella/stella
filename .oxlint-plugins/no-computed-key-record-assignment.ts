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

const resolveType = (context: ScopeContext, value: unknown): AstNode | null => {
  let node = value;
  const seen = new Set<Variable>();
  while (isAstNode(node)) {
    if (
      ["TSTypeAnnotation", "TSParenthesizedType", "TSTypeOperator"].includes(
        node.type,
      )
    ) {
      node = node.typeAnnotation;
      continue;
    }
    if (
      node.type !== "TSTypeReference" ||
      !isIdentifierReference(node.typeName)
    ) {
      return node;
    }
    const variable = resolveVariable(context, node.typeName);
    if (
      node.typeName.name === "Readonly" &&
      !variable?.defs.length &&
      isAstNode(node.typeArguments) &&
      Array.isArray(node.typeArguments.params) &&
      node.typeArguments.params.length === 1
    ) {
      // The global Readonly<T> is transparent for key lookups.
      node = node.typeArguments.params[0];
      continue;
    }
    const definition = variable?.defs.at(0)?.node;
    if (
      !variable ||
      !isAstNode(definition) ||
      definition.type !== "TSTypeAliasDeclaration"
    ) {
      return node;
    }
    if (seen.has(variable)) {
      return null;
    }
    seen.add(variable);
    node = definition.typeAnnotation;
  }
  return null;
};

const isStringKeyType = (context: ScopeContext, value: unknown): boolean => {
  const pending = [value];
  const seen = new Set<AstNode>();
  while (pending.length > 0) {
    const type = resolveType(context, pending.pop());
    if (type?.type === "TSStringKeyword") {
      return true;
    }
    if (
      type?.type !== "TSUnionType" ||
      !Array.isArray(type.types) ||
      seen.has(type)
    ) {
      continue;
    }
    seen.add(type);
    for (const member of type.types) {
      pending.push(member);
    }
  }
  return false;
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
      isStringKeyType(context, argumentsNode.params.at(0))
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
        isStringKeyType(context, parameter.typeAnnotation)
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

const bindingAnnotation = (
  context: ScopeContext,
  binding: AstNode,
): AstNode | null => {
  const ownType = resolveType(context, binding.typeAnnotation);
  if (ownType) {
    return ownType;
  }
  const keys: string[] = [];
  let child = binding;
  let parent = child.parent;
  while (
    isAstNode(parent) &&
    ["Property", "ObjectPattern", "AssignmentPattern"].includes(parent.type)
  ) {
    if (parent.type === "Property") {
      const key = getPropertyName(parent.key);
      if (key === null || (parent.computed && !isStaticKey(parent.key))) {
        return null;
      }
      keys.unshift(key);
    }
    let type = resolveType(context, parent.typeAnnotation);
    if (type) {
      for (const key of keys) {
        if (type?.type !== "TSTypeLiteral" || !Array.isArray(type.members)) {
          return null;
        }
        const member = type.members.find(
          (candidate) =>
            isAstNode(candidate) && getPropertyName(candidate.key) === key,
        );
        type = isAstNode(member)
          ? resolveType(context, member.typeAnnotation)
          : null;
      }
      return type;
    }
    child = parent;
    parent = child.parent;
  }
  return null;
};

type InstanceFieldOptions = { node: AstNode; seen: Set<Variable | AstNode> };
const instanceFieldShape = (
  context: ScopeContext,
  { node, seen }: InstanceFieldOptions,
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
    if (!isAstNode(field) || seen.has(field)) {
      return null;
    }
    seen.add(field);
    return (
      resolveType(context, field.typeAnnotation) ??
      shapeOf(context, { value: field.value, seen })
    );
  }
  return null;
};

// A shape is either an initializer or a type node. Keeping the nested value
// shape lets a record of arrays stay distinct from a record of records.
type ShapeOptions = { value: unknown; seen?: Set<Variable | AstNode> };

const shapeOf = (
  context: ScopeContext,
  { value, seen = new Set<Variable | AstNode>() }: ShapeOptions,
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
      shapeOf(context, { value: value.expression, seen })
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
      bindingAnnotation(context, definition.name) ??
      (definition.type === "Parameter"
        ? shapeOf(context, {
            value: reducerSeed(definition.node, definition.name),
            seen,
          })
        : shapeOf(context, { value: definition.node.init, seen }))
    );
  }
  if (node.type !== "MemberExpression") {
    return node;
  }
  let shape = shapeOf(context, { value: node.object, seen });
  if (isAstNode(node.object) && node.object.type === "ThisExpression") {
    return instanceFieldShape(context, { node, seen });
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
      (!member.computed || isStaticKey(member.key)),
  );
  return isAstNode(matchedMember)
    ? (resolveType(context, matchedMember.typeAnnotation) ??
        shapeOf(context, { value: matchedMember.value, seen }))
    : null;
};

const isRecordShape = (context: ScopeContext, shape: AstNode | null): boolean =>
  shape?.type === "ObjectExpression" ||
  shape?.type === "TSTypeLiteral" ||
  isOpenRecordType(context, shape);

const isRecordReceiver = (context: ScopeContext, value: unknown): boolean => {
  if (isRecordShape(context, shapeOf(context, { value }))) {
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

type BindingPair = { left: unknown; right: unknown };
const sameBinding = (
  context: ScopeContext,
  { left, right }: BindingPair,
): boolean => {
  const leftIdentifier = unwrapExpression(left);
  const rightIdentifier = unwrapExpression(right);
  return (
    isIdentifierReference(leftIdentifier) &&
    isIdentifierReference(rightIdentifier) &&
    resolveVariable(context, leftIdentifier) !== null &&
    resolveVariable(context, leftIdentifier) ===
      resolveVariable(context, rightIdentifier)
  );
};

type OwnKeyTestOptions = { test: unknown; table: unknown; key: unknown };
const ownKeyTest = (
  context: ScopeContext,
  { test, table, key }: OwnKeyTestOptions,
): boolean => {
  const node = unwrapExpression(test);
  if (node?.type === "LogicalExpression" && node.operator === "&&") {
    return (
      ownKeyTest(context, { test: node.left, table, key }) ||
      ownKeyTest(context, { test: node.right, table, key })
    );
  }
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
    sameBinding(context, { left: node.arguments.at(0), right: table }) &&
    sameBinding(context, { left: node.arguments.at(1), right: key })
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

type GuardReadOptions = { test: unknown; read: AstNode };
const stableGuardKey = (
  context: ScopeContext,
  { test, read }: GuardReadOptions,
): boolean => {
  const key = unwrapExpression(read.property);
  if (!isAstNode(test) || !isIdentifierReference(key)) {
    return false;
  }
  const variable = resolveVariable(context, key);
  return (
    variable !== null &&
    !variable.references.some(
      (reference) =>
        reference.isWrite() &&
        reference.identifier.range[0] >= test.range[0] &&
        reference.identifier.range[0] < read.range[0],
    )
  );
};

type GuardBranchOptions = { parent: AstNode; child: AstNode };
const branchTest = ({ parent, child }: GuardBranchOptions): AstNode | null => {
  if (
    parent.type === "IfStatement" ||
    parent.type === "ConditionalExpression"
  ) {
    const test = unwrapExpression(parent.test);
    if (child === parent.consequent) {
      return test;
    }
    if (
      child === parent.alternate &&
      test?.type === "UnaryExpression" &&
      test.operator === "!"
    ) {
      return unwrapExpression(test.argument);
    }
  }
  if (
    parent.type === "LogicalExpression" &&
    parent.operator === "&&" &&
    child === parent.right
  ) {
    return unwrapExpression(parent.left);
  }
  return null;
};

const guardedRead = (context: ScopeContext, value: unknown): boolean => {
  if (!isAstNode(value)) {
    return false;
  }
  const read = value;
  let child = read;
  let parent = read.parent;
  while (isAstNode(parent) && !isFunction(parent)) {
    const test = branchTest({ parent, child });
    if (
      test &&
      ownKeyTest(context, { test, table: read.object, key: read.property }) &&
      stableGuardKey(context, { test, read })
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
          ownKeyTest(context, {
            test: statement.test.argument,
            table: read.object,
            key: read.property,
          }) &&
          exits(statement.consequent) &&
          stableGuardKey(context, { test: statement.test, read })
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
  return moduleLevel && isOpenRecordType(context, shapeOf(context, { value }));
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
            "Copy dynamic entries with object spread ({ ...target, ...source }).",
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
            const callee = node.callee;
            if (
              callee.type !== "MemberExpression" ||
              !isMemberAccess(callee, "Object", "assign") ||
              (isIdentifierReference(callee.object) &&
                resolveVariable(context, callee.object)?.defs.length)
            ) {
              return;
            }
            if (
              !node.arguments.some(
                (argument) => argument.type === "SpreadElement",
              ) &&
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
            if (!node.computed || !isOpenModuleTable(context, node.object)) {
              return;
            }
            const parent = node.parent;
            if (
              parent.type === "AssignmentExpression" &&
              parent.left === node &&
              parent.operator === "="
            ) {
              return;
            }
            if (
              !isStringKeyType(
                context,
                shapeOf(context, { value: node.property }),
              ) ||
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
