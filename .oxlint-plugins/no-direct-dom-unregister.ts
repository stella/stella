import { eslintCompatPlugin } from "@oxlint/plugins";

import { getPropertyName, isAstNode } from "./utils.ts";

const GLOBAL_REGISTRATOR = "GlobalRegistrator";
const UNREGISTER = "unregister";

export default eslintCompatPlugin({
  meta: { name: "no-direct-dom-unregister" },
  rules: {
    "no-direct-dom-unregister": {
      meta: {
        type: "problem",
        messages: {
          directUnregister:
            "Use unregisterDomEnvironment from @/test-dom-environment so React scheduler work drains before DOM globals are removed.",
        },
      },
      createOnce(context) {
        return {
          CallExpression(node) {
            if (
              !isAstNode(node.callee) ||
              node.callee.type !== "MemberExpression" ||
              getPropertyName(node.callee.property) !== UNREGISTER ||
              !isAstNode(node.callee.object) ||
              node.callee.object.type !== "Identifier" ||
              node.callee.object.name !== GLOBAL_REGISTRATOR
            ) {
              return;
            }
            context.report({ node, messageId: "directUnregister" });
          },
        };
      },
    },
  },
});
