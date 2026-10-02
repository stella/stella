import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  filenameForContext,
  resolveImportedExpression,
  staticStringValue,
  unwrapExpression,
} from "./utils.ts";

const RULE_NAME = "no-provision-brand-outside-owner";
const PROVISION_BRANDS = new Set(["ProvisionKey", "ProvisionRef"]);
const OWNER_PATH = /(?:^|\/)packages\/legal-atlas\//u;

export default eslintCompatPlugin({
  meta: { name: RULE_NAME },
  rules: {
    [RULE_NAME]: {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          provisionBrand:
            "{{brand}} is minted only in packages/legal-atlas. Use provisionRefOf or parseProvisionKey instead.",
        },
      },
      createOnce(context) {
        return {
          before() {
            return !OWNER_PATH.test(filenameForContext(context));
          },
          CallExpression(node) {
            const brand = staticStringValue(
              unwrapExpression(node.arguments.at(0)),
            );
            if (brand === null || !PROVISION_BRANDS.has(brand)) {
              return;
            }
            const binding = resolveImportedExpression(context, node.callee);
            if (binding?.source !== "valibot" || binding.imported !== "brand") {
              return;
            }
            context.report({
              node,
              messageId: "provisionBrand",
              data: { brand },
            });
          },
        };
      },
    },
  },
});
