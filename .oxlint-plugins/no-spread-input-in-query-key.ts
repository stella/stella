// Disallow spreading a bare input object into a TanStack Query key array.
//
// A `queryKey` array (and the arrays returned by `*Keys` query-key-factory
// helpers) must compose other query-key *composition calls* only, never a
// caller-supplied object or identifier. Spreading `...input` / `...filters`
// leaks every property of the source object into the cache identity, which
// causes spurious refetches, stale reads, unbounded cache growth, and makes
// tenant-scoping reasoning impossible (extra keys you never declared).
//
// Spread a composition call or a `*Keys` member instead, then list the
// concrete cache-identity fields explicitly.
//
// Flagged:
//   queryKey: [...entitiesKeys.all(ws), ...filters]
//   queryKey: [...input]
//   list: (input) => [...entitiesKeys.all(input.ws), ...input]
//   page: (key) => [...entitiesKeys.all(key.ws), { ...key }]
//
// Allowed:
//   queryKey: [...entitiesKeys.all(ws), { filters, sorts, page }]
//   list: (key) => [...caseLawDecisionKeys.all, "list", { court: key.court }]
//   thread: (org, key) => [...chatKeys.all, org, key.threadId]
//   // composition-call argument spread is not a key-array element:
//   queryKey: chatKeys.thread(org, { ...key, contextKind })
//   // destructuring rest is not an array spread element:
//   const { search, ...listFilters } = filters

import { getPropertyName, unwrapExpression } from "./utils.ts";

// An array element may only spread a query-key composition member/call rooted
// at a `*Keys` factory (`...entitiesKeys.all(ws)`, `...chatKeys.all`). Other
// spreads leak undeclared shape into the cache key.
const rootIdentifier = (node) => {
  const unwrapped = unwrapExpression(node);
  if (!unwrapped || typeof unwrapped.type !== "string") {
    return null;
  }
  if (unwrapped.type === "Identifier") {
    return unwrapped;
  }
  if (unwrapped.type === "MemberExpression") {
    return rootIdentifier(unwrapped.object);
  }
  if (unwrapped.type === "CallExpression") {
    return rootIdentifier(unwrapped.callee);
  }
  return null;
};

const isAllowedCompositionSpread = (node) => {
  const unwrapped = unwrapExpression(node);
  if (!unwrapped || typeof unwrapped.type !== "string") {
    return false;
  }
  if (unwrapped.type === "MemberExpression") {
    return rootIdentifier(unwrapped.object)?.name.endsWith("Keys") === true;
  }
  if (unwrapped.type === "CallExpression") {
    return isAllowedCompositionSpread(unwrapped.callee);
  }
  return false;
};

const isLeakySpread = (element) => {
  if (!element || element.type !== "SpreadElement") {
    return false;
  }
  return !isAllowedCompositionSpread(element.argument);
};

const isExplicitObjectSpreadValue = (node) => {
  const unwrapped = unwrapExpression(node);
  if (!unwrapped || typeof unwrapped.type !== "string") {
    return false;
  }
  if (unwrapped.type === "ObjectExpression") {
    return unwrapped.properties.every((property) => {
      if (property?.type === "SpreadElement") {
        return isExplicitObjectSpreadValue(property.argument);
      }
      return property?.computed !== true;
    });
  }
  if (unwrapped.type === "LogicalExpression" && unwrapped.operator === "&&") {
    return isExplicitObjectSpreadValue(unwrapped.right);
  }
  if (unwrapped.type === "ConditionalExpression") {
    return (
      isExplicitObjectSpreadValue(unwrapped.consequent) &&
      isExplicitObjectSpreadValue(unwrapped.alternate)
    );
  }
  return false;
};

const isLeakyObjectSpread = (property) =>
  property?.type === "SpreadElement" &&
  !isExplicitObjectSpreadValue(property.argument);

const parentAfterExpressionWrappers = (node) => {
  let current = node.parent;
  while (
    current?.type === "TSAsExpression" ||
    current?.type === "TSSatisfiesExpression"
  ) {
    current = current.parent;
  }
  return current;
};

const isInsideKeysFactoryObject = (objectExpression) => {
  let current = objectExpression;
  while (current?.type === "ObjectExpression") {
    const owner = parentAfterExpressionWrappers(current);
    if (owner?.type === "VariableDeclarator") {
      const id = owner.id;
      return id?.type === "Identifier" && id.name.endsWith("Keys");
    }
    if (owner?.type !== "Property") {
      return false;
    }
    const parentObject = owner.parent;
    if (parentObject?.type !== "ObjectExpression") {
      return false;
    }
    current = parentObject;
  }
  return false;
};

// Walk up from an ArrayExpression to decide whether it is the array returned
// by an arrow function that is a property value of a `const <name>Keys = {...}`
// query-key-factory object, including nested namespaces under that object.
// Handles direct arrow bodies (`() => [...]`), block bodies
// (`() => { return [...] }`), and ternary branches
// (`(key) => cond ? [...] : [...]`).
const isQueryKeyFactoryReturn = (arrayNode) => {
  let current = parentAfterExpressionWrappers(arrayNode);

  // Unwrap a ReturnStatement and/or a ConditionalExpression sitting between
  // the array and the arrow function.
  if (current?.type === "ConditionalExpression") {
    current = parentAfterExpressionWrappers(current);
  }
  if (current?.type === "ReturnStatement") {
    // `return <array>` or `return cond ? <array> : ...`; climb to the
    // function body block, then to the arrow itself.
    current = current.parent;
    while (current && current.type === "BlockStatement") {
      current = current.parent;
    }
  }

  if (current?.type !== "ArrowFunctionExpression") {
    return false;
  }

  const property = current.parent;
  if (property?.type !== "Property") {
    return false;
  }

  const objectExpression = property.parent;
  if (objectExpression?.type !== "ObjectExpression") {
    return false;
  }

  return isInsideKeysFactoryObject(objectExpression);
};

export default {
  meta: { name: "no-spread-input-in-query-key" },
  rules: {
    "no-spread-input-in-query-key": {
      meta: {
        type: "problem",
        messages: {
          spreadInputInQueryKey:
            "Do not spread a bare input object into a query key. " +
            "Spreading leaks every property of the source into the " +
            "cache identity (spurious refetches, stale reads, unbounded " +
            "cache growth). Spread a `*Keys` composition call " +
            "(`...entitiesKeys.all(ws)`) and list concrete cache-identity " +
            "fields explicitly instead.",
        },
      },
      create(context) {
        const reportLeakyValue = (node) => {
          const value = unwrapExpression(node);
          if (!value || typeof value.type !== "string") {
            return;
          }
          if (value.type === "LogicalExpression" && value.operator === "&&") {
            reportLeakyValue(value.right);
            return;
          }
          if (value.type === "ConditionalExpression") {
            reportLeakyValue(value.consequent);
            reportLeakyValue(value.alternate);
            return;
          }
          if (value.type === "ArrayExpression") {
            for (const element of value.elements) {
              if (isLeakySpread(element)) {
                context.report({
                  node: element,
                  messageId: "spreadInputInQueryKey",
                });
                continue;
              }
              reportLeakyValue(element);
            }
            return;
          }
          if (value.type !== "ObjectExpression") {
            return;
          }
          for (const property of value.properties) {
            if (isLeakyObjectSpread(property)) {
              context.report({
                node: property,
                messageId: "spreadInputInQueryKey",
              });
              continue;
            }
            if (property?.type === "SpreadElement") {
              reportLeakyValue(property.argument);
              continue;
            }
            if (property?.type === "Property") {
              reportLeakyValue(property.value);
            }
          }
        };

        return {
          // Scope 1: the array that is the value of a `queryKey` property.
          Property(node) {
            if (getPropertyName(node.key) !== "queryKey") {
              return;
            }
            const value = unwrapExpression(node.value);
            if (value?.type !== "ArrayExpression") {
              return;
            }
            reportLeakyValue(value);
          },

          // Scope 2: the array returned by a `*Keys` factory helper arrow.
          ArrayExpression(node) {
            if (!isQueryKeyFactoryReturn(node)) {
              return;
            }
            reportLeakyValue(node);
          },
        };
      },
    },
  },
};
