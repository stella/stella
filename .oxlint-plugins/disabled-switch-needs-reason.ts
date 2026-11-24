// A disabled Switch or SwitchField must explain why it cannot be toggled.
//
// Flagged:
//   <Switch disabled />
//   <SwitchField disabled={!canEdit} label="Require SSO" />
// Allowed:
//   <Switch disabled={false} />
//   <Switch disabled={!canEdit} disabledReason={t("...")} />
//   <SwitchField disabled={!canEdit} disabledReason={reason} label="Require SSO" />

import { eslintCompatPlugin, type Ranged } from "@oxlint/plugins";

import { guardEnforcesLine } from "../scripts/guard-rollouts.ts";
import {
  type AstNode,
  filenameForContext,
  isAstNode,
  jsxName,
} from "./utils.ts";

const RULE_NAME = "disabled-switch-needs-reason";
const SWITCH_CONTROLS = new Set(["Switch", "SwitchField"]);

type LineContext = {
  sourceCode: { getLocFromIndex: (index: number) => { line: number } };
};

const lineOf = (context: LineContext, node: Ranged): number => {
  const [start] = node.range;
  return context.sourceCode.getLocFromIndex(start).line;
};

const isLiteralFalse = (value: unknown): boolean => {
  if (!isAstNode(value) || value.type !== "JSXExpressionContainer") {
    return false;
  }
  const expr = value.expression;
  return isAstNode(expr) && expr.type === "Literal" && expr.value === false;
};

export default eslintCompatPlugin({
  meta: { name: RULE_NAME },
  rules: {
    [RULE_NAME]: {
      meta: {
        type: "suggestion",
        messages: {
          missingReason:
            "A disabled Switch or SwitchField must say why it cannot be toggled. Pass `disabledReason` so the reader gets a tooltip explaining what is required.",
        },
        schema: [],
      },
      createOnce(context) {
        return {
          before() {
            return filenameForContext(context).endsWith(".tsx");
          },
          JSXOpeningElement(node) {
            const name = jsxName(node.name);
            if (name === null || !SWITCH_CONTROLS.has(name)) {
              return;
            }
            if (!Array.isArray(node.attributes)) {
              return;
            }
            let disabledAttr: AstNode | null = null;
            for (const attr of node.attributes) {
              if (!isAstNode(attr) || attr.type !== "JSXAttribute") {
                continue;
              }
              const attrName = jsxName(attr.name);
              if (attrName === "disabledReason") {
                return;
              }
              if (attrName === "disabled" && !isLiteralFalse(attr.value)) {
                disabledAttr = attr;
              }
            }
            if (
              disabledAttr !== null &&
              guardEnforcesLine({
                guard: RULE_NAME,
                file: filenameForContext(context),
                line: lineOf(context, disabledAttr),
              })
            ) {
              context.report({
                node: disabledAttr,
                messageId: "missingReason",
              });
            }
          },
        };
      },
    },
  },
});
