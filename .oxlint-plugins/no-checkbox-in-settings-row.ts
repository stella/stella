// Instant boolean settings inside SettingsRow use Switch or SwitchField,
// never a bare Checkbox (which reads as multi-select in tables/lists).
//
// Flagged:
//   <SettingsRow title="Prompt caching"><Checkbox checked={on} /></SettingsRow>
// Allowed:
//   <SettingsRow title="Prompt caching"><Switch checked={on} /></SettingsRow>
//   <ListItem><Checkbox checked={selected} /></ListItem>

import { eslintCompatPlugin } from "@oxlint/plugins";

import { guardEnforcesLine } from "../scripts/guard-rollouts.ts";
import { filenameForContext, isAstNode, jsxName } from "./utils.ts";

const RULE_NAME = "no-checkbox-in-settings-row";

type LineContext = {
  sourceCode: { getLocFromIndex: (index: number) => { line: number } };
};

const lineOf = (
  context: LineContext,
  node: Record<string, unknown>,
): number => {
  const range = node.range;
  const start = Array.isArray(range) ? range[0] : undefined;
  return typeof start === "number"
    ? context.sourceCode.getLocFromIndex(start).line
    : 1;
};

const isInsideJsxElement = (
  node: unknown,
  names: ReadonlySet<string>,
): boolean => {
  let cursor: unknown = node;
  while (isAstNode(cursor)) {
    cursor = cursor.parent;
    if (
      isAstNode(cursor) &&
      cursor.type === "JSXElement" &&
      isAstNode(cursor.openingElement)
    ) {
      const tag = jsxName(cursor.openingElement.name);
      if (tag !== null && names.has(tag)) {
        return true;
      }
    }
  }
  return false;
};

const SETTINGS_ROW_NAMES = new Set(["SettingsRow"]);

export default eslintCompatPlugin({
  meta: { name: RULE_NAME },
  rules: {
    [RULE_NAME]: {
      meta: {
        type: "problem",
        messages: {
          useSwitch:
            "Use Switch or SwitchField instead of Checkbox inside SettingsRow: a bare Checkbox reads as item selection rather than a setting toggle.",
        },
        schema: [],
      },
      createOnce(context) {
        return {
          before() {
            return filenameForContext(context).endsWith(".tsx");
          },
          JSXOpeningElement(node) {
            if (jsxName(node.name) !== "Checkbox") {
              return;
            }
            if (
              isInsideJsxElement(node, SETTINGS_ROW_NAMES) &&
              guardEnforcesLine({
                guard: RULE_NAME,
                file: filenameForContext(context),
                line: lineOf(context, node),
              })
            ) {
              context.report({ node, messageId: "useSwitch" });
            }
          },
        };
      },
    },
  },
});
