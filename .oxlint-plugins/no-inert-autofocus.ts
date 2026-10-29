// React focuses an element with `autoFocus` on mount only when it is a form
// control: `input`, `select`, `textarea` or `button`. On any other intrinsic
// element (a contenteditable `div`, a focusable `section`) the prop renders
// nothing and focuses nothing, so the element silently opens unfocused.
// Focus those from a ref callback instead.
//
// Components are not checked: they may forward `autoFocus` to a control.
//
// Flagged:
//   <div autoFocus contentEditable />
// Allowed:
//   <input autoFocus />
//   <Input autoFocus />
//   <div contentEditable ref={(node) => node?.focus()} />

import { eslintCompatPlugin } from "@oxlint/plugins";

const AUTOFOCUSED_ELEMENTS = new Set(["button", "input", "select", "textarea"]);

const MESSAGE =
  "React applies `autoFocus` only to input, select, textarea and button; " +
  "here it focuses nothing. Focus the element from a ref callback " +
  "(`ref={(node) => node?.focus()}`).";

export default eslintCompatPlugin({
  meta: { name: "no-inert-autofocus" },
  rules: {
    "no-inert-autofocus": {
      meta: {
        type: "problem",
        messages: { inert: MESSAGE },
      },
      createOnce(context) {
        return {
          JSXAttribute(node) {
            if (
              node.name.type !== "JSXIdentifier" ||
              node.name.name !== "autoFocus"
            ) {
              return;
            }
            const element = node.parent;
            if (
              element.type !== "JSXOpeningElement" ||
              element.name.type !== "JSXIdentifier"
            ) {
              return;
            }
            const tag = element.name.name;
            if (tag !== tag.toLowerCase() || AUTOFOCUSED_ELEMENTS.has(tag)) {
              return;
            }
            context.report({ node, messageId: "inert" });
          },
        };
      },
    },
  },
});
