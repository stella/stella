// Exact cache access must retain the queryOptions data tag. A separate key
// factory plus getQueryData<T>/setQueryData<T> restates the producer's contract
// without checking it. Prefix-based cache filters still use key factories.
//
// This is a syntax guard, not a TypeScript checker: it follows const aliases,
// queryKey destructuring, and conditional branches within the file. Imported
// options/factories and inferred iteration values are trusted at `.queryKey`;
// their inferred types remain the compiler's responsibility. Local factories
// must return options on every explicit return path. Bare objects, key assertions,
// widened key aliases, and mutable aliases are rejected. Generic helpers may
// accept a DataTag parameter from TanStack; that boundary requires a tagged
// key structurally, without rebuilding a query just to access its cache.
// Static getQueryData/setQueryData member calls are covered regardless of the
// receiver name. Dynamic method dispatch and cross-file alias tracing are not.

import { eslintCompatPlugin } from "@oxlint/plugins";

import { getPropertyName, isStringLiteral } from "./utils.ts";

const CACHE_METHODS = new Set(["getQueryData", "setQueryData"]);
const TANSTACK_MODULES = new Set([
  "@tanstack/react-query",
  "@tanstack/query-core",
]);

const staticPropertyName = (node) =>
  node.computed && !isStringLiteral(node.property ?? node.key)
    ? null
    : getPropertyName(node.property ?? node.key);

const resolveVariable = (identifier, context) => {
  let scope = context.sourceCode.getScope(identifier);
  while (scope) {
    const variable = scope.set.get(identifier.name);
    if (variable) {
      return variable;
    }
    scope = scope.upper;
  }
  return null;
};

const resolveLocalType = ({
  annotation,
  context,
  seen = new Set<unknown>(),
}) => {
  const type =
    annotation?.type === "TSTypeAnnotation"
      ? annotation.typeAnnotation
      : annotation;
  if (type?.type !== "TSTypeReference" || type.typeName.type !== "Identifier") {
    return type;
  }
  const variable = resolveVariable(type.typeName, context);
  const definition = variable?.defs.at(0);
  if (
    definition?.node.type !== "TSTypeAliasDeclaration" ||
    seen.has(variable)
  ) {
    return type;
  }
  seen.add(variable);
  return resolveLocalType({
    annotation: definition.node.typeAnnotation,
    context,
    seen,
  });
};

const isDataTagType = (annotation, context): boolean => {
  const type = resolveLocalType({ annotation, context });
  if (type?.type !== "TSTypeReference" || type.typeName.type !== "Identifier") {
    return false;
  }
  const definition = resolveVariable(type.typeName, context)?.defs.at(0);
  return (
    definition?.type === "ImportBinding" &&
    definition.node.type === "ImportSpecifier" &&
    getPropertyName(definition.node.imported) === "DataTag" &&
    TANSTACK_MODULES.has(definition.parent.source.value)
  );
};

// Parameter bindings may be direct or destructured from an inline contract.
const parameterAnnotation = (identifier, context) => {
  if (identifier.typeAnnotation) {
    return identifier.typeAnnotation;
  }
  const property = identifier.parent;
  const pattern = property?.parent;
  if (property?.type !== "Property" || pattern?.type !== "ObjectPattern") {
    return null;
  }
  const annotation = resolveLocalType({
    annotation: pattern.typeAnnotation,
    context,
  });
  if (annotation?.type !== "TSTypeLiteral") {
    return null;
  }
  return annotation.members.find(
    (member) =>
      member.type === "TSPropertySignature" &&
      staticPropertyName(member) === staticPropertyName(property),
  )?.typeAnnotation;
};

const isReactCallback = (callee, context): boolean => {
  if (callee.type !== "Identifier") {
    return false;
  }
  const definition = resolveVariable(callee, context)?.defs.at(0);
  return (
    definition?.type === "ImportBinding" &&
    definition.node.type === "ImportSpecifier" &&
    getPropertyName(definition.node.imported) === "useCallback" &&
    definition.parent.source.value === "react"
  );
};

// Imported factories and inferred iteration values are module boundaries.
// Local aliases and object members must resolve to their actual definitions.
const resolveOptionsValue = ({ node, context, seen }) => {
  if (!node) {
    return null;
  }
  if (
    node.type === "TSSatisfiesExpression" ||
    node.type === "TSNonNullExpression"
  ) {
    return resolveOptionsValue({ node: node.expression, context, seen });
  }
  if (node.type === "CallExpression" && isReactCallback(node.callee, context)) {
    return resolveOptionsValue({ node: node.arguments.at(0), context, seen });
  }
  if (node.type === "Identifier") {
    const variable = resolveVariable(node, context);
    if (!variable || seen.has(variable) || variable.defs.length !== 1) {
      return null;
    }
    seen.add(variable);
    const definition = variable.defs.at(0);
    if (definition.type === "ImportBinding") {
      return { type: "boundary" } as const;
    }
    if (definition.node.type === "FunctionDeclaration") {
      return { type: "local", node: definition.node } as const;
    }
    if (
      definition.node.type !== "VariableDeclarator" ||
      definition.parent?.kind !== "const" ||
      definition.node.id.typeAnnotation
    ) {
      return null;
    }
    if (definition.parent.parent?.type === "ForOfStatement") {
      return { type: "boundary" } as const;
    }
    if (definition.node.id.type !== "Identifier") {
      return null;
    }
    return resolveOptionsValue({ node: definition.node.init, context, seen });
  }
  if (node.type === "MemberExpression") {
    const object = resolveOptionsValue({ node: node.object, context, seen });
    if (object?.type === "boundary") {
      return object;
    }
    if (object?.node.type !== "ObjectExpression") {
      return null;
    }
    const name = staticPropertyName(node);
    if (name === null) {
      return null;
    }
    const property = object.node.properties.find(
      (candidate) =>
        candidate.type === "Property" && staticPropertyName(candidate) === name,
    );
    return resolveOptionsValue({ node: property?.value, context, seen });
  }
  return { type: "local", node } as const;
};

const FUNCTION_NODES = new Set([
  "ArrowFunctionExpression",
  "FunctionExpression",
  "FunctionDeclaration",
]);

// Only statement children can contain returns belonging to this function.
// Nested callbacks' returns must never certify their enclosing factory.
const outerReturns = (node): unknown[] => {
  if (!node || FUNCTION_NODES.has(node.type)) {
    return [];
  }
  if (node.type === "ReturnStatement") {
    return [node.argument];
  }
  const returns: unknown[] = [];
  for (const key of [
    "body",
    "consequent",
    "alternate",
    "cases",
    "block",
    "handler",
    "finalizer",
  ]) {
    const child = node[key];
    for (const statement of Array.isArray(child) ? child : [child]) {
      returns.push(...outerReturns(statement));
    }
  }
  return returns;
};

const isOptionsSource = ({ node, context, seen }): boolean => {
  const source = resolveOptionsValue({ node, context, seen });
  if (!source) {
    return false;
  }
  if (source.type === "boundary") {
    return true;
  }
  if (source.node.type === "ConditionalExpression") {
    return (
      isOptionsSource({
        node: source.node.consequent,
        context,
        seen: new Set(seen),
      }) &&
      isOptionsSource({
        node: source.node.alternate,
        context,
        seen: new Set(seen),
      })
    );
  }
  if (source.node.type !== "CallExpression") {
    return false;
  }
  const factory = resolveOptionsValue({
    node: source.node.callee,
    context,
    seen,
  });
  if (!factory) {
    return false;
  }
  if (factory.type === "boundary") {
    return true;
  }
  if (!FUNCTION_NODES.has(factory.node.type) || factory.node.returnType) {
    return false;
  }
  const body = factory.node.body;
  const returns = body.type === "BlockStatement" ? outerReturns(body) : [body];
  return (
    returns.length > 0 &&
    returns.every((value) =>
      isOptionsSource({ node: value, context, seen: new Set(seen) }),
    )
  );
};

const isOptionsKey = ({
  node,
  context,
  seen = new Set<unknown>(),
}): boolean => {
  if (!node) {
    return false;
  }
  if (
    node.type === "TSSatisfiesExpression" ||
    node.type === "TSNonNullExpression"
  ) {
    return isOptionsKey({ node: node.expression, context, seen });
  }
  if (node.type === "ConditionalExpression") {
    return (
      isOptionsKey({ node: node.consequent, context, seen: new Set(seen) }) &&
      isOptionsKey({ node: node.alternate, context, seen: new Set(seen) })
    );
  }
  if (node.type === "MemberExpression") {
    return (
      staticPropertyName(node) === "queryKey" &&
      isOptionsSource({ node: node.object, context, seen })
    );
  }
  if (node.type !== "Identifier") {
    return false;
  }
  const variable = resolveVariable(node, context);
  if (!variable || seen.has(variable) || variable.defs.length !== 1) {
    return false;
  }
  seen.add(variable);
  const definition = variable.defs.at(0);
  if (definition.type === "Parameter") {
    return isDataTagType(
      parameterAnnotation(definition.name, context),
      context,
    );
  }
  if (
    definition.node.type !== "VariableDeclarator" ||
    definition.parent?.kind !== "const"
  ) {
    return false;
  }
  const binding = definition.node.id;
  if (binding.typeAnnotation) {
    return false;
  }
  if (binding.type === "Identifier") {
    return isOptionsKey({ node: definition.node.init, context, seen });
  }
  if (binding.type !== "ObjectPattern") {
    return false;
  }
  return (
    binding.properties.some(
      (property) =>
        property.type === "Property" &&
        staticPropertyName(property) === "queryKey" &&
        property.value.type === "Identifier" &&
        property.value.name === node.name,
    ) && isOptionsSource({ node: definition.node.init, context, seen })
  );
};

export default eslintCompatPlugin({
  meta: { name: "require-query-options-key" },
  rules: {
    "require-query-options-key": {
      meta: {
        type: "problem",
        messages: {
          optionsKey:
            "Use the query options' .queryKey (or an inferred const alias) for exact cache access. Bare keys lose the producer's data type; keep key factories for prefix invalidation.",
          inferredData:
            "Infer cache data from the query options' .queryKey; explicit getQueryData/setQueryData type arguments can drift from the producer.",
        },
      },
      createOnce(context) {
        return {
          CallExpression(node) {
            const callee = node.callee;
            if (callee.type !== "MemberExpression") {
              return;
            }
            const method = staticPropertyName(callee);
            if (method === null || !CACHE_METHODS.has(method)) {
              return;
            }
            if (node.typeArguments?.params.length) {
              context.report({ node, messageId: "inferredData" });
              return;
            }
            if (!isOptionsKey({ node: node.arguments.at(0), context })) {
              context.report({ node, messageId: "optionsKey" });
            }
          },
        };
      },
    },
  },
});
