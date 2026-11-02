// Inline declarations have CSS cascade semantics; substrings do not.
// Flags style.includes("italic"), $el.attr("style").startsWith("x:") and
// "span[style*=italic]". Allows substring tests on other receivers and
// declaration readers imported from the inline-style owner.
import { eslintCompatPlugin } from "@oxlint/plugins";
import type { Ranged } from "@oxlint/plugins";

import { guardEnforcesLine } from "../scripts/guard-rollouts.ts";
import {
  filenameForContext,
  isIdentifier,
  isStringLiteral,
  isTestFile,
  memberPropertyName,
  unwrapExpression,
} from "./utils.ts";

const RULE_NAME = "no-style-substring-match";
const FIXTURE_SUFFIX =
  ".oxlint-plugins/__fixtures__/no-style-substring-match.fixture.ts";
const SOURCE_SCOPE =
  /(?:^|\/)apps\/api\/src\/(?:handlers\/case-law\/ingestion|lib\/legal-search\/parsers)\//u;
const STYLE_SELECTOR = /\[\s*style\s*(?:[*^$~|])?=/iu;
const SUBSTRING_METHODS = new Set(["includes", "startsWith", "indexOf"]);

const isStyleReceiver = (node: unknown): boolean => {
  const receiver = unwrapExpression(node);
  if (isIdentifier(receiver)) {
    return /style/iu.test(receiver.name);
  }
  if (receiver?.type !== "CallExpression") {
    return false;
  }
  const callee = unwrapExpression(receiver.callee);
  const attribute = Array.isArray(receiver.arguments)
    ? receiver.arguments.at(0)
    : undefined;
  return (
    callee?.type === "MemberExpression" &&
    memberPropertyName(callee) === "attr" &&
    isStringLiteral(attribute) &&
    attribute.value === "style"
  );
};

export default eslintCompatPlugin({
  meta: { name: RULE_NAME },
  rules: {
    [RULE_NAME]: {
      meta: {
        type: "problem",
        messages: {
          declaration:
            "read declarations through apps/api/src/lib/legal-search/document-builders/inline-style.ts",
        },
        schema: [],
      },
      createOnce(context) {
        const report = (node: Ranged) => {
          const start = context.sourceCode.getLocFromIndex(node.range[0]).line;
          const end = context.sourceCode.getLocFromIndex(
            node.range[1] - 1,
          ).line;
          for (let line = start; line <= end; line++) {
            if (
              guardEnforcesLine({
                guard: RULE_NAME,
                file: filenameForContext(context),
                line,
              })
            ) {
              context.report({ node, messageId: "declaration" });
              return;
            }
          }
        };
        return {
          before() {
            const filename = filenameForContext(context);
            return (
              filename.endsWith(FIXTURE_SUFFIX) ||
              (SOURCE_SCOPE.test(filename) && !isTestFile(filename))
            );
          },
          CallExpression(node) {
            const callee = unwrapExpression(node.callee);
            const argument = node.arguments.at(0);
            if (
              callee?.type === "MemberExpression" &&
              SUBSTRING_METHODS.has(memberPropertyName(callee) ?? "") &&
              isStyleReceiver(callee.object) &&
              isStringLiteral(argument)
            ) {
              report(node);
            }
          },
          Literal(node) {
            if (
              typeof node.value === "string" &&
              STYLE_SELECTOR.test(node.value)
            ) {
              report(node);
            }
          },
        };
      },
    },
  },
});
