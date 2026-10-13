// Require every picker option that names a matter to draw its coloured icon.
//
// A matter's colour is how people tell matters apart in a list. An option in
// a combobox, select, menu or command palette that prints only the matter's
// name loses that, and nothing caught it: `no-direct-matter-glyph` guarantees
// a drawn matter glyph is the coloured `MatterIcon`, but not that one is drawn
// where matters are listed.
//
// Flags an option element (ComboboxItem, SelectItem, MenuItem,
// MenuCheckboxItem, MenuRadioItem, MenuSubTrigger, CommandItem,
// AutocompleteItem) whose children render a matter's name unless the same
// option also renders `<MatterOptionLabel>` (the shared icon + name + client
// primitive, preferred) or `<MatterIcon>` (for options with a bespoke layout,
// such as a trailing link).
//
// "Renders a matter's name" is read from the expression: `.name` on a value
// called `matter`/`workspace` (or ending in `Matter`/`Workspace`), or a
// `matterName`/`workspaceName` value. That is a naming heuristic, not type
// information: an option that reaches the name through a differently named
// variable (`item.label`, `group.name`) is not seen, which is why the
// preferred fix is the shared primitive rather than hand-built rows.
//
// Scope: apps/web. The primitive's own file is exempt.

import { eslintCompatPlugin } from "@oxlint/plugins";

import { isAstNode, isFileIn, jsxName } from "./utils.ts";

const OPTION_ELEMENTS = new Set([
  "AutocompleteItem",
  "ComboboxItem",
  "CommandItem",
  "MenuCheckboxItem",
  "MenuItem",
  "MenuRadioItem",
  "MenuSubTrigger",
  "SelectItem",
]);

const MATTER_DRAWING_ELEMENTS = new Set(["MatterIcon", "MatterOptionLabel"]);

const SANCTIONED_FILES = ["matter-option-label.tsx"];

const MATTER_VALUE_NAME = /^(?:matter|workspace)$|(?:Matter|Workspace)$/u;
const MATTER_NAME_VALUE = /^(?:matter|workspace)Name$/u;

type Finding = { drawsMatter: boolean; namesMatter: boolean };

const identifierName = (node: unknown): string | null =>
  isAstNode(node) && node.type === "Identifier" && typeof node.name === "string"
    ? node.name
    : null;

const isMatterNameExpression = (node: unknown): boolean => {
  if (!isAstNode(node)) {
    return false;
  }
  const identifier = identifierName(node);
  if (identifier !== null) {
    return MATTER_NAME_VALUE.test(identifier);
  }
  if (node.type !== "MemberExpression" || node.computed === true) {
    return false;
  }
  const property = identifierName(node.property);
  if (property !== null && MATTER_NAME_VALUE.test(property)) {
    return true;
  }
  if (property !== "name") {
    return false;
  }
  const owner = isAstNode(node.object)
    ? (identifierName(node.object) ??
      identifierName(
        node.object.type === "MemberExpression" ? node.object.property : null,
      ))
    : null;
  return owner !== null && MATTER_VALUE_NAME.test(owner);
};

/**
 * Walks an option's rendered subtree. A matter-drawing element settles its
 * own branch, so a name inside `<MatterOptionLabel>` is never counted.
 */
const inspect = (node: unknown, finding: Finding): void => {
  if (!isAstNode(node)) {
    return;
  }
  if (node.type === "JSXElement") {
    const opening = node.openingElement;
    const tag = isAstNode(opening) ? jsxName(opening.name) : null;
    if (tag !== null && MATTER_DRAWING_ELEMENTS.has(tag)) {
      finding.drawsMatter = true;
      return;
    }
  }
  if (isMatterNameExpression(node)) {
    finding.namesMatter = true;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent") {
      continue;
    }
    if (Array.isArray(value)) {
      for (const child of value) {
        inspect(child, finding);
      }
      continue;
    }
    inspect(value, finding);
  }
};

export default eslintCompatPlugin({
  meta: { name: "require-matter-option-label" },
  rules: {
    "require-matter-option-label": {
      meta: {
        type: "problem",
        messages: {
          bareMatterOption:
            "<{{tag}}> lists a matter by name without its coloured icon. " +
            "Render <MatterOptionLabel matter={...}> (icon, name, client) " +
            "inside the option, or <MatterIcon matter={{ id, color }}> " +
            "before the name when the option needs its own layout.",
        },
      },
      createOnce(context) {
        return {
          before() {
            return !isFileIn(context, SANCTIONED_FILES);
          },
          JSXElement(node) {
            const opening = node.openingElement;
            const tag = isAstNode(opening) ? jsxName(opening.name) : null;
            if (tag === null || !OPTION_ELEMENTS.has(tag)) {
              return;
            }
            const finding: Finding = { drawsMatter: false, namesMatter: false };
            for (const child of node.children) {
              inspect(child, finding);
            }
            if (finding.namesMatter && !finding.drawsMatter) {
              context.report({
                node: opening,
                messageId: "bareMatterOption",
                data: { tag },
              });
            }
          },
        };
      },
    },
  },
});
