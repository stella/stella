// A setup screen offers a choice through `ChoiceGroup` and `ChoiceCard`
// from apps/desktop/src/onboarding/SetupScreenParts.tsx: one card per
// answer with its radio, title and description, one radio group per choice,
// so every setup screen looks, reads and moves by keyboard alike. A screen
// that draws its own radio cards drifts from the others.
//
// Flagged, in setup screens other than SetupScreenParts.tsx:
//   <input type="radio" name={name} />
//   <div role="radiogroup" aria-label={title}>
//   <Label variant="choice-card">
//   <Label variant="choice">
// Allowed:
//   <ChoiceGroup label={title}>
//     <ChoiceCard checked title={title} description={body} ... />
//   </ChoiceGroup>
//   <input type="checkbox" />
//
// Syntax only: a role or type assembled at runtime is out of reach. Scoped
// by the config's file globs to apps/desktop/src/onboarding.

import { eslintCompatPlugin } from "@oxlint/plugins";

import { isAstNode, jsxName } from "./utils.ts";

/** The attribute values that draw a choice by hand, by element. */
const BANNED_VALUES = {
  role: new Set(["radio", "radiogroup"]),
  type: new Set(["radio"]),
  variant: new Set(["choice", "choice-card"]),
} as const;

/** Which elements each attribute is banned on; `null` is any element. */
const BANNED_ON = {
  role: null,
  type: "input",
  variant: "Label",
} as const;

const isBannedAttribute = (name: string): name is keyof typeof BANNED_VALUES =>
  Object.hasOwn(BANNED_VALUES, name);

/** The attribute's string value, when it is written as a literal. */
const literalValue = (value: unknown): string | null => {
  if (!isAstNode(value)) {
    return null;
  }
  if (value.type === "Literal" && typeof value.value === "string") {
    return value.value;
  }
  if (value.type === "JSXExpressionContainer") {
    const { expression } = value;
    if (
      isAstNode(expression) &&
      expression.type === "Literal" &&
      typeof expression.value === "string"
    ) {
      return expression.value;
    }
  }
  return null;
};

/** The name of the element an attribute sits on. */
const ownerName = (attribute: { parent?: unknown }): string | null => {
  const { parent } = attribute;
  return isAstNode(parent) && parent.type === "JSXOpeningElement"
    ? jsxName(parent.name)
    : null;
};

export default eslintCompatPlugin({
  meta: { name: "no-hand-rolled-setup-choice" },
  rules: {
    "no-hand-rolled-setup-choice": {
      meta: {
        type: "problem",
        messages: {
          handRolled:
            "Setup screens offer a choice through `ChoiceGroup` and " +
            "`ChoiceCard` from apps/desktop/src/onboarding/SetupScreenParts.tsx, " +
            "which draw the cards, their radios and the radio group the same " +
            "way on every screen. Add what a card lacks there instead of " +
            "drawing radio cards here.",
        },
      },
      createOnce(context) {
        return {
          JSXAttribute(node) {
            const { name } = node;
            if (
              name.type !== "JSXIdentifier" ||
              !isBannedAttribute(name.name)
            ) {
              return;
            }
            const value = literalValue(node.value);
            if (value === null || !BANNED_VALUES[name.name].has(value)) {
              return;
            }
            const on = BANNED_ON[name.name];
            if (on !== null && ownerName(node) !== on) {
              return;
            }
            context.report({ node, messageId: "handRolled" });
          },
        };
      },
    },
  },
});
