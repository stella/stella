import { eslintCompatPlugin } from "@oxlint/plugins";
// Require a query-key factory reference at every cache-touching call site.
//
// `QueryKey` is `unknown[]`, so a key typed out at an invalidation site
// compiles forever while the factory it is meant to mirror moves underneath
// it: the invalidation then matches nothing and the surface serves stale data
// for its whole stale window. The same holds for a filter predicate that
// compares key positions inline — it duplicates the factory's layout in a
// form nothing checks.
//
// Flagged:
//   queryClient.invalidateQueries({ queryKey: ["contacts", orgId] })
//   queryClient.setQueryData(["chat", orgId, "thread"], next)
//   queryClient.removeQueries({
//     predicate: (query) => query.queryKey.at(0) === "chat",
//   })
//
// Allowed:
//   queryClient.invalidateQueries({ queryKey: contactsKeys.lists(orgId) })
//   queryClient.setQueryData(chatKeys.thread(orgId, threadRef), next)
//   queryClient.invalidateQueries({
//     predicate: (query) => matchesChatThread(query.queryKey, threadRef),
//   })
//   // no key at all (dev-only blanket refresh) stays untouched:
//   queryClient.invalidateQueries()
//
// The factory the key comes from is the one place the layout is declared, so
// it is also the one place a predicate's positional walk belongs. When a call
// site genuinely cannot reference one, suppress with a reason.

import { getPropertyName, isAstNode, unwrapExpression } from "./utils.ts";

const CACHE_METHODS = new Set([
  "invalidateQueries",
  "setQueryData",
  "removeQueries",
  "cancelQueries",
]);

// `setQueryData(key, updater)` takes the key positionally; the filter-based
// methods take it as `queryKey` inside their options object.
const POSITIONAL_KEY_METHODS = new Set(["setQueryData"]);

const calleeMethodName = (callee) => {
  const unwrapped = unwrapExpression(callee);
  if (
    !unwrapped ||
    unwrapped.type !== "MemberExpression" ||
    unwrapped.computed !== false
  ) {
    return null;
  }
  return getPropertyName(unwrapped.property);
};

// The initializer of a local `const` binding the node names, so a filters
// object or a key hoisted into a variable resolves to the same literal the
// inline form would have carried. One level only: a binding initialized from
// another binding is not a hand-typed key at this call site. `let` is skipped
// because a later write can replace the value this would report on.
const constInitializer = (identifier, context) => {
  let scope = context.sourceCode.getScope(identifier);
  while (scope) {
    const variable = scope.set.get(identifier.name);
    if (variable) {
      if (variable.defs.length !== 1) {
        return null;
      }
      const definition = variable.defs.at(0);
      if (
        !isAstNode(definition?.node) ||
        definition.node.type !== "VariableDeclarator" ||
        definition.parent?.kind !== "const"
      ) {
        return null;
      }
      return unwrapExpression(definition.node.init) ?? null;
    }
    scope = scope.upper;
  }
  return null;
};

// A literal of `expected` type written here, or held by a local `const` this
// names. Both forms restate the factory's layout where nothing checks it.
const literalOf = (node, expected, context) => {
  const unwrapped = unwrapExpression(node);
  if (!unwrapped) {
    return null;
  }
  if (unwrapped.type === expected) {
    return unwrapped;
  }
  if (unwrapped.type !== "Identifier") {
    return null;
  }
  const initializer = constInitializer(unwrapped, context);
  return initializer?.type === expected ? initializer : null;
};

// `queryKey`, `query.queryKey`, `q.queryKey` — the value a predicate walks.
const isQueryKeyReference = (node) => {
  const unwrapped = unwrapExpression(node);
  if (!unwrapped) {
    return false;
  }
  if (unwrapped.type === "Identifier") {
    return unwrapped.name === "queryKey";
  }
  if (unwrapped.type === "MemberExpression" && unwrapped.computed === false) {
    return getPropertyName(unwrapped.property) === "queryKey";
  }
  return false;
};

const isNumericLiteral = (node) => {
  const unwrapped = unwrapExpression(node);
  if (!unwrapped) {
    return false;
  }
  if (unwrapped.type === "Literal") {
    return typeof unwrapped.value === "number";
  }
  // `.at(-1)` parses as a unary minus around the literal.
  return (
    unwrapped.type === "UnaryExpression" &&
    unwrapped.operator === "-" &&
    isNumericLiteral(unwrapped.argument)
  );
};

// `queryKey.at(3)` or `queryKey[3]`: a position read off a key.
const isKeyPositionRead = (node) => {
  const unwrapped = unwrapExpression(node);
  if (!unwrapped) {
    return false;
  }
  if (unwrapped.type === "CallExpression") {
    const callee = unwrapExpression(unwrapped.callee);
    if (
      !callee ||
      callee.type !== "MemberExpression" ||
      callee.computed !== false ||
      getPropertyName(callee.property) !== "at"
    ) {
      return false;
    }
    const args = Array.isArray(unwrapped.arguments) ? unwrapped.arguments : [];
    return (
      args.length === 1 &&
      isNumericLiteral(args.at(0)) &&
      isQueryKeyReference(callee.object)
    );
  }
  if (unwrapped.type === "MemberExpression" && unwrapped.computed === true) {
    return (
      isNumericLiteral(unwrapped.property) &&
      isQueryKeyReference(unwrapped.object)
    );
  }
  return false;
};

// A `predicate:` property anywhere above this node — query filters are the
// only place the option appears in web code, and the enclosing filters object
// is often hoisted into a local, so the call site is not a reliable anchor.
const isInsidePredicateOption = (node) => {
  let current = node.parent;
  while (isAstNode(current)) {
    if (
      current.type === "Property" &&
      getPropertyName(current.key) === "predicate"
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
};

export default eslintCompatPlugin({
  meta: { name: "require-query-key-factory" },
  rules: {
    "require-query-key-factory": {
      meta: {
        type: "problem",
        messages: {
          inlineQueryKey:
            "Pass a query-key factory call here, not an inline array. A " +
            "hand-typed key silently stops matching when the factory's shape " +
            "changes (QueryKey is unknown[]), leaving the cache stale.",
          inlinePredicate:
            "Match the key with a named helper exported next to the factory " +
            "(for example `matchesChatThread(query.queryKey, threadRef)`), " +
            "not with inline key-position comparisons that restate the " +
            "factory's layout where nothing checks it.",
        },
      },
      createOnce(context) {
        return {
          CallExpression(node) {
            const method = calleeMethodName(node.callee);
            if (method === null || !CACHE_METHODS.has(method)) {
              return;
            }
            const args = Array.isArray(node.arguments) ? node.arguments : [];

            if (POSITIONAL_KEY_METHODS.has(method)) {
              const positionalKey = literalOf(
                args.at(0),
                "ArrayExpression",
                context,
              );
              if (positionalKey) {
                context.report({
                  node: positionalKey,
                  messageId: "inlineQueryKey",
                });
              }
            }

            for (const argument of args) {
              const options = literalOf(argument, "ObjectExpression", context);
              if (!options) {
                continue;
              }
              const properties = Array.isArray(options.properties)
                ? options.properties
                : [];
              for (const property of properties) {
                if (
                  property?.type !== "Property" ||
                  getPropertyName(property.key) !== "queryKey"
                ) {
                  continue;
                }
                const key = literalOf(property.value, "ArrayExpression", context);
                if (!key) {
                  continue;
                }
                context.report({ node: key, messageId: "inlineQueryKey" });
              }
            }
          },

          BinaryExpression(node) {
            if (node.operator !== "===" && node.operator !== "!==") {
              return;
            }
            if (
              !isKeyPositionRead(node.left) &&
              !isKeyPositionRead(node.right)
            ) {
              return;
            }
            if (!isInsidePredicateOption(node)) {
              return;
            }
            context.report({ node, messageId: "inlinePredicate" });
          },
        };
      },
    },
  },
});
