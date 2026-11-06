import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  filenameForContext,
  getPropertyName,
  isAstNode,
  isTestFile,
  memberPropertyName,
  resolveImport,
  unwrapExpression,
} from "./utils.ts";

const RULE_NAME = "no-direct-decision-identifier-column-write";
const OWNER_PATH =
  "apps/api/src/handlers/case-law/ingestion/pipeline/decision-row.ts";
const FIXTURE_SUFFIX =
  ".oxlint-plugins/__fixtures__/no-direct-decision-identifier-column-write.fixture.ts";
const IDENTIFIER_COLUMNS = new Set(["ecli", "caseNumber"]);

export default eslintCompatPlugin({
  meta: { name: RULE_NAME },
  rules: {
    [RULE_NAME]: {
      meta: {
        type: "problem",
        messages: {
          directWrite:
            "Write decision ECLI and case number through the decision-row identifier owner.",
        },
        schema: [],
      },
      createOnce(context) {
        return {
          before() {
            const filename = filenameForContext(context);
            return (
              filename.endsWith(FIXTURE_SUFFIX) ||
              (filename.includes("apps/api/src/") &&
                !filename.endsWith(OWNER_PATH) &&
                !isTestFile(filename))
            );
          },
          CallExpression(node) {
            const callee = unwrapExpression(node.callee);
            if (
              callee?.type !== "MemberExpression" ||
              memberPropertyName(callee) !== "set"
            ) {
              return;
            }
            const updateCall = unwrapExpression(callee.object);
            const updateCallee =
              updateCall?.type === "CallExpression"
                ? unwrapExpression(updateCall.callee)
                : null;
            const table =
              updateCall?.type === "CallExpression" &&
              updateCallee?.type === "MemberExpression" &&
              memberPropertyName(updateCallee) === "update" &&
              Array.isArray(updateCall.arguments)
                ? resolveImport(context, updateCall.arguments.at(0))
                : null;
            if (table?.imported !== "caseLawDecisions") {
              return;
            }
            const payload = unwrapExpression(node.arguments.at(0));
            if (
              payload?.type === "ObjectExpression" &&
              Array.isArray(payload.properties) &&
              payload.properties.some(
                (property: unknown) =>
                  isAstNode(property) &&
                  property.type === "Property" &&
                  IDENTIFIER_COLUMNS.has(getPropertyName(property.key) ?? ""),
              )
            ) {
              context.report({ node, messageId: "directWrite" });
            }
          },
        };
      },
    },
  },
});
