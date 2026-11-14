import { eslintCompatPlugin } from "@oxlint/plugins";

import { filenameForContext, jsxName } from "./utils.ts";

const OWNER_PATH = "/packages/chat/src/link.tsx";
// In-app legal navigation keeps its own label: each entry is the one file and
// the one href expression that opens the legal reader in place.
const LEGAL_NAVIGATION = [
  { file: "/legal-citation-link.tsx", href: "{sanitizeHref(citation.url)}" },
  { file: "/answer-quote.tsx", href: "{sanitizeHref(readerHref)}" },
] as const;
const isFaviconUrl = (text: string) => {
  const normalized = text.toLowerCase();
  return (
    normalized.includes("/favicon.ico") ||
    (/^(?:https?:|\/\/)/u.test(normalized) && normalized.includes("favicon"))
  );
};

export default eslintCompatPlugin({
  meta: { name: "no-ad-hoc-chat-link" },
  rules: {
    "no-ad-hoc-chat-link": {
      meta: {
        type: "problem",
        messages: {
          sharedLink:
            "Render external chat links with ChatLink from @stll/chat/link; markdown adapters delegate through StreamdownMentionLink for citation classification.",
          favicon:
            "Do not fetch third-party favicons in chat. ChatLink owns bundled icons and the server icon-source seam.",
        },
      },
      createOnce(context) {
        let filename = "";
        return {
          before() {
            filename = filenameForContext(context);
            return true;
          },
          JSXOpeningElement(node) {
            if (filename.endsWith(OWNER_PATH) || jsxName(node.name) !== "a") {
              return;
            }
            const finalHrefOrSpread = node.attributes.findLast(
              (attribute) =>
                attribute.type === "JSXSpreadAttribute" ||
                (attribute.name.type === "JSXIdentifier" &&
                  attribute.name.name === "href"),
            );
            if (!finalHrefOrSpread) {
              return;
            }
            if (finalHrefOrSpread.type === "JSXSpreadAttribute") {
              context.report({ node, messageId: "sharedLink" });
              return;
            }
            const value = finalHrefOrSpread.value;
            // Same-document navigation is not an external-link presentation.
            if (
              value?.type === "Literal" &&
              typeof value.value === "string" &&
              (value.value.startsWith("#") || /^\/(?![\\/])/u.test(value.value))
            ) {
              return;
            }
            const source = value ? context.sourceCode.getText(value) : "";
            // An attachment chip's title opens its file and keeps the chip shell.
            if (
              filename.endsWith("/chat/attachment-chip.tsx") &&
              source === "{sanitizeHref(open.href)}"
            ) {
              return;
            }
            // Legal navigation may use the specialized label. External citation
            // and source branches must delegate to ChatLink instead.
            if (
              LEGAL_NAVIGATION.some(
                (entry) =>
                  filename.endsWith(entry.file) && source === entry.href,
              ) &&
              !node.attributes.some(
                (attribute) =>
                  attribute.type === "JSXSpreadAttribute" ||
                  (attribute.name.type === "JSXIdentifier" &&
                    ["target", "rel"].includes(attribute.name.name)),
              )
            ) {
              return;
            }
            context.report({ node, messageId: "sharedLink" });
          },
          Literal(node) {
            if (typeof node.value === "string" && isFaviconUrl(node.value)) {
              context.report({ node, messageId: "favicon" });
            }
          },
          TemplateLiteral(node) {
            const text = node.quasis.map((part) => part.value.raw).join("");
            if (isFaviconUrl(text)) {
              context.report({ node, messageId: "favicon" });
            }
          },
        };
      },
    },
  },
});
