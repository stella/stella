/**
 * Invariant: a browser write issued as a capability declares that capability
 * on the request, and names it statically.
 *
 * `invokeCapability(id, (request) => ...)` and the `mutationFn(variables,
 * request)` of `useCapabilityMutation({ capability: id, ... })` hand the
 * callback the request options that carry the declared capability id. The API
 * refuses a declared id that does not own the route, so the declaration is the
 * runtime binding between a browser write and the capability catalog; a write
 * that drops `request` would run undeclared and escape that check.
 *
 * Rejected:
 *   invokeCapability("chat.threads.update", () => api.chat.threads(p).patch(body))
 *   invokeCapability(id, (request) => ...)        // id is not a string literal
 *   useCapabilityMutation({ capability: "x.y", mutationFn: (vars, request) =>
 *     api.x.post(vars) })                         // request not passed
 * Accepted:
 *   invokeCapability("x.y", (request) => api.x.post(body, request))
 *   (request) => api.x({ id }).patch(body, { ...request, query })
 *
 * Boundary: the API client write must sit directly in the capability callback (not in
 * a nested function) and be rooted at a registered client import, followed
 * through local immutable aliases. Writes outside capability callbacks are
 * counted by the `undeclared-eden-writes` ratchet metric, which can only
 * shrink; this rule checks the shape of declared writes.
 */
import { eslintCompatPlugin } from "@oxlint/plugins";

import { CAPABILITY_REQUEST_HEADER } from "../packages/api-contract/src/capability-request.ts";
import {
  API_CLIENT_CLIENT_EXPORTS,
  API_CLIENT_CLIENT_MODULES,
  API_CLIENT_WRITE_METHODS,
  API_CLIENT_WRITE_OPTIONS_INDEX,
} from "./api-client-chain.ts";
import type { AstNode, ImportedFromOptions } from "./utils.ts";
import {
  getPropertyName,
  isAstNode,
  isIdentifier,
  isIdentifierReference,
  isImportedFrom,
  isStringLiteral,
  memberPropertyName,
  resolveVariable,
  stableInitializer,
  unwrapExpression,
} from "./utils.ts";

type Context = ImportedFromOptions["context"];

const INVOKE_MODULES = [
  "@/lib/capabilities/capability-request",
  "apps/web/src/lib/capabilities/capability-request",
];
const INVOKE_NAMES = new Set(["invokeCapability"]);
const MUTATION_MODULES = [
  "@/lib/capabilities/use-capability-mutation",
  "apps/web/src/lib/capabilities/use-capability-mutation",
];
const MUTATION_NAMES = new Set(["useCapabilityMutation"]);
const FUNCTION_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionExpression",
  "FunctionDeclaration",
]);

const isClientRooted = (
  context: Context,
  value: unknown,
  visited = new Set<unknown>(),
): boolean => {
  const node = unwrapExpression(value);
  if (node === null || visited.has(node)) {
    return false;
  }
  visited.add(node);
  if (
    isImportedFrom({
      context,
      node,
      modules: API_CLIENT_CLIENT_MODULES,
      names: API_CLIENT_CLIENT_EXPORTS,
    })
  ) {
    return true;
  }
  if (node.type === "MemberExpression") {
    return isClientRooted(context, node.object, visited);
  }
  if (node.type === "CallExpression") {
    return isClientRooted(context, node.callee, visited);
  }
  if (!isIdentifierReference(node)) {
    return false;
  }
  const variable = resolveVariable(context, node);
  const initializer = variable === null ? null : stableInitializer(variable);
  return initializer !== null && isClientRooted(context, initializer, visited);
};

const isApiClientWrite = (context: Context, call: AstNode): boolean => {
  const callee = unwrapExpression(call.callee);
  if (callee?.type !== "MemberExpression") {
    return false;
  }
  const method = memberPropertyName(callee);
  return (
    method !== null &&
    API_CLIENT_WRITE_METHODS.has(method) &&
    isClientRooted(context, callee.object)
  );
};

const nearestFunction = (node: AstNode): AstNode | null => {
  let current = isAstNode(node.parent) ? node.parent : null;
  while (current !== null && !FUNCTION_TYPES.has(current.type)) {
    current = isAstNode(current.parent) ? current.parent : null;
  }
  return current;
};

const paramName = (fn: AstNode, index: number): string | null => {
  const param = Array.isArray(fn.params) ? fn.params.at(index) : undefined;
  return isIdentifier(param) ? param.name : null;
};

/** The request parameter name when `fn` is a capability callback. */
const capabilityRequestParam = (
  context: Context,
  fn: AstNode,
): { type: "callback"; request: string | null } | { type: "other" } => {
  const parent = isAstNode(fn.parent) ? fn.parent : null;
  if (
    parent?.type === "CallExpression" &&
    Array.isArray(parent.arguments) &&
    parent.arguments.at(1) === fn &&
    isImportedFrom({
      context,
      node: parent.callee,
      modules: INVOKE_MODULES,
      names: INVOKE_NAMES,
    })
  ) {
    return { type: "callback", request: paramName(fn, 0) };
  }
  const options = isAstNode(parent?.parent) ? parent.parent : null;
  const call = isAstNode(options?.parent) ? options.parent : null;
  if (
    parent?.type === "Property" &&
    getPropertyName(parent.key) === "mutationFn" &&
    options?.type === "ObjectExpression" &&
    call?.type === "CallExpression" &&
    isImportedFrom({
      context,
      node: call.callee,
      modules: MUTATION_MODULES,
      names: MUTATION_NAMES,
    })
  ) {
    return { type: "callback", request: paramName(fn, 1) };
  }
  return { type: "other" };
};

const passesRequest = (call: AstNode, request: string): boolean => {
  const options = Array.isArray(call.arguments)
    ? unwrapExpression(call.arguments.at(API_CLIENT_WRITE_OPTIONS_INDEX))
    : null;
  if (options === null) {
    return false;
  }
  if (isIdentifierReference(options)) {
    return options.name === request;
  }
  if (
    options.type !== "ObjectExpression" ||
    !Array.isArray(options.properties)
  ) {
    return false;
  }
  const properties: unknown[] = options.properties;
  const spread = properties.findLastIndex(
    (property) =>
      isAstNode(property) &&
      property.type === "SpreadElement" &&
      isIdentifierReference(property.argument) &&
      property.argument.name === request,
  );
  // Anything after the spread that may replace `headers` drops the
  // capability declaration the request carries.
  return (
    spread !== -1 &&
    properties
      .slice(spread + 1)
      .every((property) => !mayReplaceHeaders(property, request))
  );
};

const mayReplaceHeaders = (property: unknown, request: string): boolean => {
  if (!isAstNode(property) || property.type !== "Property") {
    return true;
  }
  if (property.computed === true) {
    return true;
  }
  const key = property.key;
  if (!isAstNode(key)) {
    return true;
  }
  if (
    (key.type !== "Identifier" || key.name !== "headers") &&
    (key.type !== "Literal" || key.value !== "headers")
  ) {
    return false;
  }
  const headers = unwrapExpression(property.value);
  if (
    headers?.type !== "ObjectExpression" ||
    !Array.isArray(headers.properties)
  ) {
    return true;
  }
  // HTTP header names ignore case. Every custom name must be static and
  // distinct from the declaration before the exact request headers are spread.
  const custom = headers.properties.slice(0, -1);
  if (
    custom.some((header) => {
      if (
        !isAstNode(header) ||
        header.type !== "Property" ||
        header.computed === true ||
        header.method === true ||
        header.kind !== "init"
      ) {
        return true;
      }
      const name = getPropertyName(header.key);
      return (
        name === null ||
        name.toLowerCase() === CAPABILITY_REQUEST_HEADER.toLowerCase()
      );
    })
  ) {
    return true;
  }
  const final = headers.properties.at(-1);
  if (!isAstNode(final) || final.type !== "SpreadElement") {
    return true;
  }
  const source = unwrapExpression(final.argument);
  return !(
    source?.type === "MemberExpression" &&
    memberPropertyName(source) === "headers" &&
    isIdentifierReference(source.object) &&
    source.object.name === request
  );
};

const capabilityArgument = (
  context: Context,
  call: AstNode,
): { type: "declared"; node: unknown } | { type: "none" } => {
  // Both wrappers are plain imported functions; skip member calls cheaply.
  if (
    !Array.isArray(call.arguments) ||
    !isIdentifierReference(unwrapExpression(call.callee))
  ) {
    return { type: "none" };
  }
  if (
    isImportedFrom({
      context,
      node: call.callee,
      modules: INVOKE_MODULES,
      names: INVOKE_NAMES,
    })
  ) {
    return { type: "declared", node: call.arguments.at(0) };
  }
  if (
    !isImportedFrom({
      context,
      node: call.callee,
      modules: MUTATION_MODULES,
      names: MUTATION_NAMES,
    })
  ) {
    return { type: "none" };
  }
  const options = unwrapExpression(call.arguments.at(0));
  const property =
    options?.type === "ObjectExpression" && Array.isArray(options.properties)
      ? options.properties.find(
          (candidate: unknown) =>
            isAstNode(candidate) &&
            candidate.type === "Property" &&
            getPropertyName(candidate.key) === "capability",
        )
      : undefined;
  return {
    type: "declared",
    node: isAstNode(property) ? property.value : undefined,
  };
};

export default eslintCompatPlugin({
  meta: { name: "capability-request" },
  rules: {
    "capability-request": {
      meta: {
        type: "problem",
        messages: {
          undeclaredRequest:
            "Pass the capability callback's request options to this write (`request` or `{ ...request, query }`) so the API can check the declared capability.",
          dynamicCapability:
            "Name the capability with a string literal so each browser write declares a statically known catalog capability.",
        },
      },
      createOnce(context) {
        return {
          CallExpression(node: unknown) {
            if (!isAstNode(node)) {
              return;
            }
            const capability = capabilityArgument(context, node);
            if (
              capability.type === "declared" &&
              !isStringLiteral(unwrapExpression(capability.node))
            ) {
              context.report({ node, messageId: "dynamicCapability" });
            }
            if (!isApiClientWrite(context, node)) {
              return;
            }
            const fn = nearestFunction(node);
            if (fn === null) {
              return;
            }
            const callback = capabilityRequestParam(context, fn);
            if (callback.type === "other") {
              return;
            }
            if (
              callback.request === null ||
              !passesRequest(node, callback.request)
            ) {
              context.report({ node, messageId: "undeclaredRequest" });
            }
          },
        };
      },
    },
  },
});
