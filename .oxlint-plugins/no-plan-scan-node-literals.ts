import { eslintCompatPlugin } from "@oxlint/plugins";

import { filenameForContext } from "./utils.ts";

const SCAN_NODE_TYPES = new Set([
  "Index Scan",
  "Index Only Scan",
  "Bitmap Heap Scan",
  "Bitmap Index Scan",
]);
const FIXTURE =
  ".oxlint-plugins/__fixtures__/no-plan-scan-node-literals.fixture.ts";
// Unit tests of the plan helpers themselves build synthetic plan trees, so
// they name node types; every consumer asserts through the helpers.
const PLAN_HELPER_TESTS = [
  "/apps/api/src/tests/query-plans/plan-walker.test.ts",
  "/apps/api/src/tests/query-perf/measurement.test.ts",
];

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
        const applies = () => {
          const filename = filenameForContext(context);
          return (
            filename.endsWith(FIXTURE) ||
            (filename.includes("apps/api/") &&
              filename.endsWith(".test.ts") &&
              !PLAN_HELPER_TESTS.some((helperTest) =>
                filename.endsWith(helperTest),
              ))
          );
        };
        return {
          Literal(node) {
            if (applies() && SCAN_NODE_TYPES.has(String(node.value))) {
              context.report({ node, messageId: "useHelper" });
            }
          },
          TemplateLiteral(node) {
            if (
              applies() &&
              node.expressions.length === 0 &&
              SCAN_NODE_TYPES.has(node.quasis[0]?.value.cooked ?? "")
            ) {
              context.report({ node, messageId: "useHelper" });
            }
          },
        };
      },
    },
  },
});
