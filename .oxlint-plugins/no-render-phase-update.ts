import { eslintCompatPlugin } from "@oxlint/plugins";

import baselineCounts from "./no-render-phase-update-baseline.json" with { type: "json" };
import {
  getPropertyName,
  isIdentifier,
  isIdentifierReference,
  repoRelativeFilename,
  resolveImportedExpressionForEnforcement,
  resolveVariable,
  stableInitializer,
} from "./utils.ts";

const FUNCTIONS = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);
const ROUTE_HANDLERS = new Set(["beforeLoad", "loader"]);
const COMPONENT_WRAPPERS = new Set(["memo", "forwardRef"]);
const STATE_HOOKS = new Set(["useState", "useReducer"]);
const ROUTER_MODULE = "@tanstack/react-router";

// The name a callee is called by: `name(...)` or `object.name(...)`.
const calleeName = (callee) =>
  isIdentifier(callee)
    ? callee.name
    : callee?.type === "MemberExpression"
      ? getPropertyName(callee.property)
      : null;

// A component passed straight to `memo(...)` or `forwardRef(...)` has no name
// of its own, but renders like any other component.
const isWrappedComponent = (node) => {
  const parent = node.parent;
  if (parent?.type !== "CallExpression" || parent.arguments[0] !== node) {
    return false;
  }
  const name = calleeName(parent.callee);
  return name !== null && COMPONENT_WRAPPERS.has(name);
};

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
  return name === null
    ? isWrappedComponent(node)
    : /^[A-Z]/u.test(name) || /^use[A-Z0-9]/u.test(name);
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

// A `useMemo` factory runs during render, like the owner's body around it.
const renderEvaluatedFunction = (node) => {
  let fn = enclosingFunction(node);
  while (
    fn?.parent?.type === "CallExpression" &&
    fn.parent.arguments[0] === fn &&
    calleeName(fn.parent.callee) === "useMemo"
  ) {
    fn = enclosingFunction(fn.parent);
  }
  return fn;
};

// The hook call a binding was initialized from, by the hook's name.
const initializedFromHook = (context, reference, hooks) => {
  if (!isIdentifierReference(reference)) {
    return false;
  }
  const variable = resolveVariable(context, reference);
  const initializer = variable === null ? null : stableInitializer(variable);
  if (initializer?.type !== "CallExpression") {
    return false;
  }
  const name = calleeName(initializer.callee);
  return name !== null && hooks.has(name);
};

const NAVIGATE_HOOKS = new Set(["useNavigate"]);
const ROUTER_HOOKS = new Set(["useRouter"]);

// `navigate(...)` from `useNavigate()` under any name, and the router's own
// `redirect`. A same-named local that is neither is someone else's function.
const isNavigationCall = (context, callee) => {
  if (!isIdentifierReference(callee)) {
    return false;
  }
  if (resolveVariable(context, callee) === null) {
    return callee.name === "navigate" || callee.name === "redirect";
  }
  if (initializedFromHook(context, callee, NAVIGATE_HOOKS)) {
    return true;
  }
  const imported = resolveImportedExpressionForEnforcement(context, callee);
  return imported?.source === ROUTER_MODULE && imported.imported === "redirect";
};

const isStateHook = (context, callee) => {
  if (isIdentifier(callee) && STATE_HOOKS.has(callee.name)) {
    return true;
  }
  const imported = resolveImportedExpressionForEnforcement(context, callee);
  return imported?.source === "react" && STATE_HOOKS.has(imported.imported);
};

// A member key compared by what it reads: `.name` and a static `[literal]`
// stay apart, and a dynamic key matches nothing.
const memberKey = (member) => {
  if (!member.computed) {
    return isIdentifier(member.property) ? `.${member.property.name}` : null;
  }
  const property = member.property;
  return property?.type === "Literal" &&
    (typeof property.value === "string" || typeof property.value === "number")
    ? `[${typeof property.value}:${String(property.value)}]`
    : null;
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
      memberKey(left) !== null &&
      memberKey(left) === memberKey(right));
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
        // `census: true` reports every finding, ignoring the per-file counts,
        // so scripts/render-phase-update-baseline.ts can regenerate them.
        schema: [
          {
            type: "object",
            properties: { census: { type: "boolean" } },
            additionalProperties: false,
          },
        ],
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
              !isStateHook(context, node.init.callee)
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
              renderEvaluatedFunction(node) !== owner ||
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
                isNavigationCall(context, node.callee) ||
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
                (method === "navigate" &&
                  (isIdentifier(object, "router") ||
                    initializedFromHook(context, object, ROUTER_HOOKS))) ||
                (method !== null &&
                  ["push", "replace"].includes(method) &&
                  isIdentifier(object, "history"));
            }
            if (forbidden) {
              findings.push({ node, messageId: "renderUpdate" });
            }
          },
          "Program:exit"() {
            const options: unknown = context.options[0];
            const census =
              typeof options === "object" &&
              options !== null &&
              Reflect.get(options, "census") === true;
            const file = repoRelativeFilename(context);
            const baseline = census ? 0 : (baselineCounts[file] ?? 0);
            for (const finding of findings.slice(baseline)) {
              context.report(finding);
            }
          },
        };
      },
    },
  },
});
