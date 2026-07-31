// Detect physical directional Tailwind CSS properties that should
// use logical equivalents for RTL support.
//
// Physical properties (ml-, mr-, pl-, pr-, left-*, right-*,
// text-left, text-right, border-l, border-r, rounded-l, rounded-r)
// are fixed to LTR layout. Logical properties (ms-, me-, ps-, pe-,
// start-*, end-*, text-start, text-end) adapt automatically.
//
// Replaces: scripts/lint-logical-properties.sh

import { hasPhysicalProperty } from "./physical-properties.ts";

export default {
  meta: { name: "no-physical-properties" },
  rules: {
    "no-physical-properties": {
      meta: {
        type: "problem",
        messages: {
          physicalProperty:
            "Physical directional CSS property breaks RTL. " +
            "Use logical equivalents: " +
            "ml→ms, mr→me, pl→ps, pr→pe, " +
            "left→start, right→end, " +
            "text-left→text-start, text-right→text-end, " +
            "border-l→border-s, border-r→border-e, " +
            "rounded-l→rounded-s, rounded-r→rounded-e.",
        },
      },
      create(context) {
        return {
          Literal(node) {
            if (typeof node.value !== "string") {
              return;
            }
            if (hasPhysicalProperty(node.value)) {
              context.report({
                node,
                messageId: "physicalProperty",
              });
            }
          },
          TemplateElement(node) {
            if (hasPhysicalProperty(node.value.raw)) {
              context.report({
                node,
                messageId: "physicalProperty",
              });
            }
          },
        };
      },
    },
  },
};
