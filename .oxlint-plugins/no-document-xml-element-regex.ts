import { eslintCompatPlugin } from "@oxlint/plugins";

import { filenameForContext, isAstNode } from "./utils.ts";

const isDocumentXmlPath = (filename: string): boolean =>
  filename.includes("/apps/api/src/lib/files/") ||
  filename.includes("/apps/api/src/lib/docx/") ||
  filename.includes("/apps/api/src/lib/docx-") ||
  filename.includes("/apps/api/src/lib/document-translation/") ||
  filename.includes("/packages/docx-utils/") ||
  filename.endsWith(
    ".oxlint-plugins/__fixtures__/no-document-xml-element-regex.fixture.ts",
  );

const regexFields = (
  node: unknown,
): { pattern: string; flags: string } | null => {
  if (
    !isAstNode(node) ||
    typeof node.regex !== "object" ||
    node.regex === null ||
    !("pattern" in node.regex) ||
    !("flags" in node.regex)
  ) {
    return null;
  }
  const { pattern, flags } = node.regex;
  return typeof pattern === "string" && typeof flags === "string"
    ? { pattern, flags }
    : null;
};

export default eslintCompatPlugin({
  meta: { name: "no-document-xml-element-regex" },
  rules: {
    "no-document-xml-element-regex": {
      meta: {
        type: "problem",
        messages: {
          sharedReader:
            "Read document XML elements through the shared XML element reader.",
        },
      },
      createOnce(context) {
        return {
          before: () => isDocumentXmlPath(filenameForContext(context)),
          Literal(node) {
            const regex = regexFields(node);
            if (regex === null) {
              return;
            }
            const hasLazyBody =
              regex.pattern.includes("[\\s\\S]*?") ||
              (regex.flags.includes("s") && regex.pattern.includes(".*?"));
            if (hasLazyBody && regex.pattern.includes("<\\/")) {
              context.report({ node, messageId: "sharedReader" });
            }
          },
        };
      },
    },
  },
});
