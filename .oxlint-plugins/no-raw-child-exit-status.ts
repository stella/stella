import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  getPropertyName,
  isAstNode,
  isFileIn,
  isIdentifierReference,
  resolveImport,
  resolveImportedExpression,
  resolveVariable,
  returnArguments,
  stableInitializer,
  staticStringValue,
  unwrapExpression,
  type AstNode,
  type FilenameContext,
  type ScopeContext,
} from "./utils.ts";

const OWNER = "packages/scripts/src/child-exit-status";
const RAW_PROPERTIES = new Set([
  "exitCode",
  "status",
  "signalCode",
  "signal",
  "exited",
]);
const BUN_SPAWN_METHODS = new Set(["spawn", "spawnSync"]);
const NUMERIC_UNARY_OPERATORS = new Set(["+", "-", "~"]);
const NUMERIC_BINARY_OPERATORS = new Set([
  "+",
  "-",
  "*",
  "/",
  "%",
  "**",
  "|",
  "&",
  "^",
  "<<",
  ">>",
  ">>>",
]);
const NODE_SPAWN_METHODS = new Set([
  "spawn",
  "spawnSync",
  "exec",
  "execFile",
  "execFileSync",
]);
type Context = ScopeContext & FilenameContext;
type ProvenanceOptions = {
  context: Context;
  value: unknown;
  seen?: Set<unknown>;
};

const propertyName = (node: AstNode): string | null =>
  node.computed
    ? staticStringValue(node.property)
    : getPropertyName(node.property);

const isProcess = ({
  context,
  value,
  seen = new Set<unknown>(),
}: ProvenanceOptions): boolean => {
  const node = unwrapExpression(value);
  if (node === null || seen.has(node)) {
    return false;
  }
  seen.add(node);
  const imported = resolveImportedExpression(context, node);
  if (
    imported !== null &&
    (imported.source === "node:process" || imported.source === "process")
  ) {
    return imported.imported === "default" || imported.imported === "*";
  }
  if (isIdentifierReference(node)) {
    const variable = resolveVariable(context, node);
    if (
      node.name === "process" &&
      (variable === null || variable.defs.length === 0)
    ) {
      return true;
    }
    return (
      variable !== null &&
      isProcess({ context, value: stableInitializer(variable), seen })
    );
  }
  return false;
};

const isExit = ({
  context,
  value,
  seen = new Set<unknown>(),
}: ProvenanceOptions): boolean => {
  const node = unwrapExpression(value);
  if (node === null || seen.has(node)) {
    return false;
  }
  seen.add(node);
  const imported = resolveImportedExpression(context, node);
  if (
    imported !== null &&
    (imported.source === "node:process" || imported.source === "process") &&
    imported.imported === "exit"
  ) {
    return true;
  }
  if (node.type === "MemberExpression") {
    return (
      propertyName(node) === "exit" &&
      isProcess({ context, value: node.object })
    );
  }
  if (!isIdentifierReference(node)) {
    return false;
  }
  const variable = resolveVariable(context, node);
  if (variable === null) {
    return false;
  }
  const initializer = stableInitializer(variable);
  const declarator = variable.defs.at(0)?.node;
  if (
    isAstNode(declarator) &&
    isAstNode(declarator.id) &&
    declarator.id.type === "ObjectPattern" &&
    Array.isArray(declarator.id.properties)
  ) {
    return (
      isProcess({ context, value: initializer }) &&
      declarator.id.properties.some(
        (property) =>
          isAstNode(property) &&
          getPropertyName(property.key) === "exit" &&
          isIdentifierReference(property.value) &&
          property.value.name === node.name,
      )
    );
  }
  return isExit({ context, value: initializer, seen });
};

const isNormalized = (context: Context, node: AstNode): boolean => {
  if (node.type !== "CallExpression") {
    return false;
  }
  const binding = resolveImport(context, node.callee);
  return (
    binding?.imported === "childExitStatus" &&
    (binding.moduleId.endsWith(OWNER) ||
      binding.moduleId === "@stll/scripts/src/child-exit-status")
  );
};

const isSpawn = ({
  context,
  value,
  seen = new Set<unknown>(),
}: ProvenanceOptions): boolean => {
  const node = unwrapExpression(value);
  if (node === null || seen.has(node)) {
    return false;
  }
  seen.add(node);
  const imported = resolveImportedExpression(context, node);
  if (imported !== null) {
    if (
      (imported.source === "node:child_process" ||
        imported.source === "child_process") &&
      NODE_SPAWN_METHODS.has(imported.imported)
    ) {
      return true;
    }
    if (imported.source === "bun" && BUN_SPAWN_METHODS.has(imported.imported)) {
      return true;
    }
  }
  if (isIdentifierReference(node)) {
    const variable = resolveVariable(context, node);
    return (
      variable !== null &&
      isSpawn({ context, value: stableInitializer(variable), seen })
    );
  }
  if (
    node.type !== "MemberExpression" ||
    !BUN_SPAWN_METHODS.has(propertyName(node) ?? "") ||
    !isIdentifierReference(node.object) ||
    node.object.name !== "Bun"
  ) {
    return false;
  }
  const variable = resolveVariable(context, node.object);
  return variable === null || variable.defs.length === 0;
};

const isChildResult = ({
  context,
  value,
  seen = new Set<unknown>(),
}: ProvenanceOptions): boolean => {
  const node = unwrapExpression(value);
  if (node === null || seen.has(node)) {
    return false;
  }
  seen.add(node);
  if (node.type === "AwaitExpression") {
    return isChildResult({ context, value: node.argument, seen });
  }
  if (isIdentifierReference(node)) {
    const variable = resolveVariable(context, node);
    return (
      variable !== null &&
      isChildResult({ context, value: stableInitializer(variable), seen })
    );
  }
  if (node.type === "CallExpression") {
    if (isSpawn({ context, value: node.callee })) {
      return true;
    }
    const callee = unwrapExpression(node.callee);
    if (callee?.type !== "MemberExpression") {
      return false;
    }
    return isChildResult({ context, value: callee.object, seen });
  }
  if (node.type === "TaggedTemplateExpression") {
    const imported = resolveImportedExpression(context, node.tag);
    return imported?.source === "bun" && imported.imported === "$";
  }
  return false;
};

type ParameterCallOptions = {
  context: Context;
  binding: unknown;
  index: number;
  seen: Set<unknown>;
};

// A local wrapper's parameter carries the arguments of its lexical callers.
// Follow aliases of the wrapper too; unrelated parameter names prove nothing.
const parameterHasRawCaller = ({
  context,
  binding,
  index,
  seen,
}: ParameterCallOptions): boolean => {
  if (!isIdentifierReference(binding)) {
    return false;
  }
  const variable = resolveVariable(context, binding);
  if (variable === null || seen.has(variable)) {
    return false;
  }
  seen.add(variable);
  return variable.references.some((reference) => {
    const identifier = reference.identifier;
    const parent = identifier.parent;
    if (!isAstNode(parent)) {
      return false;
    }
    if (
      parent.type === "CallExpression" &&
      parent.callee === identifier &&
      Array.isArray(parent.arguments)
    ) {
      return isRawStatus({
        context,
        value: parent.arguments.at(index),
        seen: new Set(seen),
      });
    }
    if (parent.type === "VariableDeclarator" && parent.init === identifier) {
      return parameterHasRawCaller({
        context,
        binding: parent.id,
        index,
        seen: new Set(seen),
      });
    }
    return false;
  });
};

type StatusOptions = {
  context: Context;
  node: AstNode;
  seen: Set<unknown>;
};

const rawCallStatus = ({ context, node, seen }: StatusOptions): boolean => {
  if (isIdentifierReference(node.callee)) {
    const variable = resolveVariable(context, node.callee);
    const definition = variable?.defs.at(0);
    const declaration = definition?.node;
    const fn =
      definition?.type !== "Parameter" &&
      isAstNode(declaration) &&
      declaration.type === "FunctionDeclaration"
        ? declaration
        : variable === null
          ? null
          : stableInitializer(variable);
    if (
      fn !== null &&
      (fn.type === "FunctionDeclaration" ||
        fn.type === "ArrowFunctionExpression" ||
        fn.type === "FunctionExpression")
    ) {
      const body = unwrapExpression(fn.body);
      return body?.type === "BlockStatement"
        ? returnArguments(body).some((argument) =>
            isRawStatus({ context, value: argument, seen: new Set(seen) }),
          )
        : isRawStatus({ context, value: body, seen });
    }
  }
  if (Array.isArray(node.arguments)) {
    return node.arguments.some(
      (argument) =>
        isRawStatus({ context, value: argument, seen: new Set(seen) }) ||
        isChildResult({ context, value: argument }),
    );
  }
  return false;
};

type ParameterStatusOptions = StatusOptions & { declarator: AstNode };

const rawParameterStatus = ({
  context,
  node,
  seen,
  declarator,
}: ParameterStatusOptions): boolean => {
  if (!Array.isArray(declarator.params)) {
    return false;
  }
  const index = declarator.params.findIndex(
    (parameter) =>
      isAstNode(parameter) &&
      parameter.type === "Identifier" &&
      parameter.name === node.name,
  );
  const parent = declarator.parent;
  const binding =
    declarator.type === "FunctionDeclaration"
      ? declarator.id
      : isAstNode(parent) && parent.type === "VariableDeclarator"
        ? parent.id
        : null;
  return (
    index !== -1 && parameterHasRawCaller({ context, binding, index, seen })
  );
};

const rawIdentifierStatus = ({
  context,
  node,
  seen,
}: StatusOptions): boolean => {
  if (!isIdentifierReference(node)) {
    return false;
  }
  const variable = resolveVariable(context, node);
  if (variable === null) {
    return false;
  }
  const definition = variable.defs.at(0);
  const declarator = definition?.node;
  if (definition?.type === "Parameter" && isAstNode(declarator)) {
    return rawParameterStatus({ context, node, seen, declarator });
  }
  if (
    isAstNode(declarator) &&
    isAstNode(declarator.id) &&
    declarator.id.type === "ObjectPattern" &&
    Array.isArray(declarator.id.properties)
  ) {
    return (
      isChildResult({ context, value: stableInitializer(variable) }) &&
      declarator.id.properties.some(
        (property) =>
          isAstNode(property) &&
          RAW_PROPERTIES.has(getPropertyName(property.key) ?? "") &&
          isIdentifierReference(property.value) &&
          property.value.name === node.name,
      )
    );
  }
  if (
    isAstNode(declarator) &&
    isAstNode(declarator.id) &&
    declarator.id.type === "ArrayPattern" &&
    Array.isArray(declarator.id.elements)
  ) {
    const index = declarator.id.elements.findIndex(
      (element) => isIdentifierReference(element) && element.name === node.name,
    );
    let initializer = unwrapExpression(stableInitializer(variable));
    if (initializer?.type === "AwaitExpression") {
      initializer = unwrapExpression(initializer.argument);
    }
    if (
      initializer?.type === "CallExpression" &&
      isAstNode(initializer.callee) &&
      initializer.callee.type === "MemberExpression" &&
      propertyName(initializer.callee) === "all" &&
      Array.isArray(initializer.arguments)
    ) {
      initializer = unwrapExpression(initializer.arguments.at(0));
    }
    return (
      index !== -1 &&
      initializer?.type === "ArrayExpression" &&
      Array.isArray(initializer.elements) &&
      isRawStatus({ context, value: initializer.elements.at(index), seen })
    );
  }
  return isRawStatus({ context, value: stableInitializer(variable), seen });
};

// Follow values, not tests: comparing a status and returning literal 0/1 is
// not forwarding it. Local aliases and return values retain their provenance.
const isRawStatus = ({
  context,
  value,
  seen = new Set<unknown>(),
}: ProvenanceOptions): boolean => {
  const node = unwrapExpression(value);
  if (node === null || seen.has(node) || isNormalized(context, node)) {
    return false;
  }
  seen.add(node);
  switch (node.type) {
    case "MemberExpression":
      return (
        RAW_PROPERTIES.has(propertyName(node) ?? "") &&
        isChildResult({ context, value: node.object })
      );
    case "AwaitExpression":
      return isRawStatus({ context, value: node.argument, seen });
    case "UnaryExpression":
      return (
        typeof node.operator === "string" &&
        NUMERIC_UNARY_OPERATORS.has(node.operator) &&
        isRawStatus({ context, value: node.argument, seen })
      );
    case "BinaryExpression":
      if (
        typeof node.operator !== "string" ||
        !NUMERIC_BINARY_OPERATORS.has(node.operator)
      ) {
        return false;
      }
      return (
        isRawStatus({ context, value: node.left, seen: new Set(seen) }) ||
        isRawStatus({ context, value: node.right, seen: new Set(seen) })
      );
    case "ConditionalExpression":
      return (
        isRawStatus({ context, value: node.consequent, seen: new Set(seen) }) ||
        isRawStatus({ context, value: node.alternate, seen: new Set(seen) })
      );
    case "LogicalExpression":
      return (
        isRawStatus({ context, value: node.left, seen: new Set(seen) }) ||
        isRawStatus({ context, value: node.right, seen: new Set(seen) })
      );
    case "SequenceExpression":
      return (
        Array.isArray(node.expressions) &&
        isRawStatus({ context, value: node.expressions.at(-1), seen })
      );
    case "CallExpression":
      return rawCallStatus({ context, node, seen });
    case "Identifier":
      return rawIdentifierStatus({ context, node, seen });
    default:
      return false;
  }
};

export default eslintCompatPlugin({
  meta: { name: "no-raw-child-exit-status" },
  rules: {
    "no-raw-child-exit-status": {
      meta: {
        type: "problem",
        messages: {
          rawStatus:
            "Normalize child termination with the shared childExitStatus helper before setting the process exit status.",
        },
      },
      createOnce(context) {
        let owned = false;
        return {
          before() {
            owned = isFileIn(context, [`${OWNER}.ts`]);
          },
          CallExpression(node) {
            if (
              !owned &&
              isExit({ context, value: node.callee }) &&
              isRawStatus({ context, value: node.arguments.at(0) })
            ) {
              context.report({ node, messageId: "rawStatus" });
            }
          },
          AssignmentExpression(node) {
            const target = unwrapExpression(node.left);
            if (
              !owned &&
              target?.type === "MemberExpression" &&
              propertyName(target) === "exitCode" &&
              isProcess({ context, value: target.object }) &&
              isRawStatus({ context, value: node.right })
            ) {
              context.report({ node, messageId: "rawStatus" });
            }
          },
        };
      },
    },
  },
});
