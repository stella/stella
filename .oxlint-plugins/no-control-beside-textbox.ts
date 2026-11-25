// A multi-line textbox and its controls never share a row. When a textarea or
// an editor sits in a row beside its buttons, the buttons keep their column
// however tall the text grows: the text is squeezed into a strip between
// them, its scrollbar lands mid-box, and the last line is clipped flush
// against a control, so the controls read as covering the text. A control
// positioned over the text (`absolute`, `fixed`, `sticky`) covers it
// outright. `ComposerFrame` (`@stll/ui/composer-frame`) owns the composer's layout:
// one line beside its controls while it fits, then the text across the box
// over a control row, the controls outside the text's scroll region.
//
// Invariant: in JSX, no multi-line textbox shares a row-laid-out parent with
// a sibling subtree holding a control, and no sibling subtree positions a
// control over it.
//
// Rejected, for a textbox (`textarea`, `Textarea`, `EditorContent`,
// `PromptEditorContent`, an element with `contentEditable`, a React Native
// `TextInput` or `Input` with `multiline`, and the `textboxComponents`
// option) beneath a JSX ancestor:
//   the ancestor is a row (`flex` or `inline-flex` without `flex-col`,
//   `flex-row`, `grid-flow-col`, or `grid-cols-*` with two or more columns)
//   and another of its children holds a control (`button`, a `*Button`, a
//   `*Menu`, a menu/popover/dialog/select trigger, a React Native
//   `Pressable` or `Touchable*`, and the `controlComponents` option);
//   another of its children holds a control inside an element positioned
//   `absolute`, `fixed`, or `sticky`.
//
// React Native markup (the `layout: "native"` option, set for the mobile app
// and the design system's `*.native.tsx` renderers) lays out differently: a
// `View` is a column unless it says `flex-row`, and `flex` only turns flex
// layout on, so there a row is `flex-row`, `flex-row-reverse` or a
// `horizontal` scroll view or list. A `View` that names no direction is read
// like the web's block element around a textbox: it holds the textbox
// without stacking anything beside it, and the walk goes on through it.
//
// The ancestors are read nearest first, up to the first column (`flex-col`,
// a one-column `grid`, `space-y-*`): a column stacks the textbox with what it
// holds, and what sits beside that column is the page's layout (a header's
// actions beside its title and description), not the textbox's. The walk
// also stops at a portaled popup (`*Popup`, `*Portal`, `DialogContent`, a
// React Native `Modal`), whose content is laid out elsewhere, and a control
// inside a portaled popup in a sibling subtree (a dialog's buttons) is not
// beside the textbox.
//
// Accepted:
//   a column (`flex flex-col`, a one-column grid) holding the text over a
//   control row, which is the stacked composer's shape;
//   a select or combobox beside the textbox: a form field beside a field;
//   a textbox handed to a component as a prop (`<ComposerFrame text={...} />`):
//   the component lays it out, and this rule reads only the markup a file
//   writes itself;
//   a positioned control anchored outside the box (`bottom-full`,
//   `top-full`, `start-full`, `end-full`), which floats beyond the text;
//   a single-line `Input`, which never grows a second line.
//
// Analysis boundary: this reads JSX and class strings, not the DOM. A class
// list is read from string literals, template chunks and same-file string
// constants anywhere in the `className` expression, so a `cn()` branch counts
// as written; an imported constant is opaque. Layout set inside another
// component (a row built by a wrapper) is invisible here; the rendered-route
// guard that measures button and text rectangles covers that side.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  classBaseName,
  elementName,
  everyNode,
  isAstNode,
  isIdentifierReference,
  resolveVariable,
  stableInitializer,
  templateElementRaw,
} from "./utils.ts";
import type { AstNode, ScopeContext } from "./utils.ts";

const DEFAULT_TEXTBOXES = new Set([
  "textarea",
  "Textarea",
  "EditorContent",
  "PromptEditorContent",
]);

// A React Native field is one line unless it is `multiline`.
const MULTILINE_FIELDS = new Set(["TextInput", "Input"]);

const DEFAULT_CONTROLS = new Set([
  "button",
  "Button",
  "Menu",
  // React Native's pressables.
  "Pressable",
  "TouchableHighlight",
  "TouchableNativeFeedback",
  "TouchableOpacity",
  "TouchableWithoutFeedback",
]);

// A design-system trigger opens a popup on press: it is a control whatever
// it renders. A select or combobox trigger is not here: it is a form field
// beside another field, not an action on the text.
const TRIGGER_SUFFIXES = ["MenuTrigger", "PopoverTrigger", "DialogTrigger"];

// Content a portal renders elsewhere: whatever it holds is not laid out by
// the markup around it.
const PORTALED =
  /(?:Popup|Portal|Positioner|Modal|(?:Dialog|Sheet|Popover|Drawer|Menu)Content)$/u;

const POSITIONED = new Set(["absolute", "fixed", "sticky"]);

// Anchored beyond the parent's box, so the element floats outside the text.
const OUTSIDE_ANCHORS = new Set([
  "bottom-full",
  "top-full",
  "start-full",
  "end-full",
  "left-full",
  "right-full",
]);

const FUNCTION_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);

/** Whose layout rules the markup follows: the web's CSS or React Native's. */
type Layout = "web" | "native";

type RuleOptions = {
  textboxes: ReadonlySet<string>;
  controls: ReadonlySet<string>;
  layout: Layout;
};

const stringList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];

const readOptions = (configured: unknown): RuleOptions => {
  const record =
    typeof configured === "object" && configured !== null ? configured : {};
  const extraTextboxes =
    "textboxComponents" in record ? stringList(record.textboxComponents) : [];
  const extraControls =
    "controlComponents" in record ? stringList(record.controlComponents) : [];
  return {
    textboxes: new Set([...DEFAULT_TEXTBOXES, ...extraTextboxes]),
    controls: new Set([...DEFAULT_CONTROLS, ...extraControls]),
    layout: "layout" in record && record.layout === "native" ? "native" : "web",
  };
};

const isControlName = (name: string, options: RuleOptions): boolean =>
  options.controls.has(name) ||
  (/^[A-Z]/u.test(name) &&
    (name.endsWith("Button") ||
      name.endsWith("Menu") ||
      TRIGGER_SUFFIXES.some((suffix) => name.endsWith(suffix))));

const openingAttributes = (element: AstNode): AstNode[] => {
  const opening = element.openingElement;
  if (!isAstNode(opening) || !Array.isArray(opening.attributes)) {
    return [];
  }
  return opening.attributes.filter(isAstNode);
};

const attributeNamed = (element: AstNode, name: string): AstNode | null =>
  openingAttributes(element).find(
    (attribute) =>
      attribute.type === "JSXAttribute" &&
      isAstNode(attribute.name) &&
      attribute.name.type === "JSXIdentifier" &&
      attribute.name.name === name,
  ) ?? null;

// `prop={false}`: an attribute written only to say no.
const isFalseAttribute = (attribute: AstNode): boolean => {
  const { value } = attribute;
  return (
    isAstNode(value) &&
    value.type === "JSXExpressionContainer" &&
    isAstNode(value.expression) &&
    value.expression.type === "Literal" &&
    value.expression.value === false
  );
};

// `contentEditable`, `contentEditable="true"`, `contentEditable={true}` make
// an element a textbox; `false` (an inline chip inside an editor) does not.
const isContentEditable = (element: AstNode): boolean => {
  const attribute = attributeNamed(element, "contentEditable");
  if (attribute === null) {
    return false;
  }
  const { value } = attribute;
  if (value === null || value === undefined) {
    return true;
  }
  if (!isAstNode(value)) {
    return false;
  }
  if (value.type === "Literal") {
    return value.value !== "false";
  }
  if (value.type === "JSXExpressionContainer" && isAstNode(value.expression)) {
    const { expression } = value;
    return !(expression.type === "Literal" && expression.value === false);
  }
  return false;
};

// A boolean prop written as on: `prop`, `prop="..."`, `prop={...}` other
// than `{false}`.
const isOn = (element: AstNode, name: string): boolean => {
  const attribute = attributeNamed(element, name);
  return attribute !== null && !isFalseAttribute(attribute);
};

const isTextbox = (element: AstNode, options: RuleOptions): boolean => {
  const name = elementName(element);
  if (
    name !== null &&
    MULTILINE_FIELDS.has(name) &&
    isOn(element, "multiline")
  ) {
    return true;
  }
  return (
    (name !== null && options.textboxes.has(name)) || isContentEditable(element)
  );
};

// A class string split only on whitespace. The shared tokenizer also splits
// on parentheses, which cuts an arbitrary grid template such as
// `grid-cols-[auto_minmax(0,1fr)_auto]` into pieces and hides its columns;
// a Tailwind token never holds whitespace, so whitespace alone is exact here.
const wholeClassTokens = (value: string): string[] =>
  value.split(/\s+/u).filter((token) => token.length > 0);

// Every class token a `className` expression can produce: its string
// literals, template chunks, and the initializers of same-file constants it
// names.
const classNameTokens = (element: AstNode, context: ScopeContext): string[] => {
  const attribute = attributeNamed(element, "className");
  if (attribute === null) {
    return [];
  }
  const tokens: string[] = [];
  const pending: unknown[] = [attribute.value];
  const visited = new Set<unknown>();
  while (pending.length > 0) {
    const root = pending.pop();
    if (visited.has(root)) {
      continue;
    }
    visited.add(root);
    for (const node of everyNode(root)) {
      const chunk = templateElementRaw(node);
      if (node.type === "Literal" && typeof node.value === "string") {
        tokens.push(...wholeClassTokens(node.value));
      } else if (chunk !== null) {
        tokens.push(...wholeClassTokens(chunk));
      } else if (isIdentifierReference(node)) {
        const variable = resolveVariable(context, node);
        const initializer =
          variable === null ? null : stableInitializer(variable);
        if (initializer !== null) {
          pending.push(initializer);
        }
      }
    }
  }
  return tokens;
};

const gridColumnCount = (base: string): number | null => {
  if (!base.startsWith("grid-cols-")) {
    return null;
  }
  const value = base.slice("grid-cols-".length);
  if (value.startsWith("[") && value.endsWith("]")) {
    // Tailwind spells the spaces between tracks `_`.
    return value
      .slice(1, -1)
      .split("_")
      .filter((track) => track.length > 0).length;
  }
  const count = Number.parseInt(value, 10);
  return Number.isNaN(count) ? null : count;
};

// A React Native row: `flex-row` or its reverse, or a scroll view or list
// laid out `horizontal`. Only unprefixed tokens count, as on the web.
const isNativeRow = (element: AstNode, tokens: readonly string[]): boolean =>
  tokens.some(
    (token) => token === "flex-row" || token === "flex-row-reverse",
  ) || isOn(element, "horizontal");

const isRow = (tokens: readonly string[]): boolean => {
  const bases = tokens.map(classBaseName);
  if (bases.includes("flex-row") || bases.includes("grid-flow-col")) {
    return true;
  }
  if (
    bases.some((base) => {
      const columns = gridColumnCount(base);
      return columns !== null && columns >= 2;
    })
  ) {
    return true;
  }
  const flex = tokens.some(
    (token) => token === "flex" || token === "inline-flex",
  );
  const column = tokens.some(
    (token) => token === "flex-col" || token === "flex-col-reverse",
  );
  return flex && !column;
};

// A block that stacks its children: a flex column, a one-column grid, or
// vertical spacing between blocks. Only unprefixed tokens count, so a
// breakpoint that turns a row into a column (`flex md:flex-col`) still reads
// as the row it is at its narrowest.
const isColumn = (tokens: readonly string[]): boolean =>
  !isRow(tokens) &&
  tokens.some(
    (token) =>
      token === "flex-col" ||
      token === "flex-col-reverse" ||
      token === "grid" ||
      token.startsWith("space-y-"),
  );

// A React Native column: one that says so. A `View` that names no direction
// stacks too, but around a textbox it is the web's block element: a cell
// that holds the textbox, read through like one (see the header).
const isNativeColumn = (tokens: readonly string[]): boolean =>
  tokens.some((token) => token === "flex-col" || token === "flex-col-reverse");

/** The ancestor's direction under the markup's layout rules. */
const directionOf = (
  element: AstNode,
  tokens: readonly string[],
  layout: Layout,
): { row: boolean; column: boolean } => {
  if (layout === "native") {
    const row = isNativeRow(element, tokens);
    return { row, column: !row && isNativeColumn(tokens) };
  }
  return { row: isRow(tokens), column: isColumn(tokens) };
};

const isPositionedOverText = (tokens: readonly string[]): boolean => {
  const bases = tokens.map(classBaseName);
  return (
    bases.some((base) => POSITIONED.has(base)) &&
    !bases.some((base) => OUTSIDE_ANCHORS.has(base))
  );
};

const contains = (outer: AstNode, inner: AstNode): boolean =>
  outer.range[0] <= inner.range[0] && inner.range[1] <= outer.range[1];

const isPortaled = (element: AstNode): boolean => {
  const name = elementName(element);
  return name !== null && PORTALED.test(name);
};

// The JSX elements a sibling lays out here: a portaled popup's content is
// laid out elsewhere, so the popup and everything inside it drop out.
const laidOutElements = (sibling: unknown): AstNode[] => {
  const elements = everyNode(sibling).filter(
    (node) => node.type === "JSXElement",
  );
  const portals = elements.filter(isPortaled);
  return elements.filter(
    (element) => !portals.some((portal) => contains(portal, element)),
  );
};

type SiblingFinding = "beside" | "over" | null;

const siblingFinding = (
  sibling: unknown,
  row: boolean,
  options: RuleOptions,
  context: ScopeContext,
): SiblingFinding => {
  const elements = laidOutElements(sibling);
  const controls = elements.filter((element) => {
    const name = elementName(element);
    return name !== null && isControlName(name, options);
  });
  if (controls.length === 0) {
    return null;
  }
  if (row) {
    return "beside";
  }
  const overlay = elements.some(
    (element) =>
      isPositionedOverText(classNameTokens(element, context)) &&
      controls.some((control) => contains(element, control)),
  );
  return overlay ? "over" : null;
};

// The JSX ancestors whose children lay the textbox out, nearest first. The
// walk stops at a prop (a component lays that slot out) and at a function
// boundary (a callback or a component of its own).
const layoutAncestors = (textbox: AstNode): AstNode[] => {
  const ancestors: AstNode[] = [];
  let node: unknown = textbox.parent;
  while (isAstNode(node)) {
    if (node.type === "JSXAttribute" || FUNCTION_TYPES.has(node.type)) {
      break;
    }
    if (node.type === "JSXElement") {
      ancestors.push(node);
    }
    node = node.parent;
  }
  return ancestors;
};

export default eslintCompatPlugin({
  meta: { name: "no-control-beside-textbox" },
  rules: {
    "no-control-beside-textbox": {
      meta: {
        type: "problem",
        schema: [
          {
            type: "object",
            properties: {
              textboxComponents: { type: "array", items: { type: "string" } },
              controlComponents: { type: "array", items: { type: "string" } },
              layout: { type: "string", enum: ["web", "native"] },
            },
            additionalProperties: false,
          },
        ],
        messages: {
          beside:
            "A multi-line textbox shares a row with a control: as the text " +
            "grows the control keeps its column, squeezes the text and " +
            "clips its last line against the control. Render the composer " +
            "through ComposerFrame from @stll/ui/composer-frame, or put the " +
            "controls in a row below the text.",
          over:
            "A control is positioned over a multi-line textbox and covers " +
            "its text. Render the composer through ComposerFrame from " +
            "@stll/ui/composer-frame, or put the controls in a row below the text.",
        },
      },
      createOnce(context) {
        let options = readOptions(undefined);
        return {
          before() {
            options = readOptions(context.options.at(0));
          },
          JSXElement(node) {
            if (!isAstNode(node) || !isTextbox(node, options)) {
              return;
            }
            for (const ancestor of layoutAncestors(node)) {
              if (isPortaled(ancestor)) {
                return;
              }
              const children = Array.isArray(ancestor.children)
                ? ancestor.children.filter(isAstNode)
                : [];
              const tokens = classNameTokens(ancestor, context);
              const { row, column } = directionOf(
                ancestor,
                tokens,
                options.layout,
              );
              for (const child of children) {
                if (contains(child, node)) {
                  continue;
                }
                const finding = siblingFinding(child, row, options, context);
                if (finding !== null) {
                  context.report({ node, messageId: finding });
                  return;
                }
              }
              // A column stacks the textbox with what it holds; what sits
              // beside that column is the page's layout, not the textbox's.
              if (column) {
                return;
              }
            }
          },
        };
      },
    },
  },
});
