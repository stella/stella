// Capacity is a parent-row locking invariant. Every production insertion must
// use the owner, including imports and future capability entry points.
import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  filenameForContext,
  getPropertyName,
  isAstNode,
  isTestFile,
  resolveImport,
} from "./utils.ts";

const RULE_NAME = "no-direct-clause-variant-insert";
const OWNER_PATH = "apps/api/src/handlers/clauses/variant-insert.ts";
const FIXTURE_PATH =
  ".oxlint-plugins/__fixtures__/no-direct-clause-variant-insert.fixture.ts";
const SCHEMA_MODULES = new Set([
  "apps/api/src/db/schema",
  "apps/api/src/db/schema/clauses",
]);

export default eslintCompatPlugin({
  meta: { name: RULE_NAME },
  rules: {
    [RULE_NAME]: {
      meta: {
        type: "problem",
        messages: {
          directInsert:
            "Insert clause variants through insertClauseVariants so ownership, capacity locks and audit writes share one transaction.",
        },
        schema: [],
      },
      createOnce(context) {
        return {
          before() {
            const filename = filenameForContext(context);
            return (
              filename.endsWith(FIXTURE_PATH) ||
              (filename.includes("apps/api/src/") &&
                !filename.endsWith(OWNER_PATH) &&
                !isTestFile(filename))
            );
          },
          CallExpression(node) {
            const callee = node.callee;
            if (
              !isAstNode(callee) ||
              callee.type !== "MemberExpression" ||
              getPropertyName(callee.property) !== "insert"
            ) {
              return;
            }
            const table = resolveImport(context, node.arguments.at(0));
            if (
              table?.imported !== "clauseVariants" ||
              !SCHEMA_MODULES.has(table.moduleId)
            ) {
              return;
            }
            context.report({ node, messageId: "directInsert" });
          },
        };
      },
    },
  },
});
