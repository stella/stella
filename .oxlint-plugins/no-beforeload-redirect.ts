// Forbid redirecting from a route's `beforeLoad` / `loader`.
//
// An unconditional `throw redirect(...)` (or `return redirect(...)`) in
// beforeLoad/loader is a control-flow alias, not a page. During the navigation
// transition the router can render that route's *redirected* match while the
// (usually suspending) target holds the transition open; the match renderer
// then throws an undefined load promise, which Suspense cannot absorb because
// it is not a thenable. The thrown `undefined` escapes as an uncaught error
// and blanks the whole page on cold direct loads.
//
// Carrying a `component`/`pendingComponent` on such a route is not a fix
// either: that abandoned UI can fire queries and schedule updates before it
// ever mounts (the original concern that motivated this rule, #823). So the
// shape is wrong whether or not a component is present.
//
// Redirect from a mounted, inert component instead: render TanStack's
// `<Navigate>`, or a component that calls `useNavigate()` from a mount effect
// and renders only a static pending splash. A component keeps the route in
// `success` status so it never enters the redirected-match state, and an inert
// fallback fires no queries. See apps/web/src/routes/_protected.chat_.new.tsx.
//
// Conditional guards (e.g. `if (!session) throw redirect({ to: "/auth" })`)
// are intentionally allowed: they protect a route that otherwise renders its
// own component, and must run before render.

import { getPropertyName, isIdentifier } from "./utils.ts";

const LOAD_PROPERTIES = new Set(["beforeLoad", "loader"]);

const isRedirectCall = (node) =>
  node?.type === "CallExpression" && isIdentifier(node.callee, "redirect");

// `throw redirect(...)` or `return redirect(...)`.
const isRedirectStatement = (node) =>
  (node?.type === "ThrowStatement" && isRedirectCall(node.argument)) ||
  (node?.type === "ReturnStatement" && isRedirectCall(node.argument));

// The function's sole effect is to redirect: a single-statement block
// (`() => { throw redirect(...) }`) or a concise body (`() => redirect(...)`).
// This is the pure-alias shape, dangerous regardless of a component.
const isUnconditionalRedirect = (fn) => {
  if (
    fn?.type !== "ArrowFunctionExpression" &&
    fn?.type !== "FunctionExpression"
  ) {
    return false;
  }
  if (fn.body?.type === "BlockStatement") {
    return fn.body.body.length === 1 && isRedirectStatement(fn.body.body[0]);
  }
  return isRedirectCall(fn.body);
};

// Does the subtree redirect anywhere? Used together with "no component" to
// catch multi-statement dispatchers (e.g. the root `/` that resolves auth and
// then redirects on every branch) that the single-statement check misses.
const containsRedirect = (node, seen) => {
  if (node === null || typeof node !== "object" || seen.has(node)) {
    return false;
  }
  seen.add(node);
  if (isRedirectStatement(node)) {
    return true;
  }
  for (const key of Object.keys(node)) {
    if (key === "parent") {
      continue;
    }
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) {
        if (containsRedirect(child, seen)) {
          return true;
        }
      }
      continue;
    }
    if (value && typeof value === "object" && typeof value.type === "string") {
      if (containsRedirect(value, seen)) {
        return true;
      }
    }
  }
  return false;
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
            "Route {{property}} redirects via redirect(...). This blanks the " +
            "page on cold direct loads: the router can render the redirected " +
            "match while the target suspends, throwing an undefined load " +
            "promise that Suspense cannot absorb. Redirect from a mounted " +
            "inert component instead — render <Navigate>, or call useNavigate() " +
            "from useMountEffect and render a static pending splash. See " +
            "apps/web/src/routes/_protected.chat_.new.tsx. Conditional guards " +
            "that protect a rendered route are fine.",
        },
      },
      create(context) {
        return {
          ObjectExpression(node) {
            if (!isCreateFileRouteConfig(node)) {
              return;
            }

            const properties = getStaticProperties(node);
            const hasComponent = properties.has("component");

            for (const propertyName of LOAD_PROPERTIES) {
              const property = properties.get(propertyName);
              if (property === undefined) {
                continue;
              }

              const fn = property.value;
              const unconditional = isUnconditionalRedirect(fn);
              const componentlessRedirect =
                !hasComponent && containsRedirect(fn, new Set());

              if (unconditional || componentlessRedirect) {
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
