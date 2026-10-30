import { eslintCompatPlugin } from "@oxlint/plugins";

import { getPropertyName, isFileIn, isIdentifier } from "./utils.ts";

const OWNER =
  "apps/api/src/lib/legal-search/case-law-source-ingestion-lease.ts";

export default eslintCompatPlugin({
  meta: { name: "no-bare-case-law-source-ingestion-lease" },
  rules: {
    "no-bare-case-law-source-ingestion-lease": {
      meta: {
        type: "problem",
        messages: {
          bareAcquisition:
            "Run source work through withCaseLawSourceIngestionLease; only the lease owner may acquire directly.",
        },
        schema: [],
      },
      createOnce(context) {
        return {
          before() {
            return !isFileIn(context, [OWNER]);
          },
          CallExpression(node) {
            const memberName =
              node.callee.type === "MemberExpression"
                ? getPropertyName(node.callee.property)
                : null;
            if (
              (isIdentifier(node.callee) &&
                node.callee.name === "acquireCaseLawSourceIngestionLease") ||
              memberName === "acquireCaseLawSourceIngestionLease"
            ) {
              context.report({
                node: node.callee,
                messageId: "bareAcquisition",
              });
            }
          },
        };
      },
    },
  },
});
