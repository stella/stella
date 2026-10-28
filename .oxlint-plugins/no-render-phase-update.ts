import { eslintCompatPlugin } from "@oxlint/plugins";

import baselineCounts from "./no-render-phase-update-baseline.json" with { type: "json" };
import {
  getPropertyName,
  isIdentifier,
  isIdentifierReference,
  repoRelativeFilename,
  resolveVariable,
} from "./utils.ts";

const FUNCTIONS = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);
const ROUTE_HANDLERS = new Set(["beforeLoad", "loader"]);

const functionName = (node) => {
  if (isIdentifier(node.id)) {
    return node.id.name;
  }
  const parent = node.parent;
  if (parent?.type === "VariableDeclarator" && isIdentifier(parent.id)) {
    return parent.id.name;
  }
  if (parent?.type === "Property") {
    return getPropertyName(parent.key);
  }
  return null;
};

const isReactOwner = (node) => {
  const name = functionName(node);
  return name !== null && (/^[A-Z]/u.test(name) || /^use[A-Z0-9]/u.test(name));
};

const enclosingFunction = (node) => {
  let current = node.parent;
  while (current) {
    if (FUNCTIONS.has(current.type)) {
      return current;
    }
    current = current.parent;
  }
  return null;
};

const enclosingReactOwner = (node) => {
  let current = node.parent;
  while (current) {
    if (FUNCTIONS.has(current.type) && isReactOwner(current)) {
      return current;
    }
    current = current.parent;
  }
  return null;
};

const isRouteHandler = (fn) => {
  if (fn?.parent?.type !== "Property") {
    return false;
  }
  const name = getPropertyName(fn.parent.key);
  return name !== null && ROUTE_HANDLERS.has(name);
};

const isGuardedAdjustment = (node, setters, context, owner) => {
  const sameExpression = (left, right) =>
    left === right ||
    (left?.type === "Identifier" &&
      right?.type === "Identifier" &&
      left.name === right.name) ||
    (left?.type === "MemberExpression" &&
      right?.type === "MemberExpression" &&
      sameExpression(left.object, right.object) &&
      getPropertyName(left.property) === getPropertyName(right.property));
  let descendant = node;
  let current = node.parent;
  while (current && !FUNCTIONS.has(current.type)) {
    if (current.type === "IfStatement" && descendant === current.consequent) {
      const test = current.test;
      if (
        test?.type === "BinaryExpression" &&
        ["!==", "!="].includes(test.operator)
      ) {
        const pairs = [
          [test.left, test.right],
          [test.right, test.left],
        ];
        for (const [previousNode, valueNode] of pairs) {
          if (!isIdentifierReference(previousNode)) {
            continue;
          }
          const previous = resolveVariable(context, previousNode);
          const setterEntry = [...setters.entries()].find(
            ([, setter]) => setter.owner === owner && setter.state === previous,
          );
          if (!setterEntry) {
            continue;
          }
          const [setterVariable] = setterEntry;
          const statements =
            current.consequent.type === "BlockStatement"
              ? current.consequent.body
              : [current.consequent];
          if (
            statements.some(
              (statement) =>
                statement.type === "ExpressionStatement" &&
                statement.expression.type === "CallExpression" &&
                isIdentifierReference(statement.expression.callee) &&
                resolveVariable(context, statement.expression.callee) ===
                  setterVariable &&
                sameExpression(statement.expression.arguments[0], valueNode),
            )
          ) {
            return true;
          }
        }
      }
    }
    descendant = current;
    current = current.parent;
  }
  return false;
};

export default eslintCompatPlugin({
  meta: { name: "no-render-phase-update" },
  rules: {
    "no-render-phase-update": {
      meta: {
        type: "problem",
        messages: {
          renderUpdate:
            "Do not navigate, redirect, or update React state during render. Move the action to an event handler or a sanctioned effect wrapper.",
        },
      },
      createOnce(context) {
        const setters = new Map();
        const findings: Parameters<typeof context.report>[0][] = [];
        return {
          Program() {
            setters.clear();
            findings.length = 0;
          },
          VariableDeclarator(node) {
            if (
              node.id.type !== "ArrayPattern" ||
              node.init?.type !== "CallExpression" ||
              !isIdentifier(node.init.callee) ||
              !["useState", "useReducer"].includes(node.init.callee.name)
            ) {
              return;
            }
            const binding = node.id.elements[1];
            const state = node.id.elements[0];
            if (isIdentifierReference(binding)) {
              const variable = resolveVariable(context, binding);
              const stateVariable = isIdentifierReference(state)
                ? resolveVariable(context, state)
                : null;
              const owner = enclosingReactOwner(node);
              if (variable && owner) {
                setters.set(variable, { owner, state: stateVariable });
              }
            }
          },
          CallExpression(node) {
            const owner = enclosingReactOwner(node);
            if (
              !owner ||
              enclosingFunction(node) !== owner ||
              isRouteHandler(owner)
            ) {
              return;
            }
            let forbidden = false;
            if (isIdentifier(node.callee)) {
              const setter = isIdentifierReference(node.callee)
                ? setters.get(resolveVariable(context, node.callee))
                : undefined;
              forbidden =
                node.callee.name === "navigate" ||
                node.callee.name === "redirect" ||
                setter?.owner === owner;
              if (
                setter?.owner === owner &&
                isGuardedAdjustment(node, setters, context, owner)
              ) {
                forbidden = false;
              }
            } else if (node.callee.type === "MemberExpression") {
              const method = getPropertyName(node.callee.property);
              const object = node.callee.object;
              forbidden =
                (method === "navigate" && isIdentifier(object, "router")) ||
                (method !== null &&
                  ["push", "replace"].includes(method) &&
                  isIdentifier(object, "history"));
            }
            if (forbidden) {
              findings.push({ node, messageId: "renderUpdate" });
            }
          },
          "Program:exit"() {
            const file = repoRelativeFilename(context);
            const baseline = baselineCounts[file] ?? 0;
            for (const finding of findings.slice(baseline)) {
              context.report(finding);
            }
          },
        };
      },
    },
  },
});
