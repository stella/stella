import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  filenameForContext,
  getPropertyName,
  isTestFile,
  memberPropertyName,
} from "./utils.ts";

const RULE_NAME = "no-independent-fallback-state";
const OWNERS = [
  "apps/api/src/lib/case-law/fallback-decision-identity.ts",
  "apps/api/src/lib/case-law/decision-storage-identity.ts",
];
const STATE_COLUMNS = new Set([
  "fallbackIdentityKey",
  "fallbackCohortKey",
  "fallbackPublicationHash",
  "fallbackContentHash",
  "fallbackDocumentHash",
]);

export default eslintCompatPlugin({
  meta: { name: RULE_NAME },
  rules: {
    [RULE_NAME]: {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          independentState:
            "Write complete fallback state through decisionFallbackState; independent column writes lose identity claims across enrichment.",
        },
      },
      createOnce(context) {
        return {
          before() {
            const filename = filenameForContext(context);
            return (
              filename.endsWith(
                ".oxlint-plugins/__fixtures__/no-independent-fallback-state.fixture.ts",
              ) ||
              (filename.includes("apps/api/src/") &&
                !isTestFile(filename) &&
                !OWNERS.some((owner) => filename.endsWith(owner)) &&
                !filename.endsWith("apps/api/src/db/schema/case-law.ts"))
            );
          },
          Property(node) {
            if (
              node.parent.type !== "ObjectExpression" ||
              !STATE_COLUMNS.has(getPropertyName(node.key) ?? "")
            ) {
              return;
            }
            // Read projections are booleans; query predicates cannot be assigned to scalar columns.
            if (
              node.value.type === "ObjectExpression" ||
              (node.value.type === "Literal" &&
                typeof node.value.value === "boolean")
            ) {
              return;
            }
            if (
              filenameForContext(context).endsWith(
                "apps/api/src/handlers/case-law/ingestion/pipeline/corpus-mirror.ts",
              ) &&
              node.value.type === "Literal" &&
              node.value.value === "text"
            ) {
              return;
            }
            context.report({ node, messageId: "independentState" });
          },
          AssignmentExpression(node) {
            if (
              node.left.type === "MemberExpression" &&
              STATE_COLUMNS.has(memberPropertyName(node.left) ?? "")
            ) {
              context.report({ node, messageId: "independentState" });
            }
          },
        };
      },
    },
  },
});
