// Enumerate commit-on-blur/keyboard inputs rather than requiring a particular
// hook. Require a view/edit state in the owning function and text commit
// handlers. Permanent fields, creation forms, numeric and multiline editors
// have different contracts and stay outside this census.
import { eslintCompatPlugin } from "@oxlint/plugins";

import { filenameForContext, isAstNode } from "./utils.ts";

const OWNER_PATH = "/packages/ui/src/components/inline-rename.tsx";
const INPUT_NAMES = ["input", "Input"];
const EDIT_STATE =
  /\b(?:isEditing\w*|editing\w*|editMode|isRenaming\w*|renaming\w*)\b|\.(?:mode|status)\s*[!=]==?\s*["']edit(?:ing)?["']/u;
const RENAME_BINDING = /rename|inlineEdit|editingName|editingTitle/iu;

export default eslintCompatPlugin({
  meta: { name: "no-ad-hoc-inline-rename" },
  rules: {
    "no-ad-hoc-inline-rename": {
      meta: {
        type: "problem",
        messages: {
          sharedRename:
            "Use InlineRenameInput from @stll/ui/inline-rename for inline renaming so typography, sizing, selection and keyboard behavior share one owner.",
        },
      },
      createOnce(context) {
        const inputNames = new Set(INPUT_NAMES);
        return {
          before() {
            inputNames.clear();
            for (const name of INPUT_NAMES) {
              inputNames.add(name);
            }
            return !filenameForContext(context).endsWith(OWNER_PATH);
          },
          ImportDeclaration(node) {
            for (const specifier of node.specifiers) {
              if (specifier.type !== "ImportSpecifier") {
                continue;
              }
              const imported = specifier.imported;
              const name =
                imported.type === "Identifier" ? imported.name : imported.value;
              if (typeof name === "string" && INPUT_NAMES.includes(name)) {
                inputNames.add(specifier.local.name);
              }
            }
          },
          JSXOpeningElement(node) {
            if (
              node.name.type !== "JSXIdentifier" ||
              !inputNames.has(node.name.name)
            ) {
              return;
            }
            const attributes = new Map(
              node.attributes.flatMap((attribute) =>
                attribute.type === "JSXAttribute" &&
                attribute.name.type === "JSXIdentifier"
                  ? [[attribute.name.name, attribute] as const]
                  : [],
              ),
            );
            if (!attributes.has("onBlur") || !attributes.has("onKeyDown")) {
              return;
            }
            const inputMode = attributes.get("inputMode");
            if (
              inputMode?.value?.type === "Literal" &&
              (inputMode.value.value === "numeric" ||
                inputMode.value.value === "decimal")
            ) {
              return;
            }
            // The opening element's immediate parent is its JSXElement.
            let owner = node.parent.parent;
            while (
              owner &&
              owner.type !== "ArrowFunctionExpression" &&
              owner.type !== "FunctionExpression" &&
              owner.type !== "FunctionDeclaration"
            ) {
              owner = owner.parent;
            }
            if (!owner || !EDIT_STATE.test(context.sourceCode.getText(owner))) {
              return;
            }
            const renameBinding = [...attributes.values()].some(
              (attribute) =>
                isAstNode(attribute.value) &&
                RENAME_BINDING.test(
                  context.sourceCode.getText(attribute.value),
                ),
            );
            if (!renameBinding && !attributes.has("autoFocus")) {
              return;
            }
            context.report({ node, messageId: "sharedRename" });
          },
        };
      },
    },
  },
});
