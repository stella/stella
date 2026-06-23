// Ban render components on routes that always redirect from beforeLoad.
//
// An unconditional `throw redirect(...)` route is a control-flow alias, not a
// page. Keeping `component` or `pendingComponent` on that route can still load
// and briefly render abandoned UI during route resolution, which lets query
// subscriptions or other async work schedule updates before mount.

import { getPropertyName, isIdentifier } from "./utils.ts";

const RENDER_PROPERTIES = new Set(["component", "pendingComponent"]);

const isRedirectThrow = (node) =>
  node?.type === "ThrowStatement" &&
  node.argument?.type === "CallExpression" &&
  isIdentifier(node.argument.callee, "redirect");

const isUnconditionalRedirectBeforeLoad = (node) => {
  if (
    node?.type !== "ArrowFunctionExpression" &&
    node?.type !== "FunctionExpression"
  ) {
    return false;
  }

  if (node.body?.type === "BlockStatement") {
    return node.body.body.length === 1 && isRedirectThrow(node.body.body[0]);
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
    if (name === null) {
      continue;
    }

    properties.set(name, property);
  }
  return properties;
};

export default {
  meta: { name: "no-component-on-redirect-route" },
  rules: {
    "no-component-on-redirect-route": {
      meta: {
        type: "problem",
        messages: {
          renderOnRedirectRoute:
            "Route beforeLoad unconditionally throws redirect(...), so " +
            "{{property}} must not be defined. Keep redirect-only routes " +
            "inert; render components can be abandoned before mount and " +
            "still schedule async updates.",
        },
      },
      create(context) {
        return {
          ObjectExpression(node) {
            if (!isCreateFileRouteConfig(node)) {
              return;
            }

            const properties = getStaticProperties(node);
            const beforeLoad = properties.get("beforeLoad");
            if (
              beforeLoad === undefined ||
              !isUnconditionalRedirectBeforeLoad(beforeLoad.value)
            ) {
              return;
            }

            for (const propertyName of RENDER_PROPERTIES) {
              const property = properties.get(propertyName);
              if (property === undefined) {
                continue;
              }

              context.report({
                node: property,
                messageId: "renderOnRedirectRoute",
                data: { property: propertyName },
              });
            }
          },
        };
      },
    },
  },
};
