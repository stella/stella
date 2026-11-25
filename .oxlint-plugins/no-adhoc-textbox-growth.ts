// How tall a textbox grows, and where it scrolls once it stops, belongs to
// its primitive. `ComposerFrame` (`@stll/ui/composer-frame`) caps a composer's text
// and scrolls it in its own region, outside the controls; `Textarea`
// (`@stll/ui/textarea`) grows a form field and caps it with `maxRows`. A cap
// set by hand on the textbox puts the scroller on the editable element itself,
// wherever its parent happens to place it: beside the controls, its
// scrollbar mid-box, its last line clipped against a button.
//
// Invariant: outside the owner modules, no class string sets a textbox's
// growth or scroll cap.
//
// Rejected:
//   `field-sizing-content` and `field-sizing-fixed`, under any variant
//   (growth is the `Textarea` primitive's `fieldSizing`);
//   a `max-h-*` or `overflow-*` utility behind an arbitrary variant that
//   selects a textbox through a descendant or child combinator:
//   `[&_.ProseMirror]:max-h-32`, `[&_textarea]:max-h-48`,
//   `[&>.tiptap]:overflow-y-auto`, `[&_[contenteditable]]:overflow-auto`;
//   a `max-h-*` in the `className` of a `textarea` or `Textarea`;
//   a `max-h-*` or `overflow-*` in an editor's `attributes` `class` (the
//   classes a TipTap or ProseMirror view puts on its editable element).
//
// Accepted:
//   the owner modules, named in `oxlint.config.ts` with their reason;
//   `min-h-*` and typography behind the same selectors (`[&_.ProseMirror]:
//   leading-5`): a floor and text styling do not cap growth;
//   `max-h-*` and `overflow-*` on chrome that is not a textbox (a popover, a
//   list), which `no-raw-overflow-scroll` governs.
//
// Analysis boundary: this reads class strings, not the DOM. Every string
// literal and template chunk in a scoped file is tokenized, so a utility in a
// `cn()` argument is read like one written on the element; the `className`
// and `attributes` checks need the string written inside that attribute or
// property. A cap set from a stylesheet or an inline style is not seen.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  classBaseName,
  classTokens,
  classVariants,
  elementName,
  getPropertyName,
  isAstNode,
  templateElementRaw,
} from "./utils.ts";
import type { AstNode } from "./utils.ts";

const FIELD_SIZING = new Set(["field-sizing-content", "field-sizing-fixed"]);

// The textbox an arbitrary selector may reach: a ProseMirror or TipTap
// editable element, a textarea, any contenteditable element.
const TEXTBOX_SELECTORS = [
  ".ProseMirror",
  ".tiptap",
  "textarea",
  "[contenteditable]",
  "[contenteditable=true]",
  "[role=textbox]",
];

const TEXTBOX_ELEMENTS = new Set(["textarea", "Textarea"]);

const isCap = (base: string): boolean =>
  base.startsWith("max-h-") ||
  (base.startsWith("overflow-") &&
    base !== "overflow-visible" &&
    base !== "overflow-hidden" &&
    base !== "overflow-clip");

// Tailwind spells the descendant combinator `_`; `>` is the child combinator.
const COMBINATORS = ["_", ">"];

// A pseudo-class name; `_` is not one of its characters, since Tailwind
// spells the descendant combinator with it.
const PSEUDO_NAME = /[a-z0-9-]/iu;

/**
 * The index just past the pseudo-classes and pseudo-elements that start at
 * `at` (`:hover`, `:focus-visible`, `::placeholder`), or `at` itself when none
 * does. A functional pseudo-class never reaches here whole: `classTokens`
 * splits on parentheses.
 */
const skipPseudoClasses = (variants: string, at: number): number => {
  let index = at;
  while (variants.charAt(index) === ":") {
    index += 1;
    while (PSEUDO_NAME.test(variants.charAt(index))) {
      index += 1;
    }
  }
  return index;
};

/**
 * Whether a variant's arbitrary selector lands on the textbox itself: the
 * textbox follows a combinator and ends the selector (`]`), possibly after
 * pseudo-classes of its own (`[&_.ProseMirror:focus]`).
 * `[&_.ProseMirror_p]` and `[&_.ProseMirror:hover_pre]` select an element
 * inside the editor, not the editor.
 */
const selectsTextbox = (variants: string): boolean =>
  TEXTBOX_SELECTORS.some((selector) =>
    COMBINATORS.some((combinator) => {
      const needle = `${combinator}${selector}`;
      let at = variants.indexOf(needle);
      while (at !== -1) {
        const end = skipPseudoClasses(variants, at + needle.length);
        if (variants.charAt(end) === "]") {
          return true;
        }
        at = variants.indexOf(needle, at + 1);
      }
      return false;
    }),
  );

const adHocToken = (token: string): boolean => {
  const base = classBaseName(token);
  if (FIELD_SIZING.has(base)) {
    return true;
  }
  return isCap(base) && selectsTextbox(classVariants(token));
};

const capToken = (token: string): boolean => isCap(classBaseName(token));

const maxHeightToken = (token: string): boolean =>
  classBaseName(token).startsWith("max-h-");

const textOf = (node: AstNode): string | null =>
  node.type === "Literal" && typeof node.value === "string"
    ? node.value
    : templateElementRaw(node);

// The JSX element whose `className` this string is written in, if any.
const classNameOwner = (node: AstNode): AstNode | null => {
  let current: unknown = node.parent;
  while (isAstNode(current)) {
    if (current.type === "JSXAttribute") {
      const name = isAstNode(current.name) ? current.name.name : null;
      if (name !== "className") {
        return null;
      }
      const opening = current.parent;
      const element = isAstNode(opening) ? opening.parent : null;
      return isAstNode(element) ? element : null;
    }
    if (
      current.type === "JSXElement" ||
      current.type === "ArrowFunctionExpression" ||
      current.type === "FunctionExpression" ||
      current.type === "FunctionDeclaration"
    ) {
      return null;
    }
    current = current.parent;
  }
  return null;
};

// Whether this string is the `class` of an editor's `attributes`: written in
// a `class` property inside an `attributes` property (an object, or a
// function returning one).
const isEditorAttributeClass = (node: AstNode): boolean => {
  let current: unknown = node.parent;
  let insideClass = false;
  while (isAstNode(current)) {
    if (current.type === "Property") {
      const name = getPropertyName(current.key);
      if (!insideClass) {
        if (name !== "class") {
          return false;
        }
        insideClass = true;
      } else if (name === "attributes") {
        return true;
      }
    }
    if (current.type === "JSXElement" || current.type === "Program") {
      return false;
    }
    current = current.parent;
  }
  return false;
};

const findingFor = (
  node: AstNode,
): "adHoc" | "textboxMaxHeight" | "editorAttributes" | null => {
  const text = textOf(node);
  if (text === null) {
    return null;
  }
  const tokens = classTokens(text);
  if (tokens.some(adHocToken)) {
    return "adHoc";
  }
  if (tokens.some(maxHeightToken)) {
    const owner = classNameOwner(node);
    const name = owner === null ? null : elementName(owner);
    if (name !== null && TEXTBOX_ELEMENTS.has(name)) {
      return "textboxMaxHeight";
    }
  }
  if (tokens.some(capToken) && isEditorAttributeClass(node)) {
    return "editorAttributes";
  }
  return null;
};

const FIX =
  "A composer renders its text through ComposerFrame from " +
  "@stll/ui/composer-frame, which caps and scrolls it; a form field uses " +
  "Textarea's maxRows and fieldSizing.";

export default eslintCompatPlugin({
  meta: { name: "no-adhoc-textbox-growth" },
  rules: {
    "no-adhoc-textbox-growth": {
      meta: {
        type: "problem",
        messages: {
          adHoc:
            "A textbox's growth or scroll cap is set by hand (field-sizing, " +
            `or max-h/overflow through a textbox selector). ${FIX}`,
          textboxMaxHeight: `A textarea's height cap is set by hand. ${FIX}`,
          editorAttributes:
            "An editor's editable element is capped or made to scroll by " +
            `its own classes. ${FIX}`,
        },
      },
      createOnce(context) {
        const check = (node: unknown) => {
          if (!isAstNode(node)) {
            return;
          }
          const finding = findingFor(node);
          if (finding !== null) {
            context.report({ node, messageId: finding });
          }
        };
        return { Literal: check, TemplateElement: check };
      },
    },
  },
});
