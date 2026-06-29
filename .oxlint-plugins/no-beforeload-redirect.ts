// Forbid redirecting from a route's `beforeLoad` / `loader`.
//
// A handler that redirects on every path (`throw redirect(...)` /
// `return redirect(...)`) is a control-flow alias, not a page. During the
// navigation transition the router can render that route's *redirected* match
// while the (usually suspending) target holds the transition open; the match
// renderer then throws an undefined load promise, which Suspense cannot absorb
// because it is not a thenable. The thrown `undefined` escapes as an uncaught
// error and blanks the whole page on cold direct loads.
//
// Carrying a `component`/`pendingComponent` on such a route is not a fix
// either: that abandoned UI can fire queries and schedule updates before it
// ever mounts (the original concern that motivated this rule, #823). So the
// shape is wrong regardless of whether a component is present, which is why
// this rule is component-agnostic.
//
// Redirect from a mounted, inert component instead: render TanStack's
// `<Navigate>`, or a component that calls `useNavigate()` from a mount effect
// and renders only a static pending splash. A component keeps the route in
// `success` status so it never enters the redirected-match state, and an inert
// fallback fires no queries. See apps/web/src/routes/_protected.knowledge/skills.tsx
// (`<Navigate>`) or apps/web/src/routes/index.tsx (async dispatch).
//
// Conditional guards are intentionally allowed: a handler with a reachable
// non-redirect exit (e.g. `if (ok) return;` then `throw redirect(...)`, or a
// bare `if (!session) throw redirect(...)` that falls through) protects a route
// that otherwise renders its own component and must run before render.

import { getPropertyName, isIdentifier } from "./utils.ts";

const LOAD_PROPERTIES = new Set(["beforeLoad", "loader"]);

const FUNCTION_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionExpression",
  "FunctionDeclaration",
]);

const isRedirectCall = (node) =>
  node?.type === "CallExpression" && isIdentifier(node.callee, "redirect");

// `throw redirect(...)` or `return redirect(...)`.
const isRedirectStatement = (node) =>
  (node?.type === "ThrowStatement" && isRedirectCall(node.argument)) ||
  (node?.type === "ReturnStatement" && isRedirectCall(node.argument));

// A statement that completes the handler WITHOUT redirecting, so a path can
// fall through and render the route: a plain/non-redirect `return`, or a
// non-redirect `throw`.
const isNonRedirectCompletion = (node) =>
  (node?.type === "ReturnStatement" && !isRedirectCall(node.argument)) ||
  (node?.type === "ThrowStatement" && !isRedirectCall(node.argument));

// Is a non-redirect exit reachable anywhere inside this statement? Skips nested
// function bodies, whose returns/throws belong to that function, not the
// handler. This is what distinguishes a genuine guard from a pure alias.
const hasNonRedirectExit = (node, seen) => {
  if (node === null || typeof node !== "object" || seen.has(node)) {
    return false;
  }
  seen.add(node);
  if (FUNCTION_TYPES.has(node.type)) {
    return false;
  }
  if (isNonRedirectCompletion(node)) {
    return true;
  }
  for (const key of Object.keys(node)) {
    if (key === "parent") {
      continue;
    }
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) {
        if (hasNonRedirectExit(child, seen)) {
          return true;
        }
      }
      continue;
    }
    if (value && typeof value === "object" && typeof value.type === "string") {
      if (hasNonRedirectExit(value, seen)) {
        return true;
      }
    }
  }
  return false;
};

// Does every path through this statement end in a redirect?
const statementAlwaysRedirects = (node) => {
  if (node === null || typeof node !== "object") {
    return false;
  }
  if (isRedirectStatement(node)) {
    return true;
  }
  if (node.type === "BlockStatement") {
    return blockAlwaysRedirects(node.body);
  }
  // Both branches must exist and both must redirect.
  if (node.type === "IfStatement") {
    return (
      node.alternate != null &&
      statementAlwaysRedirects(node.consequent) &&
      statementAlwaysRedirects(node.alternate)
    );
  }
  return false;
};

// Scan a statement sequence: the handler always redirects once we reach a
// statement that guarantees a redirect, provided no earlier statement opens a
// non-redirect exit (which would make it a conditional guard).
const blockAlwaysRedirects = (statements) => {
  for (const statement of statements) {
    if (statementAlwaysRedirects(statement)) {
      return true;
    }
    if (hasNonRedirectExit(statement, new Set())) {
      return false;
    }
  }
  return false;
};

// The handler unconditionally redirects: a concise `() => redirect(...)`, or a
// body whose every path ends in a redirect throw/return.
const alwaysRedirects = (fn) => {
  if (!FUNCTION_TYPES.has(fn?.type)) {
    return false;
  }
  if (fn.body?.type === "BlockStatement") {
    return blockAlwaysRedirects(fn.body.body);
  }
  return isRedirectCall(fn.body);
};

const isCreateFileRouteConfig = (node) => {
  const parent = node.parent;
  return (
    parent?.type === "CallExpression" &&
    parent.arguments?.[0] === node &&
    parent.callee?.type === "CallExpression" &&
    isIdentifier(parent.callee.callee, "createFileRoute")
  );
};

const getStaticProperties = (node) => {
  const properties = new Map();
  for (const property of node.properties ?? []) {
    if (property.type !== "Property") {
      continue;
    }
    const name = getPropertyName(property.key);
    if (name !== null) {
      properties.set(name, property);
    }
  }
  return properties;
};

export default {
  meta: { name: "no-beforeload-redirect" },
  rules: {
    "no-beforeload-redirect": {
      meta: {
        type: "problem",
        messages: {
          beforeLoadRedirect:
            "Route {{property}} always redirects via redirect(...). This blanks " +
            "the page on cold direct loads: the router can render the " +
            "redirected match while the target suspends, throwing an undefined " +
            "load promise that Suspense cannot absorb. Redirect from a mounted " +
            "inert component instead — render <Navigate>, or call useNavigate() " +
            "from useMountEffect and render a static pending splash. See " +
            "apps/web/src/routes/_protected.knowledge/skills.tsx. Conditional " +
            "guards that fall through to render a route are fine.",
        },
      },
      create(context) {
        return {
          ObjectExpression(node) {
            if (!isCreateFileRouteConfig(node)) {
              return;
            }

            const properties = getStaticProperties(node);

            for (const propertyName of LOAD_PROPERTIES) {
              const property = properties.get(propertyName);
              if (property === undefined) {
                continue;
              }

              if (alwaysRedirects(property.value)) {
                context.report({
                  node: property,
                  messageId: "beforeLoadRedirect",
                  data: { property: propertyName },
                });
              }
            }
          },
        };
      },
    },
  },
};
