import { eslintCompatPlugin } from "@oxlint/plugins";

import { isStringLiteral } from "./utils.ts";

type AstNode = Record<string, unknown> & { type: string };

const isAstNode = (value: unknown): value is AstNode =>
  typeof value === "object" &&
  value !== null &&
  "type" in value &&
  typeof (value as { type: unknown }).type === "string";

const isRawSeoToken = (value: string): boolean =>
  value === "canonical" ||
  value === "robots" ||
  value.startsWith("og:") ||
  value.startsWith("twitter:");

const rawTemplateText = (node: unknown): string | null => {
  if (!isAstNode(node) || node.type !== "TemplateElement") {
    return null;
  }
  const value = node.value;
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const raw = (value as { raw?: unknown }).raw;
  return typeof raw === "string" ? raw : null;
};

export default eslintCompatPlugin({
  meta: { name: "no-raw-public-law-seo" },
  rules: {
    "no-raw-public-law-seo": {
      meta: {
        type: "problem",
        messages: {
          rawPublicLawSeo:
            "Public law routes must build canonical, robots, Open Graph, and Twitter metadata through createPublicLawHead().",
        },
      },
      createOnce(context) {
        return {
          Literal(node) {
            if (isStringLiteral(node) && isRawSeoToken(node.value)) {
              context.report({ node, messageId: "rawPublicLawSeo" });
            }
          },
          TemplateElement(node) {
            const raw = rawTemplateText(node);
            if (raw !== null && isRawSeoToken(raw)) {
              context.report({ node, messageId: "rawPublicLawSeo" });
            }
          },
        };
      },
    },
  },
});
