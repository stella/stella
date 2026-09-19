// A rendered `<input type="file">` paints the browser's own "Choose file /
// No file chosen" chrome, which no locale can translate, and every surface
// that hides one behind a button re-implements the same ref, `.click()`, and
// value-reset (forgetting the reset makes re-picking the same file a silent
// no-op). `@stll/ui` owns both shapes: `openFilePicker` opens the chooser
// from any handler with no input in the tree, and `FileInput` is the labelled
// single-file field.
//
// Flagged:
//   <input type="file" />
//   <input className="hidden" ref={inputRef} type="file" />
//   <input type={"file"} />
// Allowed:
//   <input type="text" />
//   <input type={inputType} />       (dynamic; the type system guards `Input`)
//   document.createElement("input")  (how `openFilePicker` builds its own)

import { eslintCompatPlugin } from "@oxlint/plugins";

import { isAstNode, jsxName } from "./utils.ts";

const staticStringValue = (value: unknown): string | null => {
  if (!isAstNode(value)) {
    return null;
  }
  if (value.type === "Literal") {
    return typeof value.value === "string" ? value.value : null;
  }
  if (value.type === "JSXExpressionContainer") {
    return staticStringValue(value.expression);
  }
  return null;
};

export default eslintCompatPlugin({
  meta: { name: "no-raw-file-input" },
  rules: {
    "no-raw-file-input": {
      meta: {
        type: "problem",
        messages: {
          rawFileInput:
            'Do not render <input type="file">: its chrome is untranslatable ' +
            "and the hidden-input wiring is duplicated at every site. Open the " +
            "chooser with `openFilePicker` from '@stll/ui/file-picker', or " +
            "render `FileInput` from '@stll/ui/file-input' for a labelled " +
            "single-file field.",
        },
      },
      createOnce(context) {
        return {
          JSXOpeningElement(node) {
            if (
              jsxName(node.name) !== "input" ||
              !Array.isArray(node.attributes)
            ) {
              return;
            }
            for (const attribute of node.attributes) {
              if (
                !isAstNode(attribute) ||
                attribute.type !== "JSXAttribute" ||
                jsxName(attribute.name) !== "type"
              ) {
                continue;
              }
              if (staticStringValue(attribute.value) === "file") {
                context.report({ node: attribute, messageId: "rawFileInput" });
              }
            }
          },
        };
      },
    },
  },
});
