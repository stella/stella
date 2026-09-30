import { eslintCompatPlugin } from "@oxlint/plugins";

import { filenameForContext, isStringLiteral } from "./utils.ts";

const CACHE_POLICY_OWNERS = ["apps/api/src/lib/security-headers.ts"] as const;

const CACHE_DIRECTIVE =
  /^(?:no-cache|no-store|no-transform|must-revalidate|proxy-revalidate|must-understand|private|public|immutable|stale-while-revalidate|stale-if-error|max-age|s-maxage)(?:\s*=.*)?$/iu;

const isCacheControlLiteral = (value: string): boolean => {
  if (value.trim().toLowerCase() === "cache-control") {
    return true;
  }
  const directives = value.split(",").map((directive) => directive.trim());
  if (
    directives.length === 1 &&
    /^(?:private|public)$/iu.test(directives.at(0) ?? "")
  ) {
    return false;
  }
  return directives.some((directive) => CACHE_DIRECTIVE.test(directive));
};

export default eslintCompatPlugin({
  meta: { name: "no-raw-cache-control" },
  rules: {
    "no-raw-cache-control": {
      meta: {
        type: "problem",
        messages: {
          rawPolicy:
            "Use the API cache policy owner instead of a raw Cache-Control header name or caching directive.",
        },
        schema: [],
      },
      createOnce(context) {
        return {
          before() {
            const filename = filenameForContext(context);
            return !CACHE_POLICY_OWNERS.some((owner) =>
              filename.endsWith(owner),
            );
          },
          Literal(node) {
            if (isStringLiteral(node) && isCacheControlLiteral(node.value)) {
              context.report({ node, messageId: "rawPolicy" });
            }
          },
          TemplateLiteral(node) {
            const flagged = node.quasis.some((quasi) =>
              isCacheControlLiteral(quasi.value.raw),
            );
            if (flagged) {
              context.report({ node, messageId: "rawPolicy" });
            }
          },
        };
      },
    },
  },
});
