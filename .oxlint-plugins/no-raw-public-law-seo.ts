import { isStringLiteral } from "./utils.ts";

type AstNode = Record<string, unknown> & { type: string };

type RuleContext = {
  report: (descriptor: { node: unknown; messageId: "rawPublicLawSeo" }) => void;
};

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

const rawTemplateText = (node: AstNode): string | null => {
  if (node.type !== "TemplateElement") {
    return null;
  }
  const value = node.value;
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const raw = (value as { raw?: unknown }).raw;
  return typeof raw === "string" ? raw : null;
};

export default {
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
      create(context: RuleContext) {
        return {
          Literal(node: unknown) {
            if (isStringLiteral(node) && isRawSeoToken(node.value)) {
              context.report({ node, messageId: "rawPublicLawSeo" });
            }
          },
          TemplateElement(node: unknown) {
            if (!isAstNode(node)) {
              return;
            }
            const raw = rawTemplateText(node);
            if (raw !== null && isRawSeoToken(raw)) {
              context.report({ node, messageId: "rawPublicLawSeo" });
            }
          },
        };
      },
    },
  },
};
