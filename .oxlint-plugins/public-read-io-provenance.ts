import type { Variable } from "@oxlint/plugins";

import {
  PUBLIC_READ_IO_METHODS,
  PUBLIC_READ_TRANSPORTS,
} from "../apps/api/src/lib/legal-search/public-read-transports.ts";
import {
  isAstNode,
  isIdentifierReference,
  isSingleAssignment,
  isStringLiteral,
  memberPropertyName,
  patternKeyFor,
  resolveImport,
  resolveVariable,
  stableInitializer,
  unwrapExpression,
} from "./utils.ts";
import type { AstNode, FilenameContext, ScopeContext } from "./utils.ts";

export const PUBLIC_READ_SERVING_ROOTS = [
  "apps/api/src/lib/legal-search/",
  "apps/api/src/handlers/case-law/decisions/",
  "apps/api/src/handlers/legal-resolve/",
  "apps/api/src/handlers/legislation/",
];

const PUBLIC_READ_OWNER =
  "apps/api/src/lib/legal-search/public-read-timeout-context";
const IO_METHODS = new Set(Object.keys(PUBLIC_READ_IO_METHODS));
const IO_METHOD_KINDS = new Map(Object.entries(PUBLIC_READ_IO_METHODS));

export const publicReadIoMethodKind = (method: string | null) =>
  method === null ? undefined : IO_METHOD_KINDS.get(method);
const TRANSPORT_CALL_METHODS = new Set([...IO_METHODS, "transaction"]);
const TRANSPORT_NAMES = new Set(Object.keys(PUBLIC_READ_TRANSPORTS));

type PublicReadIoContext = ScopeContext & FilenameContext;

const publicReadIoCallback = (
  context: PublicReadIoContext,
  node: unknown,
): { transport: string; parameter: Variable | null } | null => {
  if (!isAstNode(node) || !Array.isArray(node.params)) {
    return null;
  }
  const parent = node.parent;
  if (
    !isAstNode(parent) ||
    parent.type !== "CallExpression" ||
    !Array.isArray(parent.arguments) ||
    parent.arguments.at(1) !== node
  ) {
    return null;
  }
  const binding = resolveImport(context, parent.callee);
  const transport = parent.arguments.at(0);
  if (
    binding?.moduleId !== PUBLIC_READ_OWNER ||
    binding.imported !== "withPublicReadIo" ||
    !isStringLiteral(transport) ||
    !TRANSPORT_NAMES.has(transport.value)
  ) {
    return null;
  }
  const parameter = node.params.at(0);
  return {
    transport: transport.value,
    parameter: isIdentifierReference(parameter)
      ? resolveVariable(context, parameter)
      : null,
  };
};

type PublicReadIoSource = {
  transport: string;
  method: string | null;
};
type IssuedIoSourceOptions = {
  context: PublicReadIoContext;
  node: unknown;
  variable: Variable;
};

const issuedIoSource = ({
  context,
  node,
  variable,
}: IssuedIoSourceOptions): PublicReadIoSource | null => {
  const callback = publicReadIoCallback(context, node);
  if (callback === null) {
    return null;
  }
  if (callback.parameter === variable) {
    return { transport: callback.transport, method: null };
  }
  const functionNode = node;
  const pattern =
    isAstNode(functionNode) && Array.isArray(functionNode.params)
      ? functionNode.params.at(0)
      : null;
  const method =
    isAstNode(pattern) && pattern.type === "ObjectPattern"
      ? patternKeyFor(pattern, variable.defs.at(0)?.name)
      : null;
  return method !== null && IO_METHODS.has(method)
    ? { transport: callback.transport, method }
    : null;
};

type PublicReadIoSourceOptions = {
  context: PublicReadIoContext;
  node: unknown;
  seen?: Set<unknown>;
};

const ioSource = ({
  context,
  node,
  seen = new Set<unknown>(),
}: PublicReadIoSourceOptions): PublicReadIoSource | null => {
  const expression = unwrapExpression(node);
  if (expression === null || seen.has(expression)) {
    return null;
  }
  seen.add(expression);
  if (expression.type === "CallExpression") {
    const callee = unwrapExpression(expression.callee);
    return callee?.type === "MemberExpression" &&
      memberPropertyName(callee) === "bind"
      ? ioSource({ context, node: callee.object, seen })
      : null;
  }
  if (expression.type === "MemberExpression") {
    const source = ioSource({ context, node: expression.object, seen });
    const method = memberPropertyName(expression);
    return source?.method === null && method !== null && IO_METHODS.has(method)
      ? { transport: source.transport, method }
      : null;
  }
  if (!isIdentifierReference(expression)) {
    return null;
  }
  const variable = resolveVariable(context, expression);
  const definition = variable?.defs.at(0);
  if (
    variable === null ||
    definition === undefined ||
    !isSingleAssignment(variable)
  ) {
    return null;
  }
  if (definition.type === "Parameter") {
    return issuedIoSource({ context, node: definition.node, variable });
  }
  const initializer = stableInitializer(variable);
  const source = ioSource({ context, node: initializer, seen });
  const declaration = definition.node;
  if (
    source === null ||
    !isAstNode(declaration) ||
    !isAstNode(declaration.id) ||
    declaration.id.type !== "ObjectPattern"
  ) {
    return source;
  }
  const method = patternKeyFor(declaration.id, definition.name);
  return source.method === null && method !== null && IO_METHODS.has(method)
    ? { transport: source.transport, method }
    : null;
};

/** Only a parameter issued by the canonical scope owner proves a transport handle. */
export const publicReadIoMethod = (
  context: PublicReadIoContext,
  node: unknown,
): { transport: string; method: string } | null => {
  const source = ioSource({ context, node });
  return source?.method
    ? { transport: source.transport, method: source.method }
    : null;
};

export const publicReadIoWrapper = (
  context: PublicReadIoContext,
  call: AstNode,
) =>
  call.type === "CallExpression" && Array.isArray(call.arguments)
    ? publicReadIoCallback(context, unwrapExpression(call.arguments.at(1)))
    : null;

/** Statically selected methods retain their kind through local aliases. */
export const publicReadIoCallMethod = (
  context: PublicReadIoContext,
  node: unknown,
  seen = new Set<unknown>(),
): string | null => {
  const expression = unwrapExpression(node);
  if (expression === null || seen.has(expression)) {
    return null;
  }
  seen.add(expression);
  if (expression.type === "CallExpression") {
    const callee = unwrapExpression(expression.callee);
    return callee?.type === "MemberExpression" &&
      memberPropertyName(callee) === "bind"
      ? publicReadIoCallMethod(context, callee.object, seen)
      : null;
  }
  if (expression.type === "MemberExpression") {
    const method = memberPropertyName(expression);
    return method !== null && TRANSPORT_CALL_METHODS.has(method)
      ? method
      : null;
  }
  if (!isIdentifierReference(expression)) {
    return null;
  }
  const variable = resolveVariable(context, expression);
  if (variable === null) {
    return null;
  }
  const definition = variable.defs.at(0);
  const declaration = definition?.node;
  const pattern =
    isAstNode(declaration) && declaration.type === "VariableDeclarator"
      ? declaration.id
      : isAstNode(declaration) && Array.isArray(declaration.params)
        ? declaration.params.at(0)
        : null;
  const method =
    isAstNode(pattern) && pattern.type === "ObjectPattern"
      ? patternKeyFor(pattern, definition?.name)
      : null;
  return method !== null && TRANSPORT_CALL_METHODS.has(method)
    ? method
    : publicReadIoCallMethod(context, stableInitializer(variable), seen);
};
