// Enforce stella's single toast integration surface.
//
// Product code should use `stellaToast` from `@stll/ui/components/toast`.
// That wrapper applies default timeouts and keeps app code away from
// raw Base UI toast managers.

import { getImportedName } from "./utils.ts";

const STELLA_TOAST_MODULE = "@stll/ui/components/toast";
const RAW_TOAST_MODULE = "@base-ui/react/toast";

const DISALLOWED_STELLA_IMPORTS = new Set([
  "AnchoredToastProvider",
  "anchoredToastManager",
  "toast",
  "toastManager",
]);

type RuleContext = {
  report: (diagnostic: {
    node: unknown;
    messageId: string;
    data?: Record<string, string>;
  }) => void;
};

type IdentifierNode = {
  type: "Identifier";
  name: string;
};

type LiteralNode = {
  type: "Literal";
  value: unknown;
};

type ImportSpecifierLike = {
  type: string;
  imported?: IdentifierNode | LiteralNode;
};

type ImportDeclarationNode = {
  source: LiteralNode;
  specifiers: ImportSpecifierLike[];
};

export default {
  meta: { name: "stella-toast" },
  rules: {
    "stella-toast": {
      meta: {
        type: "problem",
        messages: {
          rawToast:
            "Use `stellaToast` from `@stll/ui/components/toast` instead of raw Base UI toast APIs.",
          restrictedStellaImport:
            "Use `stellaToast` from `@stll/ui/components/toast`; `{{name}}` bypasses stella toast guarantees.",
        },
      },
      create(context: RuleContext) {
        return {
          ImportDeclaration(node: ImportDeclarationNode) {
            if (typeof node.source.value !== "string") {
              return;
            }

            if (node.source.value === RAW_TOAST_MODULE) {
              context.report({ node, messageId: "rawToast" });
              return;
            }

            if (node.source.value !== STELLA_TOAST_MODULE) {
              return;
            }

            for (const specifier of node.specifiers) {
              const name = getImportedName(specifier);
              if (name === null || !DISALLOWED_STELLA_IMPORTS.has(name)) {
                continue;
              }

              context.report({
                node: specifier,
                messageId: "restrictedStellaImport",
                data: { name },
              });
            }
          },
        };
      },
    },
  },
};
