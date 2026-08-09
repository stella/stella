import { eslintCompatPlugin } from "@oxlint/plugins";

const BROWSER_GLOBALS = new Set([
  "document",
  "localStorage",
  "matchMedia",
  "sessionStorage",
  "window",
]);

export default eslintCompatPlugin({
  meta: { name: "no-public-law-browser-globals" },
  rules: {
    "no-public-law-browser-globals": {
      meta: {
        type: "problem",
        messages: {
          publicLawBrowserGlobal:
            "Public law modules must be SSR-safe for crawlers. Do not reference browser globals directly.",
        },
      },
      createOnce(context) {
        return {
          Identifier(node) {
            if (BROWSER_GLOBALS.has(node.name)) {
              context.report({ node, messageId: "publicLawBrowserGlobal" });
            }
          },
        };
      },
    },
  },
});
