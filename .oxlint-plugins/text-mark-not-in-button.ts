// A text mark (`textMarkClass`, `TextMark` from `@stll/ui/text-mark`) draws
// review, search or evidence marks over a run of prose. A `<button>` is one
// atomic box even at `display: inline`: a mark it holds cannot break across
// the paragraph's lines, so a mark that crosses a line is laid out as a block
// beside the text before it and the paragraph no longer reads in order.
// Prose that acts as a control is `ButtonTextRun` (`@stll/ui/button`), the
// one owner of clickable runs of text.
//
// Flagged: a `Button` from `@stll/ui/button` with a text mark anywhere in its
// own markup.
//   <Button onClick={select}><span className={textMarkClass(mark)}>…</span></Button>
// Allowed:
//   <ButtonTextRun onClick={select}><span className={textMarkClass(mark)}>…</span></ButtonTextRun>
//
// Detection is single-file: a mark built in another component and passed in
// as children goes unreported.

import { eslintCompatPlugin } from "@oxlint/plugins";

import type { AstNode } from "./utils.ts";
import {
  elementName,
  everyNode,
  getImportedName,
  getImportLocalName,
  isAstNode,
  isIdentifier,
} from "./utils.ts";

const BUTTON_MODULE = "@stll/ui/button";
const TEXT_MARK_MODULE = "@stll/ui/text-mark";

const localNamesOf = (
  program: AstNode,
  source: string,
  imported: string,
): Set<string> => {
  const names = new Set<string>();
  const body = Array.isArray(program.body) ? program.body : [];
  for (const statement of body) {
    if (
      !isAstNode(statement) ||
      statement.type !== "ImportDeclaration" ||
      !isAstNode(statement.source) ||
      statement.source.value !== source ||
      !Array.isArray(statement.specifiers)
    ) {
      continue;
    }
    for (const specifier of statement.specifiers) {
      const local = getImportLocalName(specifier);
      if (getImportedName(specifier) === imported && local !== null) {
        names.add(local);
      }
    }
  }
  return names;
};

export default eslintCompatPlugin({
  meta: { name: "text-mark-not-in-button" },
  rules: {
    "text-mark-not-in-button": {
      meta: {
        type: "problem",
        messages: {
          markInButton:
            "A text mark is prose, and a Button is one atomic box: a mark that crosses a line is lifted out of the paragraph's reading order. Make the run a control with ButtonTextRun from @stll/ui/button.",
        },
        schema: [],
      },
      create(context) {
        let buttons = new Set<string>();
        let markClasses = new Set<string>();
        let markElements = new Set<string>();
        const isMark = (node: AstNode): boolean => {
          if (node.type === "CallExpression") {
            return (
              isIdentifier(node.callee) && markClasses.has(node.callee.name)
            );
          }
          const name = elementName(node);
          return name !== null && markElements.has(name);
        };
        return {
          Program(node: unknown) {
            if (!isAstNode(node)) {
              return;
            }
            buttons = localNamesOf(node, BUTTON_MODULE, "Button");
            markClasses = localNamesOf(node, TEXT_MARK_MODULE, "textMarkClass");
            markElements = localNamesOf(node, TEXT_MARK_MODULE, "TextMark");
          },
          JSXElement(node: unknown) {
            const name = elementName(node);
            if (!isAstNode(node) || name === null || !buttons.has(name)) {
              return;
            }
            const children = Array.isArray(node.children) ? node.children : [];
            if (everyNode(children).some(isMark)) {
              context.report({ node, messageId: "markInButton" });
            }
          },
        };
      },
    },
  },
});
