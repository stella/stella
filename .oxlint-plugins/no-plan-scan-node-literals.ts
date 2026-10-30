import { eslintCompatPlugin } from "@oxlint/plugins";

import { filenameForContext } from "./utils.ts";

const SCAN_NODE_TYPES = new Set([
  "Index Scan",
  "Index Only Scan",
  "Bitmap Heap Scan",
  "Bitmap Index Scan",
]);

export default eslintCompatPlugin({
  meta: { name: "no-plan-scan-node-literals" },
  rules: {
    "no-plan-scan-node-literals": {
      meta: {
        type: "problem",
        messages: {
          useHelper:
            "Use indexedAccessPaths from the query-plan walker instead of asserting a planner node type.",
        },
      },
      createOnce(context) {
        return {
          Literal(node) {
            const filename = filenameForContext(context);
            const applies =
              filename.includes("apps/api/") &&
              filename.endsWith(".test.ts") &&
              !filename.includes("/apps/api/src/tests/query-plans/");
            if (applies && SCAN_NODE_TYPES.has(String(node.value))) {
              context.report({ node, messageId: "useHelper" });
            }
          },
        };
      },
    },
  },
});
