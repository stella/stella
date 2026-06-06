import { isIdentifier } from "./utils.ts";

type RuleContext = {
  report: (descriptor: {
    node: unknown;
    messageId: "publicLawBrowserGlobal";
  }) => void;
};

const BROWSER_GLOBALS = new Set([
  "document",
  "localStorage",
  "matchMedia",
  "sessionStorage",
  "window",
]);

export default {
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
      create(context: RuleContext) {
        return {
          Identifier(node: unknown) {
            if (isIdentifier(node) && BROWSER_GLOBALS.has(node.name)) {
              context.report({ node, messageId: "publicLawBrowserGlobal" });
            }
          },
        };
      },
    },
  },
};
