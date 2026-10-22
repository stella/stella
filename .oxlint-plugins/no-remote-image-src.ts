import { eslintCompatPlugin } from "@oxlint/plugins";

import { jsxName } from "./utils.ts";

const REMOTE_VALUE_NAME = /(?:iconHref|iconUrl|remoteUrl|safeIconHref)$/u;

export default eslintCompatPlugin({
  meta: { name: "no-remote-image-src" },
  rules: {
    "no-remote-image-src": {
      meta: {
        type: "problem",
        messages: {
          remote:
            "Do not pass a remote data URL to <img src>; resolve remote icons through useProxiedIconSrc.",
        },
      },
      create(context) {
        return {
          JSXOpeningElement(node) {
            if (jsxName(node.name) !== "img") {
              return;
            }
            const src = node.attributes.find(
              (attribute) =>
                attribute.type === "JSXAttribute" &&
                attribute.name.type === "JSXIdentifier" &&
                attribute.name.name === "src",
            );
            if (!src || src.type !== "JSXAttribute") {
              return;
            }
            const value = src.value;
            if (
              value?.type === "Literal" &&
              typeof value.value === "string" &&
              /^https?:\/\//u.test(value.value) &&
              !value.value.startsWith("https://lh3.googleusercontent.com/")
            ) {
              context.report({ node: value, messageId: "remote" });
              return;
            }
            const expression =
              value?.type === "JSXExpressionContainer"
                ? value.expression
                : undefined;
            if (
              expression?.type === "Identifier" &&
              REMOTE_VALUE_NAME.test(expression.name)
            ) {
              context.report({ node: expression, messageId: "remote" });
            }
          },
        };
      },
    },
  },
});
